import { beforeEach, describe, expect, it } from "vitest";

import {
  getRecentChangeUndo,
  recordRecentChange,
  resetRecentChangesForTest,
  type RecentChangeWorkspace,
} from "./recent-changes";

function workspace(
  input: Partial<{
    findJobs: string[];
    hidden: string[];
    shortlisted: Array<[string, string]>;
    applied: string[];
  }>,
): RecentChangeWorkspace {
  return {
    applicationJobIds: new Set(input.applied ?? []),
  };
}

describe("recent changes", () => {
  beforeEach(() => resetRecentChangesForTest());

  it("a move back to Shortlisted undoes until the job is applied to again", () => {
    const change = recordRecentChange({
      kind: "moved_to_shortlisted",
      jobIds: ["a"],
      label: "A at Acme",
    });
    expect(
      getRecentChangeUndo(
        change,
        workspace({ shortlisted: [["a", "approved"]] }),
      ),
    ).toEqual({ possible: true, jobIds: ["a"] });
    expect(
      getRecentChangeUndo(
        change,
        workspace({ shortlisted: [["a", "approved"]], applied: ["a"] }),
      ),
    ).toEqual({ possible: false, reason: "In Applications again since." });
  });
});
