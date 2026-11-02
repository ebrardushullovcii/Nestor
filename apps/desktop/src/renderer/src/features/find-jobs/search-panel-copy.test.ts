import type { JobSearchStatus } from "@nestor/contracts";
import { JobSearchSettingsSchema } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { lastSearchLine } from "./search-panel";

function status(search: {
  added: number;
  merged: number;
  alreadySaved?: number;
}): JobSearchStatus {
  return {
    search: {
      id: "s1",
      state: "done",
      settings: JobSearchSettingsSchema.parse({}),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      sourcesTotal: 3,
      sourcesDone: 3,
      found: 10,
      scored: 0,
      error: null,
      ...search,
    },
    sources: [],
    progress: null,
    sourceRevision: 0,
  };
}

describe("the last search line", () => {
  it("makes counts and nouns agree", () => {
    expect(lastSearchLine(status({ added: 1, merged: 1 }))).toBe(
      "Last search today: 1 new job, 1 duplicate merged.",
    );
    expect(
      lastSearchLine(status({ added: 14, merged: 2, alreadySaved: 1 })),
    ).toBe(
      "Last search today: 14 new jobs, 2 duplicates merged, 1 already saved.",
    );
  });
});
