import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  isRunnableJobDiscoveryTarget,
  JobSearchSettingsSchema,
  type FoundJob,
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
      concurrency(deps.concurrency?.fit, 2),
      (scored) => update(run, { scored }),
      (error) => {
        fitError = errorMessage(error);
      },
    );
    run.fits = fits;
    run.setReady(fits);
    const states = new Map(sources.map((source) => [source.sourceId, source]));
    const feeds: JobDiscoveryTarget[] = [];
    const browsers: JobDiscoveryTarget[] = [];
    try {
      for (const target of targets) {
        signal.throwIfAborted();
        try {
          (deps.engine.lane(target, context) === "feed"
            ? feeds
            : browsers
          ).push(target);
        } catch (error) {
          const source = states.get(target.id)!;
          source.state = "failed";
          source.message = errorMessage(error);
          update(run, { sourcesDone: 1 });
        }
      }
      const work = async (target: JobDiscoveryTarget) => {
        const source = states.get(target.id)!;
        const seen = new Set<string>();
        source.state = "searching";
        notify();
        const save = (found: readonly FoundJob[]) => {
          if (signal.aborted) return;
          // A site's batches repeat what it already handed over.
          const jobs = found.filter((job) => {
            const key = job.sourceJobId || job.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (jobs.length === 0) return;
          const result = deps.store.saveFoundJobs({
            searchId: run.record!.id,
            jobs,
          });
          source.found += jobs.length;
          source.added += result.added.length;
          source.hidden += result.hidden.length;
          update(run, {
            found: jobs.length,
            added: result.added.length,
            merged: result.merged.length,
          });
          fits.enqueue(result.added);
        };
        try {
          const result = await deps.engine.searchSite({
            target,
            settings,
            context,
            signal,
            knownUrls: (urls) => deps.store.findKnownUrls(urls),
            found: save,
            message(message) {
              if (!signal.aborted) {
                source.message = message;
                notify();
              }
            },
          });
          source.state = result.needsYou ? "needs_you" : "done";
          source.message = result.message;
        } catch (error) {
          if (signal.aborted) return;
          source.state = "failed";
          source.message = errorMessage(error);
        } finally {
          if (!signal.aborted) {
            update(run, { sourcesDone: 1 });
          }
        }
        await yieldTurn();
      };
      await Promise.all([
        inWorkers(feeds, concurrency(deps.concurrency?.feeds, 4), signal, work),
        inWorkers(
          browsers,
          concurrency(deps.concurrency?.browser, 2),
          signal,
          work,
        ),
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
          const selected =
            settings.sourceIds === "all" ? null : new Set(settings.sourceIds);
          const targets = [
            ...new Map(
              context.sources
                .filter(
                  (target) =>
                    isRunnableJobDiscoveryTarget(target) &&
                    (!selected || selected.has(target.id)),
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
            concurrency(deps.concurrency?.fit, 2),
            () => {},
            () => {},
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
