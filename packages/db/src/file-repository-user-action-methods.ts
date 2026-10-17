import {
  SaveUserActionAnswerDraftInputSchema,
  mergeUserActionAnswerDraft,
  UserActionEventSchema,
  UserActionRequestSchema,
  type UserActionEvent,
  type UserActionRequest,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";

import { secureDatabaseFile } from "./internal/migrations";
import { cloneValue, listCollectionValues } from "./internal/state";
import { runImmediateTransaction } from "./file-repository-support";
import type { FileRepositoryContext } from "./file-repository-support";
import type { JobFinderRepository } from "./repository-types";
import {
  areSameUserActionEvents,
  areSameUserActionRequests,
  assertUserActionTransitionCurrent,
  createPersistedUserActionCreatedEvent,
  normalizeUserActionTransition,
  USER_ACTION_INDEXED_COLLECTION_CONFIGS,
} from "./user-action-repository-support";

function listRequests(
  context: FileRepositoryContext,
  options: Parameters<JobFinderRepository["listUserActionRequests"]>[0],
): UserActionRequest[] {
  if (options?.states?.length === 0) {
    return [];
  }

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (options?.id !== undefined) {
    clauses.push("id = ?");
    params.push(options.id);
  }
  if (options?.scopeType !== undefined) {
    clauses.push("scope_type = ?");
    params.push(options.scopeType);
  }
  if (options?.applicationRecordId !== undefined) {
    clauses.push("application_record_id = ?");
    params.push(options.applicationRecordId);
  }
  if (options?.states !== undefined) {
    clauses.push(`state IN (${options.states.map(() => "?").join(", ")})`);
    params.push(...options.states);
  }

  return listCollectionValues(
    context.database,
    "user_action_requests",
    UserActionRequestSchema,
    {
      orderBySql: "updated_at DESC, id ASC",
      ...(clauses.length > 0 ? { whereSql: clauses.join(" AND ") } : {}),
      ...(params.length > 0 ? { params } : {}),
    },
  );
}

function listEvents(
  context: FileRepositoryContext,
  options: Parameters<JobFinderRepository["listUserActionEvents"]>[0],
): UserActionEvent[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (options?.requestId !== undefined) {
    clauses.push("request_id = ?");
    params.push(options.requestId);
  }
  if (options?.operation !== undefined) {
    clauses.push("operation = ?");
    params.push(options.operation);
  }

  return listCollectionValues(
    context.database,
    "user_action_events",
    UserActionEventSchema,
    {
      orderBySql: "occurred_at ASC, id ASC",
      ...(clauses.length > 0 ? { whereSql: clauses.join(" AND ") } : {}),
      ...(params.length > 0 ? { params } : {}),
    },
  );
}

function insertUserActionRequest(
  context: FileRepositoryContext,
  request: UserActionRequest,
): void {
  const columns = USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_requests;
  context.database
    .prepare(
      `
      INSERT INTO user_action_requests (
        id, dedupe_key, revision, kind, state, scope_type,
        application_record_id, updated_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(request.id, ...columns.getColumns(request), JSON.stringify(request));
}

function updateUserActionRequest(
  context: FileRepositoryContext,
  request: UserActionRequest,
): void {
  const columns = USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_requests;
  context.database
    .prepare(
      `
      INSERT INTO user_action_requests (
        id, dedupe_key, revision, kind, state, scope_type,
        application_record_id, updated_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        revision = excluded.revision,
        kind = excluded.kind,
        state = excluded.state,
        scope_type = excluded.scope_type,
        application_record_id = excluded.application_record_id,
        updated_at = excluded.updated_at,
        value = excluded.value
    `,
    )
    .run(request.id, ...columns.getColumns(request), JSON.stringify(request));
}

function insertUserActionEvent(
  context: FileRepositoryContext,
  event: UserActionEvent,
): void {
  const columns = USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_events;
  context.database
    .prepare(
      `
      INSERT INTO user_action_events (
        id, request_id, operation, previous_revision, resulting_revision,
        occurred_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(event.id, ...columns.getColumns(event), JSON.stringify(event));
}

function getRequestById(
  context: FileRepositoryContext,
  id: string,
): UserActionRequest | null {
  return listRequests(context, { id })[0] ?? null;
}

function getRequestByDedupeKey(
  context: FileRepositoryContext,
  dedupeKey: string,
): UserActionRequest | null {
  return (
    listCollectionValues(
      context.database,
      "user_action_requests",
      UserActionRequestSchema,
      {
        whereSql: "dedupe_key = ?",
        params: [dedupeKey],
        orderBySql: "updated_at DESC, id ASC",
      },
    )[0] ?? null
  );
}

function getEventById(
  context: FileRepositoryContext,
  id: string,
): UserActionEvent | null {
  return (
    listCollectionValues(
      context.database,
      "user_action_events",
      UserActionEventSchema,
      {
        whereSql: "id = ?",
        params: [id],
        orderBySql: "occurred_at ASC, id ASC",
      },
    )[0] ?? null
  );
}

export function createFileRepositoryUserActionMethods(
  context: FileRepositoryContext,
): Pick<
  JobFinderRepository,
  | "listUserActionRequests"
  | "saveUserActionAnswerDraft"
  | "getUserActionRequest"
  | "createUserActionRequest"
  | "listUserActionEvents"
  | "commitUserActionTransition"
> {
  return {
    async saveUserActionAnswerDraft(input) {
      const command = SaveUserActionAnswerDraftInputSchema.parse(input);
      runImmediateTransaction(context.database, () => {
        const request = getRequestById(context, command.requestId);
        if (
          !request ||
          request.kind !== "manual_answer" ||
          request.scope.type !== "application" ||
          request.revision !== command.expectedRevision ||
          !(
            command.draft === null
              ? [
                  "pending",
                  "awaiting_user",
                  "still_blocked",
                  "verifying",
                  "resolved",
                ]
              : ["pending", "awaiting_user", "still_blocked"]
          ).includes(request.state)
        ) {
          throw new Error(
            "This question has changed. Reopen it before editing your answer.",
          );
        }
        updateUserActionRequest(
          context,
          UserActionRequestSchema.parse({
            ...request,
            ...mergeUserActionAnswerDraft(
              request,
              command.draft,
              command.editedAt ?? Date.now(),
            ),
          }),
        );
      });
      await secureDatabaseFile(context.filePath);
    },
    listUserActionRequests(options) {
      return Promise.resolve(cloneValue(listRequests(context, options)));
    },
    getUserActionRequest(id) {
      const request = getRequestById(context, id);
      return Promise.resolve(request ? cloneValue(request) : null);
    },
    createUserActionRequest(request) {
      const normalizedRequest = UserActionRequestSchema.parse(
        cloneValue(request),
      );
      let result: Awaited<
        ReturnType<JobFinderRepository["createUserActionRequest"]>
      > | null = null;

      runImmediateTransaction(context.database, () => {
        const existingById = getRequestById(context, normalizedRequest.id);
        const existingByDedupeKey = getRequestByDedupeKey(
          context,
          normalizedRequest.dedupeKey,
        );

        if (
          existingById &&
          !areSameUserActionRequests(existingById, normalizedRequest)
        ) {
          throw new Error(
            `User action request id '${normalizedRequest.id}' already exists with different data.`,
          );
        }

        const existing = existingById ?? existingByDedupeKey;
        if (existing) {
          let createdEvent = listEvents(context, {
            requestId: existing.id,
            operation: "created",
          })[0];
          if (!createdEvent) {
            createdEvent = createPersistedUserActionCreatedEvent(existing);
            const collision = getEventById(context, createdEvent.id);
            if (
              collision &&
              !areSameUserActionEvents(collision, createdEvent)
            ) {
              throw new Error(
                `User action event id '${createdEvent.id}' already exists with different data.`,
              );
            }
            if (!collision) {
              insertUserActionEvent(context, createdEvent);
            }
          }
          result = {
            status: "existing",
            request: existing,
            event: createdEvent,
          };
          return;
        }

        const createdEvent =
          createPersistedUserActionCreatedEvent(normalizedRequest);
        const collision = getEventById(context, createdEvent.id);
        if (collision) {
          throw new Error(
            `User action event id '${createdEvent.id}' already exists.`,
          );
        }
        insertUserActionRequest(context, normalizedRequest);
        insertUserActionEvent(context, createdEvent);
        result = {
          status: "created",
          request: normalizedRequest,
          event: createdEvent,
        };
      });

      const creationResult = result;
      if (!creationResult) {
        throw new Error("User action creation did not produce a result.");
      }
      return secureDatabaseFile(context.filePath).then(() =>
        cloneValue(creationResult),
      );
    },
    listUserActionEvents(options) {
      return Promise.resolve(cloneValue(listEvents(context, options)));
    },
    commitUserActionTransition(input) {
      const transition = normalizeUserActionTransition(input);
      let result: Awaited<
        ReturnType<JobFinderRepository["commitUserActionTransition"]>
      > | null = null;

      runImmediateTransaction(context.database, () => {
        const existingEvent = getEventById(context, transition.event.id);
        if (existingEvent) {
          if (!areSameUserActionEvents(existingEvent, transition.event)) {
            throw new Error(
              `User action event id '${transition.event.id}' already exists with different data.`,
            );
          }
          const currentRequest = getRequestById(context, transition.request.id);
          if (!currentRequest) {
            throw new Error(
              `User action request '${transition.request.id}' does not exist.`,
            );
          }
          result = {
            status: "duplicate",
            request: currentRequest,
            event: existingEvent,
          };
          return;
        }

        const currentRequest = getRequestById(context, transition.request.id);
        if (!currentRequest) {
          throw new Error(
            `User action request '${transition.request.id}' does not exist.`,
          );
        }
        if (currentRequest.revision !== transition.event.previousRevision) {
          result = {
            status: "stale",
            request: currentRequest,
            event: null,
          };
          return;
        }

        assertUserActionTransitionCurrent(
          currentRequest,
          transition.request,
          transition.event,
        );
        // Lifecycle transitions cannot replace edits saved while the command waited.
        transition.request.answerDraft = currentRequest.answerDraft;
        transition.request.answerDraftFieldUpdatedAt =
          currentRequest.answerDraftFieldUpdatedAt;
        updateUserActionRequest(context, transition.request);
        insertUserActionEvent(context, transition.event);
        result = {
          status: "applied",
          request: transition.request,
          event: transition.event,
        };
      });

      const transitionResult = result;
      if (!transitionResult) {
        throw new Error("User action transition did not produce a result.");
      }
      return secureDatabaseFile(context.filePath).then(() =>
        cloneValue(transitionResult),
      );
    },
  };
}
