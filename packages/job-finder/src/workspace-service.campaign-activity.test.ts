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
  test("persists pause state; Check source and opening the browser refuse while paused, only Resume lowers it", async () => {
    const { service } = createService();
    const paused = await service.setActivityControl({
      paused: true,
      reason: "Pause all browser work.",
    });

    expect(paused.activityControl).toMatchObject({
      paused: true,
      reason: "Pause all browser work.",
    });
    await expect(service.runSourceDebug("1")).rejects.toThrow(
      "Background work is paused",
    );
    await expect(service.openBrowserSession()).rejects.toThrow(
      "Background work is paused",
    );
    expect(
      (await service.getWorkspaceSnapshot()).activityControl,
    ).toMatchObject({ paused: true, reason: "Pause all browser work." });

    await service.setActivityControl({ paused: true, reason: "Again." });
    const resumed = await service.setActivityControl({ paused: false });
    expect(resumed.activityControl).toEqual({
      paused: false,
      pausedAt: null,
      reason: null,
    });
  });
});
