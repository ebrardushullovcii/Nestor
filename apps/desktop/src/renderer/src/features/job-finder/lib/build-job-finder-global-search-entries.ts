import type { JobRow, JobStage } from "@nestor/contracts";
import { STAGE_LABEL } from "@renderer/features/job-lists/job-format";
import type { JobFinderGlobalSearchEntry } from "./job-finder-global-search";
import { JOB_FINDER_ROUTE_PATHS } from "./job-finder-route-hrefs";

/**
 * Every screen, so "set" then Enter opens Settings. The extra words are what
 * a person might type for it.
 */
function screen(
  id: string,
  title: string,
  subtitle: string,
  href: string,
  words: readonly string[],
): JobFinderGlobalSearchEntry {
  return {
    href,
    id: `screen:${id}`,
    kind: "screen",
    metadata: words,
    subtitle,
    title,
  };
}

export const SCREEN_ENTRIES: readonly JobFinderGlobalSearchEntry[] = [
  screen("home", "Home", "Your next step", "/job-finder/home", ["start"]),
  screen(
    "profile",
    "Profile",
    "Experience and documents",
    JOB_FINDER_ROUTE_PATHS.profile,
    ["resume", "experience"],
  ),
  screen(
    "job-sources",
    "Job sources",
    "Profile",
    JOB_FINDER_ROUTE_PATHS.profileSources,
    ["sites", "boards", "feeds"],
  ),
  screen(
    "discovery",
    "Find jobs",
    "Search and triage",
    JOB_FINDER_ROUTE_PATHS.discovery,
    ["discover", "search now"],
  ),
  screen(
    "review-queue",
    "Shortlisted",
    "Resumes and applying",
    JOB_FINDER_ROUTE_PATHS.reviewQueue,
    ["review", "approve"],
  ),
  screen(
    "applications",
    "Applications",
    "Where each application stands",
    JOB_FINDER_ROUTE_PATHS.applications,
    ["tracker", "interviews"],
  ),
  screen(
    "settings",
    "Settings",
    "Applying, AI, appearance",
    JOB_FINDER_ROUTE_PATHS.settings,
    ["preferences", "options"],
  ),
  screen(
    "settings-applying",
    "Applying settings",
    "Settings",
    `${JOB_FINDER_ROUTE_PATHS.settings}#settings-application-authority`,
    ["send for me", "fill in"],
  ),
];

/** Where a saved job opens: the screen that lists its stage. */
function jobHref(row: JobRow): string {
  if (row.stage === "applied")
    return `${JOB_FINDER_ROUTE_PATHS.applications}?jobId=${row.id}`;
  if (row.stage === "shortlisted" || row.stage === "resume")
    return `${JOB_FINDER_ROUTE_PATHS.reviewQueue}?jobId=${row.id}`;
  return `${JOB_FINDER_ROUTE_PATHS.discovery}?job=${row.id}`;
}

/** Every stage, in the order a person most likely means. */
const SEARCHED_STAGES: readonly JobStage[] = [
  "found",
  "shortlisted",
  "resume",
  "applied",
  "hidden",
];

/**
 * The saved jobs whose title, company or place match `query`, read from the
 * job store a few per stage, best fit first. Applied jobs are applications.
 */
export async function searchSavedJobs(
  query: string,
  perStage = 8,
): Promise<readonly JobFinderGlobalSearchEntry[]> {
  const pages = await Promise.all(
    SEARCHED_STAGES.map((stage) =>
      window.nestor.jobs.run("list_jobs", {
        stage,
        text: query,
        sort: "best_fit",
        limit: perStage,
      }),
    ),
  );
  return pages.flatMap((page) =>
    page.rows.map((row) => ({
      href: jobHref(row),
      id: `job:${row.id}`,
      kind:
        row.stage === "applied" ? ("application" as const) : ("job" as const),
      metadata: [],
      subtitle: [row.company, row.location, STAGE_LABEL[row.stage]]
        .filter(Boolean)
        .join(" · "),
      title: row.title,
    })),
  );
}
