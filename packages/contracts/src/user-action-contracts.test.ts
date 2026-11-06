import { describe, expect, it } from "vitest";

import {
  BrowserSourceAccessProbeResultSchema,
  UserActionCommandSchema,
  UserActionRequestSchema,
  userActionExpectedControlStateValues,
  userActionRequestKindValues,
  userActionRequestStateValues,
  userActionRequirementValues,
} from "./index";

const now = "2026-07-30T10:00:00.000Z";

function createDiscoveryRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "action-source-login",
    dedupeKey: "discovery-source-login:target-greenhouse",
    revision: 1,
    kind: "login",
    state: "awaiting_user",
    scope: {
      type: "discovery_source",
      targetId: "target-greenhouse",
      source: "target_site",
    },
    verification: {
      type: "source_access",
      targetId: "target-greenhouse",
      blockerFingerprint: "login-form-v1",
      expectedOrigin: "https://boards.greenhouse.io",
    },
    title: "Sign in to continue",
    summary: "Sign in in the browser, then confirm when the source is ready.",
    actionUrl: "https://boards.greenhouse.io/users/sign_in",
    displayOrigin: "https://boards.greenhouse.io",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApplicationRequest(
  verification: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "action-application-question",
    dedupeKey: "application-question:run-1:job-1",
    revision: 2,
    kind: "manual_answer",
    state: "pending",
    scope: {
      type: "application",
      runId: "run-1",
      jobId: "job-1",
      source: "target_site",
    },
    verification,
    title: "Answer a required question",
    summary: "Review and answer the question before the draft can continue.",
    createdAt: now,
    updatedAt: now,
  };
}

const commandBase = {
  requestId: "action-application-question",
  commandId: "command-1",
  expectedRevision: 2,
};

describe("unified user action request contracts", () => {
  it("exposes the complete request vocabulary", () => {
    expect(userActionRequestKindValues).toEqual([
      "login",
      "signup",
      "mfa",
      "email_verification",
      "captcha",
      "existing_account_choice",
      "manual_answer",
      "legal_consent",
      "external_redirect",
      "manual_upload",
      "other",
    ]);
    expect(userActionRequestStateValues).toEqual([
      "pending",
      "page_opened",
      "awaiting_user",
      "verifying",
      "still_blocked",
      "resolved",
      "skipped",
      "cancelled",
      "expired",
      "superseded",
    ]);
    expect(userActionRequirementValues).toEqual(["required", "recommended"]);
    expect(userActionExpectedControlStateValues).toEqual([
      "answered",
      "checked",
      "file_attached",
      "selection_made",
    ]);
  });

  it("defaults every request to browser-only, non-submitting behavior", () => {
    const request = UserActionRequestSchema.parse(createDiscoveryRequest());

    expect(request).toMatchObject({
      schemaVersion: 1,
      requirement: "required",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      attemptCount: 0,
      maxAttempts: 3,
      instructions: [],
      openedAt: null,
      resolvedAt: null,
      expiresAt: null,
    });
    expect(request.scope).toMatchObject({
      sourceDebugRunId: null,
      sourceDebugAttemptId: null,
    });
  });

  it.each([
    {
      type: "source_access",
      targetId: "target-application",
      blockerFingerprint: "access-wall-v1",
    },
    {
      type: "page_blocker_absent",
      blockerFingerprint: "captcha-v1",
    },
    {
      type: "form_control_state",
      controlFingerprint: "question-work-authorization",
      expectedState: "answered",
    },
    {
      type: "destination_reached",
      expectedOrigin: "https://boards.greenhouse.io",
    },
  ])("parses the $type verification strategy", (verification) => {
    const request = UserActionRequestSchema.parse(
      createApplicationRequest(verification),
    );

    expect(request.verification.type).toBe(verification.type);
    expect(request.scope).toMatchObject({
      type: "application",
      applicationRecordId: null,
      resultId: null,
      replayCheckpointId: null,
    });
  });

  it("allows application access verification without inventing a discovery target", () => {
    const request = UserActionRequestSchema.parse(
      createApplicationRequest({
        type: "source_access",
        blockerFingerprint: "application-login-v1",
        expectedOrigin: "https://boards.greenhouse.io",
      }),
    );

    expect(request.verification).toMatchObject({
      type: "source_access",
      targetId: null,
    });
  });
  it("retains attempt history and rejects inconsistent lifecycle and correlation data", () => {
    expect(
      UserActionRequestSchema.safeParse(
        createDiscoveryRequest({ attemptCount: 4, maxAttempts: 3 }),
      ).success,
    ).toBe(true);
    expect(
      UserActionRequestSchema.safeParse(
        createDiscoveryRequest({ state: "resolved" }),
      ).success,
    ).toBe(false);
    expect(
      UserActionRequestSchema.safeParse(
        createDiscoveryRequest({
          verification: {
            type: "source_access",
            targetId: "another-target",
            blockerFingerprint: "login-form-v1",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts a resolved request with an explicit resolution timestamp", () => {
    const result = UserActionRequestSchema.safeParse(
      createDiscoveryRequest({ state: "resolved", resolvedAt: now }),
    );

    expect(result.success).toBe(true);
  });

  it.each([
    { actionUrl: "https://user:secret@example.com/sign-in" },
    { actionUrl: "ftp://example.com/sign-in" },
    { displayOrigin: "https://example.com/sign-in" },
    { credentialsPolicy: "app_managed" },
    { submitAuthorized: true },
    { accountCreationAuthorized: true },
    { password: "secret" },
  ])("rejects unsafe request input %#", (unsafeOverride) => {
    expect(
      UserActionRequestSchema.safeParse(createDiscoveryRequest(unsafeOverride))
        .success,
    ).toBe(false);
  });

  it("rejects sensitive and unknown fields at nested boundaries", () => {
    const nestedOtp = createDiscoveryRequest({
      scope: {
        type: "discovery_source",
        targetId: "target-greenhouse",
        source: "target_site",
        otp: "123456",
      },
    });
    const nestedCaptchaSolution = createDiscoveryRequest({
      verification: {
        type: "source_access",
        targetId: "target-greenhouse",
        blockerFingerprint: "captcha-v1",
        captchaSolution: "solved-token",
      },
    });

    expect(UserActionRequestSchema.safeParse(nestedOtp).success).toBe(false);
    expect(
      UserActionRequestSchema.safeParse(nestedCaptchaSolution).success,
    ).toBe(false);
  });
});

describe("unified user action command contracts", () => {
  it.each([
    { action: "open_page" },
    { action: "confirm_done" },
    {
      action: "choose_account_path",
      choice: "use_existing_account",
    },
    {
      action: "submit_manual_answer",
      answer: "I am authorized to work in this location.",
    },
    {
      action: "submit_task_local_credentials",
      identifier: "fixture-person@example.test",
      password: "test-password",
      taskLocalUseAuthorized: true,
    },
    {
      action: "record_legal_decision",
      decision: "decline",
    },
    { action: "skip" },
    { action: "cancel" },
  ])("parses the $action command with immutable safety defaults", (command) => {
    const result = UserActionCommandSchema.parse({
      ...commandBase,
      ...command,
    });

    expect(result).toMatchObject({
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  it.each([
    { ...commandBase, action: "open_page", commandId: undefined },
    { ...commandBase, action: "open_page", expectedRevision: 0 },
    { ...commandBase, action: "open_page", password: "secret" },
    { ...commandBase, action: "confirm_done", otp: "123456" },
    {
      ...commandBase,
      action: "confirm_done",
      captchaSolution: "solved-token",
    },
    { ...commandBase, action: "confirm_done", submitAuthorized: true },
    {
      ...commandBase,
      action: "submit_task_local_credentials",
      identifier: "fixture-person@example.test",
      password: "test-password",
      taskLocalUseAuthorized: false,
    },
    {
      ...commandBase,
      action: "choose_account_path",
      choice: "create_account_in_browser",
      accountCreationAuthorized: true,
    },
    {
      ...commandBase,
      action: "open_page",
      credentialsPolicy: "app_managed",
    },
  ])("rejects unsafe or non-idempotent command input %#", (command) => {
    expect(UserActionCommandSchema.safeParse(command).success).toBe(false);
  });
});
describe("browser source access probe contract", () => {
  it("accepts only strong redacted authenticated evidence", () => {
    expect(
      BrowserSourceAccessProbeResultSchema.parse({
        state: "authenticated",
        checkedAt: now,
        currentOrigin: "https://boards.greenhouse.io/",
        signals: ["account_menu_control"],
      }),
    ).toMatchObject({ state: "authenticated" });

    expect(
      BrowserSourceAccessProbeResultSchema.safeParse({
        state: "authenticated",
        checkedAt: now,
        currentOrigin: "https://boards.greenhouse.io/",
        signals: [],
      }).success,
    ).toBe(false);
  });

  it("rejects blockers without an explicit safe signal and all raw evidence", () => {
    expect(
      BrowserSourceAccessProbeResultSchema.safeParse({
        state: "blocked",
        checkedAt: now,
        currentOrigin: "https://boards.greenhouse.io/",
        signals: ["login_control"],
      }).success,
    ).toBe(false);
    expect(
      BrowserSourceAccessProbeResultSchema.safeParse({
        state: "blocked",
        checkedAt: now,
        currentOrigin: "https://boards.greenhouse.io/",
        signals: ["password_control"],
        pageText: "candidate@example.com secret",
      }).success,
    ).toBe(false);
  });
});
