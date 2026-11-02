import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Tailwind v4 emits arbitrary media variants (`min-[900px]:`, `max-[899px]:`)
 * BEFORE the named breakpoints (`sm: md: lg: xl: 2xl:`) in the stylesheet. So
 * when one element carries an arbitrary variant AND a named-breakpoint utility
 * for the SAME CSS property, and both media queries match at a given width,
 * the NAMED breakpoint wins on source order at equal specificity — regardless
 * of which band is narrower or which one the author meant to refine.
 *
 * That is invisible to a `toContain("min-[900px]:pr-0")` assertion, because
 * the class really is on the element. It shipped three times: the header
 * reserved `sm:pr-64` at every compact width behind `min-[900px]:pr-0` (the
 * compact nav card sat 127px off axis), wide-band reveals cleared
 * `sm:scroll-mt-[8.25rem]` = 132px behind `min-[1440px]:scroll-mt-[4.5rem]`,
 * and locked routes kept the 12px `sm:px-3` gutter behind
 * `min-[1440px]:px-4`.
 *
 * `!` is the fix: it reverses the order for that one declaration.
 *
 * This file owns two guards:
 *   1. a model of the emission order, so the winning utility can be resolved
 *      the way the browser resolves it rather than asserted by presence;
 *   2. a centralized negative scan of every production renderer class literal,
 *      so a reintroduced plain arbitrary variant fails here instead of
 *      shipping.
 *
 * An unprefixed base utility is NOT a conflict: Tailwind emits it before every
 * variant of the same utility, so any variant already beats it.
 */
const rendererRoot = new URL("./", import.meta.url);

const NAMED_BREAKPOINT_MIN_WIDTH: Readonly<Record<string, number>> = {
  "2xl": 1536,
  lg: 1024,
  md: 768,
  sm: 640,
  xl: 1280,
};

const EMISSION_RANK_BASE = 0;
const EMISSION_RANK_ARBITRARY_MEDIA = 1;
const EMISSION_RANK_NAMED_BREAKPOINT = 2;

const DISPLAY_UTILITIES = new Set([
  "block",
  "contents",
  "flex",
  "grid",
  "hidden",
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "table",
]);

interface ParsedClass {
  important: boolean;
  /** Property group two utilities must share before they can conflict. */
  group: string;
  /** null for an unprefixed base utility. */
  variant: string | null;
  utility: string;
  token: string;
}

/**
 * Split a class token on its variant separators while ignoring the colons
 * inside arbitrary values (`text-(length:--text-tiny)`,
 * `[&::-webkit-scrollbar]:hidden`, `min-h-[calc(...)]`).
 */
function splitVariants(token: string): { utility: string; variants: string[] } {
  const variants: string[] = [];
  let depth = 0;
  let segmentStart = 0;

  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[" || character === "(") {
      depth += 1;
    } else if (character === "]" || character === ")") {
      depth -= 1;
    } else if (character === ":" && depth === 0) {
      variants.push(token.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }

  return { utility: token.slice(segmentStart), variants };
}

/**
 * The group is the utility root: `pr-64` -> `pr`, `scroll-mt-[4.5rem]` ->
 * `scroll-mt`, `grid-rows-[3.5rem]` -> `grid-rows`. Display keywords carry no
 * value segment, so they share one explicit group. Anything whose last segment
 * does not read as a value is left ungrouped, which keeps the scan
 * conservative rather than inventing conflicts.
 */
function resolveGroup(utility: string): string | null {
  if (DISPLAY_UTILITIES.has(utility)) {
    return "display";
  }

  const separator = utility.lastIndexOf("-");
  if (separator <= 0) {
    return null;
  }

  const value = utility.slice(separator + 1);
  const looksLikeValue =
    /^[[(]/.test(value) ||
    /^\d/.test(value) ||
    ["auto", "fit", "full", "max", "min", "none", "px"].includes(value);

  return looksLikeValue ? utility.slice(0, separator) : null;
}

function parseClass(token: string): ParsedClass | null {
  const { utility: rawUtility, variants } = splitVariants(token);
  // Only single media variants participate: a `hover:`/`dark:`/`group-*`
  // stack is a different cascade question and is deliberately out of scope.
  if (variants.length > 1) {
    return null;
  }

  const important = rawUtility.startsWith("!");
  const utility = important ? rawUtility.slice(1) : rawUtility;
  const group = resolveGroup(utility);
  if (group === null) {
    return null;
  }

  const variant = variants[0] ?? null;
  if (variant !== null) {
    const isMediaVariant =
      variant in NAMED_BREAKPOINT_MIN_WIDTH ||
      /^(?:min|max)-\[\d+px\]$/.test(variant);
    if (!isMediaVariant) {
      return null;
    }
  }

  return { group, important, token, utility, variant };
}

function matchesWidth(variant: string | null, widthPx: number): boolean {
  if (variant === null) {
    return true;
  }

  const min = /^min-\[(\d+)px\]$/.exec(variant);
  if (min) {
    return widthPx >= Number(min[1]);
  }

  const max = /^max-\[(\d+)px\]$/.exec(variant);
  if (max) {
    return widthPx <= Number(max[1]);
  }

  const named = NAMED_BREAKPOINT_MIN_WIDTH[variant];
  return named !== undefined && widthPx >= named;
}

function emissionRank(variant: string | null): number {
  if (variant === null) {
    return EMISSION_RANK_BASE;
  }
  return variant in NAMED_BREAKPOINT_MIN_WIDTH
    ? EMISSION_RANK_NAMED_BREAKPOINT
    : EMISSION_RANK_ARBITRARY_MEDIA;
}

/**
 * Resolve which utility of `group` actually applies at `widthPx`, the way the
 * browser resolves it: drop the non-matching media queries, then take the last
 * emitted declaration, with `!important` beating every non-important one.
 */
export function resolveWinningUtility(
  className: string,
  group: string,
  widthPx: number,
): string | null {
  let winner: ParsedClass | null = null;

  for (const token of className.split(/\s+/).filter(Boolean)) {
    const parsed = parseClass(token);
    if (
      parsed === null ||
      parsed.group !== group ||
      !matchesWidth(parsed.variant, widthPx)
    ) {
      continue;
    }

    const beats =
      winner === null ||
      (parsed.important && !winner.important) ||
      (parsed.important === winner.important &&
        emissionRank(parsed.variant) >= emissionRank(winner.variant));

    if (beats) {
      winner = parsed;
    }
  }

  return winner?.utility ?? null;
}

/**
 * A conflict is an arbitrary media variant that is nested inside a still
 * matching named breakpoint on the same property and is not important:
 * `min-[N]` or `max-[N]` with `N >= <named breakpoint min>` overlaps that
 * named band, and inside the overlap the named utility wins. A `min-[N]`
 * BELOW the named minimum is not a conflict — there the named breakpoint is
 * the later, narrower refinement and winning is the intended cascade.
 */
export function findVariantOrderConflicts(className: string): string[] {
  const parsed = className
    .split(/\s+/)
    .filter(Boolean)
    .map(parseClass)
    .filter((entry): entry is ParsedClass => entry !== null);

  const conflicts: string[] = [];

  for (const arbitrary of parsed) {
    if (
      arbitrary.variant === null ||
      emissionRank(arbitrary.variant) !== EMISSION_RANK_ARBITRARY_MEDIA ||
      arbitrary.important
    ) {
      continue;
    }

    const bound = Number(/\[(\d+)px\]$/.exec(arbitrary.variant)?.[1]);

    for (const named of parsed) {
      if (
        named.variant === null ||
        emissionRank(named.variant) !== EMISSION_RANK_NAMED_BREAKPOINT ||
        named.group !== arbitrary.group
      ) {
        continue;
      }

      const namedMin = NAMED_BREAKPOINT_MIN_WIDTH[named.variant];
      if (namedMin !== undefined && bound >= namedMin) {
        conflicts.push(`${arbitrary.token} loses to ${named.token}`);
      }
    }
  }

  return conflicts;
}

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

/** Every double-quoted single-line literal that carries a media variant. */
function collectClassLiterals(source: string): string[] {
  const quoted = source.match(/"[^"\n]*"/g) ?? [];
  // Template class strings count too: an interpolated `${...}` is replaced by
  // whitespace, so hand-written tokens beside it are still checked. Tokens
  // that arrive only through a shared constant cannot be resolved here; those
  // constants carry their own exact-token assertions (see
  // `job-finder-scroll-reveal.test.ts`).
  const templated = (source.match(/`[^`\n]*`/g) ?? []).map((literal) =>
    literal.replace(/\$\{[^}]*\}/g, " "),
  );

  return [...quoted, ...templated]
    .map((literal) => literal.slice(1, -1))
    .filter((literal) => /(?:min|max)-\[\d+px\]:/.test(literal));
}

describe("tailwind arbitrary-variant emission order", () => {
  it("resolves the header reserve the way the stylesheet does", () => {
    const shipped =
      "col-span-2 flex justify-center sm:pr-64 max-[899px]:!pr-40 min-[900px]:!pr-0";

    expect(resolveWinningUtility(shipped, "pr", 1280)).toBe("pr-0");
    expect(resolveWinningUtility(shipped, "pr", 1024)).toBe("pr-0");
    expect(resolveWinningUtility(shipped, "pr", 800)).toBe("pr-40");
    expect(resolveWinningUtility(shipped, "pr", 500)).toBe("pr-40");

    // The exact shape that shipped the 127px offset: without importance the
    // still-matching `sm:pr-64` is emitted later and wins at >=900px, and
    // `max-[899px]:pr-40` loses through the whole 640-899 band.
    const beforeTheFix =
      "col-span-2 flex justify-center sm:pr-64 max-[899px]:pr-40 min-[900px]:pr-0";
    expect(resolveWinningUtility(beforeTheFix, "pr", 1280)).toBe("pr-64");
    expect(resolveWinningUtility(beforeTheFix, "pr", 800)).toBe("pr-64");
    expect(findVariantOrderConflicts(beforeTheFix)).toEqual([
      "max-[899px]:pr-40 loses to sm:pr-64",
      "min-[900px]:pr-0 loses to sm:pr-64",
    ]);
    expect(findVariantOrderConflicts(shipped)).toEqual([]);
  });

  it("resolves the wide reveal margin and the locked-route gutter", () => {
    const reveal =
      "scroll-mt-4 sm:scroll-mt-[8.25rem] min-[1440px]:!scroll-mt-[4.5rem]";
    expect(resolveWinningUtility(reveal, "scroll-mt", 1440)).toBe(
      "scroll-mt-[4.5rem]",
    );
    expect(resolveWinningUtility(reveal, "scroll-mt", 900)).toBe(
      "scroll-mt-[8.25rem]",
    );
    expect(
      resolveWinningUtility(
        "scroll-mt-4 sm:scroll-mt-[8.25rem] min-[1440px]:scroll-mt-[4.5rem]",
        "scroll-mt",
        1440,
      ),
    ).toBe("scroll-mt-[8.25rem]");

    const locked = "overflow-hidden px-2 pb-3 pt-0 sm:px-3 min-[1440px]:!px-4";
    expect(resolveWinningUtility(locked, "px", 1440)).toBe("px-4");
    expect(resolveWinningUtility(locked, "px", 900)).toBe("px-3");
    expect(
      resolveWinningUtility(
        "overflow-hidden px-2 pb-3 pt-0 sm:px-3 min-[1440px]:px-4",
        "px",
        1440,
      ),
    ).toBe("px-3");
  });

  it("treats an unprefixed base and a non-overlapping band as no conflict", () => {
    // The scrolling route branch: the narrow value is the base utility, which
    // Tailwind emits before every variant, so the arbitrary variant wins.
    const scrolling = "screen-scroll-area px-3 min-[1440px]:px-4";
    expect(resolveWinningUtility(scrolling, "px", 1440)).toBe("px-4");
    expect(findVariantOrderConflicts(scrolling)).toEqual([]);

    // Different property, and 0-639 never overlaps sm.
    expect(
      findVariantOrderConflicts("max-[639px]:hidden sm:text-[2rem]"),
    ).toEqual([]);

    // A named breakpoint ABOVE the arbitrary band is the intended refinement.
    expect(findVariantOrderConflicts("min-[900px]:pr-80 xl:pr-0")).toEqual([]);
  });

  it("keeps every production renderer class literal free of the conflict", () => {
    const sources = collectProductionSources(rendererRoot);

    // The walk must really cover the renderer tree instead of passing
    // vacuously, and must reach the files that own the known instances.
    expect(
      sources.has("features/job-finder/components/job-finder-shell.tsx"),
    ).toBe(true);
    expect(
      sources.has("features/job-finder/lib/job-finder-scroll-reveal.ts"),
    ).toBe(true);
    expect(sources.size).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const [path, source] of sources) {
      for (const literal of collectClassLiterals(source)) {
        for (const conflict of findVariantOrderConflicts(literal)) {
          offenders.push(`${path}: ${conflict}`);
        }
      }
    }

    // One audited exception, deliberate: the header's `max-[899px]:pr-40`
    // does lose to `sm:pr-64` through the 640-899 band, but that band is below
    // the 1024px minimum supported width and
    // `job-finder-shell.navigation.test.tsx` explicitly pins it ("leaves the
    // sub-900px reserve exactly as it was"). Marking it important would change
    // rendering there for no supported-width gain, so it stays inert on
    // purpose.
    //
    // Everything else must be empty, so a NEW occurrence still fails here.
    const AUDITED_EXCEPTIONS: string[] = [];

    const unowned = offenders.filter(
      (offender) => !AUDITED_EXCEPTIONS.includes(offender),
    );
    expect(unowned).toEqual([]);
    // The exceptions must stay reachable: a stale entry would silently widen
    // the carve-out for whatever lands in those files next.
    for (const exception of AUDITED_EXCEPTIONS) {
      expect(offenders).toContain(exception);
    }
  });
});
