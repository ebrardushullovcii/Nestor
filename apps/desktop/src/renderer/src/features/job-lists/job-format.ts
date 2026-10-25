import type { JobRow, JobStage, WorkMode } from "@nestor/contracts";

export type FitTone = "positive" | "active" | "muted" | "neutral";

/** How a fit score reads in a list: the number and a word for it. */
export function describeFit(
  score: number | null,
  stage: JobStage = "found",
): {
  label: string;
  tone: FitTone;
} {
  if (score === null)
    return {
      // Only jobs in Find jobs and Shortlisted are scored.
      label:
        stage === "found" || stage === "shortlisted"
          ? "Scoring…"
          : "Not scored",
      tone: "neutral",
    };
  if (score >= 70) return { label: "Strong fit", tone: "positive" };
  if (score >= 50) return { label: "Good fit", tone: "active" };
  return { label: "Weak fit", tone: "muted" };
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
  resume: "Ready to apply",
  applied: "Applied",
};

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
