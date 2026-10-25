import type { AgentDiscoveryOptions } from "@nestor/browser-runtime";
import {
  toJobSearchGoals,
  type JobDiscoveryTarget,
  type JobPosting,
  type JobSearchSettings,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import {
  buildDiscoveryStartingUrls,
  collectPublicProviderJobs,
  inferSourceIntelligenceFromTarget,
} from "../internal/workspace-source-intelligence";
import { abortable } from "./async";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type { JobSearchContext } from "./types";

export function planSource(
  target: JobDiscoveryTarget,
  artifacts: ReadonlyMap<string, SourceInstructionArtifact>,
) {
  const draft = target.draftInstructionId
    ? artifacts.get(target.draftInstructionId)
    : undefined;
  const validated = target.validatedInstructionId
    ? artifacts.get(target.validatedInstructionId)
    : undefined;
  const artifact =
    draft?.targetId === target.id && draft.status === "draft"
      ? draft
      : validated?.targetId === target.id && validated.status === "validated"
        ? validated
        : null;
  const intelligence = inferSourceIntelligenceFromTarget({
    target,
    currentArtifact: artifact,
  });
  return {
    target,
    artifact,
    intelligence,
    feed:
      (intelligence.overrides.forceMethod ??
        intelligence.collection.preferredMethod) === "api",
  };
}

export type SourcePlan = ReturnType<typeof planSource>;

export async function searchSource(input: {
  deps: {
    browserRuntime: Pick<BrowserSessionRuntime, "runAgentDiscovery">;
    aiClient: JobFinderAiClient;
  };
  context: JobSearchContext;
  settings: JobSearchSettings;
  plan: SourcePlan;
  signal: AbortSignal;
  inBrowser<T>(work: () => Promise<T>): Promise<T>;
  openSession(target: JobDiscoveryTarget): Promise<void>;
  save(jobs: readonly JobPosting[]): void;
  knownUrls(urls: readonly string[]): readonly string[];
  message(message: string): void;
}): Promise<{ needsYou: boolean; message: string | null }> {
  const { deps, context, settings, plan, signal } = input;
  const { target, artifact } = plan;
  let catalog: JobPosting[] | undefined;
  let warning: string | null = null;
  if (plan.feed) {
    const feed = await abortable(
      collectPublicProviderJobs({
        target,
        artifact: { intelligence: plan.intelligence },
        source: "target_site",
        signal,
        // The new store owns merging. Do not prepare legacy ledger identities.
        prepareForDiscovery: false,
      }),
      signal,
    );
    signal.throwIfAborted();
    warning = feed.warning;
    if (feed.jobs.length > 0) {
      if (settings.note || settings.postedWithin !== "any") catalog = feed.jobs;
      else {
        input.save(feed.jobs);
        return { needsYou: false, message: warning };
      }
    } else if (!warning) return { needsYou: false, message: null };
    // A failed public feed may still have a usable first-party browser surface.
  }

  return input.inBrowser(async () => {
    if (!deps.browserRuntime.runAgentDiscovery)
      throw new Error("Browser search is unavailable.");
    await input.openSession(target);
    signal.throwIfAborted();
    const selectivity =
      settings.picky === "open"
        ? "wide_net"
        : settings.picky === "strict"
          ? "best_matches"
          : "balanced";
    const guidance = artifact
      ? [
          ...artifact.navigationGuidance.map((line) => `[Navigation] ${line}`),
          ...artifact.searchGuidance.map((line) => `[Search] ${line}`),
          ...artifact.detailGuidance.map((line) => `[Detail] ${line}`),
        ]
      : [];
    const quick = settings.depth === "quick";
    const options: AgentDiscoveryOptions = {
      dedicatedPage: true,
      retainAllFound: true,
      ...(catalog
        ? { sourceCatalog: catalog, sourceCatalogComplete: warning === null }
        : {}),
      userProfile: context.profile,
      searchPreferences: toJobSearchGoals(context.searchPreferences),
      // A listing already saved is not read again; it only merges.
      lookupKnownUrls: (urls) => Promise.resolve(input.knownUrls(urls)),
      searchRequest: {
        intent: settings.note,
        freshness: settings.postedWithin === "any" ? "any" : "recent",
        sourceIds: [target.id],
      },
      searchGuidance: {
        selectivity,
        remoteCountsAsAnyLocation:
          context.searchPreferences.discovery.remoteCountsAsAnyLocation ?? true,
      },
      searchMode: settings.picky === "open" ? "scale" : "precision",
      targetJobCount: 100,
      maxSteps: quick ? 24 : 240,
      runControl: {
        timeBudgetMs: quick ? 90_000 : 20 * 60_000,
        noProgressStepLimit: quick ? 6 : 24,
      },
      startingUrls: buildDiscoveryStartingUrls(target, artifact),
      siteLabel: target.label,
      navigationHostnames: [new URL(target.startingUrl).hostname],
      siteInstructions: [
        ...guidance,
        ...(target.customInstructions ? [target.customInstructions] : []),
        ...(settings.postedWithin === "any"
          ? []
          : [
              `Look for listings posted within the last ${settings.postedWithin === "week" ? "7" : "30"} days. Keep unknown posted dates.`,
            ]),
        ...(context.searchPreferences.companyBlacklist.length
          ? [
              `Exclude these companies: ${context.searchPreferences.companyBlacklist.join(", ")}.`,
            ]
          : []),
        ...(context.searchPreferences.excludedLocations.length
          ? [
              `Exclude these locations: ${context.searchPreferences.excludedLocations.join(", ")}.`,
            ]
          : []),
      ],
      aiClient: deps.aiClient,
      signal,
      onWaitingForBrowserTab: () => input.message("Waiting for a browser tab"),
      onCheckpoint: (checkpoint) => input.save(checkpoint.collectedJobs),
    };
    const result = await abortable(
      deps.browserRuntime.runAgentDiscovery("target_site", options),
      signal,
    );
    signal.throwIfAborted();
    input.save(result.jobs);
    const blocker = result.agentMetadata?.accessBlockerReason;
    return {
      needsYou: Boolean(blocker),
      message:
        blocker === "auth_required"
          ? "Sign in to search this site."
          : blocker === "site_protection"
            ? "Complete the site's CAPTCHA or security check."
            : blocker
              ? "This site needs your help to continue."
              : (result.warning ?? warning),
    };
  });
}
