import { beforeEach, describe, expect, it } from "vitest";

import {
  describeRecentChange,
  getRecentChangeUndo,
  listRecentChanges,
  markRecentChangeUndone,
  recordRecentChange,
  resetRecentChangesForTest,
  RECENT_CHANGES_LIMIT,
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
    discoveryJobs: (input.findJobs ?? []).map((id) => ({ id })),
    dismissedDiscoveryJobs: (input.hidden ?? []).map((id) => ({ id })),
    reviewQueue: (input.shortlisted ?? []).map(([jobId, status]) => ({
      jobId,
      resumeReview: { status },
    })),
    applicationJobIds: new Set(input.applied ?? []),
  };
}

describe("recent changes", () => {
  beforeEach(() => resetRecentChangesForTest());

  it("keeps the newest 20 moves, newest first", () => {
    for (let index = 0; index < RECENT_CHANGES_LIMIT + 5; index += 1)
      recordRecentChange({
        kind: "hidden",
        jobIds: [`job_${index}`],
        label: `Job ${index}`,
      });
    const entries = listRecentChanges();
    expect(entries).toHaveLength(RECENT_CHANGES_LIMIT);
    expect(entries[0]!.jobIds).toEqual([`job_${RECENT_CHANGES_LIMIT + 4}`]);
  });

  it("a shortlist can be undone while the job waits in Shortlisted", () => {
    const change = recordRecentChange({
      kind: "shortlisted",
      jobIds: ["a", "b"],
      label: "A at Acme",
    });
    expect(
      getRecentChangeUndo(change, workspace({ shortlisted: [["a", "draft"]] })),
    ).toEqual({ possible: true, jobIds: ["a"] });
    expect(
      getRecentChangeUndo(
        change,
        workspace({
          shortlisted: [
            ["a", "draft"],
            ["b", "draft"],
          ],
          applied: ["a", "b"],
        }),
      ),
    ).toEqual({
      possible: false,
      reason: "In Applications now. Move it back from there.",
    });
    expect(
      getRecentChangeUndo(change, workspace({ findJobs: ["a", "b"] })),
    ).toMatchObject({ possible: false });
    expect(describeRecentChange(change)).toBe("Shortlisted 2 jobs");
  });

  it("an approval can be undone until an application uses the resume", () => {
    const change = recordRecentChange({
      kind: "approved",
      jobIds: ["a"],
      label: "A at Acme",
      restoreStatus: { a: "needs_review" },
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
    ).toEqual({
      possible: false,
      reason: "An application already uses this resume.",
    });
  });

  it("taking back the newest move marks it undone instead of adding a line", () => {
    const hide = recordRecentChange({
      kind: "hidden",
      jobIds: ["a"],
      label: "A at Acme",
    });
    const showAgain = recordRecentChange({
      kind: "shown_again",
      jobIds: ["a"],
      label: "A at Acme",
    });
    expect(listRecentChanges()).toHaveLength(1);
    expect(listRecentChanges()[0]).toMatchObject({ id: hide.id });
    expect(listRecentChanges()[0]!.undoneAt).toBeTruthy();
    // Undoing the Show again hides it again and revives the first line.
    markRecentChangeUndone(showAgain);
    expect(listRecentChanges()[0]!.undoneAt).toBeNull();
  });

  it("an undone move says so, and applications or queue moves give a reason", () => {
    const change = recordRecentChange({
      kind: "moved_to_find_jobs",
      jobIds: ["a"],
      label: "A at Acme",
    });
    markRecentChangeUndone(change);
    expect(getRecentChangeUndo(listRecentChanges()[0]!, workspace({}))).toEqual(
      { possible: false, reason: "Undone." },
    );
    const queue = recordRecentChange({
      kind: "taken_out_of_queue",
      jobIds: ["b"],
      label: "B at Beta",
    });
    expect(getRecentChangeUndo(queue, workspace({}))).toEqual({
      possible: false,
      reason: "Press Apply on the job to queue it again.",
    });
  });

  it("only a job's newest move offers Undo", () => {
    const older = recordRecentChange({
      kind: "moved_to_find_jobs",
      jobIds: ["a", "b"],
      label: "A at Acme",
    });
    recordRecentChange({ kind: "hidden", jobIds: ["b"], label: "B at Beta" });
    expect(
      getRecentChangeUndo(
        older,
        workspace({ findJobs: ["a"] }),
        listRecentChanges(),
      ),
    ).toEqual({ possible: false, reason: "Changed again since." });
  });
});
