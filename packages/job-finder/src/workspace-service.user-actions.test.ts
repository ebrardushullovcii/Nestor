import {
  createCatalogBrowserSessionRuntime,
  type BrowserSessionRuntime,
} from "@nestor/browser-runtime";
import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
  type BrowserSourceAccessProbeResult,
  type UserActionRequest,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createRequest(
  overrides: Partial<UserActionRequest> = {},
): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: "action_login",
    dedupeKey: "discovery:target_linkedin_default:login",
    revision: 1,
    kind: "login",
    state: "pending",
    scope: {
      type: "discovery_source",
      targetId: "target_linkedin_default",
      source: "target_site",
      sourceDebugRunId: null,
      sourceDebugAttemptId: null,
    },
    verification: {
      type: "source_access",
      targetId: "target_linkedin_default",
      blockerFingerprint: "login-wall-v1",
      expectedOrigin: "https://boards.example.com/",
    },
    title: "Sign in to continue",
    summary: "Complete sign-in in the Job Finder browser.",
    instructions: ["Sign in without sharing credentials with Job Finder."],
    actionUrl: "https://boards.example.com/jobs",
    displayOrigin: "https://boards.example.com/",
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    ...overrides,
  });
}

function createRuntime(
  inspectSourceAccess: NonNullable<
    BrowserSessionRuntime["inspectSourceAccess"]
  >,
): BrowserSessionRuntime {
  return {
    ...createCatalogBrowserSessionRuntime({ sessions: [], catalog: [] }),
    inspectSourceAccess,
  };
}

const authenticatedResult: BrowserSourceAccessProbeResult = {
  state: "authenticated",
  checkedAt: "2026-07-30T08:02:00.000Z",
  currentOrigin: "https://boards.example.com/",
  signals: ["account_menu_control"],
};

const blockedResult: BrowserSourceAccessProbeResult = {
  state: "blocked",
  checkedAt: "2026-07-30T08:02:00.000Z",
  currentOrigin: "https://boards.example.com/",
  signals: ["password_control"],
};

const inconclusiveResult: BrowserSourceAccessProbeResult = {
  state: "inconclusive",
  checkedAt: "2026-07-30T08:02:00.000Z",
  currentOrigin: "https://boards.example.com/",
  signals: ["login_control"],
};

function confirmDoneCommand(
  expectedRevision: number,
  commandId = "command_done",
) {
  return {
    action: "confirm_done" as const,
    requestId: "action_login",
    commandId,
    expectedRevision,
    credentialsPolicy: "browser_only" as const,
    submitAuthorized: false as const,
    accountCreationAuthorized: false as const,
  };
}

describe("workspace user action inbox operations", () => {
  test("opens only the request URL and never treats page-opened as verified", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createRequest()];
    const inspectSourceAccess = vi.fn(() =>
      Promise.resolve(authenticatedResult),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });
    const openSession = vi.spyOn(harness.browserRuntime, "openSession");

    const snapshot = await harness.workspaceService.performUserAction({
      action: "open_page",
      requestId: "action_login",
      commandId: "command_open",
      expectedRevision: 1,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(openSession).toHaveBeenCalledWith("target_site", {
      targetUrl: "https://boards.example.com/jobs",
    });
    expect(inspectSourceAccess).not.toHaveBeenCalled();
    expect(snapshot.userActionRequests[0]?.state).toBe("page_opened");
    expect(snapshot.userActionEvents.at(-1)?.operation).toBe("open_page");
  });

  test("serializes different commands for one request so a released button cannot open twice", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createRequest()];
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(
        vi.fn(() => Promise.resolve(blockedResult)),
      ),
    });
    const openSession = vi
      .spyOn(harness.browserRuntime, "openSession")
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return harness.browserRuntime.getSessionState("target_site");
      });
    const command = {
      action: "open_page" as const,
      requestId: "action_login",
      expectedRevision: 1,
      credentialsPolicy: "browser_only" as const,
      submitAuthorized: false as const,
      accountCreationAuthorized: false as const,
    };

    await Promise.all([
      harness.workspaceService.performUserAction({
        ...command,
        commandId: "command_open_first",
      }),
      harness.workspaceService.performUserAction({
        ...command,
        commandId: "command_open_retry",
      }),
    ]);

    expect(openSession).toHaveBeenCalledTimes(1);
  });

  test("opens a fresh manual page only for an application blocked during background loading", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "ready_for_review",
        lastActionLabel: "Application started",
        nextActionLabel: "Complete sign-in",
        lastUpdatedAt: "2026-07-30T08:00:00.000Z",
      }),
    ];
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_1",
        campaignId: null,
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        createdAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
        completedAt: "2026-07-30T08:00:00.000Z",
        summary: "Application preparation paused for sign-in.",
        detail: "The exact application remains resumable.",
        totalJobs: 1,
        pendingJobs: 0,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_1",
        runId: "apply_run_1",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "blocked",
        summary: "Sign in to continue.",
        detail: "The browser is waiting for user-owned authentication.",
        startedAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
      }),
    ];
    seed.userActionRequests = [
      createRequest({
        kind: "other",
        summary:
          "Job Finder blocked a background page request before it could continue preparing this application.",
        scope: {
          type: "application",
          source: "target_site",
          runId: "apply_run_1",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
          resultId: "apply_result_1",
          replayCheckpointId: "checkpoint_1",
        },
        verification: {
          type: "page_blocker_absent",
          blockerFingerprint: "background_request",
          expectedPageFingerprint: null,
        },
      }),
    ];
    const inspectSourceAccess = vi.fn(() =>
      Promise.resolve(authenticatedResult),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });
    const openSession = vi.spyOn(harness.browserRuntime, "openSession");

    const snapshot = await harness.workspaceService.performUserAction({
      action: "open_page",
      requestId: "action_login",
      commandId: "command_open",
      expectedRevision: 1,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(openSession).toHaveBeenCalledWith("target_site", {
      targetUrl: "https://boards.example.com/jobs",
      reuseExistingPage: false,
    });
    expect(inspectSourceAccess).not.toHaveBeenCalled();
    expect(snapshot.userActionRequests[0]?.state).toBe("page_opened");
    expect(snapshot.userActionEvents.at(-1)?.operation).toBe("open_page");
  });

  test("resolves Done only after strong same-origin browser evidence", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createRequest()];
    const inspectSourceAccess = vi.fn(() =>
      Promise.resolve(authenticatedResult),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });

    const snapshot = await harness.workspaceService.performUserAction(
      confirmDoneCommand(1),
    );

    expect(inspectSourceAccess).toHaveBeenCalledWith("target_site", {
      expectedOrigin: "https://boards.example.com",
    });
    expect(snapshot.userActionRequests[0]).toMatchObject({
      state: "resolved",
      revision: 3,
      attemptCount: 1,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    expect(
      snapshot.userActionEvents.slice(-2).map((event) => event.operation),
    ).toEqual(["confirm_done", "verification_succeeded"]);
  });

  test("verifies an application-scoped login request with the same browser-only probe", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "ready_for_review",
        lastActionLabel: "Application started",
        nextActionLabel: "Complete sign-in",
        lastUpdatedAt: "2026-07-30T08:00:00.000Z",
      }),
    ];
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_1",
        campaignId: null,
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        createdAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
        completedAt: "2026-07-30T08:00:00.000Z",
        summary: "Application preparation paused for sign-in.",
        detail: "The exact application remains resumable.",
        totalJobs: 1,
        pendingJobs: 0,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_1",
        runId: "apply_run_1",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "blocked",
        summary: "Sign in to continue.",
        detail: "The browser is waiting for user-owned authentication.",
        startedAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
      }),
    ];
    seed.userActionRequests = [
      createRequest({
        scope: {
          type: "application",
          runId: "apply_run_1",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
          resultId: "apply_result_1",
          replayCheckpointId: "apply_checkpoint_1",
          source: "target_site",
        },
      }),
    ];
    const inspectSourceAccess = vi.fn(() =>
      Promise.resolve(authenticatedResult),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });

    const snapshot = await harness.workspaceService.performUserAction(
      confirmDoneCommand(1, "command_application_done"),
    );

    expect(snapshot.userActionRequests[0]).toMatchObject({
      state: "resolved",
      attemptCount: 1,
      scope: {
        type: "application",
        runId: "apply_run_1",
        jobId: "job_ready",
      },
    });
    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["blocked", () => Promise.resolve(blockedResult)],
    ["inconclusive", () => Promise.resolve(inconclusiveResult)],
    ["probe error", () => Promise.reject(new Error("probe unavailable"))],
    [
      "wrong origin",
      () =>
        Promise.resolve({
          ...authenticatedResult,
          currentOrigin: "https://accounts.example.net/",
        }),
    ],
  ])(
    "keeps %s verification truthful and retryable",
    async (_label, inspect) => {
      const seed = createSeed();
      seed.userActionRequests = [createRequest()];
      const harness = createWorkspaceServiceHarness({
        seed,
        browserRuntime: createRuntime(vi.fn(inspect)),
      });

      const snapshot = await harness.workspaceService.performUserAction(
        confirmDoneCommand(1),
      );

      expect(snapshot.userActionRequests[0]).toMatchObject({
        state: "still_blocked",
        revision: 3,
        attemptCount: 1,
        resolvedAt: null,
      });
      expect(snapshot.userActionEvents.at(-1)?.operation).toBe(
        "verification_failed",
      );
    },
  );

  test("allows one probe per Done and refuses a fourth attempt", async () => {
    const seed = createSeed();
    seed.userActionRequests = [
      createRequest({ state: "still_blocked", revision: 5, attemptCount: 2 }),
    ];
    const inspectSourceAccess = vi.fn(() => Promise.resolve(blockedResult));
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });

    const afterThird = await harness.workspaceService.performUserAction(
      confirmDoneCommand(5, "command_third"),
    );
    const thirdRequest = afterThird.userActionRequests[0];
    expect(thirdRequest).toMatchObject({
      state: "still_blocked",
      revision: 7,
      attemptCount: 3,
    });
    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);

    await expect(
      harness.workspaceService.performUserAction(
        confirmDoneCommand(thirdRequest?.revision ?? 0, "command_fourth"),
      ),
    ).rejects.toThrow(/verification attempt limit/iu);
    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent verification for the same request revision", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createRequest()];
    const inspectSourceAccess = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return authenticatedResult;
    });
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });
    const command = confirmDoneCommand(1, "command_duplicate");

    const [first, second] = await Promise.all([
      harness.workspaceService.performUserAction(command),
      harness.workspaceService.performUserAction(command),
    ]);

    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect(first.userActionRequests[0]?.state).toBe("resolved");
    expect(second.userActionRequests[0]?.state).toBe("resolved");
    expect(
      (await harness.repository.listUserActionEvents()).filter(
        (event) => event.operation === "verification_succeeded",
      ),
    ).toHaveLength(1);
  });

  test("recovers a persisted verifying request once without consuming another attempt", async () => {
    const seed = createSeed();
    seed.userActionRequests = [
      createRequest({ state: "verifying", revision: 2, attemptCount: 1 }),
    ];
    const inspectSourceAccess = vi.fn(() =>
      Promise.resolve(authenticatedResult),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createRuntime(inspectSourceAccess),
    });

    const first = await harness.workspaceService.getWorkspaceSnapshot();
    const second = await harness.workspaceService.getWorkspaceSnapshot();

    expect(first.userActionRequests[0]).toMatchObject({
      state: "resolved",
      revision: 3,
      attemptCount: 1,
    });
    expect(second.userActionRequests[0]?.state).toBe("resolved");
    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect(first.userActionEvents.at(-1)?.id).toBe(
      "verification:action_login:r2",
    );
  });
});
