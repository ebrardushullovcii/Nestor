import { describe, expect, test } from "vitest";

import {
  classifyEnabledSourceHealth,
  deriveEnabledSourceHealthCounts,
  deriveRepeatedlyFailingTargetIds,
  deriveDiscoverySourceOutcome,
  deriveSourceHealthSignals,
  deriveSucceededDiscoveryTargetIds,
  describeEnabledSourceHealth,
  isEnabledSourceNeedingAttention,
  listSourceAttentionReasons,
  type DiscoveryRunHealthFields,
  type DiscoverySourceHealthFields,
  type SourceRuntimeSignals,
  describeLatestSourceCheck,
  type SourceCheckHealthFields,
} from "./source-health";
import type {
  DiscoveryTargetExecutionState,
  SourceInstructionStatus,
} from "@nestor/contracts";

function run(
  executions: readonly {
    targetId: string;
    state: DiscoveryTargetExecutionState;
    completedAt?: string | null;
    startedAt?: string | null;
  }[],
): DiscoveryRunHealthFields {
  return {
    targetExecutions: executions.map((execution) => ({
      targetId: execution.targetId,
      state: execution.state,
      startedAt: execution.startedAt ?? null,
      completedAt: execution.completedAt ?? null,
    })),
  };
}

const VERIFIED_AT = "2026-08-20T09:00:00.000Z";

test("failed sources are terminal but never counted as completed", () => {
  expect(
    deriveDiscoverySourceOutcome(
      run([
        { targetId: "one", state: "completed" },
        { targetId: "two", state: "completed" },
        { targetId: "three", state: "failed" },
      ]),
    ),
  ).toEqual({ completed: 2, planned: 3 });
});

function source(
  overrides: Partial<DiscoverySourceHealthFields> & {
    id?: string;
  } = {},
): DiscoverySourceHealthFields {
  return {
    id: overrides.id ?? "target_001",
    enabled: true,
    instructionStatus: "missing" as SourceInstructionStatus,
    lastVerifiedAt: null,
    staleReason: null,
    ...overrides,
  };
}

function signals(
  overrides: Partial<{
    running: readonly string[];
    loginRequired: readonly string[];
  }> = {},
): SourceRuntimeSignals {
  return {
    runningTargetIds: new Set(overrides.running ?? []),
    loginRequiredTargetIds: new Set(overrides.loginRequired ?? []),
  };
}

describe("source health classification", () => {
  test("a healthy verified source needs no attention", () => {
    const target = source({
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
    });

    expect(listSourceAttentionReasons(target)).toEqual([]);
    expect(classifyEnabledSourceHealth(target)).toBe("healthy");
    expect(isEnabledSourceNeedingAttention(target)).toBe(false);
  });

  test("an enabled never-run source is healthy: checks are optional", () => {
    const target = source();

    expect(listSourceAttentionReasons(target)).toEqual([]);
    expect(classifyEnabledSourceHealth(target)).toBe("healthy");
  });

  test("draft guidance alone is not a problem", () => {
    const target = source({ instructionStatus: "draft" });

    expect(listSourceAttentionReasons(target)).toEqual([]);
    expect(classifyEnabledSourceHealth(target)).toBe("healthy");
  });

  test("failing verification marks the source for attention", () => {
    const target = source({
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
      staleReason: "Starting page URL changed.",
    });

    expect(listSourceAttentionReasons(target)).toEqual(["failing"]);
    expect(classifyEnabledSourceHealth(target)).toBe("needs_attention");
  });

  test("stale guidance marks the source for attention", () => {
    const target = source({
      instructionStatus: "stale",
      lastVerifiedAt: VERIFIED_AT,
    });

    expect(listSourceAttentionReasons(target)).toEqual(["guidance_stale"]);
    expect(classifyEnabledSourceHealth(target)).toBe("needs_attention");
  });

  test("unsupported guidance marks the source for attention", () => {
    const target = source({
      instructionStatus: "unsupported",
      lastVerifiedAt: VERIFIED_AT,
    });

    expect(listSourceAttentionReasons(target)).toEqual([
      "guidance_unsupported",
    ]);
    expect(classifyEnabledSourceHealth(target)).toBe("needs_attention");
  });

  test("a required sign-in prompt marks the source for attention", () => {
    const target = source({
      id: "target_login",
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
    });

    expect(
      listSourceAttentionReasons(
        target,
        signals({ loginRequired: ["target_login"] }),
      ),
    ).toEqual(["login_required"]);
    expect(
      classifyEnabledSourceHealth(
        target,
        signals({ loginRequired: ["target_login"] }),
      ),
    ).toBe("needs_attention");
  });

  test("an optional sign-in recommendation is not attention", () => {
    const target = source({
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
    });

    // Only `prompt_login_required` ids are ever passed in; recommended
    // prompts must stay informational.
    expect(listSourceAttentionReasons(target, signals())).toEqual([]);
    expect(classifyEnabledSourceHealth(target, signals())).toBe("healthy");
  });

  test("running wins over attention so active work is not double-reported", () => {
    const unverifiedRunning = source({ id: "target_run" });
    const healthyRunning = source({
      id: "target_run_healthy",
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
    });
    const runSignals = signals({
      running: ["target_run", "target_run_healthy"],
    });

    expect(classifyEnabledSourceHealth(unverifiedRunning, runSignals)).toBe(
      "running",
    );
    expect(isEnabledSourceNeedingAttention(unverifiedRunning, runSignals)).toBe(
      false,
    );
    expect(classifyEnabledSourceHealth(healthyRunning, runSignals)).toBe(
      "running",
    );
  });

  test("disabled sources never need attention regardless of their problems", () => {
    const disabledNeverRun = source({ enabled: false });
    const disabledFailing = source({
      enabled: false,
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
      staleReason: "Starting page URL changed.",
    });
    const disabledLogin = source({
      id: "target_disabled_login",
      enabled: false,
      instructionStatus: "validated",
      lastVerifiedAt: VERIFIED_AT,
    });

    for (const target of [disabledNeverRun, disabledFailing]) {
      expect(isEnabledSourceNeedingAttention(target)).toBe(false);
    }
    expect(
      isEnabledSourceNeedingAttention(
        disabledLogin,
        signals({ loginRequired: ["target_disabled_login"] }),
      ),
    ).toBe(false);
  });

  test("counts fold over enabled sources with honest denominators", () => {
    const targets = [
      // Enabled: one healthy, four needing attention.
      source({
        id: "target_healthy",
        instructionStatus: "validated",
        lastVerifiedAt: VERIFIED_AT,
      }),
      source({ id: "target_never_run" }),
      source({
        id: "target_failing",
        instructionStatus: "validated",
        lastVerifiedAt: VERIFIED_AT,
        staleReason: "Verification failed.",
      }),
      source({
        id: "target_unsupported",
        instructionStatus: "unsupported",
        lastVerifiedAt: VERIFIED_AT,
      }),
      source({
        id: "target_login",
        instructionStatus: "validated",
        lastVerifiedAt: VERIFIED_AT,
      }),
      // Disabled: excluded from every bucket.
      source({ id: "target_disabled_never_run", enabled: false }),
      source({
        id: "target_disabled_failing",
        enabled: false,
        instructionStatus: "validated",
        lastVerifiedAt: VERIFIED_AT,
        staleReason: "Verification failed.",
      }),
    ];

    const counts = deriveEnabledSourceHealthCounts(
      targets,
      signals({ loginRequired: ["target_login"] }),
    );

    expect(counts).toEqual({
      healthy: 2,
      needsAttention: 3,
      running: 0,
      total: 5,
    });
  });

  test("first-run workspace with a single never-run source is healthy", () => {
    const counts = deriveEnabledSourceHealthCounts([source()]);

    expect(counts).toEqual({
      healthy: 1,
      needsAttention: 0,
      running: 0,
      total: 1,
    });
  });

  test("a never-verified source whose latest discovery run succeeded is healthy", () => {
    const target = source({ id: "target_fresh" });
    const succeeded = signals();
    const withSuccess: SourceRuntimeSignals = {
      ...succeeded,
      succeededTargetIds: new Set(["target_fresh"]),
    };

    // Guidance verification never ran, but the source just returned a
    // completed run: that is proof enough for the Home badge.
    expect(listSourceAttentionReasons(target, withSuccess)).toEqual([]);
    expect(classifyEnabledSourceHealth(target, withSuccess)).toBe("healthy");
    expect(deriveEnabledSourceHealthCounts([target], withSuccess)).toEqual({
      healthy: 1,
      needsAttention: 0,
      running: 0,
      total: 1,
    });
    // Without the success signal the same source is still fine to search.
    expect(classifyEnabledSourceHealth(target, succeeded)).toBe("healthy");
  });

  test("a successful run does not hide failing, stale, or login-blocked sources", () => {
    const withSuccess: SourceRuntimeSignals = {
      ...signals({ loginRequired: ["target_login"] }),
      succeededTargetIds: new Set([
        "target_failing",
        "target_stale",
        "target_login",
      ]),
    };

    expect(
      listSourceAttentionReasons(
        source({ id: "target_failing", staleReason: "Verification failed." }),
        withSuccess,
      ),
    ).toEqual(["failing"]);
    expect(
      listSourceAttentionReasons(
        source({ id: "target_stale", instructionStatus: "stale" }),
        withSuccess,
      ),
    ).toEqual(["guidance_stale"]);
    expect(
      listSourceAttentionReasons(source({ id: "target_login" }), withSuccess),
    ).toEqual(["login_required"]);
  });

  test("derives succeeded targets from each target's latest finished execution", () => {
    const succeeded = deriveSucceededDiscoveryTargetIds([
      // Newest run first, as the dashboard passes it.
      run([
        {
          targetId: "target_ok",
          state: "completed",
          completedAt: "2026-08-20T10:05:00.000Z",
        },
        {
          targetId: "target_regressed",
          state: "failed",
          completedAt: "2026-08-20T10:05:00.000Z",
        },
        { targetId: "target_pending", state: "planned" },
        {
          targetId: "target_active",
          state: "running",
          startedAt: "2026-08-20T10:04:00.000Z",
        },
      ]),
      run([
        {
          targetId: "target_regressed",
          state: "completed",
          completedAt: "2026-08-19T10:05:00.000Z",
        },
        {
          targetId: "target_recovered",
          state: "failed",
          completedAt: "2026-08-19T10:05:00.000Z",
        },
        {
          targetId: "target_cancelled",
          state: "cancelled",
          completedAt: "2026-08-19T10:05:00.000Z",
        },
      ]),
      run([
        {
          targetId: "target_recovered",
          state: "completed",
          completedAt: "2026-08-21T10:05:00.000Z",
        },
      ]),
    ]);

    // Order independence: the newest execution wins regardless of run order.
    expect([...succeeded].sort()).toEqual(["target_ok", "target_recovered"]);
    expect(deriveSucceededDiscoveryTargetIds([])).toEqual(new Set());
  });

  test("running sources are reported in the running bucket", () => {
    const counts = deriveEnabledSourceHealthCounts(
      [
        source({
          id: "target_a",
          instructionStatus: "validated",
          lastVerifiedAt: VERIFIED_AT,
        }),
        source({ id: "target_b" }),
      ],
      signals({ running: ["target_b"] }),
    );

    expect(counts).toEqual({
      healthy: 1,
      needsAttention: 0,
      running: 1,
      total: 2,
    });
  });
});

describe("describeEnabledSourceHealth", () => {
  test("separates empty success, productive stale guidance, failure and unknown history", () => {
    const completed = {
      targetId: "target_001",
      state: "completed" as const,
      startedAt: VERIFIED_AT,
      completedAt: VERIFIED_AT,
      jobsFound: 0,
    };
    const input = { recentRuns: [{ targetExecutions: [completed] }] };
    expect(
      describeEnabledSourceHealth(source(), deriveSourceHealthSignals(input))
        .reason,
    ).toBe("Completed, 0 jobs found.");
    completed.jobsFound = 12;
    expect(
      describeEnabledSourceHealth(
        source({ instructionStatus: "stale" }),
        deriveSourceHealthSignals(input),
      ).reason,
    ).toBe(
      "Readable · 12 job cards found. Saved guidance for this source is out of date.",
    );
    const failed = {
      ...completed,
      state: "failed" as const,
      completedAt: "2026-08-21T00:00:00.000Z",
    };
    const signals = deriveSourceHealthSignals({
      recentRuns: [...input.recentRuns, { targetExecutions: [failed] }],
    });
    expect(signals.usedTargetIds?.has(completed.targetId)).toBe(true);
    expect(describeEnabledSourceHealth(source(), signals).reason).toBe(
      "The latest search failed.",
    );
    // A failure that names a missing page says so, since searching again
    // cannot fix a wrong address; a server error says to try later.
    const withWarning = (warning: string) =>
      describeEnabledSourceHealth(
        source(),
        deriveSourceHealthSignals({
          recentRuns: [{ targetExecutions: [{ ...failed, warning }] }],
        }),
      ).reason;
    expect(
      withWarning(
        "Agent discovery failed: Starting page returned HTTP 404: http://127.0.0.1:47954/nope/",
      ),
    ).toBe(
      "The latest search failed: this address answered HTTP 404 (page not found). Check the address with Edit.",
    );
    expect(withWarning("Starting page returned HTTP 503")).toBe(
      "The latest search failed: the site answered HTTP 503 (a server error). Search again later.",
    );
    expect(withWarning("The agent stopped responding.")).toBe(
      "The latest search failed.",
    );
    expect(
      describeEnabledSourceHealth(source(), deriveSourceHealthSignals({}))
        .reason,
    ).toBe(
      "Not checked yet. Searches can still use it.",
    );
  });
  test("a source proven by a completed run is healthy with a reason", () => {
    const target = source({ id: "target_run" });

    // The exact disagreement reported in dogfooding: Home derived succeeded
    // runs and said healthy, Profile did not and said needs attention.
    expect(
      describeEnabledSourceHealth(
        target,
        deriveSourceHealthSignals({
          recentRuns: [
            run([
              {
                targetId: "target_run",
                state: "completed",
                completedAt: "2026-08-21T10:05:00.000Z",
              },
            ]),
          ],
        }),
      ),
    ).toEqual({
      reason: "Completed; job count not recorded.",
      reasons: [],
      state: "healthy",
    });

    expect(describeEnabledSourceHealth(target).state).toBe("healthy");
  });

  test("attention states name their first concrete reason", () => {
    expect(
      describeEnabledSourceHealth(
        source({ lastVerifiedAt: VERIFIED_AT, staleReason: "HTTP 403" }),
      ),
    ).toEqual({
      reason: "The last check reported a problem: HTTP 403",
      reasons: ["failing"],
      state: "needs_attention",
    });

    expect(
      describeEnabledSourceHealth(
        source({ id: "target_login", lastVerifiedAt: VERIFIED_AT }),
        deriveSourceHealthSignals({
          sourceAccessPrompts: [
            { state: "prompt_login_required", targetId: "target_login" },
          ],
        }),
      ),
    ).toEqual({
      reason: "Blocked: waiting for you to sign in.",
      reasons: ["login_required"],
      state: "needs_attention",
    });
  });

  test("a running source reports running instead of attention", () => {
    const description = describeEnabledSourceHealth(
      source({ id: "target_running" }),
      deriveSourceHealthSignals({
        activeRun: run([{ targetId: "target_running", state: "running" }]),
      }),
    );

    expect(description.state).toBe("running");
    expect(description.reason).toBe("A search is using this source right now.");
  });

  test("classification and description agree on every state", () => {
    for (const target of [
      source({ id: "a", lastVerifiedAt: VERIFIED_AT }),
      source({ id: "b" }),
      source({ id: "c", instructionStatus: "unsupported" }),
    ]) {
      expect(describeEnabledSourceHealth(target).state).toBe(
        classifyEnabledSourceHealth(target),
      );
    }
  });
});

describe("a source that returned nothing", () => {
  const target = source({
    id: "target_empty",
    instructionStatus: "validated",
    lastVerifiedAt: VERIFIED_AT,
  });
  const emptyRun: SourceRuntimeSignals = {
    latestExecutions: new Map([
      [
        "target_empty",
        {
          targetId: "target_empty",
          state: "completed" as DiscoveryTargetExecutionState,
          startedAt: VERIFIED_AT,
          completedAt: VERIFIED_AT,
          jobsFound: 0,
        },
      ],
    ]),
    succeededTargetIds: new Set(["target_empty"]),
  };

  test("does not need attention: an empty listing is not a broken source", () => {
    expect(listSourceAttentionReasons(target, emptyRun)).toEqual([]);
    expect(classifyEnabledSourceHealth(target, emptyRun)).toBe("healthy");
    expect(describeEnabledSourceHealth(target, emptyRun)).toMatchObject({
      reason: "Completed, 0 jobs found.",
      state: "healthy",
    });
  });

  test("a quiet re-run that listed only saved jobs says they were already saved", () => {
    const knownOnlyRun: SourceRuntimeSignals = {
      latestExecutions: new Map([
        [
          "target_empty",
          {
            targetId: "target_empty",
            state: "completed" as DiscoveryTargetExecutionState,
            startedAt: VERIFIED_AT,
            completedAt: VERIFIED_AT,
            jobsFound: 0,
            duplicatesMerged: 0,
            jobsSkippedByLedger: 10,
          },
        ],
      ]),
      succeededTargetIds: new Set(["target_empty"]),
    };
    expect(describeEnabledSourceHealth(target, knownOnlyRun)).toMatchObject({
      reason: "Completed, 10 listings found; all were already saved.",
      state: "healthy",
    });
  });

  test("stays healthy once the same source finds something", () => {
    const productiveRun: SourceRuntimeSignals = {
      latestExecutions: new Map([
        [
          "target_empty",
          {
            targetId: "target_empty",
            state: "completed" as DiscoveryTargetExecutionState,
            startedAt: VERIFIED_AT,
            completedAt: VERIFIED_AT,
            jobsFound: 7,
          },
        ],
      ]),
      succeededTargetIds: new Set(["target_empty"]),
    };

    expect(classifyEnabledSourceHealth(target, productiveRun)).toBe("healthy");
  });

  test("stays healthy when every listing found was already saved", () => {
    const repeatedRun: SourceRuntimeSignals = {
      latestExecutions: new Map([
        [
          "target_empty",
          {
            targetId: "target_empty",
            state: "completed" as DiscoveryTargetExecutionState,
            startedAt: VERIFIED_AT,
            completedAt: VERIFIED_AT,
            jobsFound: 0,
            duplicatesMerged: 94,
          },
        ],
      ]),
      succeededTargetIds: new Set(["target_empty"]),
    };

    expect(classifyEnabledSourceHealth(target, repeatedRun)).toBe("healthy");
    expect(describeEnabledSourceHealth(target, repeatedRun)).toMatchObject({
      reason: "Completed, 94 listings found; all were already saved.",
      state: "healthy",
    });
  });

  test("says in plain words when a site layout is not one Job Finder reads", () => {
    const unsupported = source({
      id: "target_unsupported",
      instructionStatus: "unsupported",
      lastVerifiedAt: VERIFIED_AT,
    });

    expect(describeEnabledSourceHealth(unsupported).reason).toBe(
      "Job Finder could not read this site's job listings: its page layout is not one Job Finder recognises yet.",
    );
  });
});

/**
 * A source that keeps failing is reported on the source.
 *
 * This is what replaces pausing the whole search plan: the plan keeps running
 * with the sources that still work, and the one that does not shows up in
 * Profile › Job sources.
 */
describe("deriveRepeatedlyFailingTargetIds", () => {
  test("failures of this computer's connection or a busy search never mark a source", () => {
    const failed = (warning: string) => ({
      targetExecutions: [
        {
          targetId: "api",
          state: "failed" as const,
          startedAt: null,
          completedAt: null,
          warning,
        },
      ],
    });
    const runs = [
      failed("Public provider API collection failed: Greenhouse API request timed out."),
      failed("Public provider API collection failed: fetch failed"),
      failed("Public provider API collection failed: fetch failed"),
      failed(
        "The job board did not answer in time; it is tried again on the next search.",
      ),
      failed(
        "The job board could not be reached; it is tried again on the next search.",
      ),
      failed(
        "The job board answered with an error (HTTP 503); it is tried again on the next search.",
      ),
    ];
    expect([...deriveRepeatedlyFailingTargetIds(runs)]).toEqual([]);
    expect(
      isEnabledSourceNeedingAttention(
        source({ id: "api" }),
        deriveSourceHealthSignals({ recentRuns: runs }),
      ),
    ).toBe(false);
  });

  test("a board address with no job list counts against the source", () => {
    const missing = {
      targetExecutions: [
        {
          targetId: "api",
          state: "failed" as const,
          startedAt: null,
          completedAt: null,
          warning:
            "No job list was found at this board's address (HTTP 404). Check the address with Edit.",
        },
      ],
    };
    expect([...deriveRepeatedlyFailingTargetIds([missing, missing])]).toEqual(
      ["api"],
    );
  });

  test("two failed runs in a row mark that source, and that source only", () => {
    const repeatedly = deriveRepeatedlyFailingTargetIds([
      run([
        { targetId: "one", state: "failed" },
        { targetId: "two", state: "completed" },
      ]),
      run([
        { targetId: "one", state: "failed" },
        { targetId: "two", state: "completed" },
      ]),
    ]);

    expect([...repeatedly]).toEqual(["one"]);
  });

  test("one failure on its own is not yet a pattern", () => {
    const repeatedly = deriveRepeatedlyFailingTargetIds([
      run([{ targetId: "one", state: "failed" }]),
      run([{ targetId: "one", state: "completed" }]),
    ]);

    expect([...repeatedly]).toEqual([]);
  });

  test("a repeatedly failing source needs attention", () => {
    const target = source({
      id: "one",
      lastVerifiedAt: VERIFIED_AT,
      instructionStatus: "ready" as SourceInstructionStatus,
    });
    const runtime: SourceRuntimeSignals = {
      usedTargetIds: new Set(["one"]),
      repeatedlyFailingTargetIds: new Set(["one"]),
    };

    expect(listSourceAttentionReasons(target, runtime)).toContain("failing");
    expect(isEnabledSourceNeedingAttention(target, runtime)).toBe(true);
  });
});

describe("the source row after Check source", () => {
  const check = (overrides: Partial<SourceCheckHealthFields> = {}) => ({
    targetId: "target_board",
    state: "completed",
    startedAt: "2026-09-28T01:00:00.000Z",
    completedAt: "2026-09-28T01:02:00.000Z",
    finalSummary: "Saved instructions for reading this board's job list.",
    ...overrides,
  });

  test("shows the check when it is newer than the last search", () => {
    expect(
      describeLatestSourceCheck({ id: "target_board" }, [check()], {
        completedAt: "2026-09-28T00:30:00.000Z",
      }),
    ).toBe(
      "Latest check: Saved instructions for reading this board's job list.",
    );
  });

  test("keeps the search line when a search ran after the check", () => {
    expect(
      describeLatestSourceCheck({ id: "target_board" }, [check()], {
        completedAt: "2026-09-28T02:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("says a check is running, and ignores other sources' checks", () => {
    expect(
      describeLatestSourceCheck(
        { id: "target_board" },
        [check({ state: "running", completedAt: null })],
        { completedAt: "2026-09-28T02:00:00.000Z" },
      ),
    ).toBe("Checking this source now.");
    expect(
      describeLatestSourceCheck({ id: "other" }, [check()], null),
    ).toBeNull();
  });
});
