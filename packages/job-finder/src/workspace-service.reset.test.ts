import type { JobFinderAiClient } from "@nestor/ai-providers";
import {
  ApplicationCrmSettingsSchema,
  ApplicationRecordSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("workspace reset safety", () => {
  test("re-evaluates no-response automation for the reset seed", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const createWorkspaceService = () =>
      createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });
    const workspaceService = createWorkspaceService();

    await workspaceService.getWorkspaceSnapshot();

    const resetSeed = createSeed();
    resetSeed.settings = {
      ...resetSeed.settings,
      applicationCrm: ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 14 },
      }),
    };
    resetSeed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_reset_old",
        jobId: "job_reset_old",
        title: "Senior Product Designer",
        company: "Reset Systems",
        status: "submitted",
        lastActionLabel: "Application submitted",
        nextActionLabel: "Awaiting employer response",
        lastUpdatedAt: "2020-01-01T10:00:00.000Z",
        crm: {
          revision: 1,
          stage: "applied",
          stageChangedAt: "2020-01-01T10:00:00.000Z",
          appliedAt: "2020-01-01T10:00:00.000Z",
        },
      }),
    ];

    const resetSnapshot = await workspaceService.resetWorkspace(resetSeed);
    const resetRecord = resetSnapshot.applicationRecords.find(
      (record) => record.id === "application_reset_old",
    );

    const restartedSnapshot =
      await createWorkspaceService().getWorkspaceSnapshot();
    const restartedRecord = restartedSnapshot.applicationRecords.find(
      (record) => record.id === "application_reset_old",
    );

    expect(resetRecord).toBeDefined();
    expect(restartedRecord).toBeDefined();
    expect(resetRecord?.crm?.stage).toBe("no_response");
    expect(restartedRecord).toEqual(resetRecord);
    expect(resetRecord).toMatchObject({
      lastActionLabel: "No response after 14 days",
      nextActionLabel: "Follow up with the employer",
      crm: {
        revision: 2,
        stage: "no_response",
        events: [
          {
            kind: "automation",
            title: "No response after 14 days",
            fromStage: "applied",
            toStage: "no_response",
            source: "automation",
          },
        ],
      },
    });
  });

  test("blocks reset during a profile proposal and prevents new work during reset", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const revision =
      createDeferred<
        Awaited<ReturnType<JobFinderAiClient["reviseCandidateProfile"]>>
      >();
    let revisionStarted = false;
    const aiClient: JobFinderAiClient = {
      ...createAiClient(),
      reviseCandidateProfile: () => {
        revisionStarted = true;
        return revision.promise;
      },
    };
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient,
      documentManager: createDocumentManager(),
    });
    const resetSeed = createSeed();
    resetSeed.profile = {
      ...resetSeed.profile,
      fullName: "Reset Candidate",
    };

    const proposalPromise = workspaceService.proposeProfileCopilotChange(
      "Please update my headline.",
      { surface: "profile", section: "basics" },
    );
    await vi.waitFor(() => expect(revisionStarted).toBe(true));

    const beforeStateReset = vi.fn(() => Promise.resolve());
    await expect(
      workspaceService.resetWorkspace(resetSeed, { beforeStateReset }),
    ).rejects.toThrow(
      "workspace reset is unavailable while profile proposal is still running",
    );
    expect(beforeStateReset).not.toHaveBeenCalled();
    expect((await repository.getProfile()).fullName).toBe("Alex Vanguard");

    revision.resolve({
      content: "I prepared the requested profile review.",
      patchGroups: [],
    });
    await proposalPromise;

    const resetPreparation = createDeferred<void>();
    let resetPreparationStarted = false;
    const resetPromise = workspaceService.resetWorkspace(resetSeed, {
      beforeStateReset: () => {
        resetPreparationStarted = true;
        return resetPreparation.promise;
      },
    });
    await vi.waitFor(() => expect(resetPreparationStarted).toBe(true));

    await expect(
      workspaceService.sendProfileCopilotMessage("This must not start."),
    ).rejects.toThrow("workspace reset is already in progress");

    resetPreparation.resolve();
    const resetSnapshot = await resetPromise;
    expect(resetSnapshot.profile.fullName).toBe("Reset Candidate");
    expect(await repository.listProfileCopilotMessages()).toEqual([]);
  });
});
