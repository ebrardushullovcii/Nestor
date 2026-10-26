import type { JobFinderAiClient } from "@nestor/ai-providers";
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
