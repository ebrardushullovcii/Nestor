import {
  modelConversationKeys,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import { createHash } from "node:crypto";
import { followBoardApplyLinks } from "./follow-apply-links";
import { AsyncLocalStorage } from "node:async_hooks";
import { withTraceScope } from "@nestor/core/run-trace";
import {
  collectSource,
  screenCards,
  readListings,
  fitJobs,
  roleGoalsKey,
} from "@nestor/browser-agent";
import {
  createHttpPageReader,
  createHostQueue,
  type BrowserSessionRuntime,
} from "@nestor/browser-runtime";
import {
  toJobSearchGoals,
  type JobDetail,
  type JobDiscoveryTarget,
  type JobFitUpdate,
  type JobSearchSettings,
  SourceDebugPhaseEvidenceSchema,
  type IndexPageLog,
  type ListingCard,
  type ModelTokenUsage,
  type ReadListingResult,
  type SeenListingCard,
  type SourceInventory,
  type SourceNavigationProgress,
  type JobPosting,
} from "@nestor/contracts";
import type { JobSearchContext } from "./types";
import { readListingInBrowser } from "../internal/browser-listing-read";
import { coalesceScreening } from "./coalesce-screening";

interface SearchInput {
  context: JobSearchContext;
  settings: JobSearchSettings;
  signal: AbortSignal;
}

/** The runner owns persistence and merging between these four steps. */
export interface JobSearchEngine {
  collectSource(
    input: SearchInput & {
      target: JobDiscoveryTarget;
      lane: "http" | "browser";
      onCards?: (cards: ListingCard[]) => Promise<void>;
      message(text: string): void;
      knownUrls(urls: readonly string[]): readonly string[];
      collectedUrls?(urls: readonly string[]): readonly string[];
      /** Index page addresses this search has read on the site; pages read here are added. */
      indexPages?: Set<string>;
      /** Pages in indexPages are not read again: their cards are already collected. */
      skipReadIndexPages?: boolean;
      /** Index pages this search finished on the site, kept across restarts. */
      pageLog?: IndexPageLog;
      /** Where browser collections of this site had got to, by starting address. */
      navigation?: {
        read(startUrl: string): SourceNavigationProgress | null;
        save(startUrl: string, progress: SourceNavigationProgress): void;
      };
    },
  ): Promise<SourceInventory>;
  screenCards(
    input: SearchInput & {
      cards: readonly ListingCard[];
      knownUrls(urls: readonly string[]): readonly string[];
      refreshUrls?: readonly string[];
      seenCards(
        cards: readonly ListingCard[],
        roleGoalsKey: string,
      ): readonly SeenListingCard[];
      onRelated?: (cards: ListingCard[]) => Promise<void>;
      /** Each verdict, related or unrelated, as the model decides it. */
      onSeen?: (cards: SeenListingCard[]) => Promise<void> | void;
    },
  ): Promise<{
    related: ListingCard[];
    seen: SeenListingCard[];
    skipped: number;
    failed?: { url: string; reason: string }[];
    /** Listings the site answered as removed (HTTP 404 or 410). */
    gone?: string[];
  }>;
  readListings(input: {
    lane?: "http" | "browser";
    context?: JobSearchContext;
    cards: readonly ListingCard[];
    signal: AbortSignal;
    /**
     * Each finished group of cards with its complete result, as soon as it
     * is read; the returned result is then every group's together.
     */
    onRead?: (
      cards: readonly ListingCard[],
      result: ReadListingResult,
    ) => Promise<void>;
  }): Promise<ReadListingResult>;
  fitJobs(input: {
    /** Save complete judgments before another batch or repair can fail. */
    onBatch?: (fits: readonly JobFitUpdate[]) => Promise<void>;
    onUsage?: (usage: ModelTokenUsage) => void;
    request?: string;
    jobs: readonly JobDetail[];
    context: JobSearchContext;
    signal: AbortSignal;
  }): Promise<JobFitUpdate[]>;
}

export function createListingSearchEngine(deps: {
  browserRuntime: Pick<
    BrowserSessionRuntime,
    "readRenderedPage" | "runAgentDiscovery"
  >;
  aiClient: JobFinderAiClient;
  /** Browser pages a search reads at once, read live: the Speed setting. */
  browserPages?: () => number;
}): JobSearchEngine {
  if (!deps.aiClient.chatWithTools)
    throw new Error("Search needs an available AI model.");
  const client = {
    chatWithTools: coalesceScreening(deps.aiClient.chatWithTools),
  };
  const modelContext = () => {
    const contextWindowTokens =
      deps.aiClient.getStatus().modelContextWindowTokens;
    return contextWindowTokens ? { contextWindowTokens } : {};
  };
  const onUsage = (usage: ModelTokenUsage, stage: string) =>
    console.info("[Job search AI]", JSON.stringify({ stage, ...usage }));
  const browser = createHostQueue({
    limit: () => deps.browserPages?.() ?? 2,
    perHost: 1,
  });
  const decisions = new Map<string, Map<string, boolean>>();
  const profiling = process.env.NESTOR_SEARCH_PROFILE === "1";
  const timing = (
    phase: string,
    startedAt: number,
    fields: Record<string, string | number | boolean>,
  ) => {
    if (profiling)
      console.info(
        "[Search timing]",
        JSON.stringify({
          phase,
          startedAt,
          durationMs: Date.now() - startedAt,
          ...fields,
        }),
      );
  };
  const reads = new AsyncLocalStorage<{ firstFetchAt?: number }>();
  const reader = createHttpPageReader({
    ...(profiling
      ? {
          fetch: (...args: Parameters<typeof fetch>) => {
            const read = reads.getStore();
            if (read) read.firstFetchAt ??= Date.now();
            return fetch(...args);
          },
        }
      : {}),
    readRendered: (url, options) => {
      const queuedAt = Date.now();
      const signal = options.signal ?? new AbortController().signal;
      return browser.run(new URL(url).hostname, signal, async () => {
        const startedAt = Date.now();
        let settleAt: number | null = null;
        let settleMs = 0;
        if (!deps.browserRuntime.readRenderedPage)
          throw new Error("Browser reading is unavailable.");
        try {
          return await deps.browserRuntime.readRenderedPage(url, {
            ...options,
            ...(profiling && options.ready
              ? {
                  ready: (html: string) => {
                    const ready = options.ready!(html);
                    if (!ready) settleAt ??= Date.now();
                    else if (settleAt !== null) {
                      settleMs += Date.now() - settleAt;
                      settleAt = null;
                    }
                    return ready;
                  },
                }
              : {}),
          });
        } finally {
          timing("browser_read", startedAt, {
            url: new URL(url).pathname,
            queueMs: startedAt - queuedAt,
            settleMs:
              settleMs + (settleAt === null ? 0 : Date.now() - settleAt),
          });
        }
      });
    },
  });
  const readPage: typeof reader = (url, options) => {
    if (!profiling || options.rendered) return reader(url, options);
    const startedAt = Date.now();
    const read: { firstFetchAt?: number } = {};
    return reads.run(read, async () => {
      try {
        return await reader(url, options);
      } finally {
        timing("http_read", startedAt, {
          url: new URL(url).pathname,
          queueMs: (read.firstFetchAt ?? Date.now()) - startedAt,
        });
      }
    });
  };

  return {
    async collectSource(input) {
      const { target, signal, settings, context } = input;
      const browserPermissions = context.readBrowserPermissions
        ? await context.readBrowserPermissions()
        : context.browserPermissions;
      const browserAccessAuthorized =
        browserPermissions?.signIn === true ||
        browserPermissions?.createAccounts === true ||
        browserPermissions?.solveCaptchas === true;
      const artifact =
        context.sourceInstructionArtifacts.find(
          (artifact) =>
            artifact.targetId === target.id &&
            artifact.id === target.validatedInstructionId,
        ) ??
        context.sourceInstructionArtifacts.find(
          (artifact) =>
            artifact.targetId === target.id &&
            artifact.id === target.draftInstructionId,
        );
      const guidance = [
        ...(artifact?.navigationGuidance ?? []),
        ...(artifact?.searchGuidance ?? []),
        ...(target.customInstructions ? [target.customInstructions] : []),
      ];
      const toCards = (jobs: readonly JobPosting[]): ListingCard[] =>
        jobs.map((job) => ({
          url: job.canonicalUrl,
          title: job.title,
          text: [job.title, job.company, job.location, job.description].join(
            "\n",
          ),
          cardFingerprint: createHash("sha256")
            .update(JSON.stringify(job.title.trim().toLowerCase()))
            .digest("hex")
            .slice(0, 32),
          sourceId: target.id,
          sourceLabel: target.label,
          ...(job.sourceJobId ? { sourceJobId: job.sourceJobId } : {}),
          ...(job.company && job.company !== "Company not stated on card"
            ? { companyHint: job.company }
            : {}),
          ...(job.location && job.location !== "Location not stated on card"
            ? { locationHint: job.location }
            : {}),
          ...(job.postedAt ? { postedAt: job.postedAt } : {}),
          ...(job.searchRejection?.category === "closed"
            ? { closed: true }
            : {}),
          ...(job.listingDetailFetch?.outcome === "enriched"
            ? {
                listingText: job.description,
                providerFacts: {
                  company: job.company,
                  location: job.location,
                  workModes: job.workMode,
                  employmentType: job.employmentType ?? null,
                  salaryText: job.salaryText ?? null,
                  applyUrl: job.applicationUrl ?? null,
                  postedAt: job.postedAt ?? null,
                },
              }
            : {}),
        }));
      const navigateFallback = async (
        portalUrl?: string,
      ): Promise<SourceInventory> => {
        if (!deps.browserRuntime.runAgentDiscovery)
          return {
            cards: [],
            pagesRead: 0,
            complete: false,
            notes: [
              "This site needs browser navigation, which is unavailable.",
            ],
          };
        // A restart continues this collection where it had got to;
        // its cards were accepted as they were collected.
        const earlier = input.navigation?.read(target.startingUrl) ?? null;
        if (earlier?.outcome?.complete)
          return {
            cards: [],
            pagesRead: earlier.outcome.pagesRead,
            complete: earlier.outcome.complete,
            notes: earlier.outcome.notes,
            resumed: true,
          };
        const startUrl = portalUrl ?? target.startingUrl;
        const resumeUrl =
          earlier && /^https?:/iu.test(earlier.currentUrl)
            ? earlier.currentUrl
            : null;
        const progress = (update: Omit<SourceNavigationProgress, "savedAt">) =>
          input.navigation?.save(target.startingUrl, {
            ...update,
            savedAt: new Date().toISOString(),
          });
        const remainingWork = earlier?.remainingWork ?? earlier?.outcome?.notes;
        let latest: Omit<SourceNavigationProgress, "savedAt"> = {
          currentUrl: resumeUrl ?? startUrl,
          visitedUrls: earlier?.visitedUrls ?? [],
          collected: earlier?.collected ?? 0,
          stepCount: earlier?.stepCount ?? 0,
          ...(remainingWork ? { remainingWork } : {}),
        };
        const accepted = new Map<string, JobPosting>();
        // The runner bounds source navigation in its browser queue.
        // Do not also hold the detail-reader queue: a checkpoint can
        // wait for screening that needs a rendered detail of its own.
        const result = await deps.browserRuntime.runAgentDiscovery(
          "target_site",
          {
            ...(context.browserPermissions
              ? { browserPermissions: context.browserPermissions }
              : {}),
            ...(context.readIntendedAccountEmail
              ? {
                  readIntendedAccountEmail: context.readIntendedAccountEmail,
                }
              : {}),
            ...(context.readBrowserPermissions
              ? {
                  readBrowserPermissions: context.readBrowserPermissions,
                }
              : {}),
            inventoryOnly: true,
            ...(earlier && input.collectedUrls
              ? {
                  lookupKnownUrls: (urls: readonly string[]) =>
                    Promise.resolve(input.collectedUrls!(urls)),
                }
              : {}),
            ...(earlier
              ? {
                  resumeCheckpoint: {
                    revision: 0,
                    savedAt: earlier.savedAt,
                    currentUrl: earlier.currentUrl,
                    lastStableUrl: earlier.currentUrl,
                    stepCount: earlier.stepCount,
                    collectedJobs: [],
                    collectedEarlier: earlier.collected,
                    visitedUrls: earlier.visitedUrls,
                    remainingWork,
                    phaseEvidence: SourceDebugPhaseEvidenceSchema.parse({}),
                  },
                }
              : {}),
            onCheckpoint: async (checkpoint) => {
              const changed = checkpoint.collectedJobs.filter(
                (job) => accepted.get(job.canonicalUrl) !== job,
              );
              if (changed.length) {
                input.message(
                  `Collected ${checkpoint.collectedJobs.length} listing cards; remaining batches are still being checked.`,
                );
                await input.onCards?.(toCards(changed));
                for (const job of changed) accepted.set(job.canonicalUrl, job);
              }
              // Its cards are accepted: a restart continues from here.
              const at = /^https?:/iu.test(checkpoint.currentUrl)
                ? checkpoint.currentUrl
                : checkpoint.lastStableUrl;
              latest = {
                currentUrl: /^https?:/iu.test(at) ? at : latest.currentUrl,
                visitedUrls: checkpoint.visitedUrls.length
                  ? checkpoint.visitedUrls
                  : latest.visitedUrls,
                collected:
                  (earlier?.collected ?? 0) + checkpoint.collectedJobs.length,
                stepCount: checkpoint.stepCount,
                ...(checkpoint.remainingWork
                  ? { remainingWork: checkpoint.remainingWork }
                  : {}),
              };
              progress(latest);
            },
            dedicatedPage: true,
            retainAllFound: true,
            userProfile: context.profile,
            searchPreferences: toJobSearchGoals(context.searchPreferences),
            startingUrls: [
              ...new Set([...(resumeUrl ? [resumeUrl] : []), startUrl]),
            ],
            navigationHostnames: [
              ...new Set([
                new URL(target.startingUrl).hostname,
                ...(portalUrl ? [new URL(portalUrl).hostname] : []),
                ...(resumeUrl ? [new URL(resumeUrl).hostname] : []),
              ]),
            ],
            siteLabel: target.label,
            siteInstructions: guidance,
            searchRequest: {
              intent: settings.note,
              breadth: "wide",
              depth: settings.depth,
              freshness: "any",
              sourceIds: [target.id],
            },
            targetJobCount: Number.MAX_SAFE_INTEGER,
            maxSteps: Number.MAX_SAFE_INTEGER,
            signal,
            onProgress: (progress) => {
              if (progress.message) input.message(progress.message);
            },
            aiClient: deps.aiClient,
          },
        );
        const cards = toCards(result.jobs);
        const complete = result.agentMetadata
          ? result.agentMetadata.phaseCompletionMode === "structured_finish" &&
            result.agentMetadata.incomplete === false
          : result.inventoryCompleteness === "complete";
        const needsYou =
          result.agentMetadata?.accessBlockerReason === "auth_required" ||
          result.agentMetadata?.accessBlockerReason === "site_protection";
        // A collection the model finished, without leaving the
        // person a step, is not repeated after a restart. One an
        // outage or error cut short continues from where it was,
        // and is ours to try again.
        const inventory = {
          cards,
          pagesRead: result.agentMetadata?.pagesCovered ?? 0,
          complete,
          needsYou,
          notes: [
            ...(result.agentMetadata?.phaseCompletionReason
              ? [result.agentMetadata.phaseCompletionReason]
              : []),
            result.warning ??
              `${cards.length} listings collected with browser navigation.`,
          ],
          ...(earlier ? { resumed: true } : {}),
          ...(!complete && !needsYou ? { cutShort: true } : {}),
        };
        if (complete && !inventory.needsYou && input.navigation) {
          await input.onCards?.(cards);
          progress({
            ...latest,
            collected: Math.max(
              latest.collected,
              (earlier?.collected ?? 0) + cards.length,
            ),
            outcome: {
              complete: inventory.complete,
              pagesRead: inventory.pagesRead,
              notes: inventory.notes,
            },
          });
        }
        return inventory;
      };
      if (
        input.lane === "browser" &&
        input.navigation?.read(target.startingUrl)
      )
        return navigateFallback();
      return collectSource({
        browserAccessAuthorized,
        source: { id: target.id, label: target.label, url: target.startingUrl },
        lane: input.lane,
        ...(input.indexPages ? { indexPages: input.indexPages } : {}),
        ...(input.skipReadIndexPages ? { skipReadIndexPages: true } : {}),
        ...(input.pageLog ? { pageLog: input.pageLog } : {}),
        readPage:
          input.lane === "http"
            ? readPage
            : (url, options) =>
                readPage(url, {
                  ...options,
                  rendered: true,
                }),
        signal,
        onPage: async (cards) => {
          input.message(`Read ${cards.length} listing cards from this page.`);
          await input.onCards?.(cards);
        },
        ...(input.lane === "browser" ? { navigateFallback } : {}),
      });
    },
    screenCards: (input) => {
      const goals = {
        targetRoles: input.context.searchPreferences.targetRoles,
        relatedRoles: input.context.searchPreferences.jobFamilies,
        strategy:
          input.settings.depth === "thorough"
            ? ("wide_net" as const)
            : ("related_roles" as const),
        request: input.settings.note,
      };
      const key = roleGoalsKey(goals);
      let cache = decisions.get(key);
      if (!cache) {
        cache = new Map();
        decisions.set(key, cache);
        if (decisions.size > 8)
          decisions.delete(decisions.keys().next().value!);
      }
      const startedAt = Date.now();
      return withTraceScope(
        {
          sourceId: undefined,
          sourceUrl: undefined,
          sourceIds: [...new Set(input.cards.map((card) => card.sourceId))],
        },
        () =>
          screenCards({
            ...modelContext(),
            decisions: cache,
            client,
            onUsage,
            cards: input.cards,
            signal: input.signal,
            goals,
            lookupKnownUrls: (urls) => Promise.resolve(input.knownUrls(urls)),
            refreshUrls: input.refreshUrls ?? [],
            lookupSeenCards: (cards, key) =>
              Promise.resolve(input.seenCards(cards, key)),
            readPage,
            ...(input.onRelated ? { onRelated: input.onRelated } : {}),
            ...(input.onSeen ? { onSeen: input.onSeen } : {}),
          }),
      ).finally(() =>
        timing("screen", startedAt, {
          count: input.cards.length,
          source: input.cards[0]?.sourceId ?? "",
        }),
      );
    },
    async readListings(input) {
      const { onRead, ...request } = input;
      if (input.lane !== "browser" || !input.context) {
        if (!onRead)
          return followBoardApplyLinks(
            await withTraceScope(
              {
                sourceId: undefined,
                sourceUrl: undefined,
                sourceIds: [
                  ...new Set(input.cards.map((card) => card.sourceId)),
                ],
              },
              () =>
                readListings({
                  client,
                  onUsage,
                  ...request,
                  readPage,
                  ...modelContext(),
                }),
            ),
            readPage,
            input.signal,
          );
        // Each finished group is handed over with its apply links followed,
        // before the other groups end.
        const all: ReadListingResult = { jobs: [], failures: [] };
        await withTraceScope(
          {
            sourceId: undefined,
            sourceUrl: undefined,
            sourceIds: [...new Set(input.cards.map((card) => card.sourceId))],
          },
          () =>
            readListings({
              client,
              onUsage,
              ...request,
              readPage,
              ...modelContext(),
              onRead: async (cards, part) => {
                const followed = await followBoardApplyLinks(
                  part,
                  readPage,
                  input.signal,
                );
                all.jobs.push(...followed.jobs);
                all.failures.push(...followed.failures);
                if (followed.indexes?.length)
                  (all.indexes ??= []).push(...followed.indexes);
                if (followed.closed?.length)
                  (all.closed ??= []).push(...followed.closed);
                await onRead(cards, followed);
              },
            }),
        );
        return all;
      }
      const context = input.context;
      const result: ReadListingResult = { jobs: [], failures: [] };
      for (const card of input.cards) {
        input.signal.throwIfAborted();
        // One listing's complete result, handed over when onRead is given.
        const own: ReadListingResult = onRead
          ? { jobs: [], failures: [] }
          : result;
        try {
          const discovery = await withTraceScope(
            {
              sourceId: card.sourceId,
              sourceUrl: undefined,
              listingUrl: card.url,
            },
            () =>
              readListingInBrowser(
                {
                  browserRuntime: deps.browserRuntime,
                  aiClient: deps.aiClient,
                },
                {
                  listing: {
                    url: card.url,
                    title: card.title,
                    text: card.text,
                  },
                  sourceId: card.sourceId,
                  sourceLabel: card.sourceLabel,
                  context,
                  signal: input.signal,
                },
              ),
          );
          const indexUrl = discovery.agentMetadata?.listingIndexUrl;
          if (indexUrl)
            (own.indexes ??= []).push({ requestedUrl: card.url, indexUrl });
          for (const job of indexUrl ? [] : discovery.jobs)
            own.jobs.push({
              ...(card.evidenceFingerprint
                ? {
                    listingCardEvidence: {
                      url: card.url,
                      sourceId: card.sourceId,
                      fingerprint: card.evidenceFingerprint,
                    },
                  }
                : {}),
              title: job.title,
              company: job.company,
              location: job.location,
              workModes: job.workMode,
              // The model gets the requested identity and the landed page;
              // its canonical URL can resolve an observed login redirect.
              url: job.canonicalUrl,
              applyUrl: job.applicationUrl ?? null,
              sourceId: card.sourceId,
              sourceLabel: card.sourceLabel,
              sourceJobId: job.sourceJobId ?? null,
              postedAt: job.postedAt ?? null,
              description: job.description,
              // An index the agent walked yields cards, not read postings.
              facts: {
                fullListingRead: job.listingDetailFetch?.outcome === "enriched",
              },
              summary: null,
              seniority: job.seniority ?? null,
              employmentType: job.employmentType ?? null,
              salaryText: job.salaryText ?? null,
              salaryMin: null,
              salaryMax: null,
              salaryCurrency: null,
              ...(job.searchRejection?.category === "closed"
                ? { hiddenReason: `Closed: ${job.searchRejection.reason}` }
                : {}),
            });
          if (!indexUrl && !discovery.jobs.length)
            own.failures.push({
              url: card.url,
              reason:
                discovery.warning ??
                "The browser agent did not finish reading this vacancy.",
              ...([
                "auth_required",
                "site_protection",
                "manual_step_required",
              ].includes(discovery.agentMetadata?.accessBlockerReason ?? "")
                ? { needsYou: true }
                : {}),
            });
        } catch (error) {
          input.signal.throwIfAborted();
          own.failures.push({
            url: card.url,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        if (onRead) {
          // Kept as soon as it is read: a restart does not read it again.
          const followed = await followBoardApplyLinks(
            own,
            readPage,
            input.signal,
          );
          result.jobs.push(...followed.jobs);
          result.failures.push(...followed.failures);
          if (followed.indexes?.length)
            (result.indexes ??= []).push(...followed.indexes);
          await onRead([card], followed);
        }
      }
      return onRead
        ? result
        : followBoardApplyLinks(result, readPage, input.signal);
    },
    fitJobs: (input) =>
      withTraceScope(
        {
          sourceId: undefined,
          sourceUrl: undefined,
          listingUrl: undefined,
          sourceIds: [
            ...new Set(
              input.jobs.flatMap((job) =>
                job.sightings.map((sighting) => sighting.sourceId),
              ),
            ),
          ],
          jobIds: input.jobs.map((job) => job.id),
        },
        () =>
          fitJobs({
            ...modelContext(),
            client: {
              chatWithTools: (messages, tools, options) =>
                client.chatWithTools(messages, tools, {
                  ...options,
                  conversationKey: modelConversationKeys.fitJudging(
                    input.context.profile,
                  ),
                }),
            },
            ...input,
            onUsage: (usage, stage) => {
              onUsage(usage, stage);
              input.onUsage?.(usage);
            },
            profile: input.context.profile,
            ...(input.context.countryOptionFallbacks?.length
              ? { countryOptionFallbacks: input.context.countryOptionFallbacks }
              : {}),
            ...(input.context.savedAnswers?.length
              ? { savedAnswers: input.context.savedAnswers }
              : {}),
            goals: toJobSearchGoals({
              ...input.context.searchPreferences,
              remoteCountsAsAnyLocation:
                input.context.remoteCountsAsAnyLocation,
            }),
          }),
      ),
  };
}
