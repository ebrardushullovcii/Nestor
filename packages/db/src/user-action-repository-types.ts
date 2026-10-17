import type {
  UserActionEvent,
  UserActionEventOperation,
  UserActionRequest,
  UserActionRequestState,
} from "@nestor/contracts";

export type UserActionRequestQuery = {
  id?: string;
  states?: readonly UserActionRequestState[];
  scopeType?: UserActionRequest["scope"]["type"];
  applicationRecordId?: string;
};

export type UserActionEventQuery = {
  requestId?: string;
  operation?: UserActionEventOperation;
};

export type CreateUserActionRequestResult = {
  status: "created" | "existing";
  request: UserActionRequest;
  event: UserActionEvent;
};

export type UserActionTransitionInput = {
  request: UserActionRequest;
  event: UserActionEvent;
};

export type UserActionTransitionCommitResult =
  | {
      status: "applied" | "duplicate";
      request: UserActionRequest;
      event: UserActionEvent;
    }
  | {
      status: "stale";
      request: UserActionRequest;
      event: null;
    };
