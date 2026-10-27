import type { FoundJob } from "@nestor/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "./job-store";
import { createTrackerStore, trackerPageSql } from "./tracker";

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
  approveOriginalResumesForTests(store, added);
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

    tracker.undoChange(undoId!);
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
  it("undoes each status and note independently, preserving a later status and edited note", () => {
    const { tracker, ids, send } = sent(1);
    send(ids);
    const id = ids[0]!;
    const first = tracker.setStatus([id], "rejected");
    const note = tracker.addEvent({
      jobId: id,
      kind: "note",
      title: "Recruiter asked for samples",
    });
    tracker.setStatus([id], "offer");
    const oldStatus = tracker.undoChange(first.undoId!);
    expect(oldStatus.skipped).toBe(1);
    expect(tracker.getRow(id)?.status).toBe("offer");
    tracker.updateEvent({ id: note.id, title: "Samples sent" });
    expect(tracker.undoChange(note.undoId!).changed).toBe(0);
    expect(tracker.events(id).find((e) => e.id === note.id)?.title).toBe(
      "Samples sent",
    );
    const second = tracker.addEvent({
      jobId: id,
      kind: "note",
      title: "Asked about start date",
    });
    tracker.undoChange(second.undoId!);
    expect(tracker.events(id).map((e) => e.id)).not.toContain(second.id);
  });

  it("restores a deleted interview, next date and agenda, and undoes its automatic status", () => {
    const { tracker, ids, send } = sent(1);
    send(ids);
    const id = ids[0]!;
    const interview = tracker.addEvent({
      jobId: id,
      kind: "interview",
      title: "Phone interview",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(tracker.getRow(id)?.status).toBe("interview");
    const deleted = tracker.deleteEvent(interview.id);
    expect(tracker.agenda(14, 40)).toEqual([]);
    tracker.undoChange(deleted.undoId!);
    expect(tracker.getRow(id)?.nextTitle).toBe(interview.title);
    expect(tracker.agenda(14, 40)[0]?.event.id).toBe(interview.id);
    tracker.undoChange(interview.undoId!);
    expect(tracker.getRow(id)).toMatchObject({
      status: "applied",
      nextAt: null,
    });
  });

  it("undoes tags and saved views without removing later tags or overwriting a reused view name", () => {
    const { tracker, ids, send } = sent(1);
    send(ids);
    const tags = tracker.setTags(ids, ["priority"], []);
    tracker.setTags(ids, ["remote"], []);
    tracker.undoChange(tags.undoId!);
    expect(tracker.getRow(ids[0]!)?.tags).toEqual(["remote"]);
    const view = tracker.saveView(
      "Interviews",
      {
        statuses: ["interview"],
        tag: null,
        text: "",
        due: false,
        quietForDays: null,
      },
      "next",
    );
    const deleted = tracker.deleteView(view.id);
    const replacement = tracker.saveView(
      "Interviews",
      { ...view.filter, statuses: ["offer"] },
      "recent",
    );
    expect(tracker.undoChange(deleted.undoId!)).toMatchObject({
      changed: 0,
      skipped: 1,
    });
    expect(tracker.views().views[0]?.id).toBe(replacement.id);
  });
  it("moves the whole filtered selection beyond one page, except unticked applications", () => {
    const { tracker, ids, send } = sent(205);
    send(ids);
    const selected = tracker.selectedIds({
      filter: { statuses: ["applied"] },
      except: [ids[0]!],
    });
    const result = tracker.setStatus(selected, "replied");
    expect(result.changed).toBe(204);
    expect(tracker.counts()).toMatchObject({ applied: 1, replied: 204 });
    tracker.undoChange(result.undoId!);
    expect(tracker.counts().applied).toBe(205);
  });

  it("reads every sort's page in index order, without sorting the rows", () => {
    const { store } = sent(1);
    const plan = (sql: string, ...params: (string | number)[]) =>
      (
        store.sql(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
          detail: string;
        }[]
      )
        .map((row) => row.detail)
        .join("\n");
    for (const sort of ["recent", "applied", "next"] as const) {
      const all = plan(trackerPageSql(sort, "1"), 51);
      const one = plan(trackerPageSql(sort, "t.status IN (?)"), "applied", 51);
      expect(all, sort).toMatch(/SCAN t USING (COVERING )?INDEX tracker_by_/);
      expect(one, sort).toMatch(/SEARCH t USING (COVERING )?INDEX tracker_by_/);
      for (const detail of [all, one])
        expect(detail, sort).not.toContain("TEMP B-TREE");
    }
  });
});
