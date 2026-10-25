import { createJobSitesStore } from "@nestor/db/job-store";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  isRunnableJobDiscoveryTarget,
  JobSearchSettingsSchema,
  type JobDiscoveryTarget,
  type JobSearchRecord,
  type JobSearchSourceState,
  type JobSearchStatus,
} from "@nestor/contracts";
import { abortable, concurrency, errorMessage, inWorkers } from "./async";
import { createFitQueue } from "./fit-queue";
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
}

export function createJobSearchRunner(
  deps: JobSearchRunnerDeps,
): JobSearchRunner {
  const siteRows = createJobSitesStore(deps.store);
  let search = deps.store.searches.latest();
  let sources: JobSearchSourceState[] = [];
  let active: ActiveSearch | null = null;
  let recovery: {
    controller: AbortController;
    result: Promise<number>;
  } | null = null;
  const listeners = new Set<(status: JobSearchStatus) => void>();
  let notification: ReturnType<typeof setTimeout> | null = null;
  const status = (): JobSearchStatus => structuredClone({ search, sources });
  const notify = () => {
    if (notification || listeners.size === 0) return;
    notification = setTimeout(() => {
      notification = null;
      for (const listener of listeners) {
        try {
          listener(status());
        } catch {
          /* A UI observer cannot stop a search. */
        }
      }
    }, 250);
    notification.unref();
  };
  const update = (
    run: ActiveSearch,
    increments: Parameters<typeof deps.store.searches.count>[1],
  ) => {
    if (run.controller.signal.aborted || !run.record) return;
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
    // Kept after the end, so the screen can say what each site found.
    for (const source of sources)
      if (source.state === "searching" || source.state === "waiting")
        source.state = state === "done" ? "done" : "stopped";
    if (active === run) active = null;
    notify();
  };

  const execute = async (
    run: ActiveSearch,
    context: JobSearchContext,
    targets: JobDiscoveryTarget[],
  ) => {
    const signal = run.controller.signal;
    const settings = run.record!.settings;
    let fitError: string | null = null;
    const fits = createFitQueue(
      deps,
      context,
      signal,
      concurrency(deps.concurrency?.fit, 6),
      (scored) => update(run, { scored }),
      (error) => {
        fitError = errorMessage(error);
      },
      settings,
    );
    run.fits = fits;
    run.setReady(fits);
    const states = new Map(sources.map((source) => [source.sourceId, source]));
    const inventories = new Map<
      string,
      Awaited<ReturnType<typeof deps.engine.collectSource>>
    >();
    try {
      await inWorkers(
        targets,
        concurrency(deps.concurrency?.sources, 4),
        signal,
        async (target) => {
          const source = states.get(target.id)!;
          source.state = "searching";
          source.message = "Collecting listings";
          notify();
          try {
            const inventory = await abortable(
              deps.engine.collectSource({
                target,
                context,
                settings,
                signal,
                knownUrls: (urls) => deps.store.findKnownUrls(urls),
                message: (text) => {
                  if (!signal.aborted) {
                    source.message = text;
                    notify();
                  }
                },
              }),
              signal,
            );
            inventories.set(target.id, inventory);
            siteRows.record(Number(target.id), {
              lastSearchedAt: new Date().toISOString(),
              health: inventory.needsYou
                ? "needs_sign_in"
                : inventory.complete
                  ? "healthy"
                  : "failed",
              signInState: inventory.needsYou
                ? "required"
                : inventory.complete
                  ? "not_required"
                  : "unknown",
              ...(inventory.lane ? { lane: inventory.lane } : {}),
              ...(inventory.provider ? { provider: inventory.provider } : {}),
            });
            source.message = `${inventory.cards.length} listings collected. Checking roles.`;
            if (inventory.needsYou) source.state = "needs_you";
          } catch (error) {
            if (signal.aborted) return;
            source.state = "failed";
            source.message = errorMessage(error);
            siteRows.record(Number(target.id), {
              lastSearchedAt: new Date().toISOString(),
              health: "failed",
            });
          }
          notify();
        },
      );
      signal.throwIfAborted();
      const cards = targets.flatMap(
        (target) => inventories.get(target.id)?.cards ?? [],
      );
      const screened = await abortable(
        deps.engine.screenCards({
          cards,
          context,
          settings,
          signal,
          knownUrls: (urls) => deps.store.findKnownUrls(urls),
          seenCards: (cards, key) => deps.store.lookupSeenCards(cards, key),
        }),
        signal,
      );
      signal.throwIfAborted();
      deps.store.rememberSeenCards(screened.seen);
      for (const source of sources) {
        if (source.state === "failed" || source.state === "needs_you") continue;
        const count = screened.related.filter(
          (card) => card.sourceId === source.sourceId,
        ).length;
        source.message = count
          ? `Reading ${count} related listings in full`
          : "No new related listings";
      }
      notify();
      const full = await abortable(
        deps.engine.readListings({ cards: screened.related, signal }),
        signal,
      );
      signal.throwIfAborted();
      const days =
        settings.postedWithin === "week"
          ? 7
          : settings.postedWithin === "month"
            ? 30
            : null;
      const cutoff = days === null ? null : Date.now() - days * 86_400_000;
      const jobs = full.jobs.map((job) =>
        cutoff !== null && job.postedAt && Date.parse(job.postedAt) < cutoff
          ? {
              ...job,
              hiddenReason: `Posted more than ${days} days ago; this search kept newer listings. You can show it again.`,
            }
          : job,
      );
      // Merge every sighting before a fit request can start.
      const saved = deps.store.saveFoundJobs({
        searchId: run.record!.id,
        jobs,
      });
      update(run, {
        found: jobs.length,
        added: saved.added.length,
        merged: saved.merged.length,
      });
      const newIds = [...saved.added, ...saved.hidden];
      const newJobs = newIds.map((id) => deps.store.getJob(id)!);
      const sourceOfUrl = new Map(jobs.map((job) => [job.url, job.sourceId]));
      const visible = new Set(saved.added);
      const hidden = new Set(saved.hidden);
      for (const source of sources) {
        const inventory = inventories.get(source.sourceId);
        if (inventory) {
          const related = screened.related.filter(
            (card) => card.sourceId === source.sourceId,
          );
          const urls = new Set(related.map((card) => card.url));
          const rejected = screened.seen.filter((card) =>
            inventory.cards.some((item) => item.url === card.url),
          ).length;
          const failed = full.failures.filter((failure) =>
            urls.has(failure.url),
          ).length;
          if (
            full.failures.some(
              (failure) => urls.has(failure.url) && failure.needsYou,
            )
          )
            source.state = "needs_you";
          source.found = jobs.filter(
            (job) => job.sourceId === source.sourceId,
          ).length;
          source.added = newJobs.filter(
            (job) =>
              visible.has(job.id) &&
              sourceOfUrl.get(job.url) === source.sourceId,
          ).length;
          source.hidden = newJobs.filter(
            (job) =>
              hidden.has(job.id) &&
              sourceOfUrl.get(job.url) === source.sourceId,
          ).length;
          source.message = [
            `${inventory.cards.length} listings; ${related.length} new related; ${rejected} unrelated; ${inventory.cards.length - related.length - rejected} already seen.`,
            failed
              ? `${failed} listing reads failed and can be retried.`
              : null,
            source.hidden
              ? `${source.hidden} saved hidden by your posting-age choice.`
              : null,
            ...inventory.notes,
          ]
            .filter(Boolean)
            .join(" ");
          if (source.state === "searching") source.state = "done";
        }
        update(run, { sourcesDone: 1 });
      }
      fits.enqueue([
        ...newIds,
        ...deps.store.unscoredJobIds(Number.MAX_SAFE_INTEGER),
      ]);
      await fits.drain();
      finish(run, signal.aborted ? "stopped" : "done", fitError);
    } catch (error) {
      finish(
        run,
        signal.aborted ? "stopped" : "failed",
        signal.aborted ? null : errorMessage(error),
      );
      run.controller.abort();
    }
  };

  const runner: JobSearchRunner = {
    start(input) {
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
          const targets = [
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
          sources = targets.map((target) => ({
            sourceId: target.id,
            label: target.label,
            state: "waiting",
            found: 0,
            added: 0,
            hidden: 0,
            message: null,
          }));
          notify();
          const started = structuredClone(run.record);
          // Let the caller receive the record before any source can finish.
          void yieldTurn()
            .then(() => execute(run, context, targets))
            .catch((error: unknown) => {
              finish(
                run,
                run.controller.signal.aborted ? "stopped" : "failed",
                errorMessage(error),
              );
              run.setReady(null);
            });
          return started;
        })
        .catch((error: unknown) => {
          run.setReady(null);
          if (active === run) active = null;
          throw error;
        });
      return run.starting;
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
        if (listeners.size === 0 && notification) {
          clearTimeout(notification);
          notification = null;
        }
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
