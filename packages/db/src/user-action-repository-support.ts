import {
  UserActionEventSchema,
  UserActionRequestSchema,
  type UserActionEvent,
  type UserActionRequest,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";

import type {
  UserActionEventQuery,
  UserActionRequestQuery,
  UserActionTransitionInput,
} from "./user-action-repository-types";

export const USER_ACTION_INDEXED_COLLECTION_CONFIGS = {
  user_action_requests: {
    columnNames: [
      "dedupe_key",
      "revision",
      "kind",
      "state",
      "scope_type",
      "application_record_id",
      "updated_at",
    ],
    getColumns: (value: unknown): readonly SQLInputValue[] => {
      const request = UserActionRequestSchema.parse(value);
      return [
        request.dedupeKey,
        request.revision,
        request.kind,
        request.state,
        request.scope.type,
        request.scope.type === "application"
          ? request.scope.applicationRecordId
          : null,
        request.updatedAt,
      ];
    },
  },
  user_action_events: {
    columnNames: [
      "request_id",
      "operation",
      "previous_revision",
      "resulting_revision",
      "occurred_at",
    ],
    getColumns: (value: unknown): readonly SQLInputValue[] => {
      const event = UserActionEventSchema.parse(value);
      return [
        event.requestId,
        event.operation,
        event.previousRevision,
        event.resultingRevision,
        event.occurredAt,
      ];
    },
  },
} as const;

export function createPersistedUserActionCreatedEvent(
  requestInput: UserActionRequest,
): UserActionEvent {
  const request = UserActionRequestSchema.parse(requestInput);

  if (request.revision !== 1) {
    throw new Error("New user action requests must start at revision one.");
  }

  return UserActionEventSchema.parse({
    id: `${request.id}:created`,
    requestId: request.id,
    operation: "created",
    previousRevision: 0,
    resultingRevision: 1,
    previousState: request.state,
    resultingState: request.state,
    occurredAt: request.createdAt,
  });
}

export function normalizeUserActionTransition(
  input: UserActionTransitionInput,
): UserActionTransitionInput {
  const request = UserActionRequestSchema.parse(structuredClone(input.request));
  const event = UserActionEventSchema.parse(structuredClone(input.event));

  if (event.operation === "created") {
    throw new Error("Created events must use createUserActionRequest.");
  }
  if (event.requestId !== request.id) {
    throw new Error("User action event and request ids do not match.");
  }
  if (event.resultingRevision !== request.revision) {
    throw new Error("User action event and request revisions do not match.");
  }
  if (event.resultingState !== request.state) {
    throw new Error("User action event and request states do not match.");
  }
  if (event.occurredAt !== request.updatedAt) {
    throw new Error("User action event and request timestamps do not match.");
  }

  return { request, event };
}

export function areSameUserActionRequests(
  left: UserActionRequest,
  right: UserActionRequest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function areSameUserActionEvents(
  left: UserActionEvent,
  right: UserActionEvent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function matchesUserActionRequestQuery(
  request: UserActionRequest,
  query?: UserActionRequestQuery,
): boolean {
  return (
    (query?.id === undefined || request.id === query.id) &&
    (query?.states === undefined || query.states.includes(request.state)) &&
    (query?.scopeType === undefined ||
      request.scope.type === query.scopeType) &&
    (query?.applicationRecordId === undefined ||
      (request.scope.type === "application" &&
        request.scope.applicationRecordId === query.applicationRecordId))
  );
}

export function matchesUserActionEventQuery(
  event: UserActionEvent,
  query?: UserActionEventQuery,
): boolean {
  return (
    (query?.requestId === undefined || event.requestId === query.requestId) &&
    (query?.operation === undefined || event.operation === query.operation)
  );
}

export function sortUserActionRequests(
  requests: readonly UserActionRequest[],
): UserActionRequest[] {
  return [...requests].sort((left, right) => {
    const timestampDifference =
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return timestampDifference !== 0
      ? timestampDifference
      : left.id.localeCompare(right.id);
  });
}

export function sortUserActionEvents(
  events: readonly UserActionEvent[],
): UserActionEvent[] {
  return [...events].sort((left, right) => {
    const timestampDifference =
      new Date(left.occurredAt).getTime() -
      new Date(right.occurredAt).getTime();
    return timestampDifference !== 0
      ? timestampDifference
      : left.id.localeCompare(right.id);
  });
}

export function assertUserActionTransitionCurrent(
  current: UserActionRequest,
  next: UserActionRequest,
  event: UserActionEvent,
): void {
  if (event.previousRevision !== current.revision) {
    throw new Error("User action event does not target the current revision.");
  }
  if (event.previousState !== current.state) {
    throw new Error("User action event does not target the current state.");
  }
  if (
    next.id !== current.id ||
    next.dedupeKey !== current.dedupeKey ||
    next.kind !== current.kind ||
    next.createdAt !== current.createdAt ||
    JSON.stringify(next.scope) !== JSON.stringify(current.scope) ||
    JSON.stringify(next.verification) !== JSON.stringify(current.verification)
  ) {
    throw new Error(
      "User action transitions cannot rewrite request identity or scope.",
    );
  }
}
