import type { FoundJob } from "@nestor/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import { createHomeStore } from "./home";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "./job-store";
import { createTrackerStore } from "./tracker";

const DAY = 86_400_000;
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

/** Five approved jobs: three sent (today, yesterday, 40 days ago), two not. */
function workspace(now: number) {
  const store = openJobStore(":memory:");
  stores.push(store);
  const { added } = store.saveFoundJobs({
    searchId: null,
    jobs: [1, 2, 3, 4, 5, 6].map(job),
  });
  const approved = added.slice(0, 5);
  approveOriginalResumesForTests(store, approved);
  createApplicationStore(store).applyJobs({
    selection: { ids: approved.slice(0, 4) },
  });
  const send = (id: number, at: number) =>
    store
      .sql(
        `UPDATE applications SET state = 'submitted', submitted_at = ?, updated_at = ? WHERE job_id = ?`,
      )
      .run(at, at, id);
  send(approved[0]!, now);
  send(approved[1]!, now - DAY);
  send(approved[2]!, now - 40 * DAY);
  return { store, ids: added, tracker: createTrackerStore(store) };
}

describe("Home summary", () => {
  it("counts sends and replies per local day, and what is left to do", () => {
    const now = Date.UTC(2026, 9, 25, 12);
    const { store, ids, tracker } = workspace(now);
    tracker.addEvent({
      jobId: ids[1]!,
      kind: "reply",
      title: "Recruiter wrote",
    });

    store.sql("UPDATE jobs SET found_at = ? WHERE id = ?").run(now, ids[5]!);
    const home = createHomeStore(store).summary({ utcOffsetMinutes: 60 }, now);

    expect(home.days).toHaveLength(28);
    expect(home.days.at(-1)).toMatchObject({ day: "2026-10-25", sent: 1 });
    expect(home.days.at(-2)).toMatchObject({ day: "2026-10-24", sent: 1 });
    expect(home.days.reduce((sum, day) => sum + day.sent, 0)).toBe(2);
    expect(home.recent).toMatchObject({ applied: 1, replied: 1 });
    expect(home.tracker).toMatchObject({ applying: 1, applied: 2, replied: 1 });
    expect(home.readyToApply).toBe(1);
    expect(home.applyWorking).toBe(1);
    expect(home.jobs.found).toBe(1);
    expect(home.foundToday).toBe(1);
  });

  it("counts only unfinished applications as Apply's work", () => {
    const now = Date.now();
    const { store } = workspace(now);
    const home = createHomeStore(store);
    expect(home.summary({ utcOffsetMinutes: 0 }, now).applyWorking).toBe(1);
    // Stopped and failed work is over, though the job is still being applied to.
    store
      .sql(`UPDATE applications SET state = 'stopped' WHERE state = 'queued'`)
      .run();
    expect(home.summary({ utcOffsetMinutes: 0 }, now).applyWorking).toBe(0);
    store
      .sql(`UPDATE applications SET state = 'failed' WHERE state = 'stopped'`)
      .run();
    expect(home.summary({ utcOffsetMinutes: 0 }, now).applyWorking).toBe(0);
  });

  it("lists interviews first, then due and upcoming reminders, soonest first", () => {
    const now = Date.now();
    const { store, ids, tracker } = workspace(now);
    tracker.addEvent({
      jobId: ids[0]!,
      kind: "interview",
      title: "Panel",
      dueAt: new Date(now + 2 * DAY).toISOString(),
      place: "https://meet.example.test/x",
    });
    tracker.addEvent({
      jobId: ids[1]!,
      kind: "reminder",
      title: "Follow up",
      dueAt: new Date(now - DAY).toISOString(),
    });
    tracker.addEvent({
      jobId: ids[2]!,
      kind: "reminder",
      title: "Much later",
      dueAt: new Date(now + 20 * DAY).toISOString(),
    });

    const home = createHomeStore(store).summary({ utcOffsetMinutes: 0 }, now);

    expect(home.followUpsDue).toBe(1);
    expect(home.upcoming.map((item) => [item.kind, item.what])).toEqual([
      ["interview", "Panel"],
      ["reminder", "Follow up"],
    ]);
    expect(home.upcoming[0]?.place).toBe("https://meet.example.test/x");
  });

  it("counts this week's interviews even behind an earlier reminder on the same job", () => {
    const now = Date.now();
    const { store, ids, tracker } = workspace(now);
    tracker.addEvent({
      jobId: ids[0]!,
      kind: "reminder",
      title: "Send references",
      dueAt: new Date(now - 60_000).toISOString(),
    });
    tracker.addEvent({
      jobId: ids[0]!,
      kind: "interview",
      title: "Hiring manager call",
      dueAt: new Date(now + 3 * 3_600_000).toISOString(),
    });

    const home = createHomeStore(store).summary({ utcOffsetMinutes: 0 }, now);

    expect(home.interviewsThisWeek).toBe(1);
    expect(home.upcoming.map((item) => item.what)).toEqual([
      "Hiring manager call",
      "Send references",
    ]);
  });

  it("keeps questions for applications apart from site sign-ins", () => {
    const now = Date.now();
    const { store } = workspace(now);
    const open = store.sql(
      `INSERT INTO needs_you (kind, answer_key, country, site_origin, prompt, input, options_json, opened_at)
       VALUES (?, ?, '', ?, 'Synthetic', 'text', '[]', ?)`,
    );
    open.run("question", "notice", "https://jobs.example.test", now);
    for (const site of ["a", "b", "c"])
      open.run("sign_in", "account", `https://${site}.example.test`, now);

    const home = createHomeStore(store).summary({ utcOffsetMinutes: 0 }, now);

    expect(home.needsYou).toEqual({ questions: 1, signIns: 3, checks: 0 });
  });
});
