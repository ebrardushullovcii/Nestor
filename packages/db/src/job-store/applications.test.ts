import { SubmissionOutcomeRecordSchema } from "@nestor/contracts";
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
  it("binds confirmed receipts to one attempt and never requeues a confirmed or uncertain send", () => {
    const { jobs, applications } = open();
    const ids = add(jobs, 2);
    applications.applyJobs({ selection: { ids } });
    const first = applications.claimNext()!;
    const second = applications.claimNext()!;
    const at = new Date().toISOString();
    const receipt = SubmissionOutcomeRecordSchema.parse({
      id: "receipt",
      preflightId: "preflight",
      idempotencyKey: "send",
      authorityEnvelopeId: "permission",
      authorityRevision: 1,
      jobId: String(first.jobId),
      applicationRecordId: `application_${first.id}`,
      runId: `application_run_${first.id}`,
      resultId: `application_${first.id}_attempt_${first.attempt}`,
      outcome: "submitted",
      attemptedAt: at,
      verifiedAt: at,
      evidence: [
        {
          id: "employer",
          kind: "employer_site_state",
          observedAt: at,
          destination: {
            origin: "https://jobs.example.test",
            safePath: "/thanks",
          },
          artifactRefId: null,
          summary: "The employer confirmed receipt.",
        },
      ],
      retry: { eligible: false, blockReason: "submission_confirmed" },
    });
    expect(
      applications.recordSubmission(first.id, first.attempt, receipt),
    ).toBe(false);
    applications.beginSubmission(first.id, first.attempt);
    expect(() =>
      applications.recordSubmission(first.id, first.attempt, {
        ...receipt,
        resultId: "another_attempt",
      }),
    ).toThrow("another application attempt");
    expect(jobs.getJob(first.jobId)?.stage).toBe("resume");
    expect(
      applications.recordSubmission(first.id, first.attempt, receipt),
    ).toBe(true);
    expect(
      applications.recordSubmission(first.id, first.attempt, receipt),
    ).toBe(false);
    expect(jobs.getJob(first.jobId)?.stage).toBe("applied");
    applications.beginSubmission(second.id, second.attempt);
    applications.submissionUnknown(second.id, second.attempt);
    expect(applications.applyJobs({ selection: { ids } }).queued).toBe(0);
    expect(applications.stop(second.id)).toBe(false);
  });

  it("reads remembered answers only for the questions visible on the current form", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 2) } });
    const first = applications.claimNext()!;
    const second = applications.claimNext()!;
    const requested = applications.needsYou.request(
      question(first.id, first.attempt, { scope: {} }),
    );
    if (requested.status !== "needs_you") throw new Error("Missing question");
    applications.needsYou.answer({
      id: requested.task.id,
      answer: "No",
      remember: true,
    });
    expect(
      applications.needsYou
        .answersForQuestions(
          second.id,
          ["sponsorship"],
          "https://jobs.example.test",
        )
        .map((answer) => answer.answer),
    ).toEqual(["No"]);
    expect(
      applications.needsYou.answersForQuestions(
        second.id,
        ["different-question"],
        "https://jobs.example.test",
      ),
    ).toEqual([]);
  });

  it("retains the mode chosen at Apply and accepts a changed mode only on an explicit retry", () => {
    const { jobs, applications } = open();
    const ids = add(jobs, 1);
    applications.applyJobs({ selection: { ids } }, "confirm_before_submit");
    const original = applications.listApplications().rows[0]!;
    expect(original.mode).toBe("confirm_before_submit");
    expect(
      applications.applyJobs({ selection: { ids } }, "autonomous_submit")
        .queued,
    ).toBe(0);
    expect(applications.getApplication(original.id)?.mode).toBe(
      "confirm_before_submit",
    );
    applications.stop(original.id);
    expect(
      applications.applyJobs({ selection: { ids } }, "autonomous_submit")
        .queued,
    ).toBe(1);
    expect(applications.getApplication(original.id)?.mode).toBe(
      "autonomous_submit",
    );
  });
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
  it("keeps task drafts on their exact IDs and rejects out-of-order saves", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 2) } });
    const first = applications.claimNext()!;
    const second = applications.claimNext()!;
    const original = applications.needsYou.request(
      question(first.id, first.attempt),
    );
    const later = applications.needsYou.request(
      question(second.id, second.attempt, {
        key: "notice",
        fieldKey: "notice",
        prompt: "What is your notice period?",
        input: "text",
      }),
    );
    if (original.status !== "needs_you" || later.status !== "needs_you")
      throw new Error("Missing task");
    const memory = applications.needsYou;
    expect(
      memory.saveDraft({
        id: original.task.id,
        answer: "No",
        remember: true,
        revision: 0,
      }),
    ).toEqual({ saved: true, revision: 1 });
    expect(
      memory.saveDraft({
        id: original.task.id,
        answer: "Yes",
        remember: false,
        revision: 0,
      }),
    ).toEqual({ saved: false, revision: 1 });
    expect(memory.details(original.task.id)?.draft).toEqual({
      answer: "No",
      remember: true,
      revision: 1,
    });
    expect(memory.details(later.task.id)?.draft).toBeNull();
    expect(memory.list({ limit: 1 }).rows.map((task) => task.id)).toEqual([
      original.task.id,
    ]);
    expect(
      memory
        .list({ after: original.task.id, limit: 1 })
        .rows.map((task) => task.id),
    ).toEqual([later.task.id]);
    expect(memory.list({ text: "notice" }).rows.map((task) => task.id)).toEqual(
      [later.task.id],
    );
    expect(memory.counts().question).toBe(2);
    memory.answer({ id: original.task.id, answer: "No", remember: true });
    expect(memory.details(original.task.id)).toBeNull();
    expect(
      memory.saveDraft({
        id: original.task.id,
        answer: "Yes",
        remember: true,
        revision: 1,
      }).saved,
    ).toBe(false);
    expect(memory.counts()).toEqual({
      question: 1,
      sign_in: 0,
      captcha: 0,
      mfa: 0,
      saved: 1,
    });
  });

  it("pages, edits and forgets saved answers without changing a previous answer or another scope", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 2) } });
    const first = applications.claimNext()!;
    const second = applications.claimNext()!;
    const memory = applications.needsYou;
    for (const [application, country] of [
      [first, "US"],
      [second, "DE"],
    ] as const) {
      const request = memory.request(
        question(application.id, application.attempt, { scope: { country } }),
      );
      if (request.status !== "needs_you") throw new Error("Missing task");
      memory.answer({ id: request.task.id, answer: "No", remember: true });
    }
    const page = memory.listAnswers({ limit: 1 });
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBe(page.rows[0]!.id);
    const us = memory.savedAnswer(page.rows[0]!.id)!;
    expect(us.scope.country).toBe("US");
    expect(() => memory.saveAnswer({ id: us.id, answer: "Maybe" })).toThrow(
      "valid answer",
    );
    expect(memory.saveAnswer({ id: us.id, answer: "Yes" })).toBe(true);
    expect(memory.findAnswer("sponsorship", { country: "US" })).toBe("Yes");
    expect(memory.findAnswer("sponsorship", { country: "DE" })).toBe("No");
    expect(
      memory.listAnswers({ text: "Yes" }).rows.map((row) => row.id),
    ).toEqual([us.id]);
    expect(
      memory.forgetAnswers({
        filter: { text: "sponsorship" },
        except: [us.id],
      }),
    ).toBe(1);
    expect(memory.counts().saved).toBe(1);
    expect(memory.listAnswers({ after: us.id }).rows).toEqual([]);
    expect(memory.forgetAnswers({ ids: [us.id] })).toBe(1);
    expect(memory.counts().saved).toBe(0);
    expect(memory.listAnswers({ text: "Yes" }).total).toBe(0);
  });
});
