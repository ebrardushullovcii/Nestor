// @vitest-environment jsdom

/**
 * PKG-01 guard — "primary action in reach".
 *
 * Two structural rules the four locked routes must keep, plus the one reveal
 * mechanism the three list/detail routes must share:
 *
 * 1. A locked route owns its own scrolling, so it must bound itself to the
 *    route viewport by passing `lockContentHeight` and/or `bottomContent` to
 *    `LockedScreenLayout`. Without either, the layout grid's `1fr` row resolves
 *    to max-content, every pane grows past the fold, and the route's primary
 *    action leaves the screen.
 * 2. It follows that no `data-locked-pane-scroll-region` pane may live inside
 *    an unbounded locked layout: such a pane advertises a scroll owner that can
 *    never get a scroll range.
 * 3. Find jobs, Shortlisted and Applications all stack list over detail below
 *    the `xl` (1280px) breakpoint, so all three must reveal the stacked detail
 *    region on selection. Anything else means a click that changes nothing the
 *    user can see.
 *
 * `LOCKED_LAYOUT_SCREENS` is a module-level `const` in `job-finder-shell.tsx`
 * with no `export` (`job-finder-page.tsx` re-declares it for the same reason),
 * so rule 1 derives the list from that source rather than adding a production
 * export just for a test.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const SCREENS_DIR = dirname(fileURLToPath(import.meta.url));
const FEATURE_DIR = join(SCREENS_DIR, "..");
const SCROLL_REGION_MARKER = "data-locked-pane-scroll-region";

/** Route id -> the screen file that renders that route's LockedScreenLayout. */
const LOCKED_SCREEN_FILES: Readonly<Record<string, string>> = {
  profile: "screens/profile-screen.tsx",
  actions: "../needs-you/needs-you-screen.tsx",
  "review-queue": "../shortlisted/shortlisted-screen.tsx",
  applications: "../applications/applications-screen.tsx",
};

/** Feature-relative path prefix -> the locked route that owns those files. */
const ROUTE_OWNERSHIP: readonly (readonly [string, string])[] = [
  ["screens/profile-screen.tsx", "profile"],
  ["components/profile/", "profile"],
  ["screens/applications/", "applications"],
];

function readFeatureSource(relativePath: string): string {
  return readFileSync(join(FEATURE_DIR, relativePath), "utf8");
}

function listFeatureSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFeatureSourceFiles(absolute));
      continue;
    }

    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }

    files.push(relative(FEATURE_DIR, absolute).split(sep).join("/"));
  }

  return files;
}

/**
 * The locked routes exactly as the shell declares them. Parsed from source on
 * purpose: a route added to the shell list without a mapping here fails the
 * guard instead of silently escaping it.
 */
function readLockedLayoutScreens(): readonly string[] {
  const source = readFeatureSource("components/job-finder-shell.tsx");
  const declaration = /const LOCKED_LAYOUT_SCREENS[^=]*=\s*\[([\s\S]*?)\]/.exec(
    source,
  );

  if (!declaration?.[1]) {
    throw new Error(
      "LOCKED_LAYOUT_SCREENS declaration not found in job-finder-shell.tsx",
    );
  }

  return Array.from(declaration[1].matchAll(/"([^"]+)"/g)).map(
    (match) => match[1] as string,
  );
}

/**
 * The props text of a file's `<LockedScreenLayout` opening tag. Brace depth is
 * tracked so a `>` inside an expression prop (an arrow function, for instance)
 * is not mistaken for the end of the tag.
 */
function readLockedScreenLayoutProps(source: string, label: string): string {
  const start = source.indexOf("<LockedScreenLayout");

  if (start < 0) {
    throw new Error(`${label} does not render a LockedScreenLayout`);
  }

  let depth = 0;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === ">" && depth === 0) {
      return source.slice(start, index);
    }
  }

  throw new Error(`${label} has an unterminated LockedScreenLayout tag`);
}

function isBoundedLayout(props: string): boolean {
  return /\blockContentHeight\b/.test(props) || /\bbottomContent\b/.test(props);
}

function ownerRouteForFile(relativePath: string): string | null {
  return (
    ROUTE_OWNERSHIP.find(([prefix]) => relativePath.startsWith(prefix))?.[1] ??
    null
  );
}

describe("locked route bounds", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("bounds every locked route's LockedScreenLayout to the route viewport", () => {
    const lockedScreens = readLockedLayoutScreens();

    expect(lockedScreens.length).toBeGreaterThan(0);

    for (const screenId of lockedScreens) {
      // Find jobs (features/find-jobs) sizes its own list and details panes.
      if (screenId === "discovery") continue;
      const file = LOCKED_SCREEN_FILES[screenId];

      expect(
        file,
        `${screenId} is a locked route with no screen file mapped in this guard`,
      ).toBeTruthy();

      const props = readLockedScreenLayoutProps(
        readFeatureSource(file as string),
        file as string,
      );

      expect(
        isBoundedLayout(props),
        `${file} must pass lockContentHeight and/or bottomContent; a locked route with neither has no viewport bound and its primary action leaves the screen`,
      ).toBe(true);
    }
  });

  it("keeps every data-locked-pane-scroll-region inside a bounded locked layout", () => {
    const markedFiles = listFeatureSourceFiles(FEATURE_DIR).filter(
      (file) =>
        // The layout itself only queries the marker; it never declares a pane.
        file !== "components/locked-screen-layout.tsx" &&
        readFeatureSource(file).includes(SCROLL_REGION_MARKER),
    );

    expect(markedFiles.length).toBeGreaterThan(0);

    for (const file of markedFiles) {
      const route = ownerRouteForFile(file);

      expect(
        route,
        `${file} declares ${SCROLL_REGION_MARKER} but belongs to no locked route known to this guard`,
      ).toBeTruthy();

      const screenFile = LOCKED_SCREEN_FILES[route as string] as string;
      const props = readLockedScreenLayoutProps(
        readFeatureSource(screenFile),
        screenFile,
      );

      expect(
        isBoundedLayout(props),
        `${file} advertises a pane scroll owner, but ${screenFile} renders an unbounded LockedScreenLayout, so that pane can never get a scroll range`,
      ).toBe(true);
    }
  });
});
