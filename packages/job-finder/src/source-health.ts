import type {
  DiscoveryTargetExecutionState,
  SourceInstructionStatus,
} from "@nestor/contracts";

/**
 * Canonical source-health interpretation shared by the Home dashboard
 * projection (`internal/campaign-dashboard.ts`) and the Profile Job sources
 * library. Keep this module dependency-free (types only) so the main process
 * and the renderer bundle classify sources identically.
 *
 * Health is reported for enabled sources only: disabled sources never inflate
 * active health counts. They stay visible through their own Enabled/Disabled
 * labels and guidance status lines instead.
 */

export type DiscoverySourceHealthFields = {
  id: string;
  enabled: boolean;
  instructionStatus: SourceInstructionStatus;
  lastVerifiedAt: string | null;
  staleReason: string | null;
};

/** Every concrete, truthful reason an enabled source needs attention. */
export type SourceAttentionReason =
  | "failing"
  | "never_verified"
  | "guidance_stale"
  | "guidance_unsupported"
  | "login_required";

export type SourceRuntimeSignals = {
  /** Presence proves use; absence is unknown because run history is bounded. */
  usedTargetIds?: ReadonlySet<string>;
  latestExecutions?: ReadonlyMap<
    string,
    DiscoveryRunHealthFields["targetExecutions"][number]
  >;
  /** Targets with an in-flight execution in the active discovery run. */
  runningTargetIds?: ReadonlySet<string>;
  /** Targets with an open `prompt_login_required` access prompt. */
  loginRequiredTargetIds?: ReadonlySet<string>;
  /**
   * Targets that failed several runs in a row. Derive this with
   * `deriveRepeatedlyFailingTargetIds`; it is how a repeatedly failing source
   * is reported instead of pausing the plan it belongs to.
   */
  repeatedlyFailingTargetIds?: ReadonlySet<string>;
  /**
   * Targets whose latest discovery execution completed successfully. A
   * source that guidance verification never touched but that just returned
   * a completed run is proven working, so it is not "never verified".
   * Derive this with `deriveSucceededDiscoveryTargetIds`.
   */
  succeededTargetIds?: ReadonlySet<string>;
};

/** The minimal discovery-run shape needed to judge per-source success. */
export type DiscoveryRunHealthFields = {
  targetExecutions: readonly {
    targetId: string;
    state: DiscoveryTargetExecutionState;
    startedAt: string | null;
    completedAt: string | null;
    jobsFound?: number;
    duplicatesMerged?: number;
    /** Listings skipped because an earlier unchanged search already kept them. */
    jobsSkippedByLedger?: number;
    /** The execution's own failure text, when it failed. */
    warning?: string | null;
  }[];
};

/** A terminal source counts as completed only when its execution succeeded. */
export function deriveDiscoverySourceOutcome(run: DiscoveryRunHealthFields): {
  completed: number;
  planned: number;
} {
  return {
    completed: run.targetExecutions.filter(
      (execution) => execution.state === "completed",
    ).length,
    planned: run.targetExecutions.length,
  };
}

/**
 * Collect the targets whose most recent discovery execution across the given
 * runs finished in the `completed` state. Only the latest execution per
 * target counts, so a later failure or cancellation withdraws the proof. Pass
 * the active run first when one exists so its finished executions win over
 * older history.
 */
export function deriveSucceededDiscoveryTargetIds(
  runs: readonly DiscoveryRunHealthFields[],
): Set<string> {
  const latestByTarget = new Map<
    string,
    { at: string; state: DiscoveryTargetExecutionState }
  >();

  for (const run of runs) {
    for (const execution of run.targetExecutions) {
      if (execution.state === "planned" || execution.state === "running") {
        continue;
      }
      const at = execution.completedAt ?? execution.startedAt ?? "";
      const current = latestByTarget.get(execution.targetId);
      if (!current || at > current.at) {
        latestByTarget.set(execution.targetId, { at, state: execution.state });
      }
    }
  }

  const succeeded = new Set<string>();
  for (const [targetId, latest] of latestByTarget) {
    if (latest.state === "completed") {
      succeeded.add(targetId);
    }
  }
  return succeeded;
}

/**
 * How many failures in a row make one source worth a person's attention.
 *
 * A source that fails twice running is reported here, on the source, rather
 * than by pausing the whole search plan. The plan keeps running with the
 * sources that still work.
 */
export const SOURCE_REPEATED_FAILURE_RUNS = 2;

/**
 * The sources whose last few executions were failures, newest run first.
 *
 * Pass the runs newest first (the active run ahead of history), the way the
 * other helpers here are passed. A source with fewer recorded executions than
 * the minimum cannot qualify.
 */
export function deriveRepeatedlyFailingTargetIds(
  runsNewestFirst: readonly DiscoveryRunHealthFields[],
  minimumConsecutiveFailures: number = SOURCE_REPEATED_FAILURE_RUNS,
): Set<string> {
  const streaks = new Map<string, { failures: number; broken: boolean }>();

  for (const run of runsNewestFirst) {
    for (const execution of run.targetExecutions) {
      if (execution.state === "planned" || execution.state === "running") {
        continue;
      }
      const current = streaks.get(execution.targetId) ?? {
        failures: 0,
        broken: false,
      };
      if (current.broken) continue;
      // A run-side failure (network, time) neither counts against the site
      // nor ends its streak.
      if (execution.state === "failed" && !failedOnSite(execution)) continue;
      if (execution.state === "failed") {
        streaks.set(execution.targetId, {
          failures: current.failures + 1,
          broken: false,
        });
        continue;
      }
      streaks.set(execution.targetId, { ...current, broken: true });
    }
  }

  const repeatedly = new Set<string>();
  for (const [targetId, streak] of streaks) {
    if (streak.failures >= Math.max(1, minimumConsecutiveFailures)) {
      repeatedly.add(targetId);
    }
  }
  return repeatedly;
}

export type EnabledSourceHealthState =
  | "running"
  | "needs_attention"
  | "healthy";

export type EnabledSourceHealthCounts = {
  healthy: number;
  needsAttention: number;
  running: number;
  total: number;
};

// "fetch failed" and "API request timed out" are this computer's connection
// or a busy search, not the site: one 900-source search left 663 sources
// failing with them, and Home called every one broken. A job board feed that
// fails for a passing reason says it "is tried again on the next search".
const RUN_SIDE_FAILURE_PATTERN =
  /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|fetch failed|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|did not answer in time|could not be reached|tried again on the next search|ran out of time|was stopped/iu;

/** A failure that says something about the site rather than this run. */
function failedOnSite(execution: {
  state: DiscoveryTargetExecutionState;
  warning?: string | null;
}): boolean {
  return (
    execution.state === "failed" &&
    !RUN_SIDE_FAILURE_PATTERN.test(execution.warning ?? "")
  );
}

export function listSourceAttentionReasons(
  target: DiscoverySourceHealthFields,
  signals: SourceRuntimeSignals = {},
): SourceAttentionReason[] {
  const reasons: SourceAttentionReason[] = [];

  const latestExecution = signals.latestExecutions?.get(target.id);
  // A search that lost the network or ran out of time says nothing about
  // the site itself; only a failure on the site counts against it.
  if (
    target.staleReason ||
    (latestExecution && failedOnSite(latestExecution)) ||
    signals.repeatedlyFailingTargetIds?.has(target.id)
  ) {
    reasons.push("failing");
  }
  // A search that ran to the end and found no new jobs is not a problem with
  // the source: it may have listed only jobs already saved, or the site had
  // none today. The outcome sentence says which; Home stays neutral too.
  // A source that was never checked is not a problem: checks are optional
  // guidance (ADR 0024) and searches use unchecked sources as they are.
  if (target.instructionStatus === "stale") {
    reasons.push("guidance_stale");
  }
  if (target.instructionStatus === "unsupported") {
    reasons.push("guidance_unsupported");
  }
  if (signals.loginRequiredTargetIds?.has(target.id)) {
    reasons.push("login_required");
  }

  return reasons;
}

/**
 * Classify an enabled source. Running wins over attention so an in-flight
 * execution is never double-reported as unhealthy.
 */
export function classifyEnabledSourceHealth(
  target: DiscoverySourceHealthFields,
  signals: SourceRuntimeSignals = {},
): EnabledSourceHealthState {
  if (target.enabled && signals.runningTargetIds?.has(target.id)) {
    return "running";
  }

  return listSourceAttentionReasons(target, signals).length > 0
    ? "needs_attention"
    : "healthy";
}

/** True only for enabled sources; disabled sources are never attention. */
export function isEnabledSourceNeedingAttention(
  target: DiscoverySourceHealthFields,
  signals: SourceRuntimeSignals = {},
): boolean {
  return (
    target.enabled &&
    classifyEnabledSourceHealth(target, signals) === "needs_attention"
  );
}

/**
 * Fold health counts across targets. Disabled sources are excluded, so
 * `total` is the honest denominator of enabled sources in the search plan.
 */
export function deriveEnabledSourceHealthCounts(
  targets: readonly DiscoverySourceHealthFields[],
  signals: SourceRuntimeSignals = {},
): EnabledSourceHealthCounts {
  const counts: EnabledSourceHealthCounts = {
    healthy: 0,
    needsAttention: 0,
    running: 0,
    total: 0,
  };

  for (const target of targets) {
    if (!target.enabled) {
      continue;
    }

    counts.total += 1;

    switch (classifyEnabledSourceHealth(target, signals)) {
      case "running":
        counts.running += 1;
        break;
      case "needs_attention":
        counts.needsAttention += 1;
        break;
      default:
        counts.healthy += 1;
        break;
    }
  }

  return counts;
}

/**
 * One classification with a plain-language reason so every surface (Home
 * dashboard, Profile job sources) can say the same thing about the same
 * source instead of showing a bare badge that contradicts another screen.
 */
export type EnabledSourceHealthDescription = {
  reason: string;
  reasons: readonly SourceAttentionReason[];
  state: EnabledSourceHealthState;
};

function describeAttentionReason(
  reason: SourceAttentionReason,
  target: DiscoverySourceHealthFields,
): string {
  switch (reason) {
    case "failing":
      return target.staleReason
        ? `The last check reported a problem: ${target.staleReason}`
        : "The last check reported a problem.";
    case "login_required":
      return "This source is waiting for you to sign in.";
    case "guidance_stale":
      return "Saved guidance for this source is out of date.";
    case "guidance_unsupported":
      return "Job Finder could not read this site's job listings: its page layout is not one Job Finder recognises yet.";
    default:
      return "Earlier search usage is unknown. This source has not been verified yet.";
  }
}

/**
 * The failed-search sentence, with the one fact the person can act on when
 * the failure names an HTTP status: a missing page needs a corrected
 * address, and searching again will not fix it.
 */
function describeFailedSearch(warning: string | null): string {
  const status = Number(/\bHTTP (\d{3})\b/u.exec(warning ?? "")?.[1]);
  if (status === 404 || status === 410) {
    return `The latest search failed: this address answered HTTP ${status} (page not found). Check the address with Edit.`;
  }
  if (status >= 500 && status < 600) {
    return `The latest search failed: the site answered HTTP ${status} (a server error). Search again later.`;
  }
  return "The latest search failed.";
}

export function describeEnabledSourceHealth(
  target: DiscoverySourceHealthFields,
  signals: SourceRuntimeSignals = {},
): EnabledSourceHealthDescription {
  if (target.enabled && signals.runningTargetIds?.has(target.id)) {
    return {
      reason: "A search is using this source right now.",
      reasons: [],
      state: "running",
    };
  }

  const reasons = listSourceAttentionReasons(target, signals);
  const latest = signals.latestExecutions?.get(target.id);
  // Listings a quiet re-run skipped because they are already kept are
  // already saved too; leaving them out is what made that re-run read as
  // "0 jobs found".
  const alreadySavedCount =
    (latest?.duplicatesMerged ?? 0) + (latest?.jobsSkippedByLedger ?? 0);
  const outcome = signals.loginRequiredTargetIds?.has(target.id)
    ? "Blocked: waiting for you to sign in."
    : latest?.state === "completed"
      ? latest.jobsFound === undefined
        ? "Completed; job count not recorded."
        : latest.jobsFound === 0 && alreadySavedCount > 0
          ? `Completed, ${alreadySavedCount} ${alreadySavedCount === 1 ? "listing" : "listings"} found; ${alreadySavedCount === 1 ? "it was" : "all were"} already saved.`
          : latest.jobsFound === 0
            ? "Completed, no jobs kept."
            : `Readable · ${latest.jobsFound} ${latest.jobsFound === 1 ? "job" : "jobs"} kept.`
      : latest?.state === "failed"
        ? describeFailedSearch(latest.warning ?? null)
        : latest?.state === "cancelled"
          ? "The latest search was stopped."
          : null;
  if (outcome) {
    const guidance = reasons
      .filter(
        (reason) =>
          reason !== "login_required" &&
          !(reason === "failing" && !target.staleReason),
      )
      .map((reason) => describeAttentionReason(reason, target));
    return {
      reason: [outcome, ...guidance].join(" "),
      reasons,
      state: reasons.length ? "needs_attention" : "healthy",
    };
  }
  const firstReason = reasons[0];
  if (firstReason) {
    return {
      reason: describeAttentionReason(firstReason, target),
      reasons,
      state: "needs_attention",
    };
  }

  return {
    reason: signals.succeededTargetIds?.has(target.id)
      ? "The latest search used this source successfully."
      : target.lastVerifiedAt || signals.usedTargetIds?.has(target.id)
        ? "Checked and working."
        : "Not checked yet. Searches can still use it.",
    reasons,
    state: "healthy",
  };
}

/** The workspace facts both surfaces need to classify sources identically. */
export type SourceHealthSignalInput = {
  activeRun?: DiscoveryRunHealthFields | null | undefined;
  recentRuns?: readonly DiscoveryRunHealthFields[] | undefined;
  sourceAccessPrompts?:
    | readonly { state: string; targetId: string }[]
    | undefined;
};

/**
 * Builds the exact signal set the dashboard uses. Home and Profile disagreed
 * because only one of them derived succeeded-run proof, so a source that had
 * just returned jobs still read as "never verified" on the other screen.
 * Both surfaces must build their signals here.
 */
export function deriveSourceHealthSignals(
  input: SourceHealthSignalInput,
): SourceRuntimeSignals {
  const activeRuns = input.activeRun ? [input.activeRun] : [];
  const usedTargetIds = new Set<string>();
  const latestExecutions = new Map<
    string,
    DiscoveryRunHealthFields["targetExecutions"][number]
  >();
  for (const run of [...activeRuns, ...(input.recentRuns ?? [])]) {
    for (const execution of run.targetExecutions) {
      if (
        execution.state === "planned" ||
        (execution.state === "skipped" && !execution.startedAt)
      )
        continue;
      usedTargetIds.add(execution.targetId);
      if (execution.state === "running") continue;
      const previous = latestExecutions.get(execution.targetId);
      if (
        !previous ||
        (execution.completedAt ?? execution.startedAt ?? "") >
          (previous.completedAt ?? previous.startedAt ?? "")
      ) {
        latestExecutions.set(execution.targetId, execution);
      }
    }
  }

  return {
    usedTargetIds,
    latestExecutions,
    loginRequiredTargetIds: new Set(
      (input.sourceAccessPrompts ?? [])
        .filter((prompt) => prompt.state === "prompt_login_required")
        .map((prompt) => prompt.targetId),
    ),
    runningTargetIds: new Set(
      input.activeRun?.targetExecutions
        .filter((execution) => execution.state === "running")
        .map((execution) => execution.targetId) ?? [],
    ),
    // A source that failed several runs running is reported here rather than
    // by pausing the plan it belongs to.
    repeatedlyFailingTargetIds: deriveRepeatedlyFailingTargetIds([
      ...activeRuns,
      ...(input.recentRuns ?? []),
    ]),
    // The active run is listed first so its already-finished executions win
    // over older history for the same target.
    succeededTargetIds: deriveSucceededDiscoveryTargetIds([
      ...activeRuns,
      ...(input.recentRuns ?? []),
    ]),
  };
}

/** The fields of a source check this row needs. */
export type SourceCheckHealthFields = {
  targetId: string;
  state: string;
  startedAt: string;
  completedAt: string | null;
  finalSummary: string | null;
};

/**
 * The newest "Check source" run for a source, as one line, when it is newer
 * than the source's last search. A row that kept showing the last search
 * line after a check read as if the check had done nothing.
 */
export function describeLatestSourceCheck(
  target: { id: string },
  checks: readonly SourceCheckHealthFields[],
  latestSearch?: {
    completedAt?: string | null;
    startedAt?: string | null;
  } | null,
): string | null {
  const latest = checks
    .filter((check) => check.targetId === target.id)
    .sort((left, right) =>
      (right.completedAt ?? right.startedAt).localeCompare(
        left.completedAt ?? left.startedAt,
      ),
    )[0];
  if (!latest) return null;
  const checkedAt = latest.completedAt ?? latest.startedAt;
  const searchedAt = latestSearch?.completedAt ?? latestSearch?.startedAt ?? "";
  if (latest.state !== "running" && searchedAt > checkedAt) return null;
  const summary = latest.finalSummary?.trim();
  switch (latest.state) {
    case "running":
      return "Checking this source now.";
    case "completed":
      return summary ? `Latest check: ${summary}` : "Latest check finished.";
    case "failed":
      return summary
        ? `The latest check failed: ${summary}`
        : "The latest check failed.";
    case "cancelled":
    case "interrupted":
      return "The latest check was stopped before it finished.";
    default:
      return null;
  }
}
