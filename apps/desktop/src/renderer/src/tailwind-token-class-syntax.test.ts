import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Tailwind v4's custom-property shorthand takes the property name directly:
 * `text-(--headline-primary)`, `sm:text-(length:--text-tiny)`. Wrapping it in
 * `var()` produces `var(var(--x))`, Tailwind emits no rule at all, and the
 * intended token silently never applies — invisible to rendered assertions
 * because the class string itself still looks plausible.
 *
 * This is a centralized negative guard over every production renderer source.
 * Positive token expectations stay with the components that own them.
 */
const rendererRoot = new URL("./", import.meta.url);

const NESTED_VAR_TOKEN_CLASS = /-\((?:[A-Za-z-]+:)?var\(--/;

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

describe("tailwind custom-property class syntax", () => {
  it("keeps renderer sources free of var()-wrapped custom-property classes", () => {
    const sources = collectProductionSources(rendererRoot);

    // The walk must really cover the renderer tree instead of passing vacuously.
    expect(
      sources.has("features/job-finder/components/job-finder-shell-brand.tsx"),
    ).toBe(true);
    expect(
      sources.has("features/live-assistant/live-assistant-page.tsx"),
    ).toBe(true);
    expect(sources.size).toBeGreaterThan(100);

    const offenders = [...sources.entries()]
      .filter(([, source]) => NESTED_VAR_TOKEN_CLASS.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("still recognizes the malformed form it guards against", () => {
    expect(NESTED_VAR_TOKEN_CLASS.test("text-(var(--headline-primary))")).toBe(
      true,
    );
    expect(
      NESTED_VAR_TOKEN_CLASS.test("sm:text-(length:var(--text-tiny))"),
    ).toBe(true);
    // The correct shorthand and the bracket escape hatch stay allowed.
    expect(NESTED_VAR_TOKEN_CLASS.test("text-(--headline-primary)")).toBe(
      false,
    );
    expect(NESTED_VAR_TOKEN_CLASS.test("text-[var(--headline-primary)]")).toBe(
      false,
    );
  });
});
