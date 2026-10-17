import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JOB_FINDER_BROWSER_LABEL,
  JOB_FINDER_BROWSER_NAME,
  JOB_FINDER_BROWSER_NAME_SENTENCE_START,
  OPEN_JOB_FINDER_BROWSER_ACTION,
  REOPEN_JOB_FINDER_BROWSER_ACTION,
} from "./job-finder-browser-handoff-copy";

/**
 * One window, one name.
 *
 * The round-eight review recorded four names for the same window; the fix that
 * followed introduced the canonical one and converted two screens, leaving
 * Discovery on two other phrasings in six more places. A per-screen assertion
 * cannot catch that — it only ever proves the screen it renders — so this scans
 * the renderer source instead and fails on any retired phrasing, including one
 * added later.
 *
 * It scans code, not prose: comments are stripped first, so a docblock may
 * still quote a retired name to explain why it was retired.
 */
const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * `@nestor/job-finder` writes user-facing copy about the same window (the
 * per-source access prompt Discovery renders as its primary action), so a
 * renderer-only scan would leave a name the user reads unguarded.
 */
const JOB_FINDER_PACKAGE_ROOT = path.resolve(
  RENDERER_ROOT,
  "../../../../../packages/job-finder/src",
);

const SCAN_ROOTS: ReadonlyArray<{ id: string; directory: string }> = [
  { id: "renderer", directory: RENDERER_ROOT },
  { id: "job-finder", directory: JOB_FINDER_PACKAGE_ROOT },
];

/**
 * Phrasings this app has used for the Job Finder browser and no longer uses.
 * Adding a name here is how a newly retired phrasing stops coming back.
 */
const RETIRED_BROWSER_PHRASINGS: ReadonlyArray<{
  id: string;
  pattern: RegExp;
}> = [
  { id: "open-the-browser", pattern: /\b(?:Re)?[Oo]pen the browser\b(?! Job)/ },
  { id: "open-browser", pattern: /\b(?:Re|re)?[Oo]pen browser\b/ },
  { id: "search-browser", pattern: /\bSearch browser\b/i },
  { id: "dedicated-browser", pattern: /\bdedicated browser\b/i },
  { id: "managed-browser", pattern: /\bmanaged browser\b/i },
  { id: "browser-job-finder-uses", pattern: /\bbrowser Job Finder uses\b/i },
  { id: "bare-browser-opened", pattern: /"Browser (?:opened|refreshed)\./ },
];

/**
 * Deliberately empty, and it stays that way. An allowlist here would make this
 * guard green without making the product consistent, which is the exact
 * failure mode it exists to catch: the entries it briefly held were a
 * cross-package copy string that has since been converted, and a detection
 * regex that {@link stripScannedSource} now excludes structurally rather than
 * by name.
 */
const ALLOWED: ReadonlyArray<{
  file: string;
  phrasingId: string;
  reason: string;
}> = [];

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      return listSourceFiles(full);
    }

    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
      return [];
    }

    return [full];
  });
}

/**
 * Reduces a file to the text a user could read.
 *
 * Comments go first, so a docblock explaining why a name was retired is not
 * itself reported as that name; `://` is left alone so a URL inside a string
 * does not truncate the rest of its line. Regular-expression literals go next:
 * a matcher over the browser runtime's own failure wording has to spell that
 * wording, and it is never shown to anyone. A literal is only recognised where
 * a regex can legally start, so a division never eats the rest of a line.
 */
function stripScannedSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(
      /(^|[=(,:[!?&|+{};]|\breturn|\bcase)(\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuvy]*/g,
      "$1$2/…/",
    );
}

describe("Job Finder browser naming", () => {
  const violations: { file: string; phrasingId: string; line: string }[] = [];

  let scannedFileCount = 0;

  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root.directory)) {
      scannedFileCount += 1;

      const relative = `${root.id}/${path
        .relative(root.directory, file)
        .split(path.sep)
        .join("/")}`;
      const code = stripScannedSource(readFileSync(file, "utf8"));

      for (const line of code.split("\n")) {
        for (const phrasing of RETIRED_BROWSER_PHRASINGS) {
          if (
            phrasing.pattern.test(line) &&
            !ALLOWED.some(
              (allowed) =>
                allowed.file === relative && allowed.phrasingId === phrasing.id,
            )
          ) {
            violations.push({
              file: relative,
              phrasingId: phrasing.id,
              line: line.trim(),
            });
          }
        }
      }
    }
  }

  it("uses one name for the window in every place that names it", () => {
    expect(violations).toEqual([]);
  });

  it("enforces that with no exceptions", () => {
    // A retired phrasing is either converted or it fails. Nothing is excused.
    expect(ALLOWED).toEqual([]);
  });

  it("actually reads both places that name the window", () => {
    // A scan root that silently resolves to an empty directory would make
    // every assertion above vacuous.
    expect(scannedFileCount).toBeGreaterThan(100);

    for (const root of SCAN_ROOTS) {
      expect(listSourceFiles(root.directory).length).toBeGreaterThan(0);
    }
  });

  it("still reports a retired phrasing that is really there", () => {
    // Comment and regex stripping is what lets the allowlist be empty, so it
    // has to remove exactly those and nothing else.
    const openBrowser = RETIRED_BROWSER_PHRASINGS.find(
      (phrasing) => phrasing.id === "open-browser",
    );

    expect(openBrowser).toBeDefined();
    expect(
      openBrowser?.pattern.test(
        stripScannedSource('const label = "Open browser";'),
      ),
    ).toBe(true);
    expect(
      openBrowser?.pattern.test(
        stripScannedSource('// historical: this said "Open browser"'),
      ),
    ).toBe(false);
    expect(
      openBrowser?.pattern.test(
        stripScannedSource("const detect = /Open browser/i;"),
      ),
    ).toBe(false);
    // A division must not swallow the rest of the line and hide a real string.
    expect(
      openBrowser?.pattern.test(
        stripScannedSource(
          'const ratio = a / b; const label = "Open browser";',
        ),
      ),
    ).toBe(true);
  });

  it("derives every hand-off label from the one canonical name", () => {
    expect(JOB_FINDER_BROWSER_LABEL).toBe("Job Finder browser");
    expect(JOB_FINDER_BROWSER_NAME).toBe("the Job Finder browser");
    expect(JOB_FINDER_BROWSER_NAME_SENTENCE_START).toBe(
      "The Job Finder browser",
    );
    expect(OPEN_JOB_FINDER_BROWSER_ACTION).toBe("Open the Job Finder browser");
    expect(REOPEN_JOB_FINDER_BROWSER_ACTION).toBe(
      "Reopen the Job Finder browser",
    );
  });
});
