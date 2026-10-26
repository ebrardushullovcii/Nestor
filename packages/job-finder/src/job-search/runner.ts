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
import { createSearchPipeline } from "./pipeline";
import { sourceWork, type SourceWork } from "./source-work";
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
  enqueue?: (target: JobDiscoveryTarget, force: boolean) => void;
}

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
  const listeners = new Set<(status: JobSearchStatus) => void>();
  let notification: ReturnType<typeof setTimeout> | null = null;
  const status = (): JobSearchStatus => {
    const compact = search
      ? resultRows.compact(search.id)
      : { sources: [], progress: null };
    return {
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
  };

  const execute = async (
    run: ActiveSearch,
    context: JobSearchContext,
    targets: JobDiscoveryTarget[],
    forced?: string,
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
      limit: concurrency(deps.concurrency?.browser, 2),
      perHost: 1,
    });
    let fitError: string | null = null;
    const fits = createFitQueue(
      deps,
      context,
      signal,
      concurrency(deps.concurrency?.fit, 6),
      (n) => update(run, { scored: n }),
      (error) => {
        fitError = errorMessage(error);
      },
      settings,
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
    const write = (source: SourceWork) => {
      if (!current(source)) return;
      resultRows.put(run.record!.id, source.row);
      revision++;
      notify();
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
      if (source.row.state !== "needs_you" && source.row.state !== "failed")
        source.row.state = "done";
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
      if (source.row.state !== "failed" && source.row.state !== "needs_you") {
        source.row.phase = "browser";
        source.row.state = "waiting";
      }
      write(source);
      void browser
        .run(new URL(source.target.startingUrl).hostname, signal, async () => {
          if (!current(source)) return;
          if (
            source.row.state !== "failed" &&
            source.row.state !== "needs_you"
          ) {
            source.row.state = "searching";
            source.row.phase = "browser";
          }
          write(source);
          const deadline = AbortSignal.any([
            signal,
            AbortSignal.timeout(settings.depth === "quick" ? 25000 : 45000),
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
      readSignal: AbortSignal,
    ) => {
      const inventory = await abortable(
        deps.engine.collectSource({
          target: source.target,
          lane,
          context,
          settings,
          signal: readSignal,
          knownUrls: (urls) => deps.store.findKnownUrls(urls),
          onCards: (cards) => pipeline.accept(source, cards),
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
        const signedIn =
          access.pending(Number(source.target.id)) ||
          siteRows.get(Number(source.target.id))?.signInState === "signed_in";
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
      }
      write(source);
      markDone(source);
    };
    const enqueue = (target: JobDiscoveryTarget, force: boolean) => {
      if (signal.aborted) return;
      const before = states.get(target.id);
      if (before && !before.counted) return;
      if (before?.counted) update(run, { sourcesDone: -1 });
      else if (run.enqueue) update(run, { sourcesTotal: 1 });
      const source = sourceWork(target);
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
        for (const target of targets) enqueue(target, target.id === forced);
      });
      run.enqueue = enqueue;
      run.setReady(fits);
      fits.enqueue(deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER));
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
    } catch (error) {
      finish(
        run,
        signal.aborted ? "stopped" : "failed",
        signal.aborted ? null : errorMessage(error),
      );
      run.setReady(null);
    }
  };

  const begin = (
    input: JobSearchSettingsInput,
    forcedTarget?: JobDiscoveryTarget,
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
        const selected = new Set(
          ("all" in settings.sites
            ? settings.sites.except
            : settings.sites.ids
          ).map(String),
        );
        const targets = forcedTarget
          ? [{ ...forcedTarget, enabled: true }]
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
          .then(() => execute(run, context, targets, forcedTarget?.id))
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
    start: (input) => begin(input),
    async retrySource(id) {
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
        target,
      );
    },
    stop() {
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
            const before = liveFits.scored;
            liveFits.enqueue(
              deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER),
            );
            await liveFits.drain();
            return liveFits.scored - before;
          }
          controller.signal.throwIfAborted();
          const context = await abortable(
            deps.readContext(),
            controller.signal,
          );
          const fits = createFitQueue(
            deps,
            context,
            controller.signal,
            concurrency(deps.concurrency?.fit, 6),
            () => {},
            () => {},
            search?.settings,
          );
          fits.enqueue(deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER));
          await fits.drain();
          return fits.scored;
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return 0;
          throw error;
        })
        .finally(() => {
          if (recovery?.controller === controller) recovery = null;
        });
      recovery = { controller, result };
      return result;
    },
  };
  return runner;
}
