import {
  UserActionCommandSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  UserActionVerificationResultSchema,
  type UserActionCommandInput,
  type UserActionEvent,
  type UserActionEventOperation,
  type UserActionRequest,
  type UserActionRequestState,
  type UserActionVerificationResultInput,
} from "@nestor/contracts";

const terminalUserActionStates: ReadonlySet<UserActionRequestState> = new Set([
  "resolved",
  "skipped",
  "cancelled",
  "expired",
  "superseded",
]);

export type UserActionReduction =
  | {
      status: "applied";
      request: UserActionRequest;
      event: UserActionEvent;
    }
  | {
      status: "stale";
      request: UserActionRequest;
      event: null;
    };

export function isUserActionTerminal(state: UserActionRequestState): boolean {
  return terminalUserActionStates.has(state);
}

function assertRequestIdentity(
  request: UserActionRequest,
  requestId: string,
): void {
  if (request.id !== requestId) {
    throw new Error(
      `User action operation targets '${requestId}', not '${request.id}'.`,
    );
  }
}

function assertTransitionable(request: UserActionRequest): void {
  if (isUserActionTerminal(request.state)) {
    throw new Error(
      `Cannot transition terminal user action '${request.id}' from '${request.state}'.`,
    );
  }
}

function incrementAttempt(request: UserActionRequest): number {
  if (request.attemptCount >= request.maxAttempts) {
    throw new Error(
      `User action '${request.id}' has reached its verification attempt limit.`,
    );
  }

  return request.attemptCount + 1;
}

function applyTransition(input: {
  request: UserActionRequest;
  operationId: string;
  operation: UserActionEventOperation;
  occurredAt: string;
  patch: Partial<UserActionRequest>;
}): UserActionReduction {
  const nextRequest = UserActionRequestSchema.parse({
    ...input.request,
    ...input.patch,
    id: input.request.id,
    dedupeKey: input.request.dedupeKey,
    revision: input.request.revision + 1,
    updatedAt: input.occurredAt,
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
  });
  const event = UserActionEventSchema.parse({
    id: input.operationId,
    requestId: input.request.id,
    operation: input.operation,
    previousRevision: input.request.revision,
    resultingRevision: nextRequest.revision,
    previousState: input.request.state,
    resultingState: nextRequest.state,
    occurredAt: input.occurredAt,
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
  });

  return {
    status: "applied",
    request: nextRequest,
    event,
  };
}

export function createUserActionCreatedEvent(
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
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
  });
}

export function reduceUserActionCommand(
  requestInput: UserActionRequest,
  commandInput: UserActionCommandInput,
  occurredAt: string,
): UserActionReduction {
  const request = UserActionRequestSchema.parse(requestInput);
  const command = UserActionCommandSchema.parse(commandInput);
  assertRequestIdentity(request, command.requestId);

  if (command.expectedRevision !== request.revision) {
    return { status: "stale", request, event: null };
  }

  assertTransitionable(request);

  switch (command.action) {
    case "open_page":
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: {
          state: "page_opened",
          openedAt: request.openedAt ?? occurredAt,
        },
      });
    case "confirm_done":
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: {
          state: "verifying",
          attemptCount: incrementAttempt(request),
          resolvedAt: null,
        },
      });
    case "submit_task_local_credentials":
      if (
        request.kind !== "login" ||
        request.scope.type !== "application" ||
        !request.scope.resultId
      ) {
        throw new Error(
          "Task-local credentials can only continue an exact sign-in request.",
        );
      }
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: {
          state: "verifying",
          attemptCount: incrementAttempt(request),
          resolvedAt: null,
        },
      });
    case "choose_account_path":
      if (request.kind !== "existing_account_choice") {
        throw new Error(
          "Account path choices require an existing-account-choice request.",
        );
      }
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: { state: "awaiting_user" },
      });
    case "submit_manual_answer":
      if (request.kind !== "manual_answer") {
        throw new Error("Manual answers require a manual-answer request.");
      }
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: {
          state: "verifying",
          attemptCount: incrementAttempt(request),
          resolvedAt: null,
        },
      });
    case "record_legal_decision":
      if (request.kind !== "legal_consent") {
        throw new Error("Legal decisions require a legal-consent request.");
      }
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch:
          command.decision === "accept"
            ? {
                state: "verifying",
                attemptCount: incrementAttempt(request),
                resolvedAt: null,
              }
            : { state: "cancelled", resolvedAt: occurredAt },
      });
    case "skip":
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: { state: "skipped", resolvedAt: occurredAt },
      });
    case "cancel":
      return applyTransition({
        request,
        operationId: command.commandId,
        operation: command.action,
        occurredAt,
        patch: { state: "cancelled", resolvedAt: occurredAt },
      });
  }
}

export function reduceUserActionSuperseded(
  requestInput: UserActionRequest,
  supersedingRequestId: string,
  occurredAt: string,
): UserActionReduction {
  const request = UserActionRequestSchema.parse(requestInput);
  assertTransitionable(request);

  return applyTransition({
    request,
    operationId: `supersede:${request.id}:${supersedingRequestId}`,
    operation: "supersede",
    occurredAt,
    patch: { state: "superseded", resolvedAt: occurredAt },
  });
}

export function reduceUserActionVerification(
  requestInput: UserActionRequest,
  resultInput: UserActionVerificationResultInput,
): UserActionReduction {
  const request = UserActionRequestSchema.parse(requestInput);
  const result = UserActionVerificationResultSchema.parse(resultInput);
  assertRequestIdentity(request, result.requestId);

  if (result.expectedRevision !== request.revision) {
    return { status: "stale", request, event: null };
  }

  assertTransitionable(request);

  if (request.state !== "verifying") {
    throw new Error(
      `User action '${request.id}' must be verifying before recording a verification result.`,
    );
  }

  const verified = result.outcome === "verified";
  return applyTransition({
    request,
    operationId: result.verificationId,
    operation: verified ? "verification_succeeded" : "verification_failed",
    occurredAt: result.checkedAt,
    patch: verified
      ? { state: "resolved", resolvedAt: result.checkedAt }
      : { state: "still_blocked", resolvedAt: null },
  });
}
