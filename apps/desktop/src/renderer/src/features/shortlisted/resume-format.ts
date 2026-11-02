import type {
  ResumeLevel,
  ResumeStatus,
  ShortlistedApplication,
} from "@nestor/contracts";

import { APPLICATION_WORK_TONE } from "@renderer/features/job-finder/lib/application-status-tone";
import type { BadgeTone } from "@renderer/features/job-finder/lib/job-finder-types";

export const LEVELS: readonly ResumeLevel[] = [
  "original",
  "light",
  "tailored",
  "aggressive",
];

export const LEVEL_LABEL: Record<ResumeLevel, string> = {
  original: "Original",
  light: "Light",
  tailored: "Tailored",
  aggressive: "Aggressive",
};

/** What each level means, as a short hint beside its name. */
export const LEVEL_HINT: Record<ResumeLevel, string> = {
  original: "Your imported resume, unchanged.",
  light: "Your resume with light edits: wording and order for this job.",
  tailored: "Rewritten for this job from your real experience.",
  aggressive:
    "Rewritten hard for this job: the most emphasis, still only true facts.",
};

/** What a row and the resume header say about where a resume is. */
export function describeResume(
  resume: (ResumeStatus & { level: ResumeLevel }) | null,
): { label: string; tone: BadgeTone; detail: string | null } {
  if (!resume) {
    return {
      label: "Waiting",
      tone: "muted",
      detail: "Starts writing in a moment.",
    };
  }
  if (resume.approvedAt) {
    return { label: "Approved", tone: "positive", detail: null };
  }
  switch (resume.state) {
    case "queued":
      return {
        label: "Waiting",
        tone: "muted",
        detail: `Writes the ${LEVEL_LABEL[resume.level]} resume as soon as a writer is free.`,
      };
    case "writing":
      return {
        label: "Writing",
        tone: "active",
        detail:
          resume.level === "original"
            ? null
            : `Writing the ${LEVEL_LABEL[resume.level]} resume. You can keep browsing while it finishes.`,
      };
    case "failed":
      return { label: "Not written", tone: "warning", detail: resume.error };
    case "ready":
      return { label: "To review", tone: "neutral", detail: null };
  }
}

/** What an approved job's row says while Apply works on it. */
export const APPLICATION_BADGE: Record<
  ShortlistedApplication["status"],
  { label: string; tone: BadgeTone }
> = {
  applying: { label: "Applying…", tone: APPLICATION_WORK_TONE.running },
  ready: { label: "Ready to send", tone: APPLICATION_WORK_TONE.ready },
  needs_you: { label: "Needs you", tone: APPLICATION_WORK_TONE.needs_you },
  failed: { label: "Could not apply", tone: APPLICATION_WORK_TONE.failed },
};
