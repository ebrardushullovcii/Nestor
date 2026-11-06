import type {
  FoundJob,
  ListingCard,
  ReadListingResult,
} from "@nestor/contracts";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";
import { settledState, type SourceWork } from "./source-work";
import type { createFitQueue } from "./fit-queue";
import { createCardWaves } from "./card-waves";
import { concurrency } from "./async";
import { reportSelfLimitHit } from "@nestor/core";

/**
 * Quick reads a site while it keeps finding related jobs, and stops early
 * after this many unrelated listings in a row. There is no listing cap: a
 * board that keeps paying off is read on (until Quick's time runs out).
 */
const QUICK_REVIEW_INTERVAL = 100;

/** Each source keeps ordered waves while other sources and fit advance independently. */
export function createSearchPipeline(input: {
  deps: JobSearchRunnerDeps;
  context: JobSearchContext;
  searchId: string;
  settings: Parameters<
    JobSearchRunnerDeps["engine"]["screenCards"]
  >[0]["settings"];
  signal: AbortSignal;
  fits: ReturnType<typeof createFitQueue>;
  sources: Map<string, SourceWork>;
  write(source: SourceWork): void;
  settled(source: SourceWork): void;
  count(increments: {
    found?: number;
    added?: number;
    merged?: number;
    alreadySaved?: number;
  }): void;
  needsAccess(source: SourceWork, reason: string): void;
  failed(source: SourceWork, reason: string): void;
  browser(
    source: SourceWork,
    work: (signal: AbortSignal) => Promise<void>,
  ): void;
}) {
  const { deps, signal, context, settings, sources } = input;
  const previouslySaved = new Set<number>();
  const countPreviouslySaved = (ids: readonly number[]) => {
    const before = previouslySaved.size;
    for (const id of ids) previouslySaved.add(id);
    if (previouslySaved.size > before)
      input.count({ alreadySaved: previouslySaved.size - before });
  };
  const cutoff =
    settings.postedWithin === "any"
      ? null
      : Date.now() - (settings.postedWithin === "week" ? 7 : 30) * 86_400_000;
  const save = (jobs: FoundJob[]) => {
    signal.throwIfAborted();
    const kept = jobs.map((job) =>
      !job.hiddenReason &&
      cutoff !== null &&
      job.postedAt &&
      Date.parse(job.postedAt) < cutoff
        ? {
            ...job,
            hideOwner: "age_retention" as const,
            hiddenReason: `Posted more than ${settings.postedWithin === "week" ? 7 : 30} days ago; this search kept newer listings. You can show it again.`,
          }
        : job.hiddenReason?.startsWith("Closed:")
          ? { ...job, hideOwner: "closed_listing" as const }
          : job,
    );
    const saved = deps.store.saveFoundJobs({
      searchId: input.searchId,
      jobs: kept,
    });
    deps.store.closeFoundUrls(
      kept
        .filter((job) => job.hiddenReason?.startsWith("Closed:"))
        .map((job) => job.url),
    );
    input.count({
      found: jobs.length,
      added: saved.added.length,
      merged: saved.merged.length,
    });
    countPreviouslySaved(saved.alreadySaved ?? []);
    // Only where each job was seen and its stage note: reading whole
    // listings back here cost a 900-site search half a second of main.
    const savedIds = [...saved.added, ...saved.hidden, ...saved.merged];
    const origins = deps.store.jobOrigins(savedIds);
    for (const id of saved.added.concat(saved.hidden)) {
      const sourceId = origins.get(id)?.sourceId;
      const source = sourceId ? sources.get(sourceId) : undefined;
      if (source) {
        if (saved.hidden.includes(id)) source.row.hidden++;
        else source.row.added++;
      }
    }
    // Every sighting above is merged before a fit request gets its job id.
    input.fits.enqueue(
      savedIds.filter(
        (id) => !origins.get(id)?.stageNote?.startsWith("Closed:"),
      ),
    );
  };
  const finishRead = (
    cards: readonly ListingCard[],
    result: ReadListingResult,
  ) => {
    save(result.jobs);
    const bySource = new Map<string, ListingCard[]>();
    for (const card of cards) {
      const group = bySource.get(card.sourceId) ?? [];
      group.push(card);
      bySource.set(card.sourceId, group);
    }
    const jobs = new Map<string, number>();
    for (const job of result.jobs)
      jobs.set(job.sourceId, (jobs.get(job.sourceId) ?? 0) + 1);
    const failures = new Map(
      result.failures.map((failure) => [failure.url, failure]),
    );
    for (const [id, group] of bySource) {
      const source = sources.get(id)!;
      source.processed += group.length;
      source.row.found += jobs.get(id) ?? 0;
      for (const card of group) {
        const failure = failures.get(card.url);
        if (failure) {
          source.row.failedReads++;
          if (!failure.needsYou)
            input.failed(
              source,
              `Some listings could not be read: ${failure.reason}`,
            );
          if (failure.needsYou)
            input.needsAccess(
              source,
              "Open this site to finish sign-in or verification, then Retry.",
            );
        }
      }
      input.write(source);
      input.settled(source);
    }
  };
  const waves = createCardWaves(
    signal,
    async (cards) => {
      const touched = new Set(cards.map((card) => card.sourceId));
      for (const id of touched) {
        const source = sources.get(id)!;
        if (!settledState(source.row.state)) {
          source.row.state = "searching";
          source.row.phase = "screening";
        }
        input.write(source);
      }
      const emitted = new Set<string>();
      let reading = Promise.resolve();
      const readRelated = async (relatedCards: readonly ListingCard[]) => {
        const result = await deps.engine
          .readListings({
            cards: relatedCards,
            context,
            signal,
            lane: "http",
          })
          .catch((error: unknown): ReadListingResult => {
            signal.throwIfAborted();
            const reason =
              error instanceof Error ? error.message : String(error);
            return {
              jobs: [],
              failures: relatedCards.map((card) => ({
                url: card.url,
                reason,
              })),
            };
          });
        signal.throwIfAborted();
        const deferredUrls = new Set(
          result.failures
            .filter((failure) => failure.requiresBrowser)
            .map((failure) => failure.url),
        );
        const fastCards = relatedCards.filter(
          (card) => !deferredUrls.has(card.url),
        );
        finishRead(fastCards, {
          jobs: result.jobs,
          failures: result.failures.filter(
            (failure) => !deferredUrls.has(failure.url),
          ),
        });
        const deferred = new Map<string, ListingCard[]>();
        for (const card of relatedCards)
          if (deferredUrls.has(card.url)) {
            const group = deferred.get(card.sourceId) ?? [];
            group.push(card);
            deferred.set(card.sourceId, group);
          }
        for (const [id, group] of deferred) {
          const source = sources.get(id)!;
          input.browser(source, async (browserSignal) => {
            let result: ReadListingResult;
            try {
              result = await deps.engine.readListings({
                cards: group,
                context,
                signal: browserSignal,
                lane: "browser",
              });
            } catch (error) {
              signal.throwIfAborted();
              result = {
                jobs: [],
                failures: group.map((card) => ({
                  url: card.url,
                  reason:
                    error instanceof Error ? error.message : String(error),
                })),
              };
            }
            signal.throwIfAborted();
            browserSignal.throwIfAborted();
            finishRead(group, result);
          });
        }
      };
      // Keep each source's reads bounded and persist them before waiting for
      // unrelated cards. The final result may repeat these streamed matches.
      const readNewRelated = (
        relatedCards: readonly ListingCard[],
        account = true,
      ) => {
        const fresh = relatedCards.filter(
          (card) => !emitted.has(`${card.sourceId}\n${card.url}`),
        );
        for (const card of fresh) {
          emitted.add(`${card.sourceId}\n${card.url}`);
          if (account) {
            const source = sources.get(card.sourceId)!;
            source.screened++;
            source.row.related++;
            input.write(source);
          }
        }
        if (fresh.length) reading = reading.then(() => readRelated(fresh));
        return reading;
      };
      const screened = await deps.engine.screenCards({
        onRelated: readNewRelated,
        cards,
        context,
        settings,
        signal,
        knownUrls: (urls) => deps.store.findKnownUrls(urls),
        seenCards: (cards, key) => deps.store.lookupSeenCards(cards, key),
      });
      signal.throwIfAborted();
      deps.store.rememberSeenCards(screened.seen);
      const related = new Set(
        screened.related.map((card) => `${card.sourceId}\n${card.url}`),
      );
      const rejected = new Set(screened.seen.map((card) => card.url));
      const failed = new Map(
        screened.failed?.map((row) => [row.url, row.reason]),
      );
      const failedSources = new Map<string, string>();
      for (const card of cards) {
        const source = sources.get(card.sourceId)!;
        const streamed = emitted.has(`${card.sourceId}\n${card.url}`);
        if (!streamed) source.screened++;
        if (related.has(`${card.sourceId}\n${card.url}`)) {
          if (!streamed) source.row.related++;
          source.unrelatedRun = 0;
        } else {
          source.processed++;
          if (failed.has(card.url)) {
            source.row.failedReads++;
            failedSources.set(card.sourceId, failed.get(card.url)!);
          } else if (rejected.has(card.url)) source.row.unrelated++;
          else source.row.seen++;
          source.unrelatedRun =
            rejected.has(card.url) && !failed.has(card.url)
              ? source.unrelatedRun + 1
              : 0;
        }
      }
      for (const [id, reason] of failedSources)
        input.failed(
          sources.get(id)!,
          `Some listings could not be screened: ${reason}`,
        );
      for (const id of touched) {
        const source = sources.get(id)!;
        if (!source.counted && !settledState(source.row.state))
          source.row.phase = "reading";
        input.write(source);
        input.settled(source);
      }
      await readNewRelated(screened.related, false);
      for (const id of touched) input.settled(sources.get(id)!);
    },
    concurrency(deps.concurrency?.sources, 12),
  );
  return {
    async accept(source: SourceWork, cards: readonly ListingCard[]) {
      const quick = settings.depth === "quick" && !source.full;
      const chunk = quick ? QUICK_REVIEW_INTERVAL : 400;
      for (let offset = 0; offset < cards.length; offset += chunk) {
        if (source.quickStopReason) return;
        const fresh: ListingCard[] = [];
        for (const card of cards.slice(offset, offset + chunk)) {
          if (source.urls.has(card.url)) continue;
          source.urls.add(card.url);
          fresh.push(card);
        }
        countPreviouslySaved(
          deps.store.knownJobsBeforeSearch(
            fresh.map((card) => card.url),
            input.searchId,
          ),
        );
        const closed = fresh
          .filter((card) => card.closed)
          .map((card) => card.url);
        if (closed.length) deps.store.closeFoundUrls(closed);
        source.row.cards += fresh.length;
        input.write(source);
        await waves.push(fresh);
        if (
          quick &&
          source.row.cards - source.screened >= QUICK_REVIEW_INTERVAL
        )
          await waves.checkpoint(source.target.id);
        if (quick && source.unrelatedRun >= QUICK_REVIEW_INTERVAL) {
          reportSelfLimitHit({
            limit: "quick_unrelated_listings",
            kind: "jobs",
            value: QUICK_REVIEW_INTERVAL,
            where: "job-finder/searchPipeline/accept",
          });
          source.quickStopReason = `Quick stopped after ${QUICK_REVIEW_INTERVAL} listings in a row that don't match your profile.`;
        }
      }
    },
    drain: () => waves.drain(),
  };
}
