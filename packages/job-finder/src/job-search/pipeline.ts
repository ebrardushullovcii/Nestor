import type {
  FoundJob,
  ListingCard,
  ReadListingResult,
  SourceInventory,
} from "@nestor/contracts";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";
import { settledState, sourceSettings, type SourceWork } from "./source-work";
import type { createFitQueue } from "./fit-queue";
import { createCardWaves } from "./card-waves";
import { abortable, concurrency } from "./async";
import { createSearchSourcesStore } from "@nestor/db/job-store";
import { traceEvent } from "@nestor/core/run-trace";

/** Quick gathers smaller screening waves; acceptance never waits on screening. */
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
  browser(
    source: SourceWork,
    work: (signal: AbortSignal) => Promise<void>,
  ): void;
}) {
  const { deps, signal, context, settings, sources } = input;
  const durable = createSearchSourcesStore(deps.store);
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
    acknowledge = true,
  ) =>
    deps.store.transaction(() => {
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
      const closed = new Set(result.closed ?? []);
      if (closed.size) deps.store.closeFoundUrls([...closed]);
      if (acknowledge)
        durable.acknowledgeCards(
          input.searchId,
          cards
            .filter((card) => !failures.has(card.url))
            .map((card) => ({
              card,
              outcome: closed.has(card.url) ? "related_removed" : "related",
            })),
        );
      for (const [id, group] of bySource) {
        const source = sources.get(id)!;
        source.processed += group.length;
        source.row.found += jobs.get(id) ?? 0;
        for (const card of group) {
          if (closed.has(card.url)) source.removed++;
          const failure = failures.get(card.url);
          if (failure) {
            source.row.failedReads++;
            // A listing's failure says nothing about the rest of its source.
            source.readFailures.push(`${card.url}: ${failure.reason}`);
            if (failure.needsYou)
              input.needsAccess(
                source,
                `${source.target.label} (${card.url}): ${failure.reason}`,
              );
          }
        }
        input.write(source);
        durable.put(input.searchId, source.row);
        input.settled(source);
      }
    });
  /**
   * Related cards' detail reads, one ordered queue per source. Screening the
   * next wave needs only its cards, so no wave or screening batch waits for
   * these reads: they drain at the site's own pace while screening moves on.
   * The cards stay in the durable listing queue until their source settles,
   * which needs every read to finish, so a restart loses none of them.
   */
  const readQueues = new Map<string, Promise<void>>();
  const readsInFlight = new Set<Promise<void>>();
  let readError: Error | null = null;
  const queueReads = (
    cards: readonly ListingCard[],
    read: (cards: readonly ListingCard[]) => Promise<void>,
  ) => {
    if (readError) throw readError;
    const bySource = new Map<string, ListingCard[]>();
    for (const card of cards) {
      const group = bySource.get(card.sourceId) ?? [];
      group.push(card);
      bySource.set(card.sourceId, group);
    }
    for (const [id, group] of bySource) {
      const queued = (readQueues.get(id) ?? Promise.resolve())
        .then(() => {
          signal.throwIfAborted();
          if (readError) return;
          return read(group);
        })
        .catch((reason: unknown) => {
          if (signal.aborted) return;
          readError ??=
            reason instanceof Error ? reason : new Error(String(reason));
        });
      readQueues.set(id, queued);
      readsInFlight.add(queued);
      void queued.finally(() => {
        readsInFlight.delete(queued);
        if (readQueues.get(id) === queued) readQueues.delete(id);
      });
    }
  };
  const waves = createCardWaves(
    signal,
    async (incomingCards) => {
      const { cards, refreshUrls } =
        deps.store.prepareListingCards(incomingCards);
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
      const readRelated = async (relatedCards: readonly ListingCard[]) => {
        // Each finished group is kept as soon as it is read; a restart reads
        // only what had not finished.
        const handled = new Set<ListingCard>();
        let streamed = Promise.resolve();
        const keep = (
          cards: readonly ListingCard[],
          result: ReadListingResult,
        ) => {
          const own = relatedCards.filter(
            (card) =>
              !handled.has(card) &&
              cards.some(
                (read) =>
                  read.url === card.url && read.sourceId === card.sourceId,
              ),
          );
          for (const card of own) handled.add(card);
          streamed = streamed.then(() => readDone(own, result));
          return streamed;
        };
        let result: ReadListingResult;
        try {
          result = await deps.engine.readListings({
            cards: relatedCards,
            context,
            signal,
            lane: "http",
            onRead: keep,
          });
        } catch (error) {
          signal.throwIfAborted();
          const reason = error instanceof Error ? error.message : String(error);
          const rest = relatedCards.filter((card) => !handled.has(card));
          result = {
            jobs: [],
            failures: rest.map((card) => ({
              url: card.url,
              reason,
              requiresBrowser: true,
            })),
          };
          await keep(rest, result);
        }
        await streamed;
        // A reader that does not hand groups over returns them all at once.
        if (handled.size === 0) await keep(relatedCards, result);
      };
      const readDone = (
        relatedCards: readonly ListingCard[],
        result: ReadListingResult,
      ) => {
        signal.throwIfAborted();
        if (!relatedCards.length) return;
        const deferredUrls = new Set(
          result.failures
            .filter((failure) => failure.requiresBrowser)
            .map((failure) => failure.url),
        );
        const indexUrls = new Map(
          result.indexes?.map(({ requestedUrl, indexUrl }) => [
            requestedUrl,
            indexUrl,
          ]),
        );
        const fastCards = relatedCards.filter(
          (card) => !deferredUrls.has(card.url) && !indexUrls.has(card.url),
        );
        finishRead(fastCards, {
          jobs: result.jobs,
          failures: result.failures.filter(
            (failure) => !deferredUrls.has(failure.url),
          ),
          ...(result.closed ? { closed: result.closed } : {}),
        });
        // The reader found an index, not a vacancy: collect its postings
        // through the source's inventory path instead of a vacancy read.
        for (const card of relatedCards) {
          const indexUrl = indexUrls.get(card.url);
          if (indexUrl && !deferredUrls.has(card.url))
            queueIndex(card, indexUrl);
        }
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
            // Each listing is kept as soon as its browser read ends, so a
            // restart does not lose the reads a long group had finished.
            const handled = new Set<ListingCard>();
            const keep = (
              cards: readonly ListingCard[],
              result: ReadListingResult,
            ) => {
              signal.throwIfAborted();
              browserSignal.throwIfAborted();
              const own = group.filter(
                (card) =>
                  !handled.has(card) &&
                  cards.some(
                    (read) =>
                      read.url === card.url && read.sourceId === card.sourceId,
                  ),
              );
              for (const card of own) handled.add(card);
              const indexes = new Map(
                result.indexes?.map(({ requestedUrl, indexUrl }) => [
                  requestedUrl,
                  indexUrl,
                ]),
              );
              finishRead(
                own.filter((card) => !indexes.has(card.url)),
                result,
              );
              for (const card of own) {
                const indexUrl = indexes.get(card.url);
                if (indexUrl) queueIndex(card, indexUrl);
              }
            };
            let result: ReadListingResult;
            try {
              result = await deps.engine.readListings({
                cards: group,
                context,
                signal: browserSignal,
                lane: "browser",
                onRead: (cards, read) => {
                  keep(cards, read);
                  return Promise.resolve();
                },
              });
            } catch (error) {
              signal.throwIfAborted();
              const rest = group.filter((card) => !handled.has(card));
              result = {
                jobs: [],
                failures: rest.map((card) => ({
                  url: card.url,
                  reason:
                    error instanceof Error ? error.message : String(error),
                })),
              };
              keep(rest, result);
            }
            // A reader that does not hand listings over returns them all.
            if (handled.size === 0) keep(group, result);
          });
        }
      };
      // Hand each proven match to its source's read queue as soon as it is
      // decided; screening goes on without waiting for the read. The final
      // result may repeat these streamed matches.
      const readNewRelated = (
        relatedCards: readonly ListingCard[],
        account = true,
      ): Promise<void> => {
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
        if (fresh.length) queueReads(fresh, readRelated);
        return Promise.resolve();
      };
      const screened = await deps.engine.screenCards({
        onRelated: readNewRelated,
        cards,
        context,
        settings,
        signal,
        knownUrls: (urls) => deps.store.findKnownUrls(urls),
        refreshUrls,
        seenCards: (cards, key) => deps.store.lookupSeenCards(cards, key),
        // Kept as each batch decides, so a restart does not screen them again.
        onSeen: (seen) => deps.store.rememberSeenCards(seen),
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
      // The site answered these as removed: close any saved copy, read none.
      const gone = new Set(screened.gone ?? []);
      if (gone.size) deps.store.closeFoundUrls([...gone]);
      const failedSources = new Map<string, string>();
      for (const card of cards) {
        const source = sources.get(card.sourceId)!;
        const streamed = emitted.has(`${card.sourceId}\n${card.url}`);
        if (!streamed) source.screened++;
        if (related.has(`${card.sourceId}\n${card.url}`)) {
          if (!streamed) source.row.related++;
        } else {
          source.processed++;
          if (gone.has(card.url)) source.removed++;
          else if (failed.has(card.url)) {
            source.row.failedReads++;
            failedSources.set(card.sourceId, failed.get(card.url)!);
          } else if (rejected.has(card.url)) source.row.unrelated++;
          else source.row.seen++;
        }
      }
      deps.store.transaction(() => {
        durable.acknowledgeCards(
          input.searchId,
          cards
            .filter(
              (card) =>
                !related.has(`${card.sourceId}\n${card.url}`) &&
                !failed.has(card.url),
            )
            .map((card) => ({
              card,
              outcome: gone.has(card.url)
                ? "removed"
                : rejected.has(card.url)
                  ? "unrelated"
                  : "seen",
            })),
        );
      });
      for (const [id, reason] of failedSources)
        sources
          .get(id)!
          .readFailures.push(`Some listings could not be screened: ${reason}`);
      for (const id of touched) {
        const source = sources.get(id)!;
        if (!source.counted && !settledState(source.row.state))
          source.row.phase = "reading";
        input.write(source);
        input.settled(source);
      }
      await readNewRelated(screened.related, false);
    },
    concurrency(deps.concurrency?.sources, 12),
    durable.cardQueue(input.searchId),
  );
  const indexesInRun = new Map<
    string,
    { waiting: ListingCard[]; completed: boolean | null }
  >();
  const queueIndex = (card: ListingCard, url: string) => {
    const key = `${card.sourceId}\n${url}`;
    const existing = indexesInRun.get(key);
    if (existing) {
      if (existing.completed !== null)
        finishRead([card], { jobs: [], failures: [] }, existing.completed);
      else existing.waiting.push(card);
      return;
    }
    const index: { waiting: ListingCard[]; completed: boolean | null } = {
      waiting: [card],
      completed: null,
    };
    indexesInRun.set(key, index);
    const source = sources.get(card.sourceId)!;
    queueReads([card], () =>
      collectIndex(source, url, "http", signal, (completed) => {
        index.completed = completed;
        finishRead(
          index.waiting.splice(0),
          { jobs: [], failures: [] },
          completed,
        );
      }),
    );
  };
  /**
   * Collects the postings of an index a listing read found into its source,
   * by HTTP and then, when the index needs it, in the browser, where the
   * model can save postings from the page's data. The index counts as read
   * once its postings are accepted.
   */
  const collectIndex = async (
    source: SourceWork,
    url: string,
    lane: "http" | "browser",
    laneSignal: AbortSignal,
    complete: (completed: boolean) => void,
  ): Promise<void> => {
    let inventory: SourceInventory | null = null;
    let failure: string | null = null;
    try {
      inventory = await deps.engine.collectSource({
        target: { ...source.target, startingUrl: url },
        lane,
        context,
        settings: sourceSettings(settings, source),
        signal: laneSignal,
        indexPages: source.indexPages,
        skipReadIndexPages: true,
        ...(source.pageLog ? { pageLog: source.pageLog } : {}),
        ...(source.navigation ? { navigation: source.navigation } : {}),
        knownUrls: (urls) => deps.store.findKnownUrls(urls),
        collectedUrls: (urls) =>
          urls.filter((address) => source.urls.has(address)),
        onCards: (cards) => accept(source, cards),
        message: () => {},
      });
      await accept(source, inventory.cards);
    } catch (error) {
      signal.throwIfAborted();
      laneSignal.throwIfAborted();
      failure = error instanceof Error ? error.message : String(error);
    }
    if (lane === "http" && (failure !== null || inventory?.requiresBrowser)) {
      input.browser(source, (browserSignal) =>
        collectIndex(source, url, "browser", browserSignal, complete),
      );
      return;
    }
    if (inventory?.needsYou)
      input.needsAccess(
        source,
        `${source.target.label} (${url}): ${inventory.notes.join(" ")}`,
      );
    else if (failure !== null || !inventory?.complete) {
      const reason =
        `${url}: this index's listings were not all collected. ${failure ?? inventory?.notes.join(" ") ?? ""}`.trim();
      source.row.failedReads++;
      source.failure ??= reason;
      source.readFailures.push(reason);
    }
    complete(
      inventory?.complete === true && !inventory.needsYou && failure === null,
    );
  };
  const accept = async (source: SourceWork, cards: readonly ListingCard[]) => {
    const quick = sourceSettings(settings, source).depth === "quick";
    const chunk = quick ? QUICK_REVIEW_INTERVAL : 400;
    for (let offset = 0; offset < cards.length; offset += chunk) {
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
      // Acceptance is durable. Screening is queue work, never a browser
      // tool's silent connection, in either search depth.
    }
  };
  /** Cards an interrupted run queued, per source, until its fresh inventory. */
  const restored = new Map<string, string[]>();
  return {
    start: () => waves.push([]),
    restore(source: SourceWork) {
      const id = source.target.id;
      // What this search had finished on the site before a restart.
      source.pageLog = durable.pageLog(input.searchId, id);
      source.navigation = {
        read: (startUrl) => durable.navigation(input.searchId, id, startUrl),
        save: (startUrl, progress) =>
          durable.saveNavigation(input.searchId, id, startUrl, progress),
      };
      const urls = durable.cardUrls(input.searchId, source.target.id);
      for (const url of urls) source.urls.add(url);
      if (urls.length) restored.set(source.target.id, urls);
      source.row.cards = source.urls.size;
      for (const { outcome, total } of durable.cardOutcomes(
        input.searchId,
        id,
      )) {
        source.processed += total;
        source.screened += total;
        if (outcome === "related" || outcome === "related_removed")
          source.row.related += total;
        if (outcome === "unrelated") source.row.unrelated += total;
        if (outcome === "seen") source.row.seen += total;
        if (outcome === "removed" || outcome === "related_removed")
          source.removed += total;
      }
    },
    /**
     * A complete fresh inventory is the site's current list. Cards an
     * interrupted run queued that it no longer lists are gone from the site:
     * drop those still waiting instead of reading each one.
     */
    refresh(source: SourceWork, live: ReadonlySet<string>) {
      const urls = restored.get(source.target.id);
      if (!urls) return;
      restored.delete(source.target.id);
      const dropped = waves.drop(
        source.target.id,
        urls.filter((url) => !live.has(url)),
      );
      if (!dropped.length) return;
      for (const url of dropped) source.urls.delete(url);
      source.row.cards -= dropped.length;
      traceEvent("search_queue_refreshed", {
        sourceId: source.target.id,
        restored: urls.length,
        dropped: dropped.length,
      });
      input.write(source);
    },
    accept,
    /** Screening and every queued read; a read may find an index and add cards. */
    async drain() {
      for (;;) {
        await waves.drain();
        if (!readsInFlight.size) break;
        await abortable(Promise.all([...readsInFlight]), signal);
      }
      if (readError) throw readError;
    },
  };
}
