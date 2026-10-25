import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PKG-05's adoption guard.
 *
 * `docs/PRODUCT.md` adopts one placement rule for floating surfaces — flip
 * above, shift inside, height from the space actually available, internal
 * scroll with edge hints — and `lib/bounded-floating-surface.ts` is the one
 * implementation of it. Three surfaces did not route through it: `Saved views`
 * re-derived the whole clamp with a `Math.max(160, …)` floor that could exceed
 * the space left (so it painted past the window bottom), `Columns` was an
 * unportalled `absolute` popover trapped inside an `overflow-hidden` section
 * with no max-height at all, and the Studio Assistant resolved its no-cover
 * set once into cached nodes watched by a `ResizeObserver`, which reports
 * size and not position.
 *
 * These are source scans on purpose. The behaviours they pin are ones a
 * rendering test cannot see failing: a second clamp with a different floor is
 * correct at every height a jsdom test picks, and a cached node set is only
 * wrong once something moves.
 */

const FEATURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RENDERER_ROOT = path.resolve(FEATURE_ROOT, "../..");

/** The one file allowed to own placement arithmetic. */
const SOLVER = "features/job-finder/lib/bounded-floating-surface.ts";
/** The one file allowed to own the subscriptions and the DOM registry. */
const SOLVER_HOOKS =
  "features/job-finder/components/bounded-floating-surface.tsx";

/**
 * Same convention PKG-03 and PKG-06 use: an entry that no longer violates its
 * rule must FAIL, so the list shrinks instead of rotting. Nothing may be added
 * to it — a new violation is a bug in the change that introduced it.
 */
const PENDING_ADOPTION: ReadonlyArray<{
  owner: string;
  path: string;
  reason: string;
  rule: "portal" | "viewport-max-height";
}> = [
  {
    owner: "PKG-04",
    path: "features/job-finder/components/task-center/job-finder-task-center.tsx",
    reason:
      "The Task center popover derives its own `max-h-[calc(100vh-…)]` instead of taking a solved height.",
    rule: "viewport-max-height",
  },
  {
    owner: "PKG-07",
    path: "features/job-finder/screens/discovery/discovery-activity-panel.tsx",
    reason:
      "The search-history dialog renders in place instead of through a portal.",
    rule: "portal",
  },
];

function collectSourceFiles(directory: string): string[] {
  const collected: string[] = [];

  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);

    if (statSync(absolute).isDirectory()) {
      collected.push(...collectSourceFiles(absolute));
      continue;
    }

    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
      continue;
    }

    collected.push(
      path.relative(RENDERER_ROOT, absolute).split(path.sep).join("/"),
    );
  }

  return collected.sort();
}

const SOURCE_FILES = collectSourceFiles(FEATURE_ROOT);

function readSource(relativePath: string): string {
  return readFileSync(path.join(RENDERER_ROOT, relativePath), "utf8");
}

function allowlistedFor(rule: "portal" | "viewport-max-height"): Set<string> {
  return new Set(
    PENDING_ADOPTION.filter((entry) => entry.rule === rule).map(
      (entry) => entry.path,
    ),
  );
}

/** A `maxHeight` (or `max-h-[…]`) derived from the window rather than solved. */
const VIEWPORT_MAX_HEIGHT_PATTERN =
  /maxHeight[^;\n]*(?:window\.innerHeight|100vh)|(?:window\.innerHeight|100vh)[^;\n]*maxHeight|max-h-\[[^\]]*100vh/;

/** A surface clamping its own solved height — the exact `Saved views` defect. */
const OWN_PLACEMENT_CLAMP_PATTERN =
  /maxHeight\s*[:=][^;\n]*Math\.(?:max|min)\(/;

/**
 * A dialog, or the unportalled dropdown shape `Columns` used: an `absolute`
 * surface hung off `top-full` inside layout it does not own.
 */
const DIALOG_SURFACE_PATTERN =
  /role=["']dialog["']|absolute\s+(?:right|left)-0\s+top-full/;
const PORTAL_PATTERN =
  /createPortal|from "@renderer\/components\/ui\/(popover|dialog)"/;

describe("floating surface adoption", () => {
  it("scans a non-trivial slice of the feature tree", () => {
    // A collector that silently found nothing would make every rule vacuous.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
    expect(SOURCE_FILES).toContain(SOLVER);
    expect(SOURCE_FILES).toContain(SOLVER_HOOKS);
  });

  it("lets only the solver derive a max height from the viewport", () => {
    const allowed = allowlistedFor("viewport-max-height");
    const violations = SOURCE_FILES.filter(
      (relativePath) =>
        relativePath !== SOLVER &&
        relativePath !== SOLVER_HOOKS &&
        !allowed.has(relativePath) &&
        VIEWPORT_MAX_HEIGHT_PATTERN.test(readSource(relativePath)),
    );

    expect(violations).toEqual([]);
  });

  it("lets only the solver clamp a floating surface's own height", () => {
    // `Saved views` read `Math.max(160, Math.min(384, space))`: the 160px floor
    // ignored the space actually available, so at short heights the surface
    // painted past the window bottom instead of scrolling inside itself.
    const violations = SOURCE_FILES.filter(
      (relativePath) =>
        relativePath !== SOLVER &&
        OWN_PLACEMENT_CLAMP_PATTERN.test(readSource(relativePath)),
    );

    expect(violations).toEqual([]);
  });

  it("renders every dialog surface through a portal", () => {
    // `Columns` was an `absolute` fieldset inside a section declared
    // `overflow-hidden`, so its host clipped it.
    const allowed = allowlistedFor("portal");
    const violations = SOURCE_FILES.filter((relativePath) => {
      if (allowed.has(relativePath)) {
        return false;
      }
      const source = readSource(relativePath);
      return (
        DIALOG_SURFACE_PATTERN.test(source) && !PORTAL_PATTERN.test(source)
      );
    });

    expect(violations).toEqual([]);
  });

  it("subscribes every solved surface to all three event sources", () => {
    const source = readSource(SOLVER_HOOKS);
    // Split at the dock registry so both subscription blocks are checked
    // rather than one block covering for the other.
    const [placementHalf, dockHalf] = source.split(
      "function subscribeToBottomRightDock",
    );

    for (const half of [placementHalf, dockHalf]) {
      expect(half).toBeDefined();
      expect(half).toMatch(/addEventListener\(\s*"resize"/);
      expect(half).toMatch(/addEventListener\(\s*"scroll"/);
      expect(half).toMatch(/visualViewport\?\.addEventListener\(\s*"resize"/);
      expect(half).toMatch(/visualViewport\?\.addEventListener\(\s*"scroll"/);
      // Capturing, or a scroll inside a pane never reaches the listener.
      expect(half).toMatch(/capture:\s*true|,\s*true\s*\)/);
    }
  });

  it("re-queries the dock's no-cover set on every pass instead of caching nodes", () => {
    const source = readSource(SOLVER_HOOKS);
    const [, reader] = source.split("function readBottomRightDockNoCoverRects");

    expect(reader).toBeDefined();
    // The query has to be inside the per-pass reader, not hoisted into an
    // effect that resolves nodes once: a `ResizeObserver` on a cached node
    // reports size, never position, so a row that moves never re-measures.
    expect(reader?.slice(0, 600)).toMatch(/querySelectorAll/);
    expect(source).not.toMatch(/const\s+cachedNoCover|noCoverNodesRef/);
  });

  /**
   * Action rows a bottom-right dock occupant does NOT have to clear, with the
   * reason. Every other `data-*-actions` row in the tree must be named by the
   * solver's constant — that is what keeps the set from silently shrinking
   * back to "just the two page-level markers".
   */
  const NOT_DOCK_CLEARANCE: ReadonlyArray<{
    attribute: string;
    reason: string;
  }> = [];

  it("names every `data-*-actions` row the dock has to clear", () => {
    // CSS has no attribute-name wildcard, so the set is a constant.
    const solverSource = readSource(SOLVER);
    const declared = new Set(
      [...solverSource.matchAll(/"(data-[a-z0-9-]*-actions)"/g)].map(
        (match) => match[1],
      ),
    );
    const excused = new Set(NOT_DOCK_CLEARANCE.map((entry) => entry.attribute));

    const used = new Set<string>();
    for (const relativePath of SOURCE_FILES) {
      if (relativePath === SOLVER) {
        continue;
      }
      // The negative lookahead stops a longer attribute from backtracking into
      // a match: `data-foo-actions-extra` is its own row, not `data-foo-actions`.
      for (const match of readSource(relativePath).matchAll(
        /data-[a-zA-Z0-9-]*?-actions(?![a-zA-Z0-9-])/g,
      )) {
        used.add(match[0]);
      }
    }

    expect(
      [...used].filter(
        (attribute) => !declared.has(attribute) && !excused.has(attribute),
      ),
    ).toEqual([]);
    expect(declared.size).toBeGreaterThan(2);
    // An excused row that no longer exists must be removed from the list.
    expect(
      NOT_DOCK_CLEARANCE.filter((entry) => !used.has(entry.attribute)),
    ).toEqual([]);
  });

  it("keeps every allowlisted file real, so the list shrinks instead of rotting", () => {
    const stale = PENDING_ADOPTION.filter((entry) => {
      const source = readSource(entry.path);
      return entry.rule === "viewport-max-height"
        ? !VIEWPORT_MAX_HEIGHT_PATTERN.test(source)
        : DIALOG_SURFACE_PATTERN.test(source) && PORTAL_PATTERN.test(source);
    });

    expect(stale).toEqual([]);
  });
});
