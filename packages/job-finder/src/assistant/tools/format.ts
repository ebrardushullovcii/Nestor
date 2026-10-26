import { isProvisionalMatchAssessment } from "../../discovery-ordering";
import { getFitEvidenceDepth } from "../../discovery-result-bands";
import type {
  ApplicationRecord,
  ApplicationCrmInterview,
  AssistantMessagePart,
  DiscoveryJobView,
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
export const RESUME_ROUTE = SHORTLIST_ROUTE;
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

/**
 * A saved job's stored status as the model should read it. Shortlisting
 * stores "drafting" before any resume is asked for, so the raw word made the
 * model report a resume "being drafted" when Shortlisted says "Needs a resume".
 */
export function assistantJobStatus(status: SavedJob["status"]): string {
  return status === "drafting" ? "shortlisted_needs_resume" : status;
}

export function compactJob(job: SavedJob | DiscoveryJobView) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workMode,
    status: assistantJobStatus(job.status),
    inShortlist: ["drafting", "ready_for_review", "approved"].includes(
      job.status,
    ),
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
    mode: record.automationMode,
    updatedAt: record.lastUpdatedAt,
  };
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
