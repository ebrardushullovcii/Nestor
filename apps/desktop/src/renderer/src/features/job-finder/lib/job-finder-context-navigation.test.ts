import { describe, expect, it } from "vitest";
import {
  buildJobFinderContextRoute,
  clearJobFinderContextQuery,
  JOB_FINDER_CONTEXT_QUERY_KEYS,
  readJobFinderNavigationContext,
  selectJobFinderContext,
} from "./job-finder-context-navigation";

const entries = [{ id: "job-first" }, { id: "job-target" }] as const;

describe("job finder contextual navigation", () => {
  it("builds exact query routes while preserving unrelated query values", () => {
    expect(
      buildJobFinderContextRoute("/job-finder/discovery?view=compact", {
        jobId: "job/target",
        targetId: "target one",
      }),
    ).toBe(
      "/job-finder/discovery?view=compact&jobId=job%2Ftarget&targetId=target+one",
    );
    expect(
      buildJobFinderContextRoute("/job-finder/review-queue", {
        jobId: "job-target",
      }),
    ).toBe("/job-finder/review-queue?jobId=job-target");
  });

  it("reads encoded context and treats blank values as absent", () => {
    const context = readJobFinderNavigationContext(
      new URLSearchParams(
        "applicationRecordId= application-target &jobId=&targetId=target%2Fone",
      ),
    );

    expect(context).toEqual({
      applicationRecordId: "application-target",
      jobId: null,
      targetId: "target/one",
    });
  });

  it("prefers the requested item over an already selected item", () => {
    expect(
      selectJobFinderContext(
        entries,
        "job-target",
        "job-first",
        (entry) => entry.id,
      ),
    ).toEqual(entries[1]);
    expect(
      selectJobFinderContext(
        entries,
        "job-missing",
        "job-first",
        (entry) => entry.id,
      ),
    ).toBeNull();
    expect(
      selectJobFinderContext(entries, null, "job-first", (entry) => entry.id),
    ).toEqual(entries[0]);
  });

  it("clears only the requested context key", () => {
    const next = clearJobFinderContextQuery(
      new URLSearchParams("jobId=job-target&targetId=target-1"),
      JOB_FINDER_CONTEXT_QUERY_KEYS.jobId,
    );

    expect(next.toString()).toBe("targetId=target-1");
  });

});
