import {
  listResumeReviewsNeeded,
  listFinalApplicationActions,
} from "../attention";
import { APPLICATION_SKIPPED_BY_PERSON_LABEL } from "@nestor/contracts";
import { isProvisionalMatchAssessment } from "../../discovery-ordering";
import { getFitEvidenceDepth } from "../../discovery-result-bands";
import type {
  ApplicationRecord,
  ApplicationCrmInterview,
  AssistantMessagePart,
  DiscoveryJobView,
  JobFinderWorkspaceSnapshot,
  ReviewQueueItem,
  SavedJob,
} from "@nestor/contracts";

/**
 * Compact shapes for the model and the rows the person sees. Every read is
 * bounded; a long list goes into a result set the model pages through.
 */

// The same links global search uses, so a row opens the record in the app.
export const JOB_ROUTE = (jobId: string) =>
  `/job-finder/discovery?jobId=${encodeURIComponent(jobId)}`;
export const SHORTLIST_ROUTE = (jobId: string) =>
  `/job-finder/review-queue?jobId=${encodeURIComponent(jobId)}`;
export const RESUME_ROUTE = (jobId: string) =>
  `/job-finder/review-queue/${encodeURIComponent(jobId)}/resume`;
export const APPLICATION_ROUTE = (recordId: string) =>
  `/job-finder/applications?applicationRecordId=${encodeURIComponent(recordId)}`;

/**
 * The fit a job may claim, worded the way the Find jobs list words it: a
 * number only when it was assessed against the current profile and listing,
 * "Up to" when a gap caps it, and no number at all when it was not assessed.
 */
export function fitLabel(job: SavedJob | DiscoveryJobView): string {
  const bound = [
    job.matchAssessment.contextFingerprint,
    job.matchAssessment.postingFingerprint,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
  if (isProvisionalMatchAssessment(job) || !bound) return "Fit not assessed";
  if (getFitEvidenceDepth(job.matchAssessment).isNotJudged)
    return "Not judged yet";
  return job.matchAssessment.scoreIsUpperBound
    ? `Up to ${job.matchAssessment.score}% fit`
    : `${job.matchAssessment.score}% fit`;
}

export function compactJob(job: SavedJob | DiscoveryJobView) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workMode,
    status: job.status,
    fit: fitLabel(job),
    recommendation: job.matchAssessment.recommendation,
    postedAt: job.postedAt,
    lastSeenAt: job.lastSeenAt,
    lastVerifiedActiveAt: job.lastVerifiedActiveAt,
    salary: job.salaryText,
    url: job.applicationUrl ?? job.canonicalUrl,
    listingUrl: job.canonicalUrl,
    sourceIds:
      "provenance" in job
        ? [...new Set(job.provenance.map((entry) => entry.targetId))]
        : [],
    listing:
      "listingActivity" in job && job.listingActivity
        ? job.listingActivity.status
        : undefined,
  };
}

export function jobEvidence(job: SavedJob | DiscoveryJobView) {
  return {
    ...compactJob(job),
    reasons: job.matchAssessment.reasons.slice(0, 6),
    gaps: job.matchAssessment.gaps.slice(0, 6),
    rationale: job.matchAssessment.recommendationRationale,
    locationReach: job.matchAssessment.locationReach,
    remoteGeographies: job.screeningHints.remoteGeographies,
    sponsorshipText: job.screeningHints.sponsorshipText,
    judgedAt: job.matchAssessment.judgment?.judgedAt ?? null,
    minimumQualifications: job.minimumQualifications.slice(0, 15),
    preferredQualifications: job.preferredQualifications.slice(0, 15),
    requirements: job.matchAssessment.requirements
      .slice(0, 20)
      .map((requirement) => ({
        label: requirement.label,
        importance: requirement.importance,
        status: requirement.status,
        jobEvidence: requirement.jobEvidence,
        explanation: requirement.explanation,
      })),
    keySkills: job.keySkills.slice(0, 20),
    seniority: job.seniority,
    employmentType: job.employmentType,
    resumeLevel: job.resumeTailoringMode ?? null,
    resumeMode: job.resumeApplicationMode ?? null,
  };
}

export function jobDetail(job: SavedJob | DiscoveryJobView) {
  return {
    ...jobEvidence(job),
    summary: job.summary,
    description: job.description,
    responsibilities: job.responsibilities.slice(0, 15),
    benefits: job.benefits.slice(0, 10),
  };
}

export function compactShortlistItem(item: ReviewQueueItem) {
  return {
    jobId: item.jobId,
    title: item.title,
    company: item.company,
    location: item.location,
    score: item.matchScore,
    resume: item.resumeReview.status,
    resumeMode: item.resumeApplicationMode,
    resumeLevel: item.resumeTailoringMode ?? null,
    linesToDecide: item.resumeLinesToDecide ?? 0,
    assetStatus: item.assetStatus,
  };
}

export function compactApplication(record: ApplicationRecord) {
  return {
    id: record.id,
    jobId: record.jobId,
    title: record.title,
    company: record.company,
    status: record.status,
    lastAttempt: record.lastAttemptState,
    next: record.nextActionLabel,
    last: record.lastActionLabel,
    blocker: record.latestBlocker?.summary ?? null,
    stage: record.crm?.stage ?? null,
    crmRevision: record.crm?.revision ?? 0,
    mode: record.automationMode,
    updatedAt: record.lastUpdatedAt,
    appliedAt: record.crm?.appliedAt ?? null,
    lastEmployerActivityAt: record.crm?.lastEmployerActivityAt ?? null,
  };
}

/** Every saved job the snapshot knows, deduplicated by id. */
export function allJobs(
  snapshot: JobFinderWorkspaceSnapshot,
): DiscoveryJobView[] {
  const byId = new Map<string, DiscoveryJobView>();
  for (const job of [
    ...snapshot.discoveryJobs,
    ...snapshot.companyJobs,
    ...snapshot.dismissedDiscoveryJobs,
  ]) {
    if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

export function findJob(
  snapshot: JobFinderWorkspaceSnapshot,
  jobId: string,
): DiscoveryJobView | null {
  return allJobs(snapshot).find((job) => job.id === jobId) ?? null;
}

export function jobRowsPart(input: {
  jobs: readonly (SavedJob | DiscoveryJobView)[];
  title: string | null;
  resultSetId: string | null;
  totalCount?: number;
}): AssistantMessagePart {
  return {
    type: "records",
    kind: "jobs",
    title: input.title,
    resultSetId: input.resultSetId,
    totalCount: input.totalCount ?? input.jobs.length,
    rows: input.jobs.slice(0, 25).map((job) => ({
      id: job.id,
      title: job.title.slice(0, 300),
      subtitle: `${job.company} · ${job.location}`.slice(0, 300),
      status: fitLabel(job),
      route:
        job.status === "discovered"
          ? JOB_ROUTE(job.id)
          : SHORTLIST_ROUTE(job.id),
    })),
  };
}

export function applicationRowsPart(input: {
  records: readonly ApplicationRecord[];
  title: string | null;
  resultSetId?: string | null;
}): AssistantMessagePart {
  return {
    type: "records",
    kind: "applications",
    title: input.title,
    resultSetId: input.resultSetId ?? null,
    totalCount: input.records.length,
    rows: input.records.slice(0, 25).map((record) => ({
      id: record.id,
      title: record.title.slice(0, 300),
      subtitle: record.company.slice(0, 300),
      status: record.nextActionLabel ?? record.lastActionLabel,
      route: APPLICATION_ROUTE(record.id),
    })),
  };
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`) {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

export function unresolvedUserActions(snapshot: JobFinderWorkspaceSnapshot) {
  return snapshot.userActionRequests.filter(
    (request) =>
      !["resolved", "cancelled", "skipped", "expired", "superseded"].includes(
        request.state,
      ),
  );
}

/** Lowercase letters and digits only, for comparing company names and titles. */
export function comparableName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export interface JobCaveats {
  /** The person excluded this employer. */
  excludedEmployer: boolean;
  /** Another saved job with the same title and listing text already has an application. */
  alreadyAppliedAs: { jobId: string; status: string } | null;
}

/**
 * Facts a job pick must respect (employer exclusions, and ADR 0030's one
 * listing per job: the same posting found on two sites is one job).
 */
export function createJobCaveats(snapshot: JobFinderWorkspaceSnapshot) {
  const excluded = new Set(
    snapshot.searchPreferences.companyBlacklist.map(comparableName),
  );
  const jobs = allJobs(snapshot);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const applied: { job: DiscoveryJobView; status: string }[] = [];
  for (const record of snapshot.applicationRecords) {
    const job = byId.get(record.jobId);
    if (job) applied.push({ job, status: record.status });
  }
  const descriptionKey = (job: DiscoveryJobView) =>
    comparableName(job.description).slice(0, 240);
  return (job: DiscoveryJobView): JobCaveats => {
    const title = comparableName(job.title);
    const twin = applied.find(
      (entry) =>
        entry.job.id !== job.id &&
        comparableName(entry.job.title) === title &&
        (comparableName(entry.job.company) === comparableName(job.company) ||
          (descriptionKey(job).length > 40 &&
            descriptionKey(entry.job) === descriptionKey(job))),
    );
    const ownRecord = snapshot.applicationRecords.find(
      (record) => record.jobId === job.id,
    );
    return {
      excludedEmployer: excluded.has(comparableName(job.company)),
      alreadyAppliedAs: ownRecord
        ? { jobId: job.id, status: ownRecord.status }
        : twin
          ? { jobId: twin.job.id, status: twin.status }
          : null,
    };
  };
}

/** Where a job's application stands, in plain words, from its records. */
export function describeApplicationStanding(
  snapshot: JobFinderWorkspaceSnapshot,
  jobId: string,
): string {
  const record = snapshot.applicationRecords.find(
    (entry) => entry.jobId === jobId,
  );
  if (!record) return "not applied";
  if (record.lastActionLabel === APPLICATION_SKIPPED_BY_PERSON_LABEL)
    return "skipped";
  return record.status.replaceAll("_", " ");
}

/**
 * Background work is paused only by the person (Home's Pause, Safeguards or
 * asking the assistant). Work that would run in the background waits for
 * them instead of lifting their brake on its own.
 */
export function pausedByPersonMessage(
  activityControl:
    | {
        paused?: boolean | null;
        pausedAt?: string | null;
        reason?: string | null;
      }
    | null
    | undefined,
  what: string,
): string | null {
  if (!activityControl?.paused) return null;
  const since = activityControl.pausedAt
    ? ` since ${activityControl.pausedAt.slice(0, 16).replace("T", " ")} UTC`
    : "";
  const reason = activityControl.reason
    ? ` (reason: ${activityControl.reason})`
    : "";
  return `Nothing started: the person paused background work${since}${reason}, so ${what} cannot run. Do not resume it yourself. Tell them it is paused and ask whether to resume it and go ahead. Resume with pause_activity only if their message already says to go ahead even though it is paused, and say that you resumed it.`;
}

/** A UTC instant displayed in its saved zone; invalid zones never relabel UTC. */
export function localDateTime(at: string, timeZone: string | null) {
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) return "Invalid saved date";
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(instant);
  try {
    return format(timeZone ?? "UTC");
  } catch {
    return `${format("UTC")} (saved time zone unavailable)`;
  }
}

export function interviewForModel(interview: ApplicationCrmInterview) {
  return {
    ...interview,
    localTime: localDateTime(interview.startsAt, interview.timeZone),
    localEndTime: interview.endsAt
      ? localDateTime(interview.endsAt, interview.timeZone)
      : null,
  };
}

/** Reviews and final sends are person-owned actions even without a browser request. */
export function outstandingReviews(snapshot: JobFinderWorkspaceSnapshot) {
  const resumes = listResumeReviewsNeeded(snapshot).map((item) => ({
    kind: "resume_review",
    jobId: item.jobId,
    title: item.title,
    company: item.company,
    reason: item.resumeLinesToDecide
      ? "Decide which resume lines to keep"
      : "Review the unapproved resume draft",
    route: RESUME_ROUTE(item.jobId),
  }));
  const applications = listFinalApplicationActions(snapshot).map((record) => ({
    kind: "application_send",
    jobId: record.jobId,
    title: record.title,
    company: record.company,
    reason: "Review the prepared form and send it",
    route: APPLICATION_ROUTE(record.id),
  }));
  return [...resumes, ...applications];
}

/**
 * What the tracker says is due: pending reminders and scheduled interviews,
 * overdue first, with the time zone each was saved in. One reading for the
 * workspace summary, the agenda tool and Home's wording, so "nothing needs
 * you" can never sit beside an overdue follow-up or tomorrow's interview.
 */
export function trackerAgenda(
  snapshot: Pick<JobFinderWorkspaceSnapshot, "applicationRecords">,
  now: number,
  horizonDays = 14,
) {
  const horizon = now + horizonDays * 86_400_000;
  const items: {
    kind: "reminder" | "interview";
    applicationRecordId: string;
    job: string;
    title: string;
    at: string;
    timeZone: string | null;
    overdue: boolean;
  }[] = [];
  for (const record of snapshot.applicationRecords) {
    const job = `${record.title} at ${record.company}`;
    for (const reminder of record.crm?.reminders ?? []) {
      if (reminder.status !== "pending") continue;
      const due = Date.parse(reminder.dueAt);
      if (!Number.isFinite(due) || due > horizon) continue;
      items.push({
        kind: "reminder",
        applicationRecordId: record.id,
        job,
        title: reminder.title,
        at: reminder.dueAt,
        timeZone: null,
        overdue: due < now,
      });
    }
    for (const interview of record.crm?.interviews ?? []) {
      if (interview.status !== "scheduled") continue;
      const starts = Date.parse(interview.startsAt);
      if (!Number.isFinite(starts) || starts < now || starts > horizon) {
        continue;
      }
      items.push({
        kind: "interview",
        applicationRecordId: record.id,
        job,
        title: interview.title,
        at: interview.startsAt,
        timeZone: interview.timeZone,
        overdue: false,
      });
    }
  }
  // By instant, not by text: saved times can carry different UTC offsets.
  return items
    .map((item) => ({
      ...item,
      localTime: localDateTime(item.at, item.timeZone),
    }))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
