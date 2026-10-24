import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Source-scan guard, in the shape of `features/job-finder/field-chrome.test.ts`:
// `list-row.test.tsx` pins what the three lists render today, and this rules
// out a fourth list treatment appearing anywhere in the feature tree.
const featureRoot = new URL("../", import.meta.url);
// A fourth list treatment could just as easily land outside this feature, so
// the shared primitive's own directory and the sibling feature are scanned too.
const EXTRA_ROOTS: ReadonlyArray<readonly [string, URL]> = [
  ["components/ui/", new URL("../../../components/ui/", import.meta.url)],
  [
    "features/live-assistant/",
    new URL("../../live-assistant/", import.meta.url),
  ],
];

function collectProductionSources(dir: URL, prefix = ""): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [nestedPath, nestedSource] of collectProductionSources(
        new URL(`${entry.name}/`, dir),
        `${prefix}${entry.name}/`,
      )) {
        sources.set(nestedPath, nestedSource);
      }
      continue;
    }
    const path = `${prefix}${entry.name}`;
    if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      sources.set(path, readFileSync(new URL(entry.name, dir), "utf8"));
    }
  }
  return sources;
}

/** Scroll containers, including Find jobs' view during initial loading. */
const LIST_PANEL_PATHS = [
  "screens/applications/applications-records-panel.tsx",
  "screens/discovery/discovery-results-panel.tsx",
  "screens/discovery/find-jobs-launch.tsx",
  "screens/review-queue/review-queue-list-panel.tsx",
];

/**
 * Where each of those three lists renders its ROW. Usually the panel itself;
 * Shortlisted keeps its row in a module of its own so the row can be memoised
 * and a one-job update stops re-rendering the whole list. Still one list
 * treatment. Find jobs also renders its first query page before the full
 * workspace loads; those rows must use the same treatment too.
 */
const LIST_ROW_PATHS = [
  "screens/applications/applications-records-panel.tsx",
  "screens/discovery/discovery-results-panel.tsx",
  "screens/discovery/find-jobs-launch.tsx",
  "screens/review-queue/review-queue-list-row.tsx",
];

describe("Job Finder list rows carry no chrome of their own", () => {
  it("routes every selectable row through the shared list-row treatment", () => {
    const sources = collectProductionSources(featureRoot);
    for (const [prefix, root] of EXTRA_ROOTS) {
      for (const [path, source] of collectProductionSources(root, prefix)) {
        sources.set(path, source);
      }
    }

    // The walk must really scan all three trees instead of passing vacuously.
    expect(
      sources.has("screens/applications/applications-records-panel.tsx"),
    ).toBe(true);
    expect(sources.has("components/ui/selectable-row.tsx")).toBe(true);
    expect(
      sources.has("features/live-assistant/live-assistant-page.tsx"),
    ).toBe(true);

    const rowSources = [...sources.entries()].filter(([, source]) =>
      source.includes("<SelectableRow"),
    );
    // Every list view, and no list left behind. A new list that renders rows
    // outside the shared treatment shows up here first.
    expect(rowSources.map(([path]) => path).sort()).toEqual(LIST_ROW_PATHS);

    const offenders = rowSources
      .filter(([, source]) => !source.includes("jobFinderListRowClassName"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("lets no list region space its rows apart into separate cards", () => {
    const sources = collectProductionSources(featureRoot);

    // A flat divider-ruled row and a card differ by exactly two things: the
    // row's own border/radius, and whether the region pushes its rows apart.
    // The first is owned by `jobFinderListRowClassName`; this pins the second,
    // because a `gap-*` between flat rows re-creates the card look the shared
    // treatment exists to remove.
    const offenders: string[] = [];
    // Each panel must be accounted for: either it routes through
    // the shared gap-free region class, or it declares its own `content-start`
    // region — and then that region must itself carry no row gap. Counting
    // panels rather than regex hits is what stops this passing on nothing.
    let panelsAccountedFor = 0;
    for (const path of LIST_PANEL_PATHS) {
      const source = sources.get(path);
      if (source === undefined) {
        throw new Error(`Expected the scan to reach ${path}.`);
      }
      if (source.includes("jobFinderListRegionClassName")) {
        panelsAccountedFor += 1;
      }
    }

    // `content-start` is ordinary layout elsewhere, so only the lists and the
    // shared module they route through are inspected for a row gap.
    for (const path of [...LIST_PANEL_PATHS, "components/list-row.ts"]) {
      const source = sources.get(path);
      if (source === undefined) {
        throw new Error(`Expected the scan to reach ${path}.`);
      }
      for (const [region] of source.matchAll(
        /"[^"\n]*\bcontent-start\b[^"\n]*"/g,
      )) {
        const gaps = [...region.matchAll(/\bgap(?:-[xy])?-[\w.]+/g)].map(
          (match) => match[0],
        );
        if (gaps.length > 0) {
          offenders.push(`${path}: ${gaps.join(" ")}`);
        }
      }
    }

    // Not a vacuous pass: every list view must be reached and accounted for.
    expect(panelsAccountedFor).toBe(LIST_PANEL_PATHS.length);
    expect(offenders).toEqual([]);
  });
});
