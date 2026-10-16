import {
  applyResultHasQuestionForPerson,
  applyResultNeedsSecurityCheck,
  looksLikeAccountWall,
  looksLikeSignInWall,
} from "./application-attention-display";
export {
  getPausedQuestionText,
  formatQuestionPrompt,
  applyResultPausedOnQuestion,
  applyResultHasQuestionForPerson,
  applyResultNeedsSecurityCheck,
  looksLikeAccountWall,
  looksLikeSignInWall,
} from "./application-attention-display";
import {
  isApplicationTrackedAsSentByPerson,
  isApplicationWithdrawnByPerson,
  type JobFinderRendererWorkspaceSnapshot,
  type GroupedManualAnswerDecision,
} from "@nordri/contracts";
import { projectPlanSafeguardPauses } from "../plan-safeguard-pauses";

type AttentionSnapshot = Pick<
  JobFinderRendererWorkspaceSnapshot,
  | "reviewQueue"
  | "applicationRecords"
  | "applyJobResults"
  | "userActionRequests"
>;

const terminal = new Set([
  "resolved",
  "cancelled",
  "skipped",
  "expired",
  "superseded",
]);

export function listResumeReviewsNeeded(
  snapshot: Pick<AttentionSnapshot, "reviewQueue" | "applicationRecords">,
) {
  const applied = new Set(
    (snapshot.applicationRecords ?? []).map((record) => record.jobId),
  );
  return (snapshot.reviewQueue ?? []).filter(
    (item) =>
      !applied.has(item.jobId) &&
      item.resumeApplicationMode !== "original_resume" &&
      ["draft", "needs_review", "stale"].includes(item.resumeReview.status),
  );
}

export function listFinalApplicationActions(
  snapshot: Pick<
    AttentionSnapshot,
    "applicationRecords" | "applyJobResults" | "userActionRequests"
  >,
) {
  const covered = new Set(
    (snapshot.userActionRequests ?? [])
      .filter((request) => !terminal.has(request.state))
      .flatMap((request) =>
        request.scope?.type === "application"
          ? [request.scope.applicationRecordId]
          : [],
      ),
  );
  const latest = new Map<
    string,
    AttentionSnapshot["applyJobResults"][number]
  >();
  for (const result of snapshot.applyJobResults ?? []) {
    if (!result.applicationRecordId) continue;
    const previous = latest.get(result.applicationRecordId);
    if (!previous || previous.updatedAt < result.updatedAt)
      latest.set(result.applicationRecordId, result);
  }
  const needsYou = new Set(
    listApplicationsNeedingYou(snapshot).map((record) => record.id),
  );
  return (snapshot.applicationRecords ?? []).filter(
    (record) =>
      !covered.has(record.id) &&
      !needsYou.has(record.id) &&
      !isApplicationTrackedAsSentByPerson(record.crm) &&
      !isApplicationWithdrawnByPerson(record.crm) &&
      (latest.has(record.id)
        ? latest.get(record.id)?.state === "awaiting_review"
        : record.status === "ready_for_review"),
  );
}

/** Questions and walls, excluding completed preparation and resume reviews (ADR 0027). */
export function listApplicationsNeedingYou(
  snapshot: Pick<
    AttentionSnapshot,
    "applicationRecords" | "applyJobResults" | "userActionRequests"
  >,
) {
  const covered = new Set(
    (snapshot.userActionRequests ?? [])
      .filter((request) => !terminal.has(request.state))
      .flatMap((request) =>
        request.scope?.type === "application"
          ? [request.scope.applicationRecordId]
          : [],
      ),
  );
  const latest = new Map<
    string,
    AttentionSnapshot["applyJobResults"][number]
  >();
  for (const result of snapshot.applyJobResults ?? []) {
    if (!result.applicationRecordId) continue;
    const previous = latest.get(result.applicationRecordId);
    if (!previous || previous.updatedAt < result.updatedAt)
      latest.set(result.applicationRecordId, result);
  }
  return (snapshot.applicationRecords ?? []).filter((record) => {
    if (
      covered.has(record.id) ||
      isApplicationTrackedAsSentByPerson(record.crm) ||
      isApplicationWithdrawnByPerson(record.crm)
    )
      return false;
    const result = latest.get(record.id);
    if (!result)
      return (
        ["drafting", "ready_for_review", "approved"].includes(record.status) &&
        record.lastAttemptState === "paused" &&
        record.consentSummary.status !== "declined" &&
        (record.consentSummary.status !== "requested" ||
          Boolean(record.nextActionLabel))
      );
    if (
      [
        "planned",
        "filling",
        "question_capture",
        "submitting",
        "submitted",
        "cancelled",
        "skipped",
      ].includes(result.state) ||
      result.privacyReceipt?.submissionOutcome?.outcome === "submitted"
    )
      return false;
    if (
      result.blockerReason === "submission_outcome_uncertain" ||
      result.privacyReceipt?.submissionOutcome?.outcome === "outcome_uncertain"
    )
      return true;
    if (
      record.lastAttemptState === "failed" &&
      record.lastUpdatedAt >= result.updatedAt
    )
      return false;
    if (result.blockerReason === "application_closed") return false;
    const text = `${result.blockerSummary ?? ""} ${result.detail ?? ""}`;
    if (
      applyResultNeedsSecurityCheck(result) ||
      looksLikeSignInWall({ blockerCode: result.blockerReason, text }) ||
      looksLikeAccountWall({ blockerCode: result.blockerReason, text })
    )
      return true;
    return applyResultHasQuestionForPerson(
      result,
      Math.max(
        0,
        record.questionSummary.total - record.questionSummary.answered,
      ),
    );
  });
}

export function projectNeedsYou(input: {
  applicationRecords?:
    | readonly AttentionSnapshot["applicationRecords"][number][]
    | undefined;
  applyJobResults?:
    | readonly AttentionSnapshot["applyJobResults"][number][]
    | undefined;
  requests?:
    | readonly AttentionSnapshot["userActionRequests"][number][]
    | undefined;
  groupedDecisions?: readonly GroupedManualAnswerDecision[] | undefined;
}) {
  const liveRequests = (input.requests ?? []).filter(
    (request) => !terminal.has(request.state),
  );
  const groupedDecisions = (input.groupedDecisions ?? []).filter(
    (decision) => decision.approval === "pending",
  );
  const represented = new Set(
    groupedDecisions.flatMap((decision) =>
      decision.lineage.map((entry) => entry.requestId),
    ),
  );
  const requests = liveRequests.filter(
    (request) => !represented.has(request.id),
  );
  const applications = listApplicationsNeedingYou({
    applicationRecords: [...(input.applicationRecords ?? [])],
    applyJobResults: [...(input.applyJobResults ?? [])],
    userActionRequests: [...liveRequests],
  });
  return {
    requests,
    groupedDecisions,
    applications,
    count: requests.length + groupedDecisions.length + applications.length,
  };
}

export function projectWorkspaceAttention(
  snapshot: Pick<
    JobFinderRendererWorkspaceSnapshot,
    | "reviewQueue"
    | "applicationRecords"
    | "applyJobResults"
    | "userActionRequests"
    | "intelligence"
    | "campaigns"
  >,
) {
  const needsYou = projectNeedsYou({
    applicationRecords: snapshot.applicationRecords,
    applyJobResults: snapshot.applyJobResults,
    requests: snapshot.userActionRequests,
    groupedDecisions: snapshot.intelligence?.groupedDecisions,
  });
  const safeguards = projectPlanSafeguardPauses(
    snapshot.intelligence?.safeguards,
    snapshot.campaigns ?? [],
  );
  return {
    ...needsYou,
    safeguards,
    count: needsYou.count + safeguards.length,
    resumeReviews: listResumeReviewsNeeded(snapshot),
    readyToSend: listFinalApplicationActions(snapshot),
  };
}
