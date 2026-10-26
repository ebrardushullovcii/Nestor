import type { AssistantScreen } from "./assistant";
import type { JobFinderSettings } from "./workspace";

/**
 * Contract values that build no schema. A screen that imports only these never
 * loads the schema modules, so the first screen can paint without building
 * them. The modules they belong to re-export them.
 */

export const suiteModules = ["job-finder", "live-assistant"] as const;

/** The score bands used by fit judgments, labels and pickiness. */
export const JOB_FIT_BANDS = { strong: 85, good: 65, stretch: 40 } as const;

/** Each screen by the name the app shows for it. */
export const ASSISTANT_SCREEN_LABELS: Record<AssistantScreen, string> = {
  home: "Home",
  profile: "Profile",
  setup: "Setup",
  discovery: "Find jobs",
  review_queue: "Shortlisted",
  resume_studio: "Shortlisted › Resume",
  applications: "Applications",
  actions: "Needs you",
  settings: "Settings",
  browser: "Browser",
  other: "Job Finder",
};

/**
 * The one name this product uses for the separate browser window Job Finder
 * drives, without an article, for labels and headings that carry none.
 *
 * It lives here — beside the session state it names — because both the desktop
 * renderer and `@nestor/job-finder` write user-facing copy about that
 * window, and a review found the same window called four different things
 * across four screens. Contracts is the one package both already depend on, so
 * this is the only place the label can exist once. Every derived form ("the
 * Job Finder browser", "Open the Job Finder browser", …) is composed from it in
 * the desktop copy module; nothing should re-spell the words here.
 */
export const JOB_FINDER_BROWSER_LABEL = "Job Finder browser";

/** On unless the person turned it off. */
export function collapsesSideMenuWithAssistant(
  settings: Pick<JobFinderSettings, "collapseSideMenuWithAssistant">,
): boolean {
  return settings.collapseSideMenuWithAssistant !== false;
}

const BROWSER_SEARCH_URL = "https://www.google.com/search?q=";
const BROWSER_HOST_PATTERN =
  /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/i;
const BROWSER_LOCAL_HOST_PATTERN =
  /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/i;

export type DesktopBrowserAddressResolution =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string };

/**
 * Reads what a person typed into the address bar the way a browser does: a
 * web address is opened, and anything else is searched. Only http(s) pages are
 * ever opened; other schemes (file:, javascript:, data:) become searches.
 */
export function resolveBrowserAddress(
  input: string,
): DesktopBrowserAddressResolution | null {
  const text = input.trim();
  if (!text) return null;
  const search = (query: string): DesktopBrowserAddressResolution => ({
    kind: "search",
    url: `${BROWSER_SEARCH_URL}${encodeURIComponent(query)}`,
    query,
  });
  if (text === "about:blank") return { kind: "url", url: text };
  if (/\s/u.test(text)) return search(text);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try {
      const url = new URL(text);
      if (url.username || url.password) return search(text);
      return { kind: "url", url: url.href };
    } catch {
      return search(text);
    }
  }
  if (scheme) return search(text);
  const authority = text.split(/[/?#]/u, 1)[0] ?? "";
  if (!BROWSER_HOST_PATTERN.test(authority)) return search(text);
  const protocol = BROWSER_LOCAL_HOST_PATTERN.test(authority)
    ? "http://"
    : "https://";
  try {
    return { kind: "url", url: new URL(`${protocol}${text}`).href };
  } catch {
    return search(text);
  }
}
