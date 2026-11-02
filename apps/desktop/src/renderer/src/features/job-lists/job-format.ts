import {
  JOB_FIT_BANDS,
  type JobRow,
  type JobStage,
  type WorkMode,
} from "@nestor/contracts";

/**
 * A fit as an ordered step: 4 strong, 3 good, 2 stretch, 1 weak, 0 not
 * scored. The Fit component draws it as that many filled marks of four.
 */
export type FitLevel = 0 | 1 | 2 | 3 | 4;

/** How a fit score reads: one label form and its step on the meter. */
export function describeFit(
  score: number | null,
  stage: JobStage = "found",
): {
  label: string;
  level: FitLevel;
} {
  if (score === null)
    return {
      // Only jobs in Find jobs and Shortlisted are scored.
      // Plainly "not scored yet": the list cannot say whether a score is
      // being written this second or waits its turn.
      label:
        stage === "found" || stage === "shortlisted"
          ? "Not scored yet"
          : "Not scored",
      level: 0,
    };
  if (score >= JOB_FIT_BANDS.strong) return { label: "Strong fit", level: 4 };
  if (score >= JOB_FIT_BANDS.good) return { label: "Good fit", level: 3 };
  if (score >= JOB_FIT_BANDS.stretch) return { label: "Stretch fit", level: 2 };
  return { label: "Weak fit", level: 1 };
}

const DAY = 86_400_000;

/** "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago". */
export function describeAge(
  iso: string | null,
  now = Date.now(),
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const days = Math.floor((now - ms) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

const WORK_MODE_LABEL: Record<WorkMode, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  flexible: "Flexible",
};

export function describeWorkModes(modes: readonly WorkMode[]): string | null {
  return modes.length > 0
    ? modes.map((mode) => WORK_MODE_LABEL[mode]).join(" / ")
    : null;
}

/** One line under the title: employer, place and how it is worked. */
export function describeWhere(row: JobRow): string {
  const place = row.location.trim();
  const modes = describeWorkModes(row.workModes);
  const parts = [row.company.trim(), place];
  if (modes && !place.toLowerCase().includes(modes.toLowerCase()))
    parts.push(modes);
  return parts.filter(Boolean).join(" · ");
}

export const STAGE_LABEL: Record<JobStage, string> = {
  found: "Found",
  hidden: "Hidden",
  shortlisted: "Shortlisted",
  // A job with an approved resume, waiting for Apply. "Ready to send" is the
  // filled-in application waiting for the person's Send.
  resume: "Approved",
  applied: "Applied",
};

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
