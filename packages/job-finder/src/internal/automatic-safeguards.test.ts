import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  DiscoveryRunRecordSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
} from "@nestor/contracts";
import { describe, expect, test, } from "vitest";

import {
  deriveDiscoveryFailureEvidence,
  deriveDiscoveryRunFailureEvidence,
  deriveSourceDebugCampaignWork,
  deriveSourceDebugFailureEvidence,
  isUserOwnedBlockerEvidence,
  shouldPersistApplicationFailureNotification,
} from "./automatic-safeguards";

const startedAt = "2026-08-15T10:00:00.000Z";
const completedAt = "2026-08-15T10:01:00.000Z";

function discoveryRun(input: {
  id: string;
  state: "completed" | "failed";
  targetExecutions?: readonly {
    targetId: string;
    state: "completed" | "failed";
    warning?: string | null;
  }[];
}) {
  return DiscoveryRunRecordSchema.parse({
    id: input.id,
    campaignId: "campaign-1",
    state: input.state,
    startedAt,
    completedAt,
    targetIds: (input.targetExecutions ?? []).map((entry) => entry.targetId),
    targetExecutions: (input.targetExecutions ?? []).map((entry) => ({
      targetId: entry.targetId,
      adapterKind: "auto",
      state: entry.state,
      startedAt,
      completedAt,
      warning: entry.warning ?? null,
    })),
  });
}

function sourceRun(input: {
  id: string;
  targetId?: string;
  state: "completed" | "failed" | "paused_manual";
  finalSummary?: string | null;
  attemptIds?: readonly string[];
}) {
  const state = input.state;
  return SourceDebugRunRecordSchema.parse({
    id: input.id,
    targetId: input.targetId ?? "source-1",
    state,
    startedAt,
    updatedAt: completedAt,
    completedAt: state === "paused_manual" ? completedAt : completedAt,
    activePhase: state === "paused_manual" ? "access_auth_probe" : null,
    targetLabel: "Source one",
    targetUrl: "https://example.com",
    targetHostname: "example.com",
    finalSummary: input.finalSummary ?? null,
    attemptIds: input.attemptIds ?? [],
  });
}

function attempt(input: {
  id: string;
  runId: string;
  outcome:
    | "succeeded"
    | "failed_runtime"
    | "blocked_auth"
    | "unsupported_layout";
  resultSummary?: string;
}) {
  return SourceDebugWorkerAttemptSchema.parse({
    id: input.id,
    runId: input.runId,
    targetId: "source-1",
    phase: "site_structure_mapping",
    startedAt,
    completedAt,
    outcome: input.outcome,
    strategyLabel: "test strategy",
    strategyFingerprint: `fingerprint-${input.id}`,
    resultSummary: input.resultSummary ?? "Attempt finished.",
  });
}

describe("automatic source/discovery safeguards", () => {
  test("derives technical discovery failures but excludes manual blockers", () => {
    const evidence = deriveDiscoveryFailureEvidence([
      discoveryRun({
        id: "run-1",
        state: "completed",
        targetExecutions: [
          { targetId: "source-ok", state: "completed" },
          {
            targetId: "source-failed",
            state: "failed",
            warning: "Runtime transport failed.",
          },
          {
            targetId: "source-login",
            state: "failed",
            warning: "Login required before discovery.",
          },
        ],
      }),
    ]);

    expect(evidence).toEqual([
      {
        attemptId: "discovery:run-1:source-ok",
        failed: false,
        occurredAt: completedAt,
      },
      {
        attemptId: "discovery:run-1:source-failed",
        failed: true,
        occurredAt: completedAt,
      },
    ]);
  });

  test("derives source-debug failure samples without counting auth blockers", () => {
    const run = sourceRun({
      id: "debug-1",
      state: "failed",
      attemptIds: ["attempt-ok", "attempt-runtime", "attempt-auth"],
      finalSummary: "Source debug failed after bounded attempts.",
    });
    const attempts = [
      attempt({ id: "attempt-ok", runId: run.id, outcome: "succeeded" }),
      attempt({
        id: "attempt-runtime",
        runId: run.id,
        outcome: "failed_runtime",
      }),
      attempt({
        id: "attempt-auth",
        runId: run.id,
        outcome: "blocked_auth",
        resultSummary: "Login required.",
      }),
    ];

    expect(deriveSourceDebugFailureEvidence({ runs: [run], attempts })).toEqual(
      [
        {
          attemptId: "source-debug:attempt-ok",
          failed: false,
          occurredAt: completedAt,
        },
        {
          attemptId: "source-debug:attempt-runtime",
          failed: true,
          occurredAt: completedAt,
        },
      ],
    );
  });

  test("derives a stable blocked source notification with source identity", () => {
    const run = sourceRun({
      id: "debug-manual",
      state: "paused_manual",
      finalSummary: "Login required before the source can be checked.",
    });
    const work = deriveSourceDebugCampaignWork(run);
    expect(work.failedWork).toEqual([]);
    expect(work.blockedWork[0]).toEqual(
      expect.objectContaining({
        workId: "source_debug_debug-manual",
        sourceTargetId: "source-1",
      }),
    );
  });

  test("recognizes only explicit user-owned blocker language", () => {
    expect(isUserOwnedBlockerEvidence("Consent is required.")).toBe(true);
    expect(isUserOwnedBlockerEvidence("Runtime transport failed.")).toBe(false);
  });
});

describe("automatic application safeguard identity", () => {
  test("suppresses failure notifications after the persisted run is cancelled", () => {
    const result = ApplyJobResultSchema.parse({
      id: "result-cancel-race",
      runId: "run-cancel-race",
      jobId: "job-cancel-race",
      state: "failed",
      summary: "Application preparation failed.",
      detail: "The provider returned a runtime error.",
      startedAt,
      updatedAt: completedAt,
      completedAt,
    });
    const cancelledRun = ApplyRunSchema.parse({
      id: "run-cancel-race",
      campaignId: "campaign-1",
      mode: "queue_auto",
      state: "cancelled",
      jobIds: [result.jobId],
      createdAt: startedAt,
      updatedAt: completedAt,
      completedAt,
      summary: "Automatic apply run cancelled.",
      detail: "The queued run was cancelled before final submit.",
    });
    const activeRun = ApplyRunSchema.parse({
      ...cancelledRun,
      state: "running",
      completedAt: null,
      summary: "Automatic apply queue is running.",
    });

    expect(
      shouldPersistApplicationFailureNotification({
        result,
        run: cancelledRun,
      }),
    ).toBe(false);
    expect(
      shouldPersistApplicationFailureNotification({ result, run: activeRun }),
    ).toBe(true);
  });
});

/**
 * What it takes for a plan to pause itself.
 *
 * A pause stops the person's searches, so it has to mean the plan is broken.
 * One source failing while the others bring back jobs is one source needing
 * attention, not a broken plan.
 */
describe("deriveDiscoveryRunFailureEvidence", () => {
  test("the pause decision never opens a stored run's activity history", () => {
    const failed = discoveryRun({ id: "stored-failure", state: "failed" });
    Object.defineProperty(failed, "activity", {
      get() {
        throw new Error("Failure evidence opened activity history");
      },
    });
    expect(deriveDiscoveryRunFailureEvidence([failed])).toEqual([
      {
        attemptId: "discovery_run:stored-failure",
        failed: true,
        occurredAt: completedAt,
      },
    ]);
  });

  function run(
    id: string,
    executions: readonly { targetId: string; state: "completed" | "failed" }[],
    state: "completed" | "failed" = "completed",
  ) {
    return {
      ...discoveryRun({ id, state, targetExecutions: executions }),
      startedAt: `2026-08-1${id.slice(-1)}T10:00:00.000Z`,
      completedAt: `2026-08-1${id.slice(-1)}T10:01:00.000Z`,
    };
  }

  test("two failed sources out of five do not count as a failed run", () => {
    const evidence = deriveDiscoveryRunFailureEvidence([
      run("run1", [
        { targetId: "a", state: "failed" },
        { targetId: "b", state: "failed" },
        { targetId: "c", state: "completed" },
        { targetId: "d", state: "completed" },
        { targetId: "e", state: "completed" },
      ]),
    ]);

    expect(evidence).toEqual([]);
  });

  test("three whole runs failing in a row is the evidence a pause needs", () => {
    const failed = (id: string) =>
      run(id, [{ targetId: "a", state: "failed" }], "failed");
    const evidence = deriveDiscoveryRunFailureEvidence([
      failed("run1"),
      failed("run2"),
      failed("run3"),
    ]);

    expect(evidence).toHaveLength(3);
    expect(evidence.every((entry) => entry.failed)).toBe(true);
  });

  test("one run that worked clears the streak behind it", () => {
    const evidence = deriveDiscoveryRunFailureEvidence([
      run("run1", [{ targetId: "a", state: "failed" }], "failed"),
      run("run2", [{ targetId: "a", state: "failed" }], "failed"),
      run("run3", [{ targetId: "a", state: "completed" }]),
    ]);

    expect(evidence).toEqual([]);
  });

  test("a run that only a sign-in stopped is not the plan failing", () => {
    const evidence = deriveDiscoveryRunFailureEvidence([
      {
        ...discoveryRun({
          id: "run1",
          state: "failed",
          targetExecutions: [
            { targetId: "a", state: "failed", warning: "Sign in to continue" },
          ],
        }),
      },
    ]);

    expect(evidence).toEqual([]);
  });
});
