import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  BrowserSourceAccessProbeResultSchema,
  UserActionRequestSchema,
  UserActionVerificationResultSchema,
  type UserActionRequest,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

import { reduceUserActionVerification } from "../user-action-domain";
import { inspectApplicationAccessPage } from "./application-access-page";

export function isSourceAccessUserAction(request: UserActionRequest): boolean {
  return request.verification.type === "source_access";
}

export function getUserActionVerificationFlightKey(
  request: UserActionRequest,
): string {
  return `${request.id}:${request.revision}`;
}

function getVerificationEventId(request: UserActionRequest): string {
  return `verification:${request.id}:r${request.revision}`;
}

function normalizeBrowserOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

async function inspectSourceAccess(input: {
  browserRuntime: BrowserSessionRuntime;
  request: UserActionRequest;
}): Promise<"verified" | "still_blocked"> {
  const expectedOrigin =
    input.request.verification.type === "source_access" &&
    input.request.verification.expectedOrigin
      ? normalizeBrowserOrigin(input.request.verification.expectedOrigin)
      : null;

  // An application sign-in is read on the exact page kept for that
  // application. Origin probes are inconclusive when two tabs share a host
  // and fail on application steps that show no account menu.
  const exactPage = await inspectApplicationAccessPage({
    browserRuntime: input.browserRuntime,
    request: input.request,
  });
  if (exactPage !== "unavailable") {
    return exactPage;
  }

  if (!input.browserRuntime.inspectSourceAccess || !expectedOrigin) {
    return "still_blocked";
  }

  try {
    const result = BrowserSourceAccessProbeResultSchema.safeParse(
      await input.browserRuntime.inspectSourceAccess(
        input.request.scope.source,
        {
          expectedOrigin,
          // A source parked on one tab is read on that tab only, so a second
          // tab on the same site never makes the check inconclusive.
          ...(input.request.scope.type === "discovery_source" &&
          input.request.scope.parkedTab?.tabId
            ? { tabId: input.request.scope.parkedTab.tabId }
            : {}),
        },
      ),
    );
    const currentOrigin =
      result.success && result.data.currentOrigin
        ? normalizeBrowserOrigin(result.data.currentOrigin)
        : null;
    return result.success &&
      result.data.state === "authenticated" &&
      currentOrigin === expectedOrigin
      ? "verified"
      : "still_blocked";
  } catch {
    return "still_blocked";
  }
}

export async function verifySourceAccessUserAction(input: {
  browserRuntime: BrowserSessionRuntime;
  repository: JobFinderRepository;
  request: UserActionRequest;
  onVerified?: (
    request: UserActionRequest,
  ) => Promise<{ status: "continued" } | { status: "blocked"; message: string }>;
}): Promise<UserActionRequest | null> {
  const request = UserActionRequestSchema.parse(input.request);
  if (request.state !== "verifying" || !isSourceAccessUserAction(request)) {
    return null;
  }

  const outcome = await inspectSourceAccess({
    browserRuntime: input.browserRuntime,
    request,
  });
  const currentRequest = await input.repository.getUserActionRequest(
    request.id,
  );

  if (
    !currentRequest ||
    currentRequest.state !== "verifying" ||
    currentRequest.revision !== request.revision
  ) {
    return null;
  }

  let verifiedContinuationMessage: string | null = null;
  if (outcome === "verified" && input.onVerified) {
    const continuation = await input.onVerified(currentRequest);
    if (continuation.status === "blocked") {
      verifiedContinuationMessage = continuation.message;
    }
  }

  const checkedAt = new Date().toISOString();
  const reduction = reduceUserActionVerification(
    currentRequest,
    UserActionVerificationResultSchema.parse({
      requestId: currentRequest.id,
      verificationId: getVerificationEventId(currentRequest),
      expectedRevision: currentRequest.revision,
      outcome: verifiedContinuationMessage ? "still_blocked" : outcome,
      checkedAt,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    }),
  );

  if (reduction.status === "stale" || !reduction.event) {
    return null;
  }

  const nextRequest = verifiedContinuationMessage
    ? UserActionRequestSchema.parse({
        ...reduction.request,
        summary: verifiedContinuationMessage,
        instructions: [verifiedContinuationMessage],
      })
    : reduction.request;

  const commit = await input.repository.commitUserActionTransition({
    request: nextRequest,
    event: reduction.event,
  });
  return commit.request.state === "resolved"
    ? commit.request
    : null;
}
