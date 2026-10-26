import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test } from "vitest";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
  createSeed,
} from "./workspace-service.test-support";


function createService() {
  const repository = createInMemoryJobFinderRepository(createSeed());
  const service = createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: { exists: () => Promise.resolve(true) },
    researchAdapter: createResearchAdapter(),
  });
  return { repository, service };
}

describe("workspace campaign and activity controls", () => {
  test("persists pause state, and an explicit user action resumes it instead of failing", async () => {
    const { service } = createService();
    const paused = await service.setActivityControl({
      paused: true,
      reason: "Pause all browser work.",
    });

    expect(paused.activityControl).toMatchObject({
      paused: true,
      reason: "Pause all browser work.",
    });
    // A deliberate Check source click clears the pause; it must never fail
    // with "press Resume on Home first" (whatever the check itself returns).
    await service.runSourceDebug("target_linkedin_default").catch((error) => {
      expect(String(error)).not.toContain("activity is paused");
    });
    expect((await service.getWorkspaceSnapshot()).activityControl.paused).toBe(
      false,
    );

    await service.setActivityControl({ paused: true, reason: "Again." });
    const resumed = await service.setActivityControl({ paused: false });
    expect(resumed.activityControl).toEqual({
      paused: false,
      pausedAt: null,
      reason: null,
    });
  });



});
