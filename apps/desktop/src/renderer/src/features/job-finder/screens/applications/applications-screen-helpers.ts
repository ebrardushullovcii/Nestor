import type {
  ApplicationAttemptListRow,
  ApplicationRecord,
} from "@nestor/contracts";
import { FAILURE_SENTENCES } from "../../lib/describe-failure";
import type { ApplicationsViewFilter } from "./applications-filters";
import type { ApplyJobStateKind } from "../../lib/apply-mode-contracts-stub";

/**
 * Resolves the one route-owned action status Applications presents. Retry,
 * queue, and copilot refusals and backend errors must stay visible here.
 */
export function resolveVisibleRouteActionMessage(input: {
  actionMessage: string | null | undefined;
  /**
   * How many jobs of the newest finished automatic run are waiting on the
   * person. Zero (or absent) means no batch outcome is on screen.
   */
  latestRunAttentionCount?: number;
}): string | null {
  const { actionMessage } = input;

  if (!actionMessage) {
    return null;
  }

  // A batch that ended with jobs waiting on the person is an application
  // outcome, not a form they mis-filled. The thrown text a failed run carries
  // is developer-shaped, so the shared classifier lands it in the
  // form-validation family and Applications printed "Check the fields you
  // just changed and try again" over a run nobody had edited a field for.
  // The run's own counters are the truth here, so they write the sentence.
  const attentionCount = input.latestRunAttentionCount ?? 0;
  if (
    actionMessage === FAILURE_SENTENCES.invalid_details &&
    attentionCount > 0
  ) {
    return formatApplicationsNeedYouSentence(attentionCount);
  }

  // The detail already confirms this exact click inline, directly under the
  // button that made it ("Opened in the Job Finder browser. Switch to that
  // window…"). A route-wide banner saying the same thing put two
  // confirmations of one click on screen, one of them far from the control.
  if (BROWSER_HANDOFF_CONFIRMATION_PATTERN.test(actionMessage)) {
    return null;
  }

  return actionMessage;
}

/**
 * The application failure family, in the voice of the failure copy table:
 * what happened, then the one thing to do about it.
 */
export function formatApplicationsNeedYouSentence(count: number): string {
  return count === 1
    ? "1 application needs you; open it to see what the site asked for."
    : `${count} applications need you; open each to see what the site asked for.`;
}

const BROWSER_HANDOFF_CONFIRMATION_PATTERN =
  /^Opened (?:the page|this application) in the Job Finder browser\b/i;

export function resolveUnambiguousApplicationRecordIdByJobId(
  records: readonly ApplicationRecord[],
): Map<string, string> {
  const recordIdsByJobId = new Map<string, string[]>();
  for (const record of records) {
    const ids = recordIdsByJobId.get(record.jobId);
    if (ids) {
      ids.push(record.id);
    } else {
      recordIdsByJobId.set(record.jobId, [record.id]);
    }
  }

  const unambiguousRecordIdByJobId = new Map<string, string>();
  for (const [jobId, ids] of recordIdsByJobId) {
    if (ids.length === 1) {
      unambiguousRecordIdByJobId.set(jobId, ids[0]!);
    }
  }
  return unambiguousRecordIdByJobId;
}

function attemptBelongsToRecord(
  attempt: ApplicationAttemptListRow,
  record: ApplicationRecord,
  unambiguousRecordIdByJobId: Map<string, string> | null,
) {
  // Exact lineage is authoritative when the attempt declares it.
  if (attempt.applicationRecordId !== null) {
    return attempt.applicationRecordId === record.id;
  }

  // Legacy attempts predate application records and can only attach when a
  // single scoped record owns the job; otherwise ownership stays ambiguous.
  return unambiguousRecordIdByJobId?.get(attempt.jobId) === record.id;
}

export function getLatestApplicationAttemptForRecord(
  record: ApplicationRecord,
  applicationAttempts: readonly ApplicationAttemptListRow[],
  applicationRecords?: readonly ApplicationRecord[],
) {
  let latestAttempt: ApplicationAttemptListRow | null = null;
  let latestUpdatedAt = Number.NEGATIVE_INFINITY;
  const unambiguousRecordIdByJobId = applicationRecords
    ? resolveUnambiguousApplicationRecordIdByJobId(applicationRecords)
    : null;

  for (const attempt of applicationAttempts) {
    if (!attemptBelongsToRecord(attempt, record, unambiguousRecordIdByJobId)) {
      continue;
    }

    const attemptUpdatedAt = new Date(attempt.updatedAt).getTime();
    if (attemptUpdatedAt > latestUpdatedAt) {
      latestAttempt = attempt;
      latestUpdatedAt = attemptUpdatedAt;
    }
  }

  return latestAttempt;
}

function isTerminalApplicationStatus(status: ApplicationRecord["status"]) {
  return (
    status === "submitted" ||
    status === "rejected" ||
    status === "offer" ||
    status === "withdrawn" ||
    status === "archived"
  );
}

/**
 * The one selector for "this application is waiting on the user".
 *
 * It is deliberately a superset of the row-level `Needs you` stage badge: a
 * failed attempt ("Needs recovery"), a site that cannot be prepared
 * automatically ("Manual apply only") and a saved next step all wait on the
 * user without being the single unresolved browser step the badge marks and
 * the global Needs you destination counts. Those two populations used to
 * share one name in front of the user — the filter chip said "Needs you 2"
 * beside a header that said "Needs you: 1 unresolved" — so this predicate is
 * the single owner of the chip's count and the filter names its own
 * population ("Waiting on you") instead of borrowing the badge's.
 */
export function applicationRecordNeedsUser(record: ApplicationRecord): boolean {
  return (
    record.lastAttemptState === "paused" ||
    record.lastAttemptState === "failed" ||
    record.lastAttemptState === "unsupported" ||
    // A form filled in and left for the person to send waits on their press,
    // so it is in this view too: otherwise "Waiting on you 0" sat beside
    // applications that could not go anywhere until the person sent them.
    (record.lastAttemptState === "ready" &&
      !isTerminalApplicationStatus(record.status)) ||
    // The person stopped it themselves: nothing waits on them until they
    // choose Try again.
    (Boolean(record.nextActionLabel) &&
      !isTerminalApplicationStatus(record.status) &&
      record.lastAttemptState !== "in_progress" &&
      record.lastAttemptState !== "ready" &&
      record.lastAttemptState !== "cancelled")
  );
}

export function matchesApplicationsFilter(
  record: ApplicationRecord,
  filter: ApplicationsViewFilter,
  applyStateKind?: ApplyJobStateKind,
) {
  if (applyStateKind) {
    switch (filter) {
      case "needs_action":
        return (
          applyStateKind === "needs_you" || applyStateKind === "ready_to_send"
        );
      case "in_progress":
        return applyStateKind === "filling_in";
      case "submitted":
        return applyStateKind === "applied";
      case "manual_only":
        return (
          applyStateKind === "could_not_apply" &&
          record.lastAttemptState === "unsupported"
        );
      default:
        return true;
    }
  }

  const needsAction = applicationRecordNeedsUser(record);
  const submitted = record.status === "submitted";
  const manualOnly = record.lastAttemptState === "unsupported";
  const inProgress =
    record.lastAttemptState === "in_progress" ||
    (!needsAction &&
      !submitted &&
      (record.status === "drafting" ||
        record.status === "ready_for_review" ||
        record.status === "approved" ||
        record.status === "assessment" ||
        record.status === "interview"));

  switch (filter) {
    case "needs_action":
      return needsAction;
    case "in_progress":
      return inProgress;
    case "submitted":
      return submitted;
    case "manual_only":
      return manualOnly;
    default:
      return true;
  }
}

export function pickLatestIsoTimestamp(
  ...values: Array<string | null | undefined>
) {
  let latestValue: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const parsedTimestamp = Date.parse(value);
    if (Number.isNaN(parsedTimestamp) || parsedTimestamp <= latestTimestamp) {
      continue;
    }

    latestTimestamp = parsedTimestamp;
    latestValue = value;
  }

  return latestValue;
}
