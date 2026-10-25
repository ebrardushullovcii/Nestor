import { describe, expect, it } from "vitest";
import type {
  JobFinderJobDetail,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { patchFindJobsLists } from "./workspace-view-refresh";

type Row = JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number];
const row = (id: string, extra: Partial<Row> = {}) =>
  ({
    id,
    title: `Role ${id}`,
    status: "discovered",
    listingActivity: { status: "active" },
    ...extra,
  }) as unknown as Row;
const detail = (id: string, extra: Record<string, unknown>) =>
  ({
    job: { id, title: `Role ${id}`, ...extra },
    planId: "plan",
  }) as unknown as JobFinderJobDetail;
const feedback = { version: 1, revision: 1, reasons: ["company"] };

describe("patching the Find jobs lists from the change feed", () => {
  const current = {
    discoveryJobs: [row("a"), row("b")],
    dismissedDiscoveryJobs: [
      row("h", { status: "archived", discoveryFeedback: feedback } as never),
    ],
    companyJobs: [row("a")],
  };

  it("takes a changed job's record and keeps its listed row's projection", () => {
    const lists = patchFindJobsLists({
      current,
      curated: [],
      jobIds: ["a"],
      details: [detail("a", { status: "shortlisted", title: "Renamed" })],
    });
    expect(lists.complete).toBe(true);
    expect(lists.discoveryJobs[0]).toMatchObject({
      id: "a",
      title: "Renamed",
      status: "shortlisted",
      listingActivity: { status: "active" },
    });
    expect(lists.companyJobs[0]).toMatchObject({ title: "Renamed" });
  });

  it("moves a hidden job to Hidden and a restored one back", () => {
    const hidden = patchFindJobsLists({
      current,
      curated: [],
      jobIds: ["b", "h"],
      details: [
        detail("b", { status: "archived", discoveryFeedback: feedback }),
        detail("h", { status: "discovered", discoveryFeedback: null }),
      ],
    });
    expect(hidden.discoveryJobs.map((job) => job.id)).toEqual(["a", "h"]);
    expect(hidden.dismissedDiscoveryJobs.map((job) => job.id)).toEqual(["b"]);
  });

  it("drops a deleted job and leaves unread ones as they were", () => {
    const lists = patchFindJobsLists({
      current,
      curated: [],
      jobIds: ["a", "b"],
      details: [null, undefined],
    });
    expect(lists.discoveryJobs.map((job) => job.id)).toEqual(["b"]);
  });

  it("says the lists fell behind when a job new to them appears", () => {
    const lists = patchFindJobsLists({
      current,
      curated: [],
      jobIds: ["new"],
      details: [detail("new", { status: "discovered" })],
    });
    expect(lists.complete).toBe(false);
    expect(lists.discoveryJobs.map((job) => job.id)).toEqual(["a", "b"]);
  });

  it("prefers the first view's own row for a job past Find jobs", () => {
    const curatedRow = row("a", { status: "approved", title: "From view" });
    const lists = patchFindJobsLists({
      current,
      curated: [curatedRow],
      jobIds: [],
      details: [],
    });
    expect(lists.discoveryJobs[0]).toBe(curatedRow);
  });
});
