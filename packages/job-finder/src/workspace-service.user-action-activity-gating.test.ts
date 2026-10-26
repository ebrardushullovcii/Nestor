import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import {
  ApplicationAttemptBlockerSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { persistApplicationUserAction } from "./internal/workspace-application-user-action";
import { USER_ACTION_RESUMPTION_CONCURRENCY } from "./internal/workspace-user-action-methods";
import { createJobFinderWorkspaceService } from "./index";
import { reduceUserActionCommand } from "./user-action-domain";
import { createSeed } from "./workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";


afterEach(() => {
  vi.useRealTimers();
});

function authenticatedSourceAccess() {
  return vi.fn(() =>
    Promise.resolve({
      state: "authenticated" as const,
      currentOrigin: "https://www.linkedin.com/",
      checkedAt: "2026-07-30T10:30:00.000Z",
      signals: ["account_menu_control" as const],
    }),
  );
}

/** One login-blocked pending action per synthesized job. */
async function persistLoginBlockedActions(
  repository: JobFinderRepository,
  count: number,
): Promise<void> {
  const sourceJob = (await repository.listSavedJobs())[0];
  if (!sourceJob) throw new Error("Expected a saved job fixture.");
  const jobs = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
      ...sourceJob,
      id: `job_gate_${suffix}`,
      sourceJobId: `gate_${suffix}`,
      canonicalUrl: `https://www.linkedin.com/jobs/view/gate_${suffix}`,
      applicationUrl: `https://www.linkedin.com/jobs/view/gate_${suffix}/apply`,
      title: `${sourceJob.title} ${suffix}`,
    };
  });
  await repository.commitSavedJobDelta({ upserts: jobs });

  for (const [index, job] of jobs.entries()) {
    await persistApplicationUserAction({
      repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: `apply_run_gate_${index}`,
      resultId: `apply_result_gate_${index}`,
      replayCheckpointId: `apply_checkpoint_gate_${index}`,
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "site_login_required",
        summary: "Sign in before continuing.",
        detail: "The application page requires a browser-owned session.",
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl,
      }),
      occurredAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00.000Z`,
    });
  }
}

/** Moves every pending request to verifying with its own exact command event. */
async function confirmAllPendingActions(
  repository: JobFinderRepository,
): Promise<void> {
  const requests = await repository.listUserActionRequests();
  for (const [index, request] of requests.entries()) {
    const reduction = reduceUserActionCommand(
      request,
      {
        action: "confirm_done",
        requestId: request.id,
        commandId: `confirm_gate_${index}`,
        expectedRevision: request.revision,
      },
      "2026-07-30T10:40:00.000Z",
    );
    if (reduction.status !== "applied") {
      throw new Error(`Expected request ${request.id} to confirm.`);
    }
    await repository.commitUserActionTransition({
      request: reduction.request,
      event: reduction.event,
    });
  }
}



describe("resolved user action resumption activity gating", () => {

  test("processes twenty resumed actions without exceeding the defined concurrency", async () => {
    const ACTION_COUNT = 20;
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const plainRepository = createInMemoryJobFinderRepository(seed);
    await persistLoginBlockedActions(plainRepository, ACTION_COUNT);
    await confirmAllPendingActions(plainRepository);

    const gateReads = { inFlight: 0, maxObserved: 0 };
    const instrumentedRepository: JobFinderRepository = {
      ...plainRepository,
      getActivityControl() {
        gateReads.inFlight += 1;
        gateReads.maxObserved = Math.max(
          gateReads.maxObserved,
          gateReads.inFlight,
        );
        return (async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return plainRepository.getActivityControl();
        })().finally(() => {
          gateReads.inFlight -= 1;
        });
      },
    };
    const service = createJobFinderWorkspaceService({
      repository: instrumentedRepository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    const snapshot = await service.getWorkspaceSnapshot();

    // Every flight enters through the fail-closed activity gate, so the
    // observed overlap of gate reads is exactly the resumption concurrency.
    expect(gateReads.maxObserved).toBeGreaterThan(1);
    expect(gateReads.maxObserved).toBeLessThanOrEqual(
      USER_ACTION_RESUMPTION_CONCURRENCY,
    );
    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    // The synthetic lineages are stale, so retries are skipped before any
    // browser flow; nothing may launch regardless.
    expect(executeApplicationFlow).not.toHaveBeenCalled();
    // Exact-lineage campaign projection hides these deliberately stale
    // synthetic actions even though the bounded resumer processed them.
    expect(snapshot.userActionRequests).toEqual([]);

    // A duplicate read stays idempotent: nothing is reprocessed.
    await service.getWorkspaceSnapshot();
    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    expect(gateReads.maxObserved).toBeLessThanOrEqual(
      USER_ACTION_RESUMPTION_CONCURRENCY,
    );
  });

  test("keeps concurrent duplicate snapshot reads single-flight", async () => {
    const ACTION_COUNT = 4;
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const repository = createInMemoryJobFinderRepository(seed);
    await persistLoginBlockedActions(repository, ACTION_COUNT);
    await confirmAllPendingActions(repository);
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    const [first, second] = await Promise.all([
      service.getWorkspaceSnapshot(),
      service.getWorkspaceSnapshot(),
    ]);

    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    expect(first.userActionRequests.map((entry) => entry.state)).toEqual(
      second.userActionRequests.map((entry) => entry.state),
    );
    expect(
      first.userActionRequests.every((entry) => entry.state === "resolved"),
    ).toBe(true);

    await service.getWorkspaceSnapshot();
    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    expect(executeApplicationFlow).not.toHaveBeenCalled();
  });


  test("fails closed when activity control cannot be read and stays resumable afterwards", async () => {
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const repository = createInMemoryJobFinderRepository(seed);
    await persistLoginBlockedActions(repository, 1);
    await confirmAllPendingActions(repository);
    const brokenActivityControl = new Error(
      "Activity control storage unavailable.",
    );
    const brokenRepository: JobFinderRepository = {
      ...repository,
      getActivityControl: () => Promise.reject(brokenActivityControl),
    };
    const service = createJobFinderWorkspaceService({
      repository: brokenRepository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    await expect(service.getWorkspaceSnapshot()).rejects.toThrow(
      /activity control storage/iu,
    );

    // Fail closed: no browser work launched and the action was not claimed,
    // completed, or failed while control could not be read.
    expect(executeApplicationFlow).not.toHaveBeenCalled();
    expect(inspectSourceAccess).not.toHaveBeenCalled();
    expect((await repository.listUserActionRequests())[0]).toMatchObject({
      state: "verifying",
    });
    expect(await repository.listApplicationAttempts()).toEqual([]);

    // Healing the control surface lets the same service retry the unclaimed
    // action on its next snapshot; recovery does not require an app restart.
    brokenRepository.getActivityControl = () => repository.getActivityControl();
    const healed = await service.getWorkspaceSnapshot();

    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect((await repository.listUserActionRequests())[0]?.state).toBe(
      "resolved",
    );
    expect(
      healed.applicationAttempts.find(
        (entry) => entry.userActionResumption != null,
      ),
    ).toBeTruthy();
    expect(executeApplicationFlow).not.toHaveBeenCalled();
  });
});
