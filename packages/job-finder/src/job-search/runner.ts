import { setMaxListeners } from "node:events";
import {
  createJobSitesStore,
  createSearchSourcesStore,
  createSourceAccessStore,
} from "@nestor/db/job-store";
import { createHostQueue } from "@nestor/browser-runtime";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  isRunnableJobDiscoveryTarget,
  jobSiteTarget,
  JobSearchSettingsSchema,
  type JobDiscoveryTarget,
  type JobSearchRecord,
  type JobSearchStatus,
  type JobSearchSettingsInput,
  type JobSearchProgress,
} from "@nestor/contracts";
import { abortable, concurrency, errorMessage } from "./async";
import { createFitQueue } from "./fit-queue";
import { fitContextFingerprint } from "./fit-input";
import { createSearchPipeline } from "./pipeline";
import { settledState, sourceWork, type SourceWork } from "./source-work";
import type {
  JobSearchContext,
  JobSearchRunner,
  JobSearchRunnerDeps,
} from "./types";

type FitQueue = ReturnType<typeof createFitQueue>;
interface ActiveSearch {
  controller: AbortController;
  record: JobSearchRecord | null;
  starting: Promise<JobSearchRecord> | null;
  fits: FitQueue | null;
  ready: Promise<FitQueue | null>;
  setReady(fits: FitQueue | null): void;
  queueProgress?: () => Partial<JobSearchProgress>;
  enqueue?: (
    target: JobDiscoveryTarget,
    force: boolean,
    full?: boolean,
  ) => void;
}

/** How long site progress gathers before it commits in one write. */
const SOURCE_WRITE_GATHER_MS = 200;

export function createJobSearchRunner(
  deps: JobSearchRunnerDeps,
): JobSearchRunner {
  const siteRows = createJobSitesStore(deps.store),
    resultRows = createSearchSourcesStore(deps.store),
    access = createSourceAccessStore(deps.store);
  let search = deps.store.searches.latest();
  let active: ActiveSearch | null = null;
  let recovery: {
    controller: AbortController;
    result: Promise<number>;
  } | null = null;
  let revision = 0,
    siteDirty = false;
  let continuation: ReturnType<typeof setTimeout> | null = null;
  let recoveryQueue: FitQueue | null = null;
  let visibleIds: readonly number[] = [];
  const scheduleFit = (delay = 300) => {
    if (continuation) clearTimeout(continuation);
    continuation = setTimeout(() => {
      continuation = null;
      void runner.scoreUnscored().catch(() => undefined);
    }, delay);
    continuation.unref();
  };
  deps.store.onChange((change) => {
    if (change.cause === "profile" || change.cause === "settings") {
      if (recovery) {
        const pending = recovery;
        const continueFit = () => {
          if (!pending.controller.signal.aborted) scheduleFit();
        };
        void pending.result.then(continueFit, continueFit);
      } else scheduleFit();
    }
  });
  const listeners = new Set<(status: JobSearchStatus) => void>();
  let notification: ReturnType<typeof setTimeout> | null = null;
  const status = (): JobSearchStatus => {
    const compact = search
      ? resultRows.compact(search.id)
      : { sources: [], progress: null };
    const fits = deps.store.fitCounts();
    return {
      fitChecking: fits.checking,
      fitRechecking: fits.rechecking,
      search: search ? structuredClone(search) : null,
      ...compact,
      progress: compact.progress
        ? { ...compact.progress, ...active?.queueProgress?.() }
        : null,
      sourceRevision: revision,
    };
  };
  const emit = () => {
    notification = null;
    if (siteDirty) {
      siteDirty = false;
      deps.store.notify({
        cause: "sites",
        stages: [],
        ids: [],
        searchId: search?.id ?? null,
      });
    }
    if (!listeners.size) return;
    const value = status();
    for (const listener of listeners) {
      try {
        listener(structuredClone(value));
      } catch {
        /* A view cannot stop a search. */
      }
    }
  };
  const notify = (now = false) => {
    if (now) {
      if (notification) clearTimeout(notification);
      emit();
      return;
    }
    if (notification) return;
    notification = setTimeout(emit, 250);
    notification.unref();
  };
  const update = (
    run: ActiveSearch,
    increments: Parameters<typeof deps.store.searches.count>[1],
  ) => {
    if (
      run.controller.signal.aborted ||
      !run.record ||
      run.record.state !== "running"
    )
      return;
    run.record =
      deps.store.searches.count(run.record.id, increments) ?? run.record;
    search = run.record;
    notify();
  };
  const finish = (
    run: ActiveSearch,
    state: "done" | "stopped" | "failed",
    error: string | null = null,
  ) => {
    if (!run.record || run.record.state !== "running") return;
    run.record =
      deps.store.searches.finish(run.record.id, state, error) ?? run.record;
    search = run.record;
    if (active === run) active = null;
    run.controller.abort();
    notify(true);
    // A finished search's cached database pages are not needed by anything
    // on screen; give them back.
    deps.store.releaseMemory();
  };

  const execute = async (
    run: ActiveSearch,
    context: JobSearchContext,
    targets: JobDiscoveryTarget[],
    forced: { ids: ReadonlySet<string>; full: boolean },
  ) => {
    setMaxListeners(0, run.controller.signal);
    const signal = run.controller.signal,
      settings = run.record!.settings;
    const states = new Map<string, SourceWork>();
    const http = createHostQueue({
      limit: concurrency(deps.concurrency?.sources, 12),
      perHost: concurrency(deps.concurrency?.perHost, 2),
    });
    const browser = createHostQueue({
      limit: concurrency(deps.concurrency?.browser ?? deps.browserPages?.(), 2),
      perHost: 1,
    });
    let fitError: string | null = null;
    const fits = createFitQueue(
      deps,
      context,
      signal,
      concurrency(deps.concurrency?.fit ?? deps.fitRequests?.(), 6),
      (n) => update(run, { scored: n }),
      (error) => {
        fitError = errorMessage(error);
      },
      settings,
      () => notify(),
    );
    run.fits = fits;
    run.queueProgress = () => ({
      httpActive: http.active,
      httpQueued: http.queued,
      browserActive: browser.active,
      browserQueued: browser.queued,
      fitActive: fits.activeCount,
      fitQueued: fits.pendingCount,
    });
    const current = (source: SourceWork) =>
      !signal.aborted && states.get(source.target.id) === source;
    // Each site's progress used to commit on its own, several times per
    // site; a 900-site search kept main busy enough to hold screens back.
    // Changes now gather for a moment and commit together.
    const dirty = new Set<SourceWork>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      const rows = [...dirty].filter(current);
      dirty.clear();
      if (rows.length === 0) return;
      deps.store.transaction(() => {
        for (const source of rows) resultRows.put(run.record!.id, source.row);
      });
      revision++;
      notify();
    };
    const write = (source: SourceWork) => {
      if (!current(source)) return;
      dirty.add(source);
      flushTimer ??= setTimeout(flush, SOURCE_WRITE_GATHER_MS);
    };
    const markDone = (source: SourceWork) => {
      if (
        !current(source) ||
        source.counted ||
        !source.collected ||
        source.processed < source.row.cards
      )
        return;
      source.counted = true;
      if (!settledState(source.row.state)) source.row.state = "done";
      // Inventory alone is not proof of access: the selected details must
      // also have finished, without an access or read failure.
      if (
        (source.row.state === "done" || source.row.state === "partial") &&
        source.row.failedReads === 0
      )
        source.completeAccess?.();
      source.row.phase = null;
      source.row.message =
        `${source.row.cards} listings; ${source.row.related} new related; ${source.row.unrelated} unrelated; ${source.row.seen} already seen.` +
        (source.row.failedReads
          ? ` ${source.row.failedReads} listing reads need attention.`
          : "") +
        (source.notes.length
          ? ` ${source.notes.join(" ").slice(0, 1800)}`
          : "");
      write(source);
      update(run, { sourcesDone: 1 });
      source.urls.clear();
    };
    const needsAccess = (source: SourceWork, message: string) => {
      if (!current(source)) return;
      source.row.state = "needs_you";
      source.row.message = message;
      access.request(Number(source.target.id), message);
      siteRows.record(
        Number(source.target.id),
        {
          health: "needs_sign_in",
          signInState: "required",
          lastSearchedAt: new Date().toISOString(),
          lane: source.row.lane ?? "browser",
        },
        false,
      );
      siteDirty = true;
      write(source);
    };
    const failedSource = (source: SourceWork, message: string) => {
      if (!current(source)) return;
      source.row.state = "failed";
      source.notes.push(message);
      siteRows.record(
        Number(source.target.id),
        {
          health: "failed",
          signInState: "unknown",
          lastSearchedAt: new Date().toISOString(),
          lane: source.row.lane ?? "browser",
        },
        false,
      );
      siteDirty = true;
      write(source);
    };
    const browserTask = (
      source: SourceWork,
      work: (signal: AbortSignal) => Promise<void>,
    ) => {
      if (!current(source)) return;
      source.row.lane = "browser";
      if (!settledState(source.row.state)) {
        source.row.phase = "browser";
        source.row.state = "waiting";
      }
      write(source);
      void browser
        .run(new URL(source.target.startingUrl).hostname, signal, async () => {
          if (!current(source)) return;
          if (!settledState(source.row.state)) {
            source.row.state = "searching";
            source.row.phase = "browser";
          }
          write(source);
          const deadline = AbortSignal.any([
            signal,
            AbortSignal.timeout(
              settings.depth === "quick" && !source.full ? 25000 : 45000,
            ),
          ]);
          await abortable(work(deadline), deadline);
        })
        .catch((error: unknown) => {
          if (!current(source)) return;
          if (source.accessBlocked)
            needsAccess(
              source,
              "This site blocked access. Open it to finish sign-in or verification, then Retry.",
            );
          else
            failedSource(
              source,
              `This site could not be read: ${errorMessage(error)}`,
            );
          source.collected = true;
          source.processed = source.row.cards;
          markDone(source);
        });
    };
    const pipeline = createSearchPipeline({
      deps,
      context,
      settings,
      signal,
      fits,
      sources: states,
      searchId: run.record!.id,
      write,
      settled: markDone,
      count: (increments) => update(run, increments),
      needsAccess,
      failed: failedSource,
      browser: browserTask,
    });
    const collect = async (
      source: SourceWork,
      lane: "http" | "browser",
      parentSignal: AbortSignal,
    ) => {
      const controller = new AbortController();
      const readSignal = AbortSignal.any([parentSignal, controller.signal]);
      const stopCollection = () =>
        controller.abort(new Error(source.quickStopReason));
      const recordAccess = (count: number) => {
        if (
          !count ||
          !current(source) ||
          source.row.state === "needs_you" ||
          source.row.state === "failed"
        )
          return;
        const signedIn =
          access.pending(Number(source.target.id)) ||
          siteRows.get(Number(source.target.id))?.signInState === "signed_in";
        source.completeAccess ??= () => {
          access.complete(Number(source.target.id));
        };
        siteRows.record(
          Number(source.target.id),
          {
            lastSearchedAt: new Date().toISOString(),
            health: "healthy",
            lane,
            signInState:
              lane === "browser" && signedIn ? "signed_in" : "not_required",
          },
          false,
        );
        siteDirty = true;
      };
      // HTTP collection has no model of its own. Stop paging, while accepted
      // cards finish their already-running screening/reading/fit on run.signal.
      const timer =
        settings.depth === "quick" && !source.full && lane === "http"
          ? setTimeout(() => {
              source.quickStopReason ??=
                "Quick's three-minute look at this site ran out.";
              stopCollection();
            }, 180000)
          : null;
      try {
        const inventory = await abortable(
          deps.engine.collectSource({
            target: source.target,
            lane,
            context,
            settings,
            signal: readSignal,
            knownUrls: (urls) => deps.store.findKnownUrls(urls),
            onCards: async (cards) => {
              await pipeline.accept(source, cards);
              recordAccess(cards.length);
              if (source.quickStopReason) stopCollection();
              readSignal.throwIfAborted();
            },
            message: (message) => {
              if (current(source)) {
                source.row.message = message;
                write(source);
              }
            },
          }),
          readSignal,
        );
        readSignal.throwIfAborted();
        await pipeline.accept(source, inventory.cards);
        recordAccess(inventory.cards.length);
        if (source.quickStopReason) stopCollection();
        readSignal.throwIfAborted();
        source.accessBlocked = inventory.complete
          ? false
          : source.accessBlocked || Boolean(inventory.accessBlocked);
        source.notes = inventory.notes;
        source.row.lane = inventory.lane ?? lane;
        if (lane === "http" && inventory.requiresBrowser) {
          browserTask(source, async (browserSignal) => {
            await collect(source, "browser", browserSignal);
          });
          return;
        }
        source.collected = true;
        if (inventory.needsYou)
          needsAccess(
            source,
            "Open this site and finish sign-in or verification, then Retry.",
          );
        else if (!inventory.complete)
          failedSource(
            source,
            inventory.cards.length
              ? "Some listings could not be read completely."
              : "No listings found; this site could not be read completely.",
          );
        else if (
          source.row.state !== "needs_you" &&
          source.row.state !== "failed"
        ) {
          source.completeAccess = () => {
            const signedIn =
              access.pending(Number(source.target.id)) ||
              siteRows.get(Number(source.target.id))?.signInState ===
                "signed_in";
            access.complete(Number(source.target.id));
            siteRows.record(
              Number(source.target.id),
              {
                lastSearchedAt: new Date().toISOString(),
                health: "healthy",
                lane: inventory.lane ?? lane,
                signInState:
                  lane === "browser" && signedIn ? "signed_in" : "not_required",
                ...(inventory.provider ? { provider: inventory.provider } : {}),
              },
              false,
            );
            siteDirty = true;
          };
        }
        write(source);
        markDone(source);
      } catch (error) {
        if (!current(source) || !source.quickStopReason) throw error;
        source.collected = true;
        source.notes.push(source.quickStopReason);
        // A deliberate Quick stop on a healthy site: more to read, not a failure.
        if (source.row.state !== "needs_you" && source.row.state !== "failed")
          source.row.state = "partial";
        write(source);
        markDone(source);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const enqueue = (
      target: JobDiscoveryTarget,
      force: boolean,
      full = false,
    ) => {
      if (signal.aborted) return;
      const before = states.get(target.id);
      if (before && !before.counted) return;
      if (before?.counted) update(run, { sourcesDone: -1 });
      else if (run.enqueue) update(run, { sourcesTotal: 1 });
      const source = sourceWork(target, full);
      states.set(target.id, source);
      write(source);
      if (!force && access.pending(Number(target.id))) {
        source.collected = true;
        source.row.state = "needs_you";
        source.notes = [
          "Waiting for sign-in. Open this source in Needs you, then Retry.",
        ];
        markDone(source);
        return;
      }
      void http
        .run(new URL(target.startingUrl).hostname, signal, async () => {
          if (!current(source)) return;
          source.row.state = "searching";
          source.row.phase = "http";
          source.row.lane = "http";
          write(source);
          const deadline = signal;
          try {
            await collect(source, "http", deadline);
          } catch (error) {
            if (!current(source)) return;
            source.notes = [
              `HTTP reading did not finish: ${errorMessage(error)}`,
            ];
            browserTask(source, async (browserSignal) => {
              await collect(source, "browser", browserSignal);
            });
          }
        })
        .catch((error: unknown) => {
          if (current(source)) {
            source.collected = true;
            source.processed = source.row.cards;
            source.row.state = "failed";
            source.row.message = errorMessage(error);
            markDone(source);
          }
        });
    };
    try {
      // One transaction for the initial rows; no 900-site status array crosses IPC.
      deps.store.transaction(() => {
        for (const target of targets)
          enqueue(
            target,
            forced.ids.has(target.id),
            forced.full && forced.ids.has(target.id),
          );
        flush();
      });
      run.enqueue = enqueue;
      run.setReady(fits);
      fits.enqueue([
        ...visibleIds,
        ...deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER),
      ]);
      fits.prioritize(visibleIds);
      for (;;) {
        await abortable(Promise.all([http.idle(), browser.idle()]), signal);
        await pipeline.drain();
        if (http.active || browser.active) continue;
        await abortable(Promise.all([http.idle(), browser.idle()]), signal);
        await pipeline.drain();
        await fits.drain();
        if (!http.active && !browser.active) break;
      }
      signal.throwIfAborted();
      flush();
      const progress = resultRows.compact(run.record!.id).progress;
      const failed = progress?.failed ?? 0,
        needsYou = progress?.needsYou ?? 0;
      const unreadable = failed + needsYou;
      const nothingReadable =
        run.record!.sourcesTotal > 0 &&
        unreadable === run.record!.sourcesTotal &&
        run.record!.found === 0;
      const blockedSummary = needsYou
        ? `${needsYou} site${needsYou === 1 ? " needs" : "s need"} sign-in in Needs you. `
        : "";
      const recovery = failed
        ? "Check each site's results, fix the URL or try the board's main jobs URL, then search again."
        : "Open Needs you to sign in, then retry.";
      finish(
        run,
        nothingReadable ? "failed" : "done",
        nothingReadable
          ? `${unreadable} site${unreadable === 1 ? "" : "s"} could not be read. ${blockedSummary}${recovery}`
          : fitError,
      );
      if (fits.needsAnotherPass) scheduleFit(5000);
    } catch (error) {
      flush();
      finish(
        run,
        signal.aborted ? "stopped" : "failed",
        signal.aborted ? null : errorMessage(error),
      );
      run.setReady(null);
    }
  };

  /**
   * `forced` sites run alone, ahead of any pending sign-in; `full` reads them
   * whole. The record keeps `input` as the choices for the next search.
   */
  const begin = (
    input: JobSearchSettingsInput,
    forced?: { targets: JobDiscoveryTarget[]; full?: boolean },
  ): Promise<JobSearchRecord> => {
    if (active)
      return active.record
        ? Promise.resolve(structuredClone(active.record))
        : active.starting!;
    const settings = JobSearchSettingsSchema.parse(input);
    recovery?.controller.abort();
    let setReady!: (fits: FitQueue | null) => void;
    const ready = new Promise<FitQueue | null>((resolve) => {
      setReady = resolve;
    });
    const run: ActiveSearch = {
      controller: new AbortController(),
      record: null,
      fits: null,
      starting: null,
      ready,
      setReady,
    };
    active = run;
    run.starting = Promise.resolve()
      .then(async () => {
        const context = await abortable(
          deps.readContext(),
          run.controller.signal,
        );
        context.remoteCountsAsAnyLocation =
          deps.readRemoteCountsAsAnyLocation?.() ??
          context.remoteCountsAsAnyLocation ??
          true;
        // A search's note shapes the fit of the jobs it finds; it is not a
        // reason to judge every saved job again.
        deps.store.syncFitContext(fitContextFingerprint(context));
        deps.store.restoreAgeHidden(
          settings.postedWithin === "any"
            ? null
            : Date.now() -
                (settings.postedWithin === "week" ? 7 : 30) * 86_400_000,
        );
        const selected = new Set(
          ("all" in settings.sites
            ? settings.sites.except
            : settings.sites.ids
          ).map(String),
        );
        const targets = forced
          ? forced.targets.map((target) => ({ ...target, enabled: true }))
          : [
              ...new Map(
                context.sources
                  .filter(
                    (target) =>
                      isRunnableJobDiscoveryTarget(target) &&
                      ("all" in settings.sites
                        ? !selected.has(target.id)
                        : selected.has(target.id)),
                  )
                  .map((target) => [target.id, target]),
              ).values(),
            ];
        run.record = deps.store.searches.start(settings, targets.length);
        search = run.record;
        revision++;
        const started = structuredClone(run.record);
        void yieldTurn()
          .then(() =>
            execute(run, context, targets, {
              ids: new Set(forced?.targets.map((target) => target.id)),
              full: forced?.full ?? false,
            }),
          )
          .catch((error: unknown) => {
            finish(
              run,
              run.controller.signal.aborted ? "stopped" : "failed",
              errorMessage(error),
            );
            run.setReady(null);
          });
        notify();
        return started;
      })
      .catch((error: unknown) => {
        run.setReady(null);
        if (active === run) active = null;
        throw error;
      });
    return run.starting;
  };

  const runner: JobSearchRunner = {
    start: (input) => {
      deps.onExplicitStart?.();
      return begin(input);
    },
    async retrySource(id) {
      deps.onExplicitStart?.();
      const site = siteRows.get(id);
      if (!site) throw new Error("This source is no longer in your list.");
      const target = { ...jobSiteTarget(site), enabled: true };
      const run = active;
      if (run) {
        await run.starting;
        await run.ready;
        if (!run.controller.signal.aborted && run.enqueue && run.record) {
          run.enqueue(target, true);
          return structuredClone(run.record);
        }
      }
      return begin(
        { ...(search?.settings ?? {}), sites: { ids: [id] } },
        { targets: [target] },
      );
    },
    async keepReading(id) {
      deps.onExplicitStart?.();
      const ids =
        id !== undefined
          ? [String(id)]
          : search
            ? resultRows.partialIds(search.id)
            : [];
      const targets = ids.flatMap((sourceId) => {
        const site = siteRows.get(Number(sourceId));
        return site ? [{ ...jobSiteTarget(site), enabled: true }] : [];
      });
      if (targets.length === 0)
        throw new Error("No site from the last search has more to read.");
      const run = active;
      if (run) {
        await run.starting;
        await run.ready;
        if (!run.controller.signal.aborted && run.enqueue && run.record) {
          for (const target of targets) run.enqueue(target, true, true);
          return structuredClone(run.record);
        }
      }
      // A new run over just these sites, keeping the person's choices for
      // their next search as they were.
      return begin(search?.settings ?? {}, { targets, full: true });
    },
    stop() {
      if (continuation) clearTimeout(continuation);
      continuation = null;
      recovery?.controller.abort();
      if (!active) return;
      const run = active;
      run.controller.abort();
      run.setReady(null);
      finish(run, "stopped");
    },
    status,
    onStatus(listener) {
      listeners.add(listener);
      notify();
      return () => {
        listeners.delete(listener);
      };
    },
    prioritizeFit(ids) {
      visibleIds = ids;
      active?.fits?.prioritize(ids);
      recoveryQueue?.prioritize(ids);
    },
    scoreUnscored() {
      if (recovery) return recovery.result;
      const controller = new AbortController();
      const result = Promise.resolve()
        .then(async () => {
          const run = active;
          if (run && !run.record) await run.starting;
          const liveFits = run
            ? await abortable(run.ready, controller.signal)
            : null;
          // Use the live queue, so recovery and discovery cannot score a job twice.
          if (run && !run.controller.signal.aborted && liveFits) {
            const current = await abortable(
              deps.readContext(),
              controller.signal,
            );
            current.remoteCountsAsAnyLocation =
              deps.readRemoteCountsAsAnyLocation?.() ??
              current.remoteCountsAsAnyLocation ??
              true;
            deps.store.syncFitContext(fitContextFingerprint(current));
            const before = liveFits.scored;
            liveFits.enqueue([
              ...visibleIds,
              ...deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER),
            ]);
            await liveFits.drain();
            if (liveFits.needsAnotherPass) scheduleFit(5000);
            return liveFits.scored - before;
          }
          controller.signal.throwIfAborted();
          const context = await abortable(
            deps.readContext(),
            controller.signal,
          );
          context.remoteCountsAsAnyLocation =
            deps.readRemoteCountsAsAnyLocation?.() ??
            context.remoteCountsAsAnyLocation ??
            true;
          deps.store.syncFitContext(fitContextFingerprint(context));
          const fits = createFitQueue(
            deps,
            context,
            controller.signal,
            concurrency(deps.concurrency?.fit ?? deps.fitRequests?.(), 6),
            () => notify(),
            () => {},
            // The last search's note was for that search only.
            search ? { ...search.settings, note: "" } : undefined,
            () => notify(),
          );
          recoveryQueue = fits;
          fits.enqueue([
            ...visibleIds,
            ...deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER),
          ]);
          fits.prioritize(visibleIds);
          await fits.drain();
          if (fits.needsAnotherPass && !controller.signal.aborted)
            scheduleFit(5000);
          return fits.scored;
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return 0;
          throw error;
        })
        .finally(() => {
          recoveryQueue = null;
          if (recovery?.controller === controller) recovery = null;
          notify();
        });
      recovery = { controller, result };
      return result;
    },
  };
  return runner;
}
