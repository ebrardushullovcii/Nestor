import { beforeEach, describe, expect, it } from "vitest";

import {
  describeRecentChange,
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

});
