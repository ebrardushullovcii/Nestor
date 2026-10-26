import { expect, it } from "vitest";
import { getAssistantSearchReadiness } from "../prompt";
import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import { assistantTestReads } from "../store-reads.test-support";

it("requires an enabled site, independently of a resume or legacy browser state", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const state = await assistantTestReads(workspaceService).readPersonalState();
  state.enabledSiteCount = 0;
  expect(getAssistantSearchReadiness(state)).toMatchObject({
    canStartSearch: false,
    resumeRequired: false,
    targetRolesRequired: false,
  });
  state.enabledSiteCount = 2;
  state.profile.baseResume.storagePath = null;
  expect(getAssistantSearchReadiness(state)).toMatchObject({
    canStartSearch: true,
    enabledSourceCount: 2,
    missingRequirements: [],
  });
  state.activityControl.paused = true;
  expect(getAssistantSearchReadiness(state)).toMatchObject({
    canStartSearch: false,
  });
  expect(getAssistantSearchReadiness(state).missingRequirements[0]).toContain(
    "paused",
  );
});
