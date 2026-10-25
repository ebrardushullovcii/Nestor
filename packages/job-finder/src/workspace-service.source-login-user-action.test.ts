
import {
  SourceDebugRunRecordSchema,
} from "@nestor/contracts";
import { describe, expect, test, } from "vitest";
import {
  persistDiscoveryLoginUserAction,
} from "./internal/workspace-source-user-action";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createPausedRun(summary: string) {
  return SourceDebugRunRecordSchema.parse({
    id: "source_debug_run_login_required",
    targetId: "1",
    state: "paused_manual",
    startedAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:01:00.000Z",
    completedAt: "2026-07-30T08:01:00.000Z",
    activePhase: "access_auth_probe",
    phases: [
      "access_auth_probe",
      "site_structure_mapping",
      "search_filter_probe",
      "job_detail_validation",
      "apply_path_validation",
      "replay_verification",
    ],
    targetLabel: "LinkedIn",
    targetUrl: "https://www.linkedin.com/jobs/search/",
    targetHostname: "www.linkedin.com",
    manualPrerequisiteSummary: summary,
    finalSummary: summary,
    attemptIds: [],
    phaseSummaries: [],
    instructionArtifactId: null,
    timing: null,
  });
}

describe("discovery source login UserActionRequest adoption", () => {

  test("persists one strict browser-owned request for a login-required source prompt", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const run = createPausedRun("Please sign in first.");

    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });
    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });

    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    expect(snapshot.userActionRequests).toHaveLength(1);
    expect(snapshot.userActionRequests[0]).toMatchObject({
      kind: "login",
      state: "pending",
      requirement: "required",
      actionUrl: "https://www.linkedin.com/jobs/search/",
      displayOrigin: "https://www.linkedin.com/",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      scope: {
        type: "discovery_source",
        targetId: "1",
        source: "target_site",
        sourceDebugRunId: run.id,
      },
      verification: {
        type: "source_access",
        targetId: "1",
        expectedOrigin: "https://www.linkedin.com/",
      },
    });
  });

  test("does not turn an unrelated manual prerequisite into a login request", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });

    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run: createPausedRun("Choose a search category manually."),
    });

    expect(await harness.repository.listUserActionRequests()).toEqual([]);
  });

  test("never reopens or clears a terminal request when the same blocker is persisted again", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const run = createPausedRun("Please sign in first.");
    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });
    const request = (await harness.repository.listUserActionRequests())[0];
    if (!request) throw new Error("Expected a persisted login request.");

    await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: request.id,
      commandId: "cancel_login_request",
      expectedRevision: request.revision,
      reason: "User chose not to sign in.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });

    const requests = await harness.repository.listUserActionRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toBe("cancelled");
  });
});
