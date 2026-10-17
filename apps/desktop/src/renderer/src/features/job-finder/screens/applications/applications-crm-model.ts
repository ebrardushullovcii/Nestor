import type {
  ApplicationCrmCalendarEntry,
  ApplicationCrmData,
  ApplicationCrmStage,
  ApplicationCrmStageDefinition,
  ApplicationRecord,
} from "@nestor/contracts";
import {
  APPLICATION_CRM_STAGE_NAMES,
  inferApplicationActivityStage,
  isApplicationTrackedAsSentByPerson,
  isApplicationWithdrawnByPerson,
  resolveApplicationCrmStageSource,
  resolveApplicationCrmTrackedStage,
} from "@nestor/contracts";
import { formatApplicationEmployerLine } from "../../lib/job-employer-location-display";

export const APPLICATION_CRM_STAGE_ORDER: readonly ApplicationCrmStage[] = [
  "discovered",
  "reviewing",
  "shortlisted",
  "preparing",
  "needs_you",
  "ready_to_send",
  "ready_for_approval",
  "failed",
  "cancelled",
  "applied",
  "employer_viewed",
  "recruiter_contact",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
];

export {
  APPLICATION_CRM_STAGE_NAMES,
  APPLICATION_CRM_MANUAL_STAGES,
} from "@nestor/contracts";
export const APPLICATION_CRM_STAGE_LABELS = {
  ...APPLICATION_CRM_STAGE_NAMES,
  preparing: "Preparing",
  failed: "Could not apply",
};

export function inferApplicationCrmStageForView(
  record: ApplicationRecord,
): ApplicationCrmStage {
  return resolveApplicationCrmTrackedStage(
    record.crm,
    inferActivityStage(record),
  );
}

function inferActivityStage(record: ApplicationRecord): ApplicationCrmStage {
  return inferApplicationActivityStage(record);
}

/**
 * Once the person records where the hiring stands (an interview, an offer),
 * that is the application's headline instead of "Applied", in the list and
 * the detail alike (N-017). A stage they named themselves keeps its name.
 * The send's own receipt stays in the details.
 */
export function trackedHiringStageBadge(
  record: ApplicationRecord,
  customStages: readonly ApplicationCrmStageDefinition[] = [],
): { label: string; tone: "positive" | "critical" | "active" } | null {
  const crm = record.crm;
  if (
    !crm ||
    crm.stage === "applied" ||
    !(
      isApplicationTrackedAsSentByPerson(crm) ||
      isApplicationWithdrawnByPerson(crm)
    )
  ) {
    return null;
  }
  const custom = crm.customStageId
    ? customStages.find((entry) => entry.id === crm.customStageId)
    : undefined;
  return {
    label: custom?.label ?? APPLICATION_CRM_STAGE_LABELS[crm.stage],
    tone:
      crm.stage === "rejected" || crm.stage === "withdrawn"
        ? "critical"
        : crm.stage === "offer" || crm.stage === "interview"
          ? "positive"
          : "active",
  };
}

/**
 * The next thing on an application's tracker: an overdue follow-up first,
 * then the soonest reminder or interview. Null when nothing is scheduled.
 */
export function nextTrackerStepLabel(
  record: ApplicationRecord,
  now: number = Date.now(),
): string | null {
  const crm = record.crm;
  if (!crm) return null;
  const items = [
    ...crm.reminders
      .filter((reminder) => reminder.status === "pending")
      .map((reminder) => ({
        title: reminder.title,
        at: Date.parse(reminder.dueAt),
        overdueAllowed: true,
      })),
    ...crm.interviews
      .filter((interview) => interview.status === "scheduled")
      .map((interview) => ({
        title: interview.title,
        at: Date.parse(interview.startsAt),
        overdueAllowed: false,
      })),
  ]
    .filter(
      (item) =>
        Number.isFinite(item.at) && (item.overdueAllowed || item.at >= now),
    )
    .sort((left, right) => left.at - right.at);
  const next = items[0];
  if (!next) return null;
  if (next.at < now) return `${next.title} (overdue)`;
  const when = new Date(next.at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${next.title}, ${when}`;
}

export function applicationCrmStageLabelForView(
  record: ApplicationRecord,
  customStages: readonly ApplicationCrmStageDefinition[] = [],
): string {
  const stage = inferApplicationCrmStageForView(record);
  // "(local historical inference)" is implementation vocabulary inside a
  // table cell. The provenance stays visible as its own badge and tooltip;
  // the cell just names the stage.
  const baseLabel = APPLICATION_CRM_STAGE_LABELS[stage];
  // A stage the person named themselves keeps the same name in list and detail.
  const custom = record.crm?.customStageId
    ? customStages.find((entry) => entry.id === record.crm?.customStageId)
    : undefined;
  return custom?.label ?? baseLabel;
}

export function applicationCrmStageProvenanceForView(
  record: ApplicationRecord,
): string {
  return resolveApplicationCrmStageSource(record.crm) === "user"
    ? "You recorded this"
    : "From your activity";
}

/** Hover explanation for how a stage was decided. */
export function applicationCrmStageProvenanceDetailForView(
  record: ApplicationRecord,
): string {
  return resolveApplicationCrmStageSource(record.crm) === "user"
    ? "You set this stage yourself."
    : "Job Finder worked this out from your activity. Set it yourself to override.";
}

export function applicationCrmDataForView(
  record: ApplicationRecord,
): ApplicationCrmData {
  const stage = inferApplicationCrmStageForView(record);
  if (record.crm)
    return {
      ...record.crm,
      stage,
      stageSource: resolveApplicationCrmStageSource(record.crm),
      stageChangedAt:
        stage === record.crm.stage
          ? record.crm.stageChangedAt
          : record.lastUpdatedAt,
    };
  return {
    revision: 0,
    stage,
    stageSource: "activity",
    customStageId: null,
    stageChangedAt: record.lastUpdatedAt,
    tags: [],
    events: [],
    contacts: [],
    reminders: [],
    interviews: [],
    notes: [],
    attachments: [],
    compensation: {
      listedMinimum: null,
      listedMaximum: null,
      expectedMinimum: null,
      expectedMaximum: null,
      offerBase: null,
      offerBonus: null,
      offerEquity: null,
      offerBenefits: [],
      offerDeadlineAt: null,
      offerStatus: "none",
      notes: null,
    },
    lastEmployerActivityAt: null,
    appliedAt: record.status === "submitted" ? record.lastUpdatedAt : null,
  };
}

export function groupApplicationRecordsByStage(
  records: readonly ApplicationRecord[],
): Map<ApplicationCrmStage, ApplicationRecord[]> {
  const grouped = new Map<ApplicationCrmStage, ApplicationRecord[]>(
    APPLICATION_CRM_STAGE_ORDER.map((stage) => [stage, []]),
  );
  for (const record of records) {
    grouped.get(inferApplicationCrmStageForView(record))?.push(record);
  }
  return grouped;
}

export function buildApplicationCrmCalendarForView(
  records: readonly ApplicationRecord[],
  relatedJobsById?: ReadonlyMap<string, { canonicalUrl?: string | null }>,
): ApplicationCrmCalendarEntry[] {
  // Sorted by instant, not by text: saved times can carry different offsets.
  return records
    .flatMap((record) => {
      const crm = applicationCrmDataForView(record);
      const employerLine = formatApplicationEmployerLine({
        company: record.company,
        ...(relatedJobsById?.get(record.jobId)?.canonicalUrl
          ? { canonicalUrl: relatedJobsById.get(record.jobId)?.canonicalUrl }
          : {}),
      });
      const employerSuffix = ` · ${record.title}${employerLine ? ` at ${employerLine}` : ""}`;
      const entries: ApplicationCrmCalendarEntry[] = [
        ...crm.reminders
          .filter((reminder) => reminder.status === "pending")
          .map((reminder) => ({
            id: `reminder_${reminder.id}`,
            applicationRecordId: record.id,
            kind: "reminder" as const,
            title: `${reminder.title}${employerSuffix}`,
            startsAt: reminder.dueAt,
            endsAt: null,
            status: reminder.status,
          })),
        ...crm.interviews
          .filter((interview) => interview.status === "scheduled")
          .map((interview) => ({
            id: `interview_${interview.id}`,
            applicationRecordId: record.id,
            kind: "interview" as const,
            title: `${interview.title}${employerSuffix}`,
            startsAt: interview.startsAt,
            timeZone: interview.timeZone,
            endsAt: interview.endsAt,
            status: interview.status,
          })),
      ];
      // An offer already accepted, declined or expired has no deadline left
      // to meet; it would sit under Overdue for good.
      if (
        crm.compensation.offerDeadlineAt &&
        (crm.compensation.offerStatus === "active" ||
          crm.compensation.offerStatus === "none")
      ) {
        entries.push({
          id: `offer_${record.id}`,
          applicationRecordId: record.id,
          kind: "offer_deadline",
          title: `Offer deadline${employerSuffix}`,
          startsAt: crm.compensation.offerDeadlineAt,
          endsAt: null,
          status: crm.compensation.offerStatus,
        });
      }
      return entries;
    })
    .sort(
      (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
    );
}

export type TrackerSort =
  | "updated"
  | "company"
  | "applied_oldest"
  | "applied_newest";
export function sortApplicationCrmRecords(
  records: readonly ApplicationRecord[],
  sort: TrackerSort,
): ApplicationRecord[] {
  return [...records].sort((left, right) => {
    if (sort === "company")
      return (
        left.company.localeCompare(right.company) ||
        left.title.localeCompare(right.title)
      );
    if (sort === "updated")
      return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
    const a = applicationCrmDataForView(left).appliedAt;
    const b = applicationCrmDataForView(right).appliedAt;
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    return sort === "applied_oldest"
      ? Date.parse(a) - Date.parse(b)
      : Date.parse(b) - Date.parse(a);
  });
}
