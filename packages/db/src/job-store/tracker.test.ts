import type { FoundJob } from "@nestor/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import { openJobStore, type JobStore } from "./job-store";
import { createTrackerStore } from "./tracker";

const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function job(n: number): FoundJob {
  return {
    title: `Data Engineer ${n}`,
    company: `Northfield ${n}`,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
    sourceJobId: String(n),
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: `Listing ${n}`,
  };
}

/** Approved jobs Apply has queued and then sent. */
function sent(count: number) {
  const store = openJobStore(":memory:");
  stores.push(store);
  const { added } = store.saveFoundJobs({
    searchId: null,
    jobs: Array.from({ length: count }, (_, i) => job(i + 1)),
  });
  store.setStage(added, "resume");
  createApplicationStore(store).applyJobs({ selection: { ids: added } });
  const tracker = createTrackerStore(store);
  const send = (ids: readonly number[]) =>
    store
      .sql(
        `UPDATE applications SET state = 'submitted', submitted_at = updated_at
       WHERE job_id IN (SELECT value FROM json_each(?))`,
      )
      .run(JSON.stringify(ids));
  return { store, tracker, ids: added, send };
}

describe("applications tracker", () => {
  it("tracks an application from Apply's queue to sent, and the job leaves Shortlisted", () => {
    const { store, tracker, ids, send } = sent(2);
    expect(tracker.counts().applying).toBe(2);
    expect(tracker.list().rows.map((row) => row.work)).toEqual([
      "queued",
      "queued",
    ]);

    send([ids[0]!]);
    const row = tracker.getRow(ids[0]!)!;
    expect(row.status).toBe("applied");
    expect(row.appliedAt).not.toBeNull();
    expect(row.work).toBeNull();
    expect(store.getJob(ids[0]!)?.stage).toBe("applied");
    expect(tracker.counts()).toMatchObject({ applying: 1, applied: 1 });
  });

  it("moves applications on with Undo and keeps the history", () => {
    const { tracker, ids, send } = sent(3);
    send(ids);
    const { changed, undoId } = tracker.setStatus(ids.slice(0, 2), "rejected");
    expect(changed).toBe(2);
    expect(tracker.counts()).toMatchObject({ applied: 1, rejected: 2 });
    expect(tracker.events(ids[0]!)[0]?.title).toBe("Rejected");

    tracker.undoStatus(undoId!);
    expect(tracker.counts()).toMatchObject({ applied: 3, rejected: 0 });
    expect(tracker.events(ids[0]!).some((e) => e.title === "Rejected")).toBe(
      false,
    );
  });

  it("logs replies and interviews, moving the status with them, and keeps the next one in front", () => {
    const { tracker, ids, send } = sent(1);
    send(ids);
    const id = ids[0]!;
    tracker.addEvent({
      jobId: id,
      kind: "reply",
      title: "Recruiter wrote back",
    });
    expect(tracker.getRow(id)?.status).toBe("replied");

    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const second = tracker.addEvent({
      jobId: id,
      kind: "interview",
      title: "Panel interview",
      dueAt: later,
    });
    tracker.addEvent({
      jobId: id,
      kind: "reminder",
      title: "Send portfolio",
      dueAt: soon,
    });
    const row = tracker.getRow(id)!;
    expect(row.status).toBe("interview");
    expect(row.nextTitle).toBe("Send portfolio");

    const reminder = tracker
      .events(id)
      .find((event) => event.title === "Send portfolio")!;
    tracker.updateEvent({ id: reminder.id, done: true });
    expect(tracker.getRow(id)?.nextTitle).toBe(second.title);
  });

  it("filters by status, tag, text, due follow-ups and quiet applications, a page at a time", () => {
    const { store, tracker, ids, send } = sent(5);
    send(ids);
    tracker.setStatus([ids[0]!], "interview");
    tracker.setTags([ids[1]!, ids[2]!], ["dream"], []);
    tracker.addEvent({
      jobId: ids[3]!,
      kind: "reminder",
      title: "Follow up",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    store
      .sql("UPDATE tracker SET status_at = ? WHERE job_id = ?")
      .run(Date.now() - 20 * 86_400_000, ids[4]!);

    expect(
      tracker.list({ statuses: ["interview"] }).rows.map((r) => r.id),
    ).toEqual([ids[0]]);
    expect(tracker.list({ tag: "dream" }).total).toBe(2);
    expect(tracker.list({ text: "Northfield 3" }).rows[0]?.id).toBe(ids[2]);
    expect(tracker.list({ due: true }).rows.map((r) => r.id)).toEqual([ids[3]]);
    expect(tracker.list({ quietForDays: 14 }).rows.map((r) => r.id)).toEqual([
      ids[4],
    ]);

    const first = tracker.list({ limit: 2 });
    const second = tracker.list({ limit: 2, cursor: first.nextCursor });
    const third = tracker.list({ limit: 2, cursor: second.nextCursor });
    const seen = [...first.rows, ...second.rows, ...third.rows].map(
      (r) => r.id,
    );
    expect(new Set(seen).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });
});
