import { classifyFailure } from "@renderer/features/job-finder/lib/describe-failure";

/**
 * Why Apply stopped, as one plain sentence in the words of the buttons
 * beside it (Try again, Apply by hand). The engine's own text ("The
 * dedicated browser could not load this employer page, so preparation
 * stopped… Retry preparation…") repeated itself, named machinery and
 * offered a recovery the buttons already are, so it never reaches the
 * screen whole: known causes get their own sentence, and an unknown reason
 * keeps only its first sentence when that one is plain.
 */
export function applyFailureCause(reason: string | null | undefined): string {
  const text = reason?.trim() ?? "";
  if (!text) return GENERIC;
  if (PAGE_NOT_OPENED.test(text)) return "Apply couldn’t open this job’s page.";
  const kind = classifyFailure(text);
  const known = KIND_CAUSE[kind];
  if (known) return known;
  const first = /^[^.!?]*[.!?]?/u.exec(text)?.[0]?.trim() ?? "";
  return first.length > 0 && first.length <= 140 && !ENGINE_WORDS.test(first)
    ? /[.!?]$/u.test(first)
      ? first
      : `${first}.`
    : GENERIC;
}

/** A failure alone does not establish what the site received. */
export function applyFailureLine(reason: string | null | undefined): string {
  return applyFailureCause(reason);
}

const GENERIC = "Apply couldn’t finish this application.";

const PAGE_NOT_OPENED =
  /could not (?:load|open) (?:this|the) (?:employer|application) page|could not open the application page|ApplicationNavigationError/iu;

/** Words of the engine, never of the screen. */
const ENGINE_WORDS =
  /dedicated\s+browser|preparation|runtime|playwright|chromium|selector|goto|stack|\bError\b|https?:\/\//iu;

const KIND_CAUSE: Partial<Record<ReturnType<typeof classifyFailure>, string>> =
  {
    offline: "Apply couldn’t reach the internet.",
    timed_out: "The job’s page took too long, so Apply stopped.",
    site_blocked: "The job site wouldn’t let Apply continue.",
    paused: "Work was paused before Apply finished.",
    file_missing: "Apply couldn’t find your resume file.",
    not_found: "Apply couldn’t find this job’s page.",
  };
