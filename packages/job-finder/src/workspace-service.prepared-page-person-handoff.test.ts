import {
  ApplicationAttemptBlockerSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { persistApplicationUserAction } from "./internal/workspace-application-user-action";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-09-24T00:20:00.000Z";


describe("opening a prepared application to finish it", () => {






  test("a finished step's snapshot recovery does not lock the page handed to the person", async () => {
    const closeApplicationFormAction = vi.fn(() => Promise.resolve());
    const drafting = createWorkspaceServiceHarness({ seed: createSeed() });
    const harness = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime: {
        ...createBrowserRuntime(),
        closeApplicationFormAction,
      },
    });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    await persistApplicationUserAction({
      repository: drafting.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "run_answered",
      resultId: "result_answered",
      replayCheckpointId: "checkpoint_answered",
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "site_login_required",
        summary: "Sign in before continuing.",
        url: job.applicationUrl ?? job.canonicalUrl,
      }),
      occurredAt: now,
    });
    const request = (await drafting.repository.listUserActionRequests())[0];
    if (!request) throw new Error("Expected a request.");

    // Settled long ago: every snapshot re-reads it, and each read used to
    // close the send window of the filled-in form the person had opened.
    await harness.repository.createUserActionRequest({
      ...request,
      state: "resolved",
      resolvedAt: now,
    });
    expect((await harness.repository.listUserActionRequests())[0]?.state).toBe(
      "resolved",
    );
    await harness.workspaceService.getWorkspaceSnapshot();
    await harness.workspaceService.getWorkspaceSnapshot();
    expect(closeApplicationFormAction).not.toHaveBeenCalled();
  });
});
