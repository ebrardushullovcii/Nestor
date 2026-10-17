import { DatabaseSync } from "node:sqlite";

import {
  UserActionEventSchema,
  UserActionRequestSchema,
  type UserActionEvent,
  type UserActionRequest,
} from "@nordri/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const temporaryDirectories: string[] = [];
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

function createTransition(
  request: UserActionRequest,
  input: {
    eventId: string;
    state: UserActionRequest["state"];
    occurredAt: string;
  },
): { event: UserActionEvent; request: UserActionRequest } {
  const nextRequest = UserActionRequestSchema.parse({
    ...request,
    revision: request.revision + 1,
    state: input.state,
    updatedAt: input.occurredAt,
    openedAt:
      input.state === "page_opened" ? input.occurredAt : request.openedAt,
  });
  const event = UserActionEventSchema.parse({
    id: input.eventId,
    requestId: request.id,
    operation: input.state === "page_opened" ? "open_page" : "confirm_done",
    previousRevision: request.revision,
    resultingRevision: nextRequest.revision,
    previousState: request.state,
    resultingState: nextRequest.state,
    occurredAt: input.occurredAt,
  });

  return { request: nextRequest, event };
}

async function exerciseIdempotentTransitions(
  repository: JobFinderRepository,
): Promise<void> {
  const initialRequest = createRequest();
  const created = await repository.createUserActionRequest(initialRequest);

  expect(created).toMatchObject({
    status: "created",
    request: { id: initialRequest.id, revision: 1 },
    event: { operation: "created" },
  });

  const repeatedCreate = await repository.createUserActionRequest(
    createRequest({ id: "another-generated-id" }),
  );
  expect(repeatedCreate).toMatchObject({
    status: "existing",
    request: { id: initialRequest.id, revision: 1 },
  });

  const transition = createTransition(initialRequest, {
    eventId: "command-open-1",
    state: "page_opened",
    occurredAt: "2026-07-30T10:01:00.000Z",
  });
  const applied = await repository.commitUserActionTransition(transition);

  expect(applied).toMatchObject({
    status: "applied",
    request: { revision: 2, state: "page_opened" },
  });

  const duplicate = await repository.commitUserActionTransition(transition);

  expect(duplicate).toMatchObject({
    status: "duplicate",
    request: { revision: 2, state: "page_opened" },
    event: { id: "command-open-1" },
  });

  const staleTransition = createTransition(initialRequest, {
    eventId: "command-stale-1",
    state: "verifying",
    occurredAt: "2026-07-30T10:02:00.000Z",
  });
  const stale = await repository.commitUserActionTransition(staleTransition);

  expect(stale).toMatchObject({
    status: "stale",
    request: { revision: 2, state: "page_opened" },
    event: null,
  });
  await expect(
    repository.listUserActionEvents({ requestId: initialRequest.id }),
  ).resolves.toEqual([
    expect.objectContaining({ operation: "created" }),
    expect.objectContaining({ operation: "open_page" }),
  ]);
  await expect(
    repository.listUserActionRequests({ states: ["page_opened"] }),
  ).resolves.toEqual([
    expect.objectContaining({ id: initialRequest.id, revision: 2 }),
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(cleanupTempDirectoryWithRetry),
  );
});

describe("user action repository persistence", () => {
  test("keeps in-memory transitions compare-and-swap safe and idempotent", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());

    await exerciseIdempotentTransitions(repository);
    await repository.close();
  });

  test("survives SQLite restart without duplicating a completed command", async () => {
    const fixture = await createTempRepository("nordri-user-actions-");
    temporaryDirectories.push(fixture.tempDirectory);
    const firstRepository = await fixture.createRepository();
    const initialRequest = createRequest();
    await firstRepository.createUserActionRequest(initialRequest);
    const transition = createTransition(initialRequest, {
      eventId: "command-open-1",
      state: "page_opened",
      occurredAt: "2026-07-30T10:01:00.000Z",
    });
    await expect(
      firstRepository.commitUserActionTransition(transition),
    ).resolves.toMatchObject({ status: "applied" });
    await firstRepository.close();

    const restartedRepository = await fixture.createRepository();
    await expect(
      restartedRepository.getUserActionRequest(initialRequest.id),
    ).resolves.toMatchObject({ revision: 2, state: "page_opened" });
    await expect(
      restartedRepository.commitUserActionTransition(transition),
    ).resolves.toMatchObject({
      status: "duplicate",
      request: { revision: 2 },
    });
    await expect(
      restartedRepository.listUserActionEvents({
        requestId: initialRequest.id,
      }),
    ).resolves.toHaveLength(2);
    await restartedRepository.close();

    const database = new DatabaseSync(fixture.filePath);
    const migration = database
      .prepare("SELECT name FROM schema_migrations WHERE version = ?")
      .get(9) as { name?: string } | undefined;
    const rawRequest = database
      .prepare("SELECT value FROM user_action_requests WHERE id = ?")
      .get(initialRequest.id) as { value?: string } | undefined;
    const rawEvents = database
      .prepare(
        "SELECT group_concat(value, '') AS value FROM user_action_events WHERE request_id = ?",
      )
      .get(initialRequest.id) as { value?: string } | undefined;
    database.close();

    expect(migration?.name).toBe("job_finder_user_actions");
    expect(`${rawRequest?.value ?? ""}${rawEvents?.value ?? ""}`).not.toMatch(
      /password|captchaSolution|otp|security-answer/iu,
    );
  });

  test("preserves in-flight verification and its final result across SQLite restarts", async () => {
    const fixture = await createTempRepository(
      "nordri-user-action-verification-restart-",
    );
    temporaryDirectories.push(fixture.tempDirectory);
    const firstRepository = await fixture.createRepository();
    const initialRequest = createRequest();
    await firstRepository.createUserActionRequest(initialRequest);

    const openedAt = "2026-07-30T10:01:00.000Z";
    const opened = createTransition(initialRequest, {
      eventId: "restart-open",
      state: "page_opened",
      occurredAt: openedAt,
    });
    await firstRepository.commitUserActionTransition(opened);

    const verifyingAt = "2026-07-30T10:02:00.000Z";
    const verifyingRequest = UserActionRequestSchema.parse({
      ...opened.request,
      revision: 3,
      state: "verifying",
      attemptCount: 1,
      updatedAt: verifyingAt,
    });
    const verifyingEvent = UserActionEventSchema.parse({
      id: "restart-confirm-done",
      requestId: initialRequest.id,
      operation: "confirm_done",
      previousRevision: 2,
      resultingRevision: 3,
      previousState: "page_opened",
      resultingState: "verifying",
      occurredAt: verifyingAt,
    });
    await firstRepository.commitUserActionTransition({
      request: verifyingRequest,
      event: verifyingEvent,
    });
    await firstRepository.close();

    const verifyingRepository = await fixture.createRepository();
    await expect(
      verifyingRepository.getUserActionRequest(initialRequest.id),
    ).resolves.toMatchObject({
      revision: 3,
      state: "verifying",
      attemptCount: 1,
      openedAt,
      resolvedAt: null,
    });
    await expect(
      verifyingRepository.listUserActionRequests({ states: ["verifying"] }),
    ).resolves.toEqual([
      expect.objectContaining({ id: initialRequest.id, revision: 3 }),
    ]);

    const resolvedAt = "2026-07-30T10:03:00.000Z";
    const resolvedRequest = UserActionRequestSchema.parse({
      ...verifyingRequest,
      revision: 4,
      state: "resolved",
      updatedAt: resolvedAt,
      resolvedAt,
    });
    const resolvedEvent = UserActionEventSchema.parse({
      id: "restart-verification-succeeded",
      requestId: initialRequest.id,
      operation: "verification_succeeded",
      previousRevision: 3,
      resultingRevision: 4,
      previousState: "verifying",
      resultingState: "resolved",
      occurredAt: resolvedAt,
    });
    await verifyingRepository.commitUserActionTransition({
      request: resolvedRequest,
      event: resolvedEvent,
    });
    await verifyingRepository.close();

    const resolvedRepository = await fixture.createRepository();
    await expect(
      resolvedRepository.getUserActionRequest(initialRequest.id),
    ).resolves.toMatchObject({
      revision: 4,
      state: "resolved",
      attemptCount: 1,
      openedAt,
      resolvedAt,
    });
    await expect(
      resolvedRepository.listUserActionRequests({ states: ["verifying"] }),
    ).resolves.toEqual([]);
    await expect(
      resolvedRepository.listUserActionEvents({
        requestId: initialRequest.id,
      }),
    ).resolves.toMatchObject([
      { operation: "created", resultingState: "awaiting_user" },
      { operation: "open_page", resultingState: "page_opened" },
      { operation: "confirm_done", resultingState: "verifying" },
      { operation: "verification_succeeded", resultingState: "resolved" },
    ]);
    await resolvedRepository.close();
  });
  test("repairs a legacy database missing user-action tables without changing workspace data", async () => {
    const fixture = await createTempRepository(
      "nordri-user-actions-legacy-",
    );
    temporaryDirectories.push(fixture.tempDirectory);
    const firstRepository = await fixture.createRepository();
    const profileBeforeMigration = await firstRepository.getProfile();
    await firstRepository.close();

    const legacyDatabase = new DatabaseSync(fixture.filePath);
    legacyDatabase.exec(`
      DROP TABLE user_action_events;
      DROP TABLE user_action_requests;
      DELETE FROM schema_migrations WHERE version = 9;
    `);
    legacyDatabase.close();

    const migratedRepository = await fixture.createRepository();
    await expect(migratedRepository.getProfile()).resolves.toEqual(
      profileBeforeMigration,
    );
    await expect(migratedRepository.listUserActionRequests()).resolves.toEqual(
      [],
    );
    await expect(
      migratedRepository.createUserActionRequest(createRequest()),
    ).resolves.toMatchObject({
      status: "created",
      request: { id: "action-login-1", revision: 1 },
    });
    await migratedRepository.close();

    const migratedDatabase = new DatabaseSync(fixture.filePath);
    const tables = migratedDatabase
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name",
      )
      .all("user_action_events", "user_action_requests") as Array<{
      name: string;
    }>;
    const migration = migratedDatabase
      .prepare("SELECT name FROM schema_migrations WHERE version = ?")
      .get(9) as { name?: string } | undefined;
    migratedDatabase.close();

    expect(tables.map((table) => table.name)).toEqual([
      "user_action_events",
      "user_action_requests",
    ]);
    expect(migration?.name).toBe("job_finder_user_actions");
  });
});

test("unfinished answers survive reopening and are scoped to the exact request", async () => {
  const fixture = await createTempRepository("answer-draft-");
  temporaryDirectories.push(fixture.tempDirectory);
  const repository = await fixture.createRepository();
  const request = createRequest({
    kind: "manual_answer",
    scope: {
      type: "application",
      source: "target_site",
      runId: "run",
      jobId: "job",
      resultId: "result",
      applicationRecordId: "app",
    },
    verification: { type: "page_blocker_absent", blockerFingerprint: "dates" },
  });
  await repository.createUserActionRequest(request);
  const draft = {
    answers: { "Start date": "2026-11-02", "Interview availability": "" },
    saveForFuture: false,
  };
  await repository.saveUserActionAnswerDraft({
    requestId: request.id,
    expectedRevision: 1,
    draft,
  });
  const reopened = await fixture.createRepository();
  expect(
    (await reopened.getUserActionRequest(request.id))?.answerDraft,
  ).toEqual(draft);
  expect((await reopened.getUserActionRequest(request.id))?.revision).toBe(1);
  await expect(
    reopened.saveUserActionAnswerDraft({
      requestId: "different-request",
      expectedRevision: 1,
      draft,
    }),
  ).rejects.toThrow("question has changed");
  const transition = createTransition(request, {
    eventId: "answer",
    state: "verifying",
    occurredAt: "2026-07-30T10:01:00.000Z",
  });
  await reopened.commitUserActionTransition(transition);
  await expect(
    reopened.saveUserActionAnswerDraft({
      requestId: request.id,
      expectedRevision: 1,
      draft,
    }),
  ).rejects.toThrow("question has changed");
  await reopened.saveUserActionAnswerDraft({
    requestId: request.id,
    expectedRevision: 2,
    draft: null,
  });
  expect(
    (await reopened.getUserActionRequest(request.id))?.answerDraft,
  ).toBeNull();
  // Open SQLite files cannot be removed on Windows.
  await reopened.close();
  await repository.close();
});

test.each(["memory", "file"] as const)(
  "%s drafts merge fields and ignore an older save arriving last",
  async (backend) => {
    const fixture =
      backend === "file" ? await createTempRepository("draft-merge-") : null;
    if (fixture) temporaryDirectories.push(fixture.tempDirectory);
    const repository = fixture
      ? await fixture.createRepository()
      : createInMemoryJobFinderRepository(createSeed());
    const request = createRequest({
      kind: "manual_answer",
      scope: {
        type: "application",
        source: "target_site",
        runId: "run",
        jobId: "job",
        resultId: "result",
        applicationRecordId: "app",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: "dates",
      },
    });
    await repository.createUserActionRequest(request);
    const save = (editedAt: number, answers: Record<string, string>) =>
      repository.saveUserActionAnswerDraft({
        requestId: request.id,
        expectedRevision: 1,
        editedAt,
        draft: { answers },
      });
    await save(10, { Start: "Monday", Interview: "Tuesday" });
    await save(30, { Start: "Friday" });
    await save(20, { Start: "Wednesday", Interview: "Thursday" });
    expect(
      (await repository.getUserActionRequest(request.id))?.answerDraft?.answers,
    ).toEqual({ Start: "Friday", Interview: "Thursday" });
    await repository.close();
  },
);
