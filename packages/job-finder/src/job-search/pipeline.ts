import type {
  FoundJob,
  ListingCard,
  ReadListingResult,
} from "@nestor/contracts";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";
import type { SourceWork } from "./source-work";
import type { createFitQueue } from "./fit-queue";
import { createCardWaves } from "./card-waves";

/** Screening stays serialized so waves share one cached profession decision. Fit runs alongside it. */
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
  count(increments: { found?: number; added?: number; merged?: number }): void;
  needsAccess(source: SourceWork, reason: string): void;
  browser(
    source: SourceWork,
    work: (signal: AbortSignal) => Promise<void>,
  ): void;
}) {
  const { deps, signal, context, settings, sources } = input;
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
            hiddenReason: `Posted more than ${settings.postedWithin === "week" ? 7 : 30} days ago; this search kept newer listings. You can show it again.`,
          }
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
    for (const id of saved.added.concat(saved.hidden)) {
      const job = deps.store.getJob(id)!;
      const sighting = job.sightings[0];
      const source = sighting ? sources.get(sighting.sourceId) : undefined;
      if (source) {
        if (saved.hidden.includes(id)) source.row.hidden++;
        else source.row.added++;
      }
    }
    // Every sighting above is merged before a fit request gets its job id.
    input.fits.enqueue(
      [...saved.added, ...saved.hidden, ...saved.merged].filter(
        (id) => !deps.store.getJob(id)?.stageNote?.startsWith("Closed:"),
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
  const waves = createCardWaves(signal, async (cards) => {
    const touched = new Set(cards.map((card) => card.sourceId));
    for (const id of touched) {
      const source = sources.get(id)!;
      if (source.row.state !== "needs_you") {
        source.row.state = "searching";
        source.row.phase = "screening";
      }
      input.write(source);
    }
    const screened = await deps.engine.screenCards({
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
    for (const card of cards) {
      const source = sources.get(card.sourceId)!;
      if (related.has(`${card.sourceId}\n${card.url}`)) source.row.related++;
      else {
        source.processed++;
        if (rejected.has(card.url)) source.row.unrelated++;
        else source.row.seen++;
      }
    }
    for (const id of touched) {
      const source = sources.get(id)!;
      if (source.row.state !== "needs_you") source.row.phase = "reading";
      input.write(source);
      input.settled(source);
    }
    const result = await deps.engine.readListings({
      cards: screened.related,
      signal,
      lane: "http",
    });
    signal.throwIfAborted();
    const deferredUrls = new Set(
      result.failures
        .filter((failure) => failure.requiresBrowser)
        .map((failure) => failure.url),
    );
    const fastCards = screened.related.filter(
      (card) => !deferredUrls.has(card.url),
    );
    finishRead(fastCards, {
      jobs: result.jobs,
      failures: result.failures.filter(
        (failure) => !deferredUrls.has(failure.url),
      ),
    });
    const deferred = new Map<string, ListingCard[]>();
    for (const card of screened.related)
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
            signal: browserSignal,
            lane: "browser",
          });
        } catch (error) {
          signal.throwIfAborted();
          result = {
            jobs: [],
            failures: group.map((card) => ({
              url: card.url,
              reason: error instanceof Error ? error.message : String(error),
              needsYou: true,
            })),
          };
        }
        signal.throwIfAborted();
        browserSignal.throwIfAborted();
        finishRead(group, result);
      });
    }
    for (const id of touched) input.settled(sources.get(id)!);
  });
  return {
    async accept(source: SourceWork, cards: readonly ListingCard[]) {
      const closed = cards
        .filter((card) => card.closed)
        .map((card) => card.url);
      if (closed.length) deps.store.closeFoundUrls(closed);
      const fresh = cards.filter((card) => {
        if (source.urls.has(card.url)) return false;
        source.urls.add(card.url);
        return true;
      });
      source.row.cards += fresh.length;
      input.write(source);
      await waves.push(fresh);
    },
    drain: () => waves.drain(),
  };
}
