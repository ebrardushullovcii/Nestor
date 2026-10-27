import type {
  ResumeLevel,
  ResumeStatus,
  ShortlistedApplication,
} from "@nestor/contracts";

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
        detail: `Writes at ${LEVEL_LABEL[resume.level]} as soon as a writer is free.`,
      };
    case "writing":
      return {
        label: "Writing",
        tone: "active",
        detail:
          resume.level === "original"
            ? null
            : `Writing at ${LEVEL_LABEL[resume.level]}. This takes under a minute.`,
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
  applying: { label: "Applying…", tone: "active" },
  ready: { label: "Ready to send", tone: "positive" },
  needs_you: { label: "Needs you", tone: "warning" },
};
