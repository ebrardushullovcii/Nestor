// Router-owned route paths for the Job Finder surfaces. Render them through
// react-router <Link to> (or navigate()) so every in-app navigation goes
// through the router and stays guarded by the page controller's dirty-state
// blocker; do not render them as raw "#/..." anchor hrefs.
export const JOB_FINDER_ROUTE_PATHS = {
  profile: "/job-finder/profile",
  profileTargetRoles:
    "/job-finder/profile?section=preferences&focus=target-roles",
  profileWorkModes: "/job-finder/profile?section=preferences&focus=work-modes",
  profileSources: "/job-finder/profile?section=sources&focus=job-sources",
  discovery: "/job-finder/discovery",
  reviewQueue: "/job-finder/review-queue",
  applications: "/job-finder/applications",
  /** The person's extra application files: a Profile tab, not a destination. */
  profileFiles: "/job-finder/profile?section=files",
  settings: "/job-finder/settings",
} as const;

/** The file kinds Profile › Files can preselect from a link. */
export type ProfileFileKindHint =
  | "portfolio"
  | "work_sample"
  | "cover_letter"
  | "transcript"
  | "certificate"
  | "image"
  | "other";

/**
 * Profile › Files with "What is the file?" already set to the kind the
 * application asked for. A transcript card used to land on Portfolio.
 */
export function profileFilesHref(
  kind?: ProfileFileKindHint | readonly ProfileFileKindHint[] | null,
): string {
  const kinds = [...new Set(kind ? (Array.isArray(kind) ? kind : [kind]) : [])];
  return kinds.length > 0
    ? `${JOB_FINDER_ROUTE_PATHS.profileFiles}&kind=${kinds.map(encodeURIComponent).join(",")}`
    : JOB_FINDER_ROUTE_PATHS.profileFiles;
}

/**
 * The file kind a form's upload field asks for, read from its question kind
 * and its label ("Academic transcript" is a transcript).
 */
export function inferFileKindForQuestion(question: {
  kind: string;
  prompt: string;
}): ProfileFileKindHint {
  if (question.kind === "portfolio") return "portfolio";
  if (question.kind === "cover_letter") return "cover_letter";
  const prompt = question.prompt.toLowerCase();
  if (/transcript|grades|academic record/u.test(prompt)) return "transcript";
  if (/certificat|licen[cs]e|diploma/u.test(prompt)) return "certificate";
  if (/cover letter|motivation letter/u.test(prompt)) return "cover_letter";
  if (/portfolio/u.test(prompt)) return "portfolio";
  if (/sample|writing|case study/u.test(prompt)) return "work_sample";
  if (/photo|image|headshot|picture/u.test(prompt)) return "image";
  return "other";
}

/** The Settings group that owns how picky a search is (ADR 0025). */
export const SETTINGS_AI_JOB_SEARCH_ANCHOR_ID = "settings-ai-job-search";
export const JOB_FINDER_SETTINGS_JOB_SEARCH_HREF = `${JOB_FINDER_ROUTE_PATHS.settings}#${SETTINGS_AI_JOB_SEARCH_ANCHOR_ID}`;
