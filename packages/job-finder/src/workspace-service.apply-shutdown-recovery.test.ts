import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  ApplicationRecordSchema,
  ApplicationAttemptSchema,
  SavedJobSchema,
  jobSourceValues,
} from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import {
  createBrowserRuntime,
  createSeed,
} from "./workspace-service.test-support";

afterEach(() => {
  vi.useRealTimers();
});

function createShutdownHarness() {
  const baseRuntime = createBrowserRuntime();
  let releaseStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const executeApplicationFlow = vi.fn(
    (
      _source: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[0],
      _input: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[1],
      options?: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[2],
    ): ReturnType<BrowserSessionRuntime["executeApplicationFlow"]> => {
      releaseStarted?.();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              reject(new DOMException("Cancelled", "AbortError"));
            }, 10);
          },
          { once: true },
        );
      });
    },
  );
  const seed = createSeed();
  seed.savedJobs = seed.savedJobs.map((job) =>
    job.id === "job_ready"
      ? SavedJobSchema.parse({
          ...job,
          resumeApplicationMode: "original_resume",
        })
      : job,
  );
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: { ...baseRuntime, executeApplicationFlow },
  });
  return { ...harness, started };
}

describe("apply shutdown recovery", () => {
  test("shutdown closes owned browser sessions without loading discovery history", async () => {
    const runtime = createBrowserRuntime();
    const closeSession = vi.fn(runtime.closeSession.bind(runtime));
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      browserRuntime: { ...runtime, closeSession },
    });
    const readDiscovery = vi.spyOn(repository, "getDiscoveryState");
    await workspaceService.shutdown();
    expect(readDiscovery).not.toHaveBeenCalled();
    for (const source of jobSourceValues)
      expect(closeSession).toHaveBeenCalledWith(source);
  });

  test("shutdown projects an active run's result, attempt, and record onto truthful failed states", async () => {
    const { workspaceService, repository, started } = createShutdownHarness();

    const staged = await workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const runId = staged.applyRuns[0]!.id;
    const approval = workspaceService.approveApplyRun(runId);
    await started;

    // The durable begun mark commits before the browser flow starts.
    const stagedResult = (await repository.listApplyJobResults({ runId }))[0];
    if (!stagedResult?.applicationRecordId) {
      throw new Error("Expected staged exact-lineage apply result.");
    }
    expect(stagedResult.state).toBe("planned");
    expect(stagedResult.applicationPreparationStartedAt).not.toBeNull();
    const applicationRecordId = stagedResult.applicationRecordId;

    // Simulate durable mid-flow progress that claims live execution, as a
    // deeper flow checkpoint would have committed before the close.
    await repository.upsertApplicationAttempt(
      ApplicationAttemptSchema.parse({
        id: `attempt_${runId}`,
        jobId: "job_ready",
        applicationRecordId,
        state: "in_progress",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: stagedResult.startedAt,
        updatedAt: stagedResult.updatedAt,
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
    );
    const stagedRecord = (await repository.listApplicationRecords()).find(
      (record) => record.id === applicationRecordId,
    );
    if (!stagedRecord) throw new Error("Expected the staged record.");
    await repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        ...stagedRecord,
        lastActionLabel: "Filling prepared answers safely.",
        lastAttemptState: "in_progress",
      }),
    );

    await workspaceService.shutdown();
    await approval.catch(() => undefined);

    const [recoveredResult] = await repository.listApplyJobResults({ runId });
    expect(recoveredResult).toMatchObject({
      state: "failed",
      // The flow was still parked before its review checkpoint, so the row
      // terminalizes with the begun-planned copy and keeps its mark.
      summary: "Application preparation stopped before review.",
      detail: expect.stringContaining(
        "No final submit action occurred",
      ) as string,
      applicationRecordId,
      applicationPreparationStartedAt:
        stagedResult.applicationPreparationStartedAt,
      applicationPreparationStartedLocalDate:
        stagedResult.applicationPreparationStartedLocalDate,
    });

    const [run] = await repository.listApplyRuns();
    // Counters describe the durable end state instead of retaining the
    // stale running-time queue count.
    expect(run).toMatchObject({
      id: runId,
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
      completedAt: expect.any(String) as string,
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 1,
    });

    const attempts = await repository.listApplicationAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: `attempt_${runId}`,
      state: "failed",
      summary: "Preparation stopped when the app closed.",
      nextActionLabel: "Retry preparation when you are ready.",
      applicationRecordId,
    });

    const records = await repository.listApplicationRecords();
    expect(records[0]?.lastAttemptState).toBe("failed");
    // Exactly one deterministic recovery event lands, whichever recovery
    // pass (shutdown's own or the settling snapshot's) commits first.
    const recoveryEvents = records[0]?.events.filter((event) =>
      event.id.endsWith(`_app_closed_recovery_${applicationRecordId}`),
    );
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents?.[0]).toMatchObject({
      title: "Preparation stopped because the app closed",
      emphasis: "warning",
    });
    expect(
      records[0]?.events.every(
        (event, _index, all) =>
          all.filter((candidate) => candidate.id === event.id).length === 1,
      ),
    ).toBe(true);
  });

  test("concurrent and repeated shutdowns stay idempotent", async () => {
    const { workspaceService, repository, started } = createShutdownHarness();

    const staged = await workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const runId = staged.applyRuns[0]!.id;
    const approval = workspaceService.approveApplyRun(runId);
    await started;

    const stagedResult = (await repository.listApplyJobResults({ runId }))[0];
    if (!stagedResult?.applicationRecordId) {
      throw new Error("Expected staged exact-lineage apply result.");
    }
    const applicationRecordId = stagedResult.applicationRecordId;
    await repository.upsertApplicationAttempt(
      ApplicationAttemptSchema.parse({
        id: `attempt_${runId}`,
        jobId: "job_ready",
        applicationRecordId,
        state: "in_progress",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: stagedResult.startedAt,
        updatedAt: stagedResult.updatedAt,
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
    );
    const stagedRecord = (await repository.listApplicationRecords()).find(
      (record) => record.id === applicationRecordId,
    );
    if (!stagedRecord) throw new Error("Expected the staged record.");
    await repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        ...stagedRecord,
        lastActionLabel: "Filling prepared answers safely.",
        lastAttemptState: "in_progress",
      }),
    );
    // Concurrent callers share one shutdown, and later calls reuse the
    // settled promise instead of re-running recovery writes.
    await Promise.all([
      workspaceService.shutdown(),
      workspaceService.shutdown(),
    ]);
    await workspaceService.shutdown();
    await approval.catch(() => undefined);

    const records = await repository.listApplicationRecords();
    // Exactly one deterministic recovery event survives every shutdown call,
    // whichever recovery pass commits first.
    const recoveryEvents = records[0]?.events.filter((event) =>
      event.id.endsWith(`_app_closed_recovery_${applicationRecordId}`),
    );
    expect(recoveryEvents).toHaveLength(1);
    const allEvents = records[0]?.events ?? [];
    expect(
      allEvents.filter(
        (event) =>
          allEvents.filter((candidate) => candidate.id === event.id).length ===
          1,
      ),
    ).toHaveLength(allEvents.length);

    const firstState = {
      run: (await repository.listApplyRuns())[0],
      result: (await repository.listApplyJobResults({ runId }))[0],
      attempt: (await repository.listApplicationAttempts())[0],
      record: records[0],
    };
    expect(firstState.run).toMatchObject({
      state: "failed",
      pendingJobs: 0,
      failedJobs: 1,
    });
    expect(firstState.result?.state).toBe("failed");
    expect(firstState.attempt?.state).toBe("failed");

    // Rereading after every shutdown call sees the same settled truth: the
    // memoized shutdown promise prevented any further recovery rewrites.
    const reread = {
      run: (await repository.listApplyRuns())[0],
      result: (await repository.listApplyJobResults({ runId }))[0],
      attempt: (await repository.listApplicationAttempts())[0],
      record: (await repository.listApplicationRecords())[0],
    };
    expect(reread.run).toMatchObject({
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
    });
    expect(reread.result).toEqual(firstState.result);
    expect(reread.attempt).toEqual(firstState.attempt);
    expect(reread.record).toEqual(firstState.record);
  });
});
