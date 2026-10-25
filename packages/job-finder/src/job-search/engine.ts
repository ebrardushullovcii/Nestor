import type { JobFinderAiClient } from "@nestor/ai-providers";
import { createHash } from "node:crypto";
import {
  collectSource,
  screenCards,
  readListings,
  fitJobs,
} from "@nestor/browser-agent";
import {
  createHttpPageReader,
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
import { createSlots } from "./async";
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
  const browserSlots = new WeakMap<
    AbortSignal,
    ReturnType<typeof createSlots>
  >();
  const slotsOf = (signal: AbortSignal) => {
    let slots = browserSlots.get(signal);
    if (!slots) {
      slots = createSlots(2, signal);
      browserSlots.set(signal, slots);
    }
    return slots;
  };
  const readPage = createHttpPageReader({
    readRendered: (url, options) => {
      const signal = options.signal ?? new AbortController().signal;
      return slotsOf(signal)(() => {
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
        readPage,
        signal,
        onPage: (cards) =>
          input.message(`Read ${cards.length} listing cards from this page.`),
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
          const result = await slotsOf(signal)(() =>
            deps.browserRuntime.runAgentDiscovery!("target_site", {
              inventoryOnly: true,
              dedicatedPage: true,
              retainAllFound: true,
              userProfile: context.profile,
              searchPreferences: toJobSearchGoals(context.searchPreferences),
              lookupKnownUrls: (urls) => Promise.resolve(input.knownUrls(urls)),
              startingUrls: [target.startingUrl],
              navigationHostnames: [new URL(target.startingUrl).hostname],
              siteLabel: target.label,
              siteInstructions: guidance,
              searchRequest: {
                intent: settings.note,
                breadth: "wide",
                freshness: "any",
                sourceIds: [target.id],
              },
              targetJobCount: Number.MAX_SAFE_INTEGER,
              maxSteps: settings.depth === "quick" ? 24 : 160,
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
            text: [job.title, job.company, job.location, job.description].join(
              "\n",
            ),
            cardFingerprint: createHash("sha256")
              .update(
                JSON.stringify([
                  job.title,
                  job.company,
                  job.location,
                  job.description,
                ]),
              )
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
            needsYou: Boolean(result.agentMetadata?.accessBlockerReason),
            notes: [
              result.warning ??
                `${cards.length} listings collected with browser navigation.`,
            ],
          };
        },
      });
    },
    screenCards: (input) =>
      screenCards({
        client,
        cards: input.cards,
        signal: input.signal,
        goals: {
          targetRoles: input.context.searchPreferences.targetRoles,
          relatedRoles: input.context.searchPreferences.jobFamilies,
          strategy:
            input.settings.depth === "thorough" ? "wide_net" : "related_roles",
          request: input.settings.note,
        },
        lookupKnownUrls: (urls) => Promise.resolve(input.knownUrls(urls)),
        lookupSeenCards: (cards, key) =>
          Promise.resolve(input.seenCards(cards, key)),
      }),
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
