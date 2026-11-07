import {
  modelConversationKeys,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import { createHash } from "node:crypto";
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
  type ListingCard,
  type ModelTokenUsage,
  type ReadListingResult,
  type SeenListingCard,
  type SourceInventory,
  type JobPosting,
} from "@nestor/contracts";
import type { JobSearchContext } from "./types";
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
    },
  ): Promise<{
    related: ListingCard[];
    seen: SeenListingCard[];
    skipped: number;
    failed?: { url: string; reason: string }[];
  }>;
  readListings(input: {
    lane?: "http" | "browser";
    context?: JobSearchContext;
    cards: readonly ListingCard[];
    signal: AbortSignal;
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
      return collectSource({
        browserAccessAuthorized,
        source: { id: target.id, label: target.label, url: target.startingUrl },
        lane: input.lane,
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
        ...(input.lane === "browser"
          ? {
              navigateFallback: async (portalUrl) => {
                if (!deps.browserRuntime.runAgentDiscovery)
                  return {
                    cards: [],
                    pagesRead: 0,
                    complete: false,
                    notes: [
                      "This site needs browser navigation, which is unavailable.",
                    ],
                  };
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
                          readIntendedAccountEmail:
                            context.readIntendedAccountEmail,
                        }
                      : {}),
                    ...(context.readBrowserPermissions
                      ? {
                          readBrowserPermissions:
                            context.readBrowserPermissions,
                        }
                      : {}),
                    inventoryOnly: true,
                    onCheckpoint: async (checkpoint) => {
                      input.message(
                        `Collected ${checkpoint.collectedJobs.length} listing cards; remaining batches are still being checked.`,
                      );
                      await input.onCards?.(toCards(checkpoint.collectedJobs));
                    },
                    dedicatedPage: true,
                    retainAllFound: true,
                    userProfile: context.profile,
                    searchPreferences: toJobSearchGoals(
                      context.searchPreferences,
                    ),
                    startingUrls: [portalUrl ?? target.startingUrl],
                    navigationHostnames: [
                      new URL(target.startingUrl).hostname,
                      ...(portalUrl ? [new URL(portalUrl).hostname] : []),
                    ],
                    siteLabel: target.label,
                    siteInstructions: guidance,
                    searchRequest: {
                      intent: settings.note,
                      breadth: "wide",
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
                return {
                  cards,
                  pagesRead: result.agentMetadata?.pagesCovered ?? 0,
                  complete: result.agentMetadata
                    ? result.agentMetadata.phaseCompletionMode ===
                        "structured_finish" &&
                      result.agentMetadata.incomplete === false
                    : result.inventoryCompleteness === "complete",
                  needsYou:
                    result.agentMetadata?.accessBlockerReason ===
                      "auth_required" ||
                    result.agentMetadata?.accessBlockerReason ===
                      "site_protection",
                  notes: [
                    ...(result.agentMetadata?.phaseCompletionReason
                      ? [result.agentMetadata.phaseCompletionReason]
                      : []),
                    result.warning ??
                      `${cards.length} listings collected with browser navigation.`,
                  ],
                };
              },
            }
          : {}),
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
          }),
      ).finally(() =>
        timing("screen", startedAt, {
          count: input.cards.length,
          source: input.cards[0]?.sourceId ?? "",
        }),
      );
    },
    async readListings(input) {
      if (input.lane !== "browser" || !input.context)
        return withTraceScope(
          {
            sourceId: undefined,
            sourceUrl: undefined,
            sourceIds: [...new Set(input.cards.map((card) => card.sourceId))],
          },
          () =>
            readListings({
              client,
              onUsage,
              ...input,
              readPage,
              ...modelContext(),
            }),
        );
      const context = input.context;
      const result: ReadListingResult = { jobs: [], failures: [] };
      for (const card of input.cards) {
        input.signal.throwIfAborted();
        if (!deps.browserRuntime.runAgentDiscovery) {
          result.failures.push({
            url: card.url,
            reason: "Browser navigation is unavailable.",
          });
          continue;
        }
        try {
          const browserPermissions = context.readBrowserPermissions
            ? await context.readBrowserPermissions()
            : context.browserPermissions;
          const discovery = await withTraceScope(
            {
              sourceId: card.sourceId,
              sourceUrl: undefined,
              listingUrl: card.url,
            },
            () =>
              deps.browserRuntime.runAgentDiscovery!("target_site", {
                ...(browserPermissions ? { browserPermissions } : {}),
                ...(context.readBrowserPermissions
                  ? { readBrowserPermissions: context.readBrowserPermissions }
                  : {}),
                ...(context.readIntendedAccountEmail
                  ? {
                      readIntendedAccountEmail:
                        context.readIntendedAccountEmail,
                    }
                  : {}),
                dedicatedPage: true,
                requestedListing: {
                  url: card.url,
                  title: card.title,
                  text: card.text,
                },
                retainAllFound: true,
                userProfile: context.profile,
                searchPreferences: toJobSearchGoals(context.searchPreferences),
                startingUrls: [card.url],
                searchRequest: {
                  intent:
                    "Read this supplied vacancy in full and keep its complete text. This is a listing read, not a fit decision; do not reject it for preferences or expected fit.",
                  breadth: "wide",
                  freshness: "any",
                  sourceIds: [card.sourceId],
                },
                navigationHostnames: [new URL(card.url).hostname],
                siteLabel: card.sourceLabel,
                siteInstructions: [
                  "Read the supplied vacancy in full, including every requirement and the application link. This is a full listing read, not a fit decision: retain this vacancy regardless of its expected fit. Preserve its complete text in description. Missing metadata is unknown, not a reason to drop a vacancy. Do not apply.",
                  "If the supplied URL is actually an index, collect its vacancy cards under their own URLs using extract_jobs or save_jobs_from_data and follow pagination. An index is not a vacancy; do not ask the person for links already on it.",
                  "Use this browser's imported session and the saved vault sign-in or Google sign-in when needed. Attempt permitted sign-in and site checks before asking the person. Never ask for or expose a password the vault can type. If a real attempt fails, hand off on the open page with exactly what happened.",
                ],
                targetJobCount: 1,
                maxSteps: Number.MAX_SAFE_INTEGER,
                signal: input.signal,
                aiClient: deps.aiClient,
              }),
          );
          for (const job of discovery.jobs)
            result.jobs.push({
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
              facts: { fullListingRead: true },
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
          if (!discovery.jobs.length)
            result.failures.push({
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
          result.failures.push({
            url: card.url,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
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
            goals: toJobSearchGoals({
              ...input.context.searchPreferences,
              remoteCountsAsAnyLocation:
                input.context.remoteCountsAsAnyLocation,
            }),
          }),
      ),
  };
}
