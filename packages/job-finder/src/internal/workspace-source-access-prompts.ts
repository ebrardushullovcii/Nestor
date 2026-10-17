import {
  JOB_FINDER_BROWSER_LABEL,
  type JobDiscoveryTarget,
  type JobFinderWorkspaceSnapshot,
  type SourceAccessPrompt,
  type SourceDebugRunRecord,
  type SourceDebugWorkerAttempt,
  type SourceInstructionArtifact,
} from "@nordri/contracts";
import { warningSuggestsAuthRestriction } from "./source-instruction-evidence";
import { buildDiscoveryStartingUrls } from "./workspace-source-intelligence";
import { resolveActiveSourceInstructionArtifact } from "./workspace-helpers";
import { uniqueStrings } from "./shared";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function includesAny(
  normalized: string,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => normalized.includes(candidate));
}

function isLoginImprovementSignal(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);

  if (!normalized) {
    return false;
  }

  if (warningSuggestsAuthRestriction(normalized)) {
    return true;
  }

  return includesAny(normalized, [
    "broader access",
    "broader visibility",
    "broader coverage",
    "broader results",
    "sign in prompts",
    "sign in is needed",
    "sign-in is needed",
    "sign in is recommended",
    "sign-in is recommended",
    "login improves",
    "login unlocks",
    "guest session has limited visibility",
    "guest access is limited",
    "auth-limited",
    "authenticated surface",
    "authenticated view",
    "logged in",
  ]);
}

function isHardLoginRequirement(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);

  if (!normalized) {
    return false;
  }

  return includesAny(normalized, [
    "login required",
    "sign in first",
    "sign in before",
    "authentication required",
    "requires login",
    "requires authentication",
    "session is not ready",
    "no guest access",
    "hidden behind a sign in",
    "gated behind authentication",
    "without being logged in",
    "without target site account",
  ]);
}

function summarizePrompt(input: {
  target: JobDiscoveryTarget;
  state: SourceAccessPrompt["state"];
}): { summary: string; actionLabel: string; rerunLabel: string } {
  const targetLabel = input.target.label.trim();

  if (input.state === "prompt_login_required") {
    return {
      summary: `Sign in to ${targetLabel} before the next search can continue.`,
      actionLabel: `Sign in to ${targetLabel}`,
      rerunLabel: "Search again after sign-in",
    };
  }

  // One name for that window everywhere it is mentioned, shared with the
  // desktop copy that renders this prompt: a review found it called four
  // different things across four screens.
  return {
    summary: `Open the ${JOB_FINDER_BROWSER_LABEL} for ${targetLabel} if you want better search coverage on the next run.`,
    actionLabel: `Open the ${JOB_FINDER_BROWSER_LABEL} for ${targetLabel}`,
    rerunLabel: "Search again for fuller results",
  };
}

export function deriveSourceAccessPrompts(input: {
  targets: readonly JobDiscoveryTarget[];
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  activeSourceDebugRun: SourceDebugRunRecord | null;
  sourceDebugAttempts: readonly SourceDebugWorkerAttempt[];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
  searchPreferences: JobFinderWorkspaceSnapshot["searchPreferences"];
  generatedAt: string;
}): SourceAccessPrompt[] {
  const attemptsByRunId = new Map<string, SourceDebugWorkerAttempt[]>();

  for (const attempt of input.sourceDebugAttempts) {
    const existingAttempts = attemptsByRunId.get(attempt.runId) ?? [];
    existingAttempts.push(attempt);
    attemptsByRunId.set(attempt.runId, existingAttempts);
  }

  return input.targets.flatMap<SourceAccessPrompt>((target) => {
    const activeInstruction = resolveActiveSourceInstructionArtifact(
      target,
      input.sourceInstructionArtifacts,
    );
    const latestRun = target.lastDebugRunId
      ? input.activeSourceDebugRun?.id === target.lastDebugRunId
        ? input.activeSourceDebugRun
        : (input.recentSourceDebugRuns.find(
            (run) => run.id === target.lastDebugRunId,
          ) ?? null)
      : null;
    const targetAttempts = latestRun
      ? (attemptsByRunId.get(latestRun.id) ?? [])
      : [];
    const hardLoginSignals = uniqueStrings(
      [
        ...(latestRun?.state === "paused_manual" &&
        latestRun.manualPrerequisiteSummary
          ? [latestRun.manualPrerequisiteSummary]
          : []),
        ...targetAttempts.flatMap((attempt) =>
          attempt.outcome === "blocked_auth"
            ? [attempt.blockerSummary, attempt.resultSummary]
            : [attempt.blockerSummary],
        ),
        ...(activeInstruction?.intelligence.apply.authMarkers ?? []),
        ...(activeInstruction?.warnings ?? []),
      ].filter((value): value is string => Boolean(value)),
    );
    // Only what the check itself called a blocker or an auth marker. A
    // finding that says "no login required to view" mentions login too, and
    // read as a signal it produced a "Sign-in recommended" header over a body
    // saying the opposite.
    const recommendationSignals = uniqueStrings(
      [
        ...targetAttempts.flatMap((attempt) => [attempt.blockerSummary]),
        ...(activeInstruction?.intelligence.apply.authMarkers ?? []),
      ].filter((value): value is string => Boolean(value)),
    );

    const requiredDetail =
      hardLoginSignals.find(isHardLoginRequirement) ?? null;
    // Resolving learned routes parses every URL a source has learned; most of
    // hundreds of sources need no prompt, so it waits until one is due.
    const learnedStartingUrls = () =>
      buildDiscoveryStartingUrls(target, activeInstruction);
    const updatedAt =
      latestRun?.updatedAt ?? activeInstruction?.updatedAt ?? input.generatedAt;

    if (requiredDetail) {
      const promptCopy = summarizePrompt({
        target,
        state: "prompt_login_required",
      });

      return [
        {
          targetId: target.id,
          targetLabel: target.label,
          targetUrl: learnedStartingUrls()[0] ?? target.startingUrl,
          state: "prompt_login_required" as const,
          summary: promptCopy.summary,
          detail: requiredDetail,
          actionLabel: promptCopy.actionLabel,
          rerunLabel: promptCopy.rerunLabel,
          updatedAt,
        },
      ];
    }

    const recommendationDetail = recommendationSignals.find(
      isLoginImprovementSignal,
    );

    if (!recommendationDetail) {
      return [];
    }

    const startingUrls = learnedStartingUrls();
    if (startingUrls.length === 0) {
      return [];
    }

    const promptCopy = summarizePrompt({
      target,
      state: "prompt_login_recommended",
    });

    return [
      {
        targetId: target.id,
        targetLabel: target.label,
        targetUrl: startingUrls[0] ?? target.startingUrl,
        state: "prompt_login_recommended" as const,
        summary: promptCopy.summary,
        detail: recommendationDetail,
        actionLabel: promptCopy.actionLabel,
        rerunLabel: promptCopy.rerunLabel,
        updatedAt,
      },
    ];
  });
}

export function resolveSourceBrowserEntryUrl(input: {
  target: JobDiscoveryTarget;
  searchPreferences: JobFinderWorkspaceSnapshot["searchPreferences"];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
}): string {
  const activeInstruction = resolveActiveSourceInstructionArtifact(
    input.target,
    input.sourceInstructionArtifacts,
  );
  const startingUrls = buildDiscoveryStartingUrls(
    input.target,
    activeInstruction,
  );

  return startingUrls[0] ?? input.target.startingUrl;
}
