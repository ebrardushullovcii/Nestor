import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Centralized negative guard for the field token migration: legacy
// `border-input` field chrome must never appear in Job Finder production
// renderer sources. Migrated controls stay covered per screen by rendered
// assertions on the canonical `--field-*` token recipe and focus hierarchy;
// this guard only rules out regressing to the legacy class anywhere in the
// feature tree.
const featureRoot = new URL("./", import.meta.url);

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

describe("job finder field chrome", () => {
  it("keeps production sources free of legacy border-input chrome", () => {
    const sources = collectProductionSources(featureRoot);

    // The walk must really scan the feature tree instead of passing vacuously.
    expect(sources.has("screens/profile-screen.tsx")).toBe(true);

    const offenders = [...sources.entries()]
      .filter(([, source]) => source.includes("border-input"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
