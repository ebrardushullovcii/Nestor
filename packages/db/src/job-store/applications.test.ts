import type {
  FoundJob,
  JobChange,
  RequestNeedsYouInput,
} from "@nestor/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import { openJobStore, type JobStore } from "./job-store";

const stores: JobStore[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function open(file = ":memory:") {
  const jobs = openJobStore(file);
  stores.push(jobs);
  const applications = createApplicationStore(jobs);
  return { jobs, applications };
}

function add(
  jobs: JobStore,
  count: number,
  stage: "resume" | "found" = "resume",
) {
  const rows = Array.from(
    { length: count },
    (_, i): FoundJob => ({
      title: `Engineer ${i}`,
      company: `Company ${i}`,
      location: "Remote",
      workModes: ["remote"],
      url: `https://jobs.example.test/${i}`,
      applyUrl: null,
      sourceId: "replica",
      sourceLabel: "Replica",
      sourceJobId: String(i),
      postedAt: null,
      salaryText: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      seniority: null,
      employmentType: null,
      summary: null,
      description: "Synthetic listing",
    }),
  );
  const { added } = jobs.saveFoundJobs({ searchId: "search", jobs: rows });
  jobs.setStage(added, stage);
  return added;
}

function question(
  applicationId: number,
  attempt: number,
  overrides: Partial<RequestNeedsYouInput> = {},
): RequestNeedsYouInput {
  return {
    applicationId,
    attempt,
    fieldKey: "sponsorship",
    kind: "question",
    key: "sponsorship",
    scope: { country: "US" },
    prompt: "Will you need visa sponsorship?",
    input: "boolean",
    options: [],
    ...overrides,
  };
}

describe("applications on the job store", () => {
  it("queues ids or the complete Approved filter once, skips unapproved jobs, and pages the queue", () => {
    const { jobs, applications } = open();
    const ids = add(jobs, 7);
    jobs.setStage([ids[0]!], "shortlisted");
    expect(
      applications.applyJobs({
        selection: { ids: [ids[0]!, ids[1]!, ids[1]!, 999] },
      }),
    ).toEqual({ queued: 1, unchanged: 0, notApproved: 2 });
    expect(
      applications.applyJobs({
        selection: {
          filter: { stage: "resume", text: "Engineer" },
          except: [ids[6]!],
        },
      }),
    ).toEqual({ queued: 4, unchanged: 1, notApproved: 0 });
    expect(() =>
      applications.applyJobs({ selection: { filter: { stage: "found" } } }),
    ).toThrow("Approved");
    const first = applications.listApplications({ state: "queued", limit: 2 });
    const next = applications.listApplications({
      state: "queued",
      limit: 2,
      cursor: first.nextCursor,
    });
    const last = applications.listApplications({
      state: "queued",
      limit: 2,
      cursor: next.nextCursor,
    });
    expect(
      new Set(
        [...first.rows, ...next.rows, ...last.rows].map((row) => row.jobId),
      ).size,
    ).toBe(5);
    expect(last.nextCursor).toBeNull();
    expect(() =>
      applications.listApplications({
        state: "stopped",
        cursor: first.nextCursor,
      }),
    ).toThrow("position");
  });

  it("stops a running application, retains its identity on retry, and rejects the old attempt's callback", () => {
    const { jobs, applications } = open();
    const ids = add(jobs, 1);
    applications.applyJobs({ selection: { ids } });
    const first = applications.claimNext()!;
    expect(applications.stop(first.id)).toBe(true);
    expect(applications.getApplication(first.id)?.state).toBe("stopped");
    expect(
      applications.applyJobs({ selection: { ids: [first.jobId] } }).queued,
    ).toBe(1);
    const retry = applications.claimNext()!;
    expect(retry).toMatchObject({ id: first.id, attempt: 2, state: "running" });
    expect(
      applications.finishPreparation({
        id: first.id,
        attempt: first.attempt,
        state: "ready",
      }),
    ).toBe(false);
    expect(
      applications.finishPreparation({
        id: retry.id,
        attempt: retry.attempt,
        state: "ready",
      }),
    ).toBe(true);
    expect(
      applications.applyJobs({ selection: { ids: [retry.jobId] } }).unchanged,
    ).toBe(1);
    jobs.setStage([retry.jobId], "shortlisted");
    expect(applications.getApplication(retry.id)?.state).toBe("stopped");
    expect(
      applications.applyJobs({ selection: { ids: [retry.jobId] } }).notApproved,
    ).toBe(1);
  });

  it("asks a shared question once, wakes every matching application, and remembers No only in its scope", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 4) } });
    const a = applications.claimNext()!;
    const b = applications.claimNext()!;
    const requested = applications.needsYou.request(question(a.id, a.attempt));
    expect(requested.status).toBe("needs_you");
    const same = applications.needsYou.request(
      question(b.id, b.attempt, { fieldKey: "visa", scope: { country: "us" } }),
    );
    expect(same).toEqual(requested);
    const taskId = applications.needsYou.list().rows[0]!.id;
    expect(
      applications.needsYou.answer({
        id: taskId,
        answer: "No",
        remember: true,
      }),
    ).toEqual({ resolved: true, queued: 2 });
    expect(applications.needsYou.list().rows).toEqual([]);
    const c = applications.claimNext()!;
    expect(applications.needsYou.request(question(c.id, c.attempt))).toEqual({
      status: "answered",
      answer: "No",
    });
    expect(() =>
      applications.needsYou.request(
        question(c.id, c.attempt, { input: "text" }),
      ),
    ).toThrow("answer format");
    expect(
      applications.needsYou.request(
        question(c.id, c.attempt, { scope: { country: "DE" } }),
      ).status,
    ).toBe("needs_you");
    expect(
      applications.needsYou.findAnswer("sponsorship", { country: "US" }),
    ).toBe("No");
    expect(() =>
      applications.needsYou.findAnswer("sponsorship", {
        country: "United States",
      }),
    ).toThrow("country code");
    expect(
      applications.needsYou.findAnswer("sponsorship", { country: "DE" }),
    ).toBeNull();
    expect(
      applications.needsYou.forgetAnswer("sponsorship", { country: "us" }),
    ).toBe(true);
    // Saving globally is optional; the original application's own answer persists.
    let resumed = applications.claimNext();
    while (resumed && resumed.id !== a.id) resumed = applications.claimNext();
    expect(resumed?.id).toBe(a.id);
    expect(
      applications.needsYou.request(question(resumed!.id, resumed!.attempt)),
    ).toEqual({ status: "answered", answer: "No" });
  });

  it("keeps new cards after existing cards, answers the named card, and waits for all questions before resuming", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 2) } });
    const a = applications.claimNext()!;
    const b = applications.claimNext()!;
    applications.needsYou.request(question(a.id, a.attempt));
    const first = applications.needsYou.list({ limit: 1 }).rows[0]!;
    applications.needsYou.request(
      question(a.id, a.attempt, {
        key: "start-date",
        fieldKey: "start",
        prompt: "When can you start?",
        input: "text",
      }),
    );
    applications.needsYou.request(
      question(b.id, b.attempt, { scope: { country: "DE" } }),
    );
    expect(applications.needsYou.list({ limit: 1 }).rows[0]).toEqual(first);
    expect(
      applications.needsYou.answer({
        id: first.id,
        answer: "No",
        remember: false,
      }).queued,
    ).toBe(0);
    expect(applications.getApplication(a.id)?.state).toBe("needs_you");
    expect(applications.getApplication(b.id)?.state).toBe("needs_you");
    const start = applications.needsYou
      .list()
      .rows.find((task) => task.key === "start-date")!;
    expect(
      applications.needsYou.answer({
        id: start.id,
        answer: "Next month",
        remember: false,
      }).queued,
    ).toBe(1);
    expect(applications.stop(b.id)).toBe(true);
    expect(applications.needsYou.list().rows).toEqual([]);
    expect(
      applications.needsYou.answer({
        id: first.id,
        answer: "Yes",
        remember: true,
      }).resolved,
    ).toBe(false);
    expect(
      applications.needsYou.findAnswer("sponsorship", { country: "US" }),
    ).toBeNull();
  });

  it("persists rows beside jobs and emits changes only after a committed transaction", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nestor-applications-"));
    folders.push(directory);
    const file = path.join(directory, "job-finder.sqlite");
    const { jobs, applications } = open(file);
    const ids = add(jobs, 1);
    const changes: JobChange[] = [];
    jobs.onChange((change) => changes.push(change));
    expect(() =>
      jobs.transaction(() => {
        applications.applyJobs({ selection: { ids } });
        expect(changes).toEqual([]);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(applications.listApplications().rows).toEqual([]);
    expect(changes).toEqual([]);
    applications.applyJobs({ selection: { ids } });
    expect(changes).toHaveLength(1);
    const app = applications.claimNext()!;
    applications.needsYou.request(question(app.id, app.attempt));
    jobs.close();
    const reopened = open(file);
    expect(reopened.applications.getApplication(app.id)?.state).toBe(
      "needs_you",
    );
    expect(reopened.applications.needsYou.list().rows).toHaveLength(1);
    expect(reopened.jobs.stageCounts().resume).toBe(1);
  });
});
