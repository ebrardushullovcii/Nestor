import type { JobFinderAiClient } from "@nestor/ai-providers";
import { createHash } from "node:crypto";
import {
  collectSource,
  listingInventoryReady,
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
  type ReadListingResult,
  type SeenListingCard,
  type SourceInventory,
} from "@nestor/contracts";
import type { JobSearchContext } from "./types";

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
      onCards?(cards: ListingCard[]): Promise<void>;
      message(text: string): void;
      knownUrls(urls: readonly string[]): readonly string[];
    },
  ): Promise<SourceInventory>;
  screenCards(
    input: SearchInput & {
      cards: readonly ListingCard[];
      knownUrls(urls: readonly string[]): readonly string[];
      seenCards(
        cards: readonly ListingCard[],
        roleGoalsKey: string,
      ): readonly SeenListingCard[];
    },
  ): Promise<{
    related: ListingCard[];
    seen: SeenListingCard[];
    skipped: number;
  }>;
  readListings(input: {
    lane?: "http" | "browser";
    cards: readonly ListingCard[];
    signal: AbortSignal;
  }): Promise<ReadListingResult>;
  fitJobs(input: {
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
}): JobSearchEngine {
  if (!deps.aiClient.chatWithTools)
    throw new Error("Search needs an available AI model.");
  const client = { chatWithTools: deps.aiClient.chatWithTools };
  const browser = createHostQueue({ limit: 2, perHost: 1 });
  const decisions = new Map<string, Map<string, boolean>>();
  const readPage = createHttpPageReader({
    readRendered: (url, options) => {
      const signal = options.signal ?? new AbortController().signal;
      return browser.run(new URL(url).hostname, signal, () => {
        if (!deps.browserRuntime.readRenderedPage)
          throw new Error("Browser reading is unavailable.");
        return deps.browserRuntime.readRenderedPage(url, options);
      });
    },
  });

  return {
    collectSource(input) {
      const { target, signal, settings, context } = input;
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
      return collectSource({
        source: { id: target.id, label: target.label, url: target.startingUrl },
        lane: input.lane,
        readPage:
          input.lane === "http"
            ? readPage
            : (url, options) =>
                readPage(url, {
                  ...options,
                  rendered: true,
                  ready: (html) => listingInventoryReady(html, url),
                }),
        signal,
        onPage: async (cards) => {
          input.message(`Read ${cards.length} listing cards from this page.`);
          await input.onCards?.(cards);
        },
        ...(input.lane === "browser"
          ? {
              navigateFallback: async () => {
                if (!deps.browserRuntime.runAgentDiscovery)
                  return {
                    cards: [],
                    pagesRead: 0,
                    complete: false,
                    notes: [
                      "This site needs browser navigation, which is unavailable.",
                    ],
                  };
                const result = await browser.run(
                  new URL(target.startingUrl).hostname,
                  signal,
                  () =>
                    deps.browserRuntime.runAgentDiscovery!("target_site", {
                      inventoryOnly: true,
                      dedicatedPage: true,
                      retainAllFound: true,
                      userProfile: context.profile,
                      searchPreferences: toJobSearchGoals(
                        context.searchPreferences,
                      ),
                      lookupKnownUrls: (urls) =>
                        Promise.resolve(input.knownUrls(urls)),
                      startingUrls: [target.startingUrl],
                      navigationHostnames: [
                        new URL(target.startingUrl).hostname,
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
                      maxSteps: settings.depth === "quick" ? 16 : 48,
                      signal,
                      onProgress: (progress) => {
                        if (progress.message) input.message(progress.message);
                      },
                      aiClient: deps.aiClient,
                    }),
                );
                const cards = result.jobs.map((job) => ({
                  url: job.canonicalUrl,
                  title: job.title,
                  text: [
                    job.title,
                    job.company,
                    job.location,
                    job.description,
                  ].join("\n"),
                  cardFingerprint: createHash("sha256")
                    .update(JSON.stringify(job.title.trim().toLowerCase()))
                    .digest("hex")
                    .slice(0, 32),
                  sourceId: target.id,
                  sourceLabel: target.label,
                  ...(job.sourceJobId ? { sourceJobId: job.sourceJobId } : {}),
                  ...(job.company ? { companyHint: job.company } : {}),
                  ...(job.location ? { locationHint: job.location } : {}),
                  ...(job.postedAt ? { postedAt: job.postedAt } : {}),
                  ...(job.listingDetailFetch?.outcome === "enriched"
                    ? { listingText: job.description }
                    : {}),
                }));
                return {
                  cards,
                  pagesRead: 0,
                  complete: result.inventoryCompleteness === "complete",
                  needsYou:
                    result.agentMetadata?.accessBlockerReason ===
                      "auth_required" ||
                    result.agentMetadata?.accessBlockerReason ===
                      "site_protection",
                  notes: [
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
      return screenCards({
        decisions: cache,
        client,
        cards: input.cards,
        signal: input.signal,
        goals,
        lookupKnownUrls: (urls) => Promise.resolve(input.knownUrls(urls)),
        lookupSeenCards: (cards, key) =>
          Promise.resolve(input.seenCards(cards, key)),
      });
    },
    readListings: (input) => readListings({ client, ...input, readPage }),
    fitJobs: (input) =>
      fitJobs({
        client,
        ...input,
        profile: input.context.profile,
        goals: toJobSearchGoals(input.context.searchPreferences),
      }),
  };
}
