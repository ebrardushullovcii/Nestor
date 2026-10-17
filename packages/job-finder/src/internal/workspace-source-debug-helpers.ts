import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  SourceDebugPhaseSummarySchema,
  type JobDiscoveryTarget,
  type SourceDebugPhase,
  type SourceDebugPhaseCompletionMode,
  type SourceDebugPhaseEvidence,
  type SourceDebugPhaseSummary,
  type SourceDebugWorkerAttempt,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import {
  formatStatusLabel,
  splitCustomDiscoveryInstructions,
} from "./source-instructions";
import { warningSuggestsAuthRestriction } from "./source-instruction-evidence";
import { normalizeText, uniqueStrings } from "./shared";
import {
  canonicalizeRouteForReuse,
  resolveRouteKindForReuse,
} from "./workspace-source-intelligence";
import type { ResolvedDiscoveryAdapter } from "./workspace-defaults";
import { buildInstructionGuidance } from "./workspace-helpers";

export function buildSourceDebugPhasePacket(
  phase: SourceDebugPhase,
  phaseSummaries: readonly SourceDebugPhaseSummary[],
  strategyFingerprintHistory: readonly string[],
  manualPrerequisiteState: string | null,
) {
  const priorPhaseSummary =
    phaseSummaries[phaseSummaries.length - 1]?.summary ?? null;
  const knownFacts = uniqueStrings(
    phaseSummaries.flatMap((summary) => summary.confirmedFacts),
  );
  const phaseGoalByPhase: Record<SourceDebugPhase, string> = {
    access_auth_probe:
      "Verify whether the site is reachable, bounded to the hostname, and blocked by auth or consent.",
    site_structure_mapping:
      "Learn how this site works so a future search can use it well: whether it opens without a sign-in, where the job list lives and the best repeatable way to reach it, which search and filter controls really change results (and which mislead), how job pages are laid out and addressed, and how applying starts. Sample a few postings to prove each point; do not collect jobs for their own sake.",
    search_filter_probe:
      "Find search controls or filters that change the result set in a reliable way.",
    job_detail_validation:
      "Open multiple job details and confirm stable identity and canonical URLs.",
    apply_path_validation:
      "Check whether discovered jobs expose a stable apply path and capture safe apply guidance without submitting.",
    replay_verification:
      "Replay the learned guidance from scratch and prove it still reaches jobs and details.",
  };
  const successCriteriaByPhase: Record<SourceDebugPhase, string[]> = {
    access_auth_probe: [
      "Reach the target site safely",
      "Detect login or manual blockers honestly",
    ],
    site_structure_mapping: [
      "Say whether the site opens without a sign-in, and what it wants if not",
      "Find the best repeatable route to the job list and to a job's own page",
      "Prove at least one search, filter, pagination, or show-all control changes the result set, or say that none could be confirmed",
      "Say how applying starts (on the site, on the employer's site, or behind an account) without sending anything",
    ],
    search_filter_probe: [
      "Probe the obvious visible search box plus the first visible filters on the homepage and jobs/results route when those surfaces exist",
      "Prove at least one search, filter, recommendation route, pagination pattern, or result-expansion control changes the result set, or record that none could be confirmed",
      "Record stable search/filter behavior and any misleading or decorative controls",
    ],
    job_detail_validation: [
      "Open multiple job details",
      "Confirm stable job identity or URL patterns",
    ],
    apply_path_validation: [
      "Identify the apply path exposed by the source",
      "Record safe apply-entry guidance without submitting",
    ],
    replay_verification: [
      "Reach jobs again from scratch",
      "Open details and recover stable identity again",
    ],
  };
  const phaseStopConditionsByPhase: Partial<
    Record<SourceDebugPhase, string[]>
  > = {
    search_filter_probe: [
      "Do not stop before checking the obvious visible search controls and top-level filters unless auth or site protection blocks progress.",
      "If recommendation chips, curated collections, or show-all links are visible, check whether at least one leads to a reusable preselected list before stopping.",
    ],
  };

  return {
    phase,
    phaseGoal: phaseGoalByPhase[phase],
    knownFacts,
    priorPhaseSummary,
    avoidStrategyFingerprints: [...strategyFingerprintHistory],
    successCriteria: successCriteriaByPhase[phase],
    stopConditions: [
      "Stop when progress stalls and no new evidence is produced.",
      "Stop immediately if auth or a manual prerequisite blocks safe progress.",
      ...(phaseStopConditionsByPhase[phase] ?? []),
    ],
    manualPrerequisiteState,
    strategyLabel: formatStatusLabel(phase),
  };
}

export function composeSourceDebugInstructions(
  target: JobDiscoveryTarget,
  adapter: ResolvedDiscoveryAdapter,
  phase: SourceDebugPhase,
  instructionArtifact: SourceInstructionArtifact | null,
  phasePacket: ReturnType<typeof buildSourceDebugPhasePacket>,
): string[] {
  const phaseInstructionsByPhase: Record<SourceDebugPhase, string[]> = {
    access_auth_probe: [
      "Determine whether the site can be accessed normally or whether login, consent, or a manual prerequisite blocks progress.",
      "Do not guess credentials or attempt to bypass protected flows.",
    ],
    site_structure_mapping: [
      "Favor finding the main jobs landing page, results list, and detail path over collecting a large set of postings.",
      "If the starting page already lists jobs directly, treat that landing page as a valid jobs surface before assuming a separate jobs route is required.",
      "If the starting page is more general than a jobs page, first look for visible jobs, careers, openings, vacancies, or show-all entry paths.",
      "Inspect the first visible landing surface for top-of-page controls before using extracted jobs as proof of the best route.",
      "Record stable route patterns and navigation anchors.",
      "On jobs hubs that open on recommendation modules first, follow a reusable Show all or collection route before deciding the landing page is the best entry path.",
      "If the homepage or jobs route exposes recommendation rows, curated collections, or show-all links, check whether they lead to a reusable list path and record the best one.",
      "Before finishing, capture the best repeatable entry path to the jobs list, especially if it is not the homepage.",
    ],
    search_filter_probe: [
      "Prefer actions that change the result set in observable ways.",
      "Inspect the visible controls on the current landing surface before using extracted jobs as evidence that no search/filter UI exists.",
      "If the visible search or filter controls are likely above the current scroll position, return to the top of the page and probe them before concluding they are missing.",
      "Explicitly test the obvious search box and the first visible location, industry, category, or work-mode filters when they are present.",
      "On jobs landing pages that start with recommendation cards, follow Show all or a reusable collection first if that reveals the fuller search/filter surface.",
      "Prefer visible search boxes, buttons, chips, dropdowns, and filter bars over inventing URL parameter recipes. Only keep a direct URL pattern if the visible UI is blocked or genuinely less reliable.",
      "If the jobs page exposes recommendation chips, curated collections, or show-all links, test whether they open reusable preselected result lists.",
      "Record which search inputs, recommendation routes, filters, pagination controls, or infinite-scroll behaviors appear reliable.",
      "If a filter is hidden, locale-specific, resets unexpectedly, or appears not to affect results, record that as a site-specific gotcha.",
      "If a visible control looks promising but does not change jobs, say that explicitly instead of omitting it.",
      "Before finishing, either prove one reliable search/filter control or state clearly that no reliable control could be confirmed after trying alternatives.",
    ],
    job_detail_validation: [
      "Open multiple job detail pages and confirm stable identity hints before trusting extraction.",
      "Prefer canonical URLs over transient result-card state.",
      "Record whether job cards open inline, in-place, in a new page, or require a second click to reach the canonical detail view.",
    ],
    apply_path_validation: [
      "Focus on whether the source exposes an inline apply button, external apply link, or no usable apply path.",
      "Do not submit an application; only capture safe apply-entry guidance and blockers.",
      "If apply requires a specific button, modal, or redirect pattern, record that exact entry behavior.",
    ],
    replay_verification: [
      "Start fresh from the beginning and follow the learned guidance rather than exploratory behavior.",
      "Only treat the instructions as validated if they work again.",
    ],
  };

  return uniqueStrings([
    ...adapter.siteInstructions,
    ...buildInstructionGuidance(instructionArtifact),
    ...phaseInstructionsByPhase[phase],
    ...splitCustomDiscoveryInstructions(target.customInstructions),
    ...phasePacket.knownFacts.map((fact) => `Known fact: ${fact}`),
  ]);
}

/**
 * Where each source-check phase starts (ADR 0041): the routes the last review
 * recorded, grouped by the kind the model gave each one. No phrase in the
 * learned notes and no rule-picked search keyword decides it; from there the
 * agent searches and moves around the site itself.
 */
export function deriveSourceDebugStartingUrls(
  target: JobDiscoveryTarget,
  instructionArtifact: SourceInstructionArtifact | null,
  phase: SourceDebugPhase,
): string[] {
  if (phase === "access_auth_probe") {
    return [target.startingUrl];
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target.startingUrl);
  } catch {
    return [target.startingUrl];
  }
  const collection = instructionArtifact?.intelligence.collection;
  const routes = [
    ...(collection?.startingRoutes ?? []),
    ...(collection?.searchRouteTemplates ?? []),
  ].flatMap((route) => {
    const url = canonicalizeRouteForReuse(route.url, targetUrl);
    return url
      ? [{ url, kind: resolveRouteKindForReuse(url, route.kind) }]
      : [];
  });
  const ofKind = (...kinds: readonly string[]) =>
    routes
      .filter((route) => kinds.includes(route.kind))
      .map((route) => route.url);
  const collectionUrls = ofKind("collection");
  const searchUrls = ofKind("search");
  const landingUrls = ofKind("listing", "anchor");

  const preferredUrls =
    phase === "site_structure_mapping"
      ? [...collectionUrls, ...landingUrls, target.startingUrl, ...searchUrls]
      : phase === "search_filter_probe"
        ? searchUrls.length > 0
          ? [
              ...searchUrls,
              ...landingUrls,
              target.startingUrl,
              ...collectionUrls,
            ]
          : [...collectionUrls, ...landingUrls, target.startingUrl]
        : [
            ...collectionUrls,
            ...searchUrls,
            ...landingUrls,
            target.startingUrl,
          ];

  return uniqueStrings(preferredUrls);
}

export function classifySourceDebugAttemptOutcome(
  result: Awaited<
    ReturnType<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>
  >,
  phase: SourceDebugPhase,
): SourceDebugWorkerAttempt["outcome"] {
  // The agent's own typed ending comes first. Matching words in a warning
  // is how "no login required to view" became "Sign-in recommended".
  const completionMode = result.agentMetadata?.phaseCompletionMode ?? null;
  if (completionMode === "blocked_auth") {
    return "blocked_auth";
  }
  if (
    completionMode === "blocked_manual_step" ||
    completionMode === "blocked_site_protection"
  ) {
    return "blocked_manual_step";
  }
  if (completionMode === "structured_finish") {
    return result.warning ? "partial" : "succeeded";
  }
  const warning = (result.warning ?? "").toLowerCase();

  if (warning.includes("login") || warning.includes("session is not ready")) {
    return "blocked_auth";
  }

  if (warning.includes("manual") || warning.includes("consent")) {
    return "blocked_manual_step";
  }

  if (
    warning.includes("unsupported") ||
    warning.includes("stable identity") ||
    warning.includes("low-confidence")
  ) {
    return "unsupported_layout";
  }

  if (
    phase === "apply_path_validation" &&
    result.jobs.every((job) => job.applyPath === "unknown")
  ) {
    return warning ? "partial" : "exhausted_no_progress";
  }

  if (result.jobs.length === 0) {
    return phase === "replay_verification"
      ? "exhausted_no_progress"
      : "partial";
  }

  if (warning) {
    return "partial";
  }

  return "succeeded";
}

export function resolveSourceDebugCompletion(
  result: Awaited<
    ReturnType<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>
  >,
): {
  completionMode: SourceDebugPhaseCompletionMode;
  completionReason: string | null;
  phaseEvidence: SourceDebugPhaseEvidence | null;
} {
  const warning = result.warning ?? null;
  const metadata = result.agentMetadata;

  if (metadata?.phaseCompletionMode) {
    return {
      completionMode: metadata.phaseCompletionMode,
      completionReason: metadata.phaseCompletionReason ?? warning,
      phaseEvidence: metadata.phaseEvidence ?? null,
    };
  }

  const normalizedWarning = normalizeText(warning ?? "");

  if (
    normalizedWarning.includes("login") ||
    normalizedWarning.includes("session is not ready")
  ) {
    return {
      completionMode: "blocked_auth",
      completionReason: warning,
      phaseEvidence: metadata?.phaseEvidence ?? null,
    };
  }

  if (
    normalizedWarning.includes("manual") ||
    normalizedWarning.includes("consent")
  ) {
    return {
      completionMode: "blocked_manual_step",
      completionReason: warning,
      phaseEvidence: metadata?.phaseEvidence ?? null,
    };
  }

  if (normalizedWarning.includes("interrupted")) {
    return {
      completionMode: "interrupted",
      completionReason: warning,
      phaseEvidence: metadata?.phaseEvidence ?? null,
    };
  }

  if (warning) {
    return {
      completionMode:
        result.jobs.length > 0
          ? "timed_out_with_partial_evidence"
          : "runtime_failed",
      completionReason: warning,
      phaseEvidence: metadata?.phaseEvidence ?? null,
    };
  }

  return {
    completionMode: "structured_finish",
    completionReason: null,
    phaseEvidence: metadata?.phaseEvidence ?? null,
  };
}

export function buildSourceDebugPhaseSummary(
  attempt: SourceDebugWorkerAttempt,
): SourceDebugPhaseSummary {
  return SourceDebugPhaseSummarySchema.parse({
    phase: attempt.phase,
    summary: attempt.resultSummary,
    completionMode: attempt.completionMode,
    completionReason: attempt.completionReason,
    confirmedFacts: attempt.confirmedFacts,
    blockerNotes: attempt.blockerSummary ? [attempt.blockerSummary] : [],
    nextRecommendedStrategies: attempt.nextRecommendedStrategies,
    avoidStrategyFingerprints: attempt.avoidStrategyFingerprints,
    producedAttemptIds: [attempt.id],
    timing: attempt.timing,
  });
}

export function getSourceDebugTargetJobCount(phase: SourceDebugPhase): number {
  switch (phase) {
    case "access_auth_probe":
      return 1;
    case "site_structure_mapping":
      return 3;
    case "search_filter_probe":
      return 1;
    case "job_detail_validation":
    case "apply_path_validation":
    case "replay_verification":
      return 2;
    default:
      return 1;
  }
}

export function resolveSourceDebugPhases(_input: {
  target: JobDiscoveryTarget;
  instructionArtifact: SourceInstructionArtifact | null;
}): SourceDebugPhase[] {
  void _input;

  // One learning run, then one short replay. Six separate phases meant six
  // agent runs re-learning the same site, six restatements of the same
  // findings, and a quarter of an hour per check. The agent is told the
  // whole goal and decides the order (ADR 0023); the replay proves the
  // guidance it wrote reaches jobs from scratch, which is what "validated"
  // means.
  return ["site_structure_mapping", "replay_verification"];
}

export function getSourceDebugMaxSteps(
  phase: SourceDebugPhase,
  input?: {
    hasLearnedRouteHints?: boolean;
    hasPriorPhaseSummary?: boolean;
    hasExistingInstructionArtifact?: boolean;
  },
): number {
  const baseStepsByPhase: Record<SourceDebugPhase, number> = {
    access_auth_probe: 16,
    site_structure_mapping: 15,
    search_filter_probe: 18,
    job_detail_validation: 18,
    apply_path_validation: 18,
    replay_verification: 18,
  };
  const minimumStepsByPhase: Record<SourceDebugPhase, number> = {
    access_auth_probe: 16,
    site_structure_mapping: 10,
    search_filter_probe: 10,
    job_detail_validation: 12,
    apply_path_validation: 12,
    replay_verification: 10,
  };

  const totalReduction =
    (phase !== "access_auth_probe" && input?.hasLearnedRouteHints
      ? phase === "search_filter_probe"
        ? 6
        : 4
      : 0) +
    (phase !== "access_auth_probe" && input?.hasPriorPhaseSummary
      ? phase === "search_filter_probe"
        ? 2
        : 1
      : 0) +
    (input?.hasExistingInstructionArtifact && phase === "replay_verification"
      ? 4
      : 0) +
    (input?.hasExistingInstructionArtifact &&
    (phase === "job_detail_validation" || phase === "apply_path_validation")
      ? 2
      : 0);
  const maxSteps = baseStepsByPhase[phase] - totalReduction;

  // The minimum clamp is load-bearing; if future deltas change, keep the reduction math and
  // these minimums aligned so phase budgets stay readable and safe.
  return Math.max(minimumStepsByPhase[phase], maxSteps);
}

export function shouldFinishSourceDebugEarly(input: {
  attempts: readonly SourceDebugWorkerAttempt[];
  currentPhase: SourceDebugPhase;
}): boolean {
  if (input.currentPhase === "access_auth_probe") {
    return false;
  }

  const byPhase = new Map(
    input.attempts.map((attempt) => [attempt.phase, attempt]),
  );
  const accessAttempt = byPhase.get("access_auth_probe");
  const structureAttempt = byPhase.get("site_structure_mapping");
  const searchAttempt = byPhase.get("search_filter_probe");
  const detailAttempt = byPhase.get("job_detail_validation");

  const structureProven =
    structureAttempt?.outcome === "succeeded" ||
    structureAttempt?.completionMode === "forced_finish";
  const searchProven =
    searchAttempt?.outcome === "succeeded" ||
    searchAttempt?.completionMode === "forced_finish";
  const detailProven =
    detailAttempt?.outcome === "succeeded" ||
    detailAttempt?.completionMode === "forced_finish";

  // This helper only runs for job_detail_validation and apply_path_validation. For auth-restricted
  // sources, a blocking auth probe is enough to skip replay/apply once structure, search, and detail
  // are proven. For non-restricted sources, we only finish early after successful access plus apply proof.
  if (input.currentPhase === "job_detail_validation") {
    if (
      !accessAttempt ||
      !warningSuggestsAuthRestriction(accessAttempt.blockerSummary)
    ) {
      return false;
    }

    return structureProven && searchProven && detailProven;
  }

  if (
    input.currentPhase !== "apply_path_validation" &&
    input.currentPhase !== "replay_verification"
  ) {
    return false;
  }

  const applyAttempt = byPhase.get("apply_path_validation");
  const applyProven = applyAttempt?.completionMode === "forced_finish";
  const replayAttempt = byPhase.get("replay_verification");
  const replayFailedWithoutNewEvidence =
    replayAttempt?.outcome === "exhausted_no_progress" ||
    replayAttempt?.completionMode === "timed_out_with_partial_evidence";

  if (!accessAttempt || accessAttempt.outcome !== "succeeded") {
    return false;
  }

  if (input.currentPhase === "replay_verification") {
    return (
      structureProven &&
      searchProven &&
      detailProven &&
      replayFailedWithoutNewEvidence
    );
  }

  return structureProven && searchProven && detailProven && applyProven;
}
