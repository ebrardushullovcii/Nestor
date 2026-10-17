import {
  UserActionRequestSchema,
  UserActionVerificationResultSchema,
  type UserActionRequest,
  type UserActionRequestState,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createUserActionCreatedEvent,
  isUserActionTerminal,
  reduceUserActionCommand,
  reduceUserActionSuperseded,
  reduceUserActionVerification,
} from "./user-action-domain";

const createdAt = "2026-07-30T10:00:00.000Z";

function createRequest(
  overrides: Record<string, unknown> = {},
): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: "action-login-1",
    dedupeKey: "source-login:target-1",
    revision: 1,
    kind: "login",
    state: "awaiting_user",
    scope: {
      type: "discovery_source",
      targetId: "target-1",
      source: "target_site",
    },
    verification: {
      type: "source_access",
      targetId: "target-1",
      blockerFingerprint: "login-form-v1",
    },
    title: "Sign in to continue",
    summary: "Complete sign-in in the browser, then ask the app to verify.",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

describe("user action lifecycle domain", () => {
  test("creates a secret-free initial event", () => {
    const request = createRequest();
    const event = createUserActionCreatedEvent(request);

    expect(event).toMatchObject({
      id: "action-login-1:created",
      requestId: request.id,
      operation: "created",
      previousRevision: 0,
      resultingRevision: 1,
      previousState: "awaiting_user",
      resultingState: "awaiting_user",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  test("moves open then done through page_opened to verifying", () => {
    const opened = reduceUserActionCommand(
      createRequest(),
      {
        action: "open_page",
        requestId: "action-login-1",
        commandId: "command-open-1",
        expectedRevision: 1,
      },
      "2026-07-30T10:01:00.000Z",
    );

    expect(opened).toMatchObject({
      status: "applied",
      request: {
        revision: 2,
        state: "page_opened",
        openedAt: "2026-07-30T10:01:00.000Z",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      },
      event: {
        id: "command-open-1",
        operation: "open_page",
        previousRevision: 1,
        resultingRevision: 2,
      },
    });

    if (opened.status !== "applied") {
      throw new Error("Expected the open command to apply.");
    }

    const verifying = reduceUserActionCommand(
      opened.request,
      {
        action: "confirm_done",
        requestId: "action-login-1",
        commandId: "command-done-1",
        expectedRevision: 2,
      },
      "2026-07-30T10:02:00.000Z",
    );

    expect(verifying).toMatchObject({
      status: "applied",
      request: {
        revision: 3,
        state: "verifying",
        attemptCount: 1,
        resolvedAt: null,
      },
      event: {
        operation: "confirm_done",
        previousState: "page_opened",
        resultingState: "verifying",
      },
    });
  });

  test("returns stale without mutating when the expected revision is old", () => {
    const request = createRequest({ revision: 2 });
    const result = reduceUserActionCommand(
      request,
      {
        action: "confirm_done",
        requestId: request.id,
        commandId: "command-stale-1",
        expectedRevision: 1,
      },
      "2026-07-30T10:03:00.000Z",
    );

    expect(result).toEqual({
      status: "stale",
      request,
      event: null,
    });
  });

  test("supersedes an older actionable request while preserving its history", () => {
    const request = createRequest({
      revision: 2,
      state: "page_opened",
      openedAt: "2026-07-30T10:01:00.000Z",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const result = reduceUserActionSuperseded(
      request,
      "action-login-new",
      "2026-07-30T11:00:00.000Z",
    );

    expect(result).toMatchObject({
      status: "applied",
      request: {
        revision: 3,
        state: "superseded",
        openedAt: "2026-07-30T10:01:00.000Z",
        resolvedAt: "2026-07-30T11:00:00.000Z",
      },
      event: {
        id: "supersede:action-login-1:action-login-new",
        operation: "supersede",
        previousRevision: 2,
        resultingRevision: 3,
        previousState: "page_opened",
        resultingState: "superseded",
        submitAuthorized: false,
      },
    });
  });

  test("never copies manual answers into persisted requests or events", () => {
    const secret = "private-security-answer-that-must-not-be-stored";
    const request = createRequest({
      kind: "manual_answer",
      verification: {
        type: "form_control_state",
        controlFingerprint: "question-work-authorization",
        expectedState: "answered",
      },
    });
    const result = reduceUserActionCommand(
      request,
      {
        action: "submit_manual_answer",
        requestId: request.id,
        commandId: "command-answer-1",
        expectedRevision: 1,
        answer: secret,
        saveForFuture: true,
      },
      "2026-07-30T10:04:00.000Z",
    );

    expect(result.status).toBe("applied");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      request: { state: "verifying", attemptCount: 1 },
      event: { operation: "submit_manual_answer" },
    });
  });

  test("never copies task-local credentials into persisted requests or events", () => {
    const identifier = "fixture-person@example.test";
    const password = "test-secret-value";
    const request = createRequest({
      scope: {
        type: "application",
        runId: "apply-run-1",
        jobId: "job-1",
        resultId: "result-1",
        replayCheckpointId: "checkpoint-1",
        source: "target_site",
      },
    });
    const result = reduceUserActionCommand(
      request,
      {
        action: "submit_task_local_credentials",
        requestId: request.id,
        commandId: "command-credential-1",
        expectedRevision: 1,
        identifier,
        password,
        taskLocalUseAuthorized: true,
      },
      "2026-07-30T10:04:00.000Z",
    );

    expect(result.status).toBe("applied");
    expect(JSON.stringify(result)).not.toContain(identifier);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(result).toMatchObject({
      request: { state: "verifying", attemptCount: 1 },
      event: { operation: "submit_task_local_credentials" },
    });
  });

  test("refuses task-local credentials for a source login without application lineage", () => {
    expect(() =>
      reduceUserActionCommand(
        createRequest(),
        {
          action: "submit_task_local_credentials",
          requestId: "action-login-1",
          commandId: "command-credential-wrong-scope",
          expectedRevision: 1,
          identifier: "fixture-person@example.test",
          password: "test-secret-value",
          taskLocalUseAuthorized: true,
        },
        "2026-07-30T10:04:00.000Z",
      ),
    ).toThrow(/exact sign-in request/i);
  });

  test("records failed verification truthfully and resolves only verified work", () => {
    const verifyingRequest = createRequest({
      revision: 2,
      state: "verifying",
      attemptCount: 1,
    });
    const failed = reduceUserActionVerification(
      verifyingRequest,
      UserActionVerificationResultSchema.parse({
        requestId: verifyingRequest.id,
        verificationId: "verification-1",
        expectedRevision: 2,
        outcome: "still_blocked",
        checkedAt: "2026-07-30T10:05:00.000Z",
      }),
    );

    expect(failed).toMatchObject({
      status: "applied",
      request: {
        revision: 3,
        state: "still_blocked",
        resolvedAt: null,
      },
      event: {
        id: "verification-1",
        operation: "verification_failed",
      },
    });

    const verified = reduceUserActionVerification(
      createRequest({
        revision: 2,
        state: "verifying",
        attemptCount: 1,
      }),
      {
        requestId: verifyingRequest.id,
        verificationId: "verification-2",
        expectedRevision: 2,
        outcome: "verified",
        checkedAt: "2026-07-30T10:06:00.000Z",
      },
    );

    expect(verified).toMatchObject({
      status: "applied",
      request: {
        revision: 3,
        state: "resolved",
        resolvedAt: "2026-07-30T10:06:00.000Z",
      },
      event: { operation: "verification_succeeded" },
    });
  });

  test("blocks impossible transitions and verification loops", () => {
    expect(() =>
      reduceUserActionCommand(
        createRequest({ state: "resolved", resolvedAt: createdAt }),
        {
          action: "open_page",
          requestId: "action-login-1",
          commandId: "command-after-resolution",
          expectedRevision: 1,
        },
        createdAt,
      ),
    ).toThrow(/terminal/iu);

    expect(() =>
      reduceUserActionCommand(
        createRequest({ attemptCount: 3, maxAttempts: 3 }),
        {
          action: "confirm_done",
          requestId: "action-login-1",
          commandId: "command-over-limit",
          expectedRevision: 1,
        },
        createdAt,
      ),
    ).toThrow(/attempt/iu);

    expect(() =>
      reduceUserActionVerification(createRequest(), {
        requestId: "action-login-1",
        verificationId: "verification-not-running",
        expectedRevision: 1,
        outcome: "verified",
        checkedAt: createdAt,
      }),
    ).toThrow(/verifying/iu);
  });

  test("identifies every terminal lifecycle state", () => {
    const terminalStates: UserActionRequestState[] = [
      "resolved",
      "skipped",
      "cancelled",
      "expired",
      "superseded",
    ];

    expect(terminalStates.every((state) => isUserActionTerminal(state))).toBe(
      true,
    );
    expect(isUserActionTerminal("still_blocked")).toBe(false);
  });
});
