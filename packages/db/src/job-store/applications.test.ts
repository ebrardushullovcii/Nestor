import reviewFixture from "./stored-json/application-review-card.full.json";
import { SubmissionOutcomeRecordSchema } from "@nestor/contracts";
import meanings from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/saved-question-meanings.json";
import type {
  FoundJob,
  JobChange,
  RequestNeedsYouInput,
} from "@nestor/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createApplicationStore,
  createSavedAnswersStore,
  readSavedApplicationAnswers,
  readSavedCountryOptionFallbacks,
} from "./applications";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "./job-store";

const stores: JobStore[] = [];
const folders: string[] = [];

it("an exact answer key wins before normalized-wording alternatives", () => {
  const { applications } = open();
  const memory = applications.needsYou;
  memory.remember({
    key: "exact",
    prompt: "Earlier wording",
    answer: "The exact stored answer",
    input: "text",
    scope: {},
    options: [],
  });
  memory.remember({
    key: "alternative",
    prompt: "Current wording",
    answer: "Another answer",
    input: "text",
    scope: {},
    options: [],
  });
  expect(
    memory.answersForQuestions(
      1,
      [{ key: "exact", prompt: "Current wording", reusePrompt: true }],
      "https://replica.test",
    )[0]?.answer,
  ).toBe("The exact stored answer");
});

it("a refused write preserves the answered link and an open task cannot hide it after restart", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "nestor-answer-replay-"));
  folders.push(folder);
  const file = path.join(folder, "jobs.sqlite");
  const { jobs, applications } = open(file);
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const row = applications.claimNext()!;
  const input = {
    applicationId: row.id,
    attempt: row.attempt,
    fieldKey: "authorization",
    kind: "question" as const,
    key: "auth",
    scope: {},
    prompt: "Can you work here?",
    input: "boolean" as const,
    options: ["Yes", "No"],
  };
  const first = applications.needsYou.request(input);
  if (first.status !== "needs_you")
    throw new Error("Expected the original question");
  applications.needsYou.answer({
    id: first.task.id,
    answer: "Yes",
    remember: false,
  });
  const next = applications.claimNext()!;
  const reason = {
    kind: "page_refused" as const,
    check: "choice_retention",
    detail: "The page cleared the selected option.",
  };
  applications.needsYou.request(
    { ...input, attempt: next.attempt, askReason: reason },
    { reuseAnswers: false },
  );
  expect(
    jobs
      .sql(
        "SELECT task_id FROM application_needs_you WHERE application_id=? ORDER BY task_id",
      )
      .all(row.id),
  ).toHaveLength(2);
  expect(
    applications.needsYou.answersForQuestions(
      row.id,
      [{ key: "auth", prompt: input.prompt, reusePrompt: false }],
      "https://replica.test",
    )[0]?.answer,
  ).toBe("Yes");
  jobs.close();
  const reopened = open(file);
  expect(reopened.applications.needsYou.list().rows[0]?.askReason).toEqual(
    reason,
  );
  expect(
    reopened.applications.needsYou.answersForQuestions(
      row.id,
      [{ key: "auth", prompt: input.prompt, reusePrompt: false }],
      "https://replica.test",
    )[0]?.answer,
  ).toBe("Yes");
});

it("an unresolved local task does not suppress a saved answer and model context stays origin-scoped", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const row = applications.claimNext()!;
  applications.needsYou.request({
    applicationId: row.id,
    attempt: row.attempt,
    fieldKey: "email",
    kind: "question",
    key: "email",
    scope: {},
    prompt: "Email",
    input: "text",
    options: [],
  });
  for (const [key, siteOrigin] of [
    ["email", ""],
    ["site", "https://replica.test"],
    ["other", "https://other.test"],
  ])
    applications.needsYou.remember({
      key: key!,
      scope: { siteOrigin },
      prompt: key!,
      answer: "alex@example.test",
      input: "text",
      options: [],
    });
  // Simulate a formerly opened unresolved task coexisting with the saved row.
  jobs
    .sql(
      "UPDATE needs_you SET answer=NULL,resolved_at=NULL WHERE answer_key='email'",
    )
    .run();
  expect(
    applications.needsYou.answersForQuestions(
      row.id,
      [{ key: "email", prompt: "Email", reusePrompt: false }],
      "https://replica.test",
    )[0]?.answer,
  ).toBe("alex@example.test");
  expect(
    readSavedApplicationAnswers(jobs, undefined, "https://replica.test")
      .map((answer) => answer.question)
      .sort(),
  ).toEqual(["email", "site"]);
});

it("search reads only confirmed global country-list rules for the person's saved country", () => {
  const { jobs, applications } = open();
  const rule = {
    primary: "Kosovo",
    fallback: "Albania",
    whenNeitherOffered: "skip_application" as const,
  };
  const remember = (
    key: string,
    scope: { country?: string; siteOrigin?: string },
  ) =>
    applications.needsYou.remember({
      key,
      prompt: "Country of residence",
      answer: "Kosovo",
      input: "choice",
      options: ["Kosovo", "Albania"],
      scope,
      optionFallback: rule,
    });
  const global = remember("country-global", {});
  applications.needsYou.remember({
    key: "country-unconfirmed",
    prompt: "Country of residence",
    answer: "Kosovo",
    input: "choice",
    options: ["Kosovo", "Albania"],
    scope: {},
    optionFallback: rule,
    needsConfirmation: true,
  });
  remember("country-site", { siteOrigin: "https://synthetic.test" });
  remember("country-hiring", { country: "US" });
  expect(readSavedCountryOptionFallbacks(jobs, " Kosovo ")).toEqual([rule]);
  expect(readSavedCountryOptionFallbacks(jobs, "Canada")).toEqual([]);
  expect(readSavedCountryOptionFallbacks(jobs, null)).toEqual([]);
  applications.needsYou.saveAnswer({ id: global.id, answer: "Albania" });
  expect(readSavedCountryOptionFallbacks(jobs, "Kosovo")).toEqual([]);
});

it("an exact country-named authorization source is read even without a preselected answer kind, and conflicts hand over", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const row = applications.claimNext()!,
    memory = applications.needsYou;
  const prompt = "Are you authorized to work in the UK?";
  const target = {
    key: "current-uk-question",
    prompt,
    reusePrompt: true,
    kind: "work_authorization" as const,
  };
  memory.remember({
    key: "unscoped-saved-question",
    prompt,
    answer: "No",
    input: "boolean",
    options: [],
    scope: {},
    kind: "other",
  });
  expect(
    memory
      .answersForQuestions(row.id, [target], "https://jobs.example.test")
      .map((answer) => answer.answer),
  ).toEqual(["No"]);
  expect(
    memory.answersForQuestions(
      row.id,
      [{ ...target, prompt: "Are you authorized to work in Germany?" }],
      "https://jobs.example.test",
    ),
  ).toEqual([]);
  memory.remember({
    key: "older-job-specific-question",
    prompt,
    answer: "Yes",
    input: "boolean",
    options: [],
    scope: {},
    kind: "work_authorization",
  });
  expect(
    memory.answersForQuestions(row.id, [target], "https://jobs.example.test"),
  ).toEqual([]);
});

it("revokes retired approvals before Apply even when Profile has never been constructed", () => {
  const jobs = openJobStore(":memory:");
  stores.push(jobs);
  jobs.db
    .exec(`INSERT INTO jobs(id,stage,stage_at,title,company,location,found_at,seen_at,source_label,url)
    VALUES(1,'resume',1,'Analyst','Synthetic','Berlin',1,1,'Board','https://example.test/jobs/retired');
    INSERT INTO resumes(job_id,level,state,updated_at,approved_at,pdf_path)
    VALUES(1,'tailored','ready',1,1,'C:/synthetic/approved.pdf');`);
  const applications = createApplicationStore(jobs);
  expect(applications.applyJobs({ selection: { ids: [1] } })).toEqual({
    queued: 0,
    unchanged: 0,
    notApproved: 1,
  });
  expect(
    jobs.sql("SELECT approved_at FROM resumes WHERE job_id=1").get()
      ?.approved_at,
  ).toBeNull();
});

it("persists a saved fallback and visible skipped application across restart without requeueing", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "nestor-saved-rule-"));
  folders.push(folder);
  const file = path.join(folder, "jobs.sqlite");
  const { jobs, applications } = open(file);
  const rule = {
    primary: "Primary territory",
    fallback: "Fallback region",
    whenNeitherOffered: "skip_application" as const,
  };
  const answer = applications.needsYou.remember({
    key: "country",
    prompt: "Country of residence",
    answer: rule.primary,
    input: "text",
    options: [],
    scope: {},
    optionFallback: rule,
  });
  expect(
    applications.needsYou.answersForQuestions(
      1,
      [{ key: "country", prompt: "Country of residence", reusePrompt: true }],
      "https://replica.test",
    )[0]?.optionFallback,
  ).toEqual(rule);
  expect(readSavedApplicationAnswers(jobs)[0]?.optionFallback).toEqual(rule);
  applications.needsYou.remember({
    key: "country",
    prompt: "Country of residence",
    answer: rule.primary,
    input: "text",
    options: [],
    scope: {},
  });
  expect(applications.needsYou.savedAnswer(answer.id)?.optionFallback).toEqual(
    rule,
  );
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const work = applications.claimNext()!;
  expect(
    applications.skip(
      work.id,
      work.attempt,
      "Neither saved option is offered.",
    ),
  ).toBe(true);
  expect(applications.needsYou.forApplication(work.id)).toEqual([]);
  // Apply all never undoes the skip.
  const everything = {
    selection: { filter: { stage: "resume" as const }, except: [] },
  };
  expect(applications.applyJobs(everything, "autonomous_submit")).toMatchObject(
    { queued: 0, unchanged: 1 },
  );
  expect(applications.getApplication(work.id)).toMatchObject({
    state: "skipped",
    mode: work.mode,
    attempt: work.attempt,
  });
  jobs.close();
  const reopened = open(file).applications;
  expect(reopened.getApplication(work.id)).toMatchObject({
    state: "skipped",
    error: "Neither saved option is offered.",
  });
  expect(reopened.claimNext()).toBeNull();
  expect(reopened.applyJobs(everything, "autonomous_submit")).toMatchObject({
    queued: 0,
    unchanged: 1,
  });
  expect(reopened.getApplication(work.id)).toMatchObject({
    state: "skipped",
    mode: work.mode,
    attempt: work.attempt,
  });
  // Applying to that job by name is the person's own call: it comes back.
  expect(
    reopened.applyJobs(
      { selection: { ids: [work.jobId] } },
      "autonomous_submit",
    ),
  ).toMatchObject({ queued: 1, unchanged: 0 });
  expect(reopened.getApplication(work.id)).toMatchObject({
    state: "queued",
    error: null,
  });
  expect(reopened.needsYou.savedAnswer(answer.id)?.optionFallback).toEqual(
    rule,
  );
  reopened.needsYou.saveAnswer({
    id: answer.id,
    answer: rule.primary,
    optionFallback: null,
  });
  expect(reopened.needsYou.savedAnswer(answer.id)?.optionFallback).toBeNull();
});

it("a fallback rule stays bound to the answer it was saved with", () => {
  const { applications } = open();
  const rule = {
    primary: "Primary territory",
    fallback: "Fallback region",
    whenNeitherOffered: "skip_application" as const,
  };
  const remember = (answer: string, optionFallback?: typeof rule | null) =>
    applications.needsYou.remember({
      key: "country",
      prompt: "Country of residence",
      answer,
      input: "text",
      options: [],
      scope: {},
      ...(optionFallback !== undefined ? { optionFallback } : {}),
    });
  const saved = remember(rule.primary, rule);
  // Saving the same answer again without mentioning the rule keeps it.
  remember(` ${rule.primary.toUpperCase()} `);
  expect(applications.needsYou.savedAnswer(saved.id)?.optionFallback).toEqual(
    rule,
  );
  // A changed answer does not quietly become the rule's first choice.
  remember("Other region");
  expect(
    applications.needsYou.savedAnswer(saved.id)?.optionFallback,
  ).toBeNull();
  // Editing keeps or drops the rule the same way, and refuses a mismatch.
  applications.needsYou.saveAnswer({
    id: saved.id,
    answer: rule.primary,
    optionFallback: rule,
  });
  applications.needsYou.saveAnswer({ id: saved.id, answer: "Other region" });
  expect(
    applications.needsYou.savedAnswer(saved.id)?.optionFallback,
  ).toBeNull();
  expect(() =>
    applications.needsYou.saveAnswer({
      id: saved.id,
      answer: "Other region",
      optionFallback: rule,
    }),
  ).toThrow(/start with the saved answer/u);
  // A fallback that is the answer itself is no fallback.
  expect(() =>
    applications.needsYou.saveAnswer({
      id: saved.id,
      answer: rule.primary,
      optionFallback: { ...rule, fallback: ` ${rule.primary} ` },
    }),
  ).toThrow(/different choice/u);
});

it("skipping retires only this application's questions and keeps a shared question for other applications", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 2) } });
  const a = applications.claimNext()!,
    b = applications.claimNext()!;
  applications.needsYou.request(question(a.id, a.attempt));
  applications.needsYou.request(question(b.id, b.attempt));
  applications.needsYou.request({
    ...question(a.id, a.attempt),
    key: "unique-question",
    fieldKey: "unique-question",
    prompt: "Unique question",
  });
  expect(applications.needsYou.list().total).toBe(2);
  applications.skip(a.id, a.attempt, "Saved rule says to skip.");
  expect(applications.needsYou.forApplication(a.id)).toEqual([]);
  expect(applications.needsYou.list().total).toBe(1);
  expect(applications.needsYou.forApplication(b.id)).toHaveLength(1);
});

it.each(meanings.cases)(
  "remembered question replay: $saved -> $asked",
  (entry) => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 1) } });
    const row = applications.claimNext()!,
      memory = applications.needsYou;
    memory.remember({
      key: "source-question",
      prompt: entry.saved,
      answer: entry.answer,
      input: "text",
      options: [],
      scope: {},
    });
    const lookup = {
      key: "target-question",
      prompt: entry.asked,
      reusePrompt: true,
      kind: "other" as const,
    };
    expect(
      memory
        .answersForQuestions(row.id, [lookup], "https://jobs.example.test")
        .map((match) => match.answer),
    ).toEqual(entry.matches ? [entry.answer] : []);
    const outcome = memory.request(
      question(row.id, row.attempt, {
        key: lookup.key,
        fieldKey: lookup.key,
        prompt: entry.asked,
        input: "text",
        reusePrompt: true,
        scope: {},
      }),
    );
    expect(outcome.status).toBe(entry.matches ? "answered" : "needs_you");
    expect(memory.list().total).toBe(entry.matches ? 0 : 1);
  },
);

it("one remembered monitoring answer resolves reworded questions in parallel applications", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 2) } });
  const first = applications.claimNext()!,
    second = applications.claimNext()!,
    memory = applications.needsYou;
  const sample = meanings.cases[1]!;
  const a = memory.request(
    question(first.id, first.attempt, {
      key: "monitoring-a",
      fieldKey: "monitoring-a",
      prompt: sample.saved,
      input: "text",
      reusePrompt: true,
      scope: {},
    }),
  );
  const b = memory.request(
    question(second.id, second.attempt, {
      key: "monitoring-b",
      fieldKey: "monitoring-b",
      prompt: sample.asked,
      input: "text",
      reusePrompt: true,
      scope: {},
    }),
  );
  if (a.status !== "needs_you" || b.status !== "needs_you")
    throw Error("Expected one shared handover");
  expect(a.task.id).toBe(b.task.id);
  expect(memory.list().total).toBe(1);
  expect(
    memory.answer({ id: a.task.id, answer: sample.answer, remember: true }),
  ).toEqual({ resolved: true, queued: 2 });
  expect(memory.list().total).toBe(0);
});

it("conflicting saved meanings and duplicate current targets never pick the latest answer", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const row = applications.claimNext()!,
    memory = applications.needsYou;
  const sample = meanings.cases[3]!;
  memory.remember({
    key: "notice-a",
    prompt: sample.saved,
    answer: "30 days",
    input: "text",
    options: [],
    scope: {},
  });
  const lookup = {
    key: "notice-target",
    prompt: sample.asked,
    reusePrompt: true,
  };
  expect(
    memory.answersForQuestions(
      row.id,
      [
        lookup,
        {
          ...lookup,
          key: "second-target",
          prompt: "How much notice do you need to give?",
        },
      ],
      "https://jobs.example.test",
    ),
  ).toEqual([]);
  memory.remember({
    key: "notice-b",
    prompt: "How much notice do you need to give?",
    answer: "60 days",
    input: "text",
    options: [],
    scope: {},
  });
  expect(
    memory.answersForQuestions(row.id, [lookup], "https://jobs.example.test"),
  ).toEqual([]);
  expect(
    memory.request(
      question(row.id, row.attempt, {
        key: lookup.key,
        fieldKey: lookup.key,
        prompt: sample.asked,
        input: "text",
        reusePrompt: true,
        scope: {},
      }),
    ).status,
  ).toBe("needs_you");
});

it.each(meanings.cases.slice(0, 4))(
  "restart remembers reworded $saved without requeueing an uncertain send",
  (entry) => {
    const folder = mkdtempSync(
      path.join(tmpdir(), "nestor-remembered-question-"),
    );
    folders.push(folder);
    const file = path.join(folder, "jobs.sqlite");
    const { jobs, applications } = open(file);
    applications.applyJobs({ selection: { ids: add(jobs, 3) } });
    const [first, exact, uncertain] = [
      applications.claimNext()!,
      applications.claimNext()!,
      applications.claimNext()!,
    ];
    const memory = applications.needsYou;
    memory.remember({
      key: "source",
      prompt: entry.saved,
      answer: entry.answer,
      input: "text",
      options: [],
      scope: {},
    });
    for (const [row, prompt] of [
      [first, entry.asked],
      [exact, entry.saved],
      [uncertain, entry.asked],
    ] as const)
      expect(
        memory.request(
          question(row.id, row.attempt, {
            key: `target-${row.id}`,
            fieldKey: "target",
            prompt,
            input: "text",
            reusePrompt: true,
            scope: {},
          }),
          { reuseAnswers: false },
        ).status,
      ).toBe("needs_you");
    jobs
      .sql("UPDATE applications SET state='uncertain' WHERE id=?")
      .run(uncertain.id);
    jobs.close();
    const reopened = open(file).applications;
    expect(reopened.needsYou.reconcileSavedQuestions()).toBe(1);
    expect(reopened.getApplication(first.id)?.state).toBe("queued");
    expect(reopened.getApplication(exact.id)?.state).toBe("needs_you");
    expect(reopened.getApplication(uncertain.id)?.state).toBe("uncertain");
    expect(reopened.needsYou.reconcileSavedQuestions()).toBe(0);
    const resumed = reopened.claimNext()!;
    expect(resumed.id).toBe(first.id);
    expect(
      reopened.needsYou.request(
        question(resumed.id, resumed.attempt, {
          key: `target-${resumed.id}`,
          fieldKey: "target",
          prompt: entry.asked,
          input: "text",
          reusePrompt: true,
          scope: {},
        }),
      ),
    ).toEqual({ status: "answered", answer: entry.answer });
  },
);

it("restart keeps conflicting meanings, duplicate targets and unoffered answers in Needs you", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 3) } });
  const [conflict, duplicate, choice] = [
    applications.claimNext()!,
    applications.claimNext()!,
    applications.claimNext()!,
  ];
  const memory = applications.needsYou;
  memory.remember({
    key: "notice-30",
    prompt: "What is your notice period?",
    answer: "30 days",
    input: "text",
    options: [],
    scope: {},
  });
  memory.remember({
    key: "notice-60",
    prompt: "Required notice period",
    answer: "60 days",
    input: "text",
    options: [],
    scope: {},
  });
  for (const [row, fieldKey, input, options] of [
    [conflict, "a", "text", []],
    [duplicate, "b", "text", []],
    [duplicate, "c", "text", []],
    [choice, "d", "choice", ["60 days", "90 days"]],
  ] as const)
    memory.request(
      question(row.id, row.attempt, {
        key: fieldKey,
        fieldKey,
        prompt: "How much notice do you need to give?",
        input,
        options: [...options],
        reusePrompt: true,
        scope: {},
      }),
      { reuseAnswers: false },
    );
  expect(memory.reconcileSavedQuestions()).toBe(0);
  expect(applications.getApplication(conflict.id)?.state).toBe("needs_you");
  memory.forgetAnswers({
    ids: [memory.getAnswerByKey({ key: "notice-60" })!.id],
  });
  expect(memory.reconcileSavedQuestions()).toBe(1);
  expect(applications.getApplication(duplicate.id)?.state).toBe("needs_you");
  expect(applications.getApplication(choice.id)?.state).toBe("needs_you");
});

it.each(["", "I am still deciding"])(
  "remembered answers and restart preserve the person's unfinished draft: %s",
  (draft) => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 1) } });
    const row = applications.claimNext()!;
    const memory = applications.needsYou;
    const waiting = memory.request(
      question(row.id, row.attempt, {
        key: "notice-current",
        fieldKey: "notice-current",
        prompt: "How much notice do you need to give?",
        input: "text",
        reusePrompt: true,
        scope: {},
      }),
    );
    if (waiting.status !== "needs_you") throw new Error("Expected handover");
    memory.saveDraft({
      id: waiting.task.id,
      answer: draft,
      remember: false,
      revision: 0,
    });
    memory.remember({
      key: "notice-saved",
      prompt: "What is your notice period?",
      answer: "Immediately",
      input: "text",
      options: [],
      scope: {},
    });
    expect(memory.reconcileSavedQuestions()).toBe(0);
    expect(memory.details(waiting.task.id)?.draft?.answer).toBe(draft);
    expect(applications.getApplication(row.id)?.state).toBe("needs_you");
  },
);

it("saving a reworded answer never resolves two distinct questions on the same application", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const row = applications.claimNext()!;
  for (const [index, prompt] of [
    "How much notice do you need to give?",
    "Required notice period",
  ].entries())
    applications.needsYou.request(
      question(row.id, row.attempt, {
        key: `notice-${index}`,
        fieldKey: `notice-${index}`,
        prompt,
        input: "text",
        reusePrompt: true,
        scope: {},
      }),
      { reuseAnswers: false },
    );
  applications.needsYou.remember({
    key: "notice-saved",
    prompt: "What is your notice period?",
    answer: "Immediately",
    input: "text",
    options: [],
    scope: {},
  });
  expect(applications.needsYou.list().total).toBe(2);
  expect(applications.getApplication(row.id)?.state).toBe("needs_you");
});

it("persists guarded answer Undo without retracting answers that released applications", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "nestor-answer-undo-"));
  folders.push(folder);
  const file = path.join(folder, "jobs.sqlite");
  const { jobs, applications } = open(file);
  applications.applyJobs({ selection: { ids: add(jobs, 2) } });
  const a = applications.claimNext()!;
  const b = applications.claimNext()!;
  applications.needsYou.request(question(a.id, a.attempt));
  applications.needsYou.request(question(b.id, b.attempt));
  const task = applications.needsYou.list().rows[0]!;
  const change = applications.needsYou.changeAnswers(() =>
    applications.needsYou.answer({ id: task.id, answer: "No", remember: true }),
  );
  expect(change.value).toEqual({ resolved: true, queued: 2 });
  expect(change.undoCount).toBe(1);
  jobs.close();
  const reopened = open(file).applications;
  expect(reopened.needsYou.undoAnswerChange(change.undoId!)).toEqual({
    changed: 1,
    skipped: 0,
  });
  expect(reopened.needsYou.listAnswers({}).total).toBe(0);
  expect(reopened.getApplication(a.id)?.state).toBe("queued");
  expect(reopened.getApplication(b.id)?.state).toBe("queued");
  expect(reopened.needsYou.list().total).toBe(0);
  const resumed = reopened.claimNext()!;
  expect(
    reopened.needsYou.request(question(resumed.id, resumed.attempt)),
  ).toEqual({
    status: "answered",
    answer: "No",
  });
});
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
  if (stage === "resume") approveOriginalResumesForTests(jobs, added);
  else jobs.setStage(added, stage);
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

it("does not infer a boolean answer from other text on the same question", () => {
  const { jobs, applications } = open();
  const memory = applications.needsYou;
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  let row = applications.claimNext()!;
  const prompt = "Are you over the age of 21?";
  const ask = (input: "text" | "boolean") =>
    memory.request({
      applicationId: row.id,
      attempt: row.attempt,
      kind: "question",
      scope: {},
      reusePrompt: true,
      prompt,
      input,
      key: `age-${input}`,
      fieldKey: `age-${input}`,
      options: input === "boolean" ? ["Yes", "No"] : [],
    });
  const first = ask("text");
  if (first.status !== "needs_you") throw new Error("Expected a question.");
  memory.answer({ id: first.task.id, answer: "21", remember: true });
  row = applications.claimNext()!;
  expect(ask("boolean").status).toBe("needs_you");
  expect(memory.list().total).toBe(1);
});

it.each([false, true])(
  "a text Yes/No answer survives the native boolean question and later text rereads (remember: %s)",
  (remember) => {
    const { jobs, applications } = open();
    const memory = applications.needsYou;
    applications.applyJobs({ selection: { ids: add(jobs, 1) } });
    let row = applications.claimNext()!;
    const ask = (input: "text" | "boolean", prompt: string, key: string) =>
      memory.request({
        applicationId: row.id,
        attempt: row.attempt,
        kind: "question",
        scope: {},
        reusePrompt: true,
        input,
        options: input === "boolean" ? ["Yes", "No"] : [],
        prompt,
        key,
        fieldKey: key,
      });
    const text = ask(
      "text",
      "Are you over the age of 21? Please choose Yes or No — required.",
      "age-text",
    );
    if (text.status !== "needs_you")
      throw new Error("Expected the first question.");
    memory.answer({ id: text.task.id, answer: "Yes", remember });
    row = applications.claimNext()!;
    expect(
      ask("boolean", "Are you over the age of 21?", "age-boolean"),
    ).toEqual({ status: "answered", answer: "Yes" });
    expect(
      ask("text", "Are you over the age of 21?", "age-text-reread"),
    ).toEqual({ status: "answered", answer: "Yes" });
    expect(memory.list().total).toBe(0);
  },
);

it.each([false, true])(
  "open text and boolean forms share one question and validate the choice (boolean first: %s)",
  (booleanFirst) => {
    const { jobs, applications } = open();
    const memory = applications.needsYou;
    applications.applyJobs({ selection: { ids: add(jobs, 2) } });
    const rows = [applications.claimNext()!, applications.claimNext()!];
    const ask = (
      index: number,
      input: "text" | "boolean",
      reuseAnswers = true,
    ) => {
      const row = rows[index]!;
      return memory.request(
        {
          applicationId: row.id,
          attempt: row.attempt,
          kind: "question",
          scope: {},
          reusePrompt: true,
          key: `age-${input}`,
          fieldKey: `age-${input}`,
          input,
          options: input === "boolean" ? ["No", "Yes"] : [],
          prompt: "Are you over the age of 21?",
        },
        { reuseAnswers },
      );
    };
    const first = ask(0, booleanFirst ? "boolean" : "text");
    if (first.status !== "needs_you")
      throw new Error("Expected the first question.");
    memory.saveDraft({
      id: first.task.id,
      answer: "No",
      remember: true,
      revision: 0,
    });
    const second = ask(1, booleanFirst ? "text" : "boolean");
    expect(second.status).toBe("needs_you");
    if (second.status !== "needs_you")
      throw new Error("Expected a shared question.");
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.input).toBe("boolean");
    const otherRendering = ask(0, booleanFirst ? "text" : "boolean");
    expect(otherRendering.status).toBe("needs_you");
    if (otherRendering.status === "needs_you")
      expect(otherRendering.task.id).toBe(first.task.id);
    for (let reread = 0; reread < 2; reread++) {
      const again = ask(0, booleanFirst ? "text" : "boolean", false);
      expect(again.status).toBe("needs_you");
      if (again.status === "needs_you")
        expect(again.task.id).toBe(first.task.id);
    }
    expect(memory.list().total).toBe(1);
    expect(memory.details(first.task.id)?.draft?.answer).toBe("No");
    expect(memory.findAnswer(first.task.key)).toBeNull();
    expect(() =>
      memory.answer({ id: first.task.id, answer: "21", remember: true }),
    ).toThrow("valid answer");
    expect(
      memory.answer({ id: first.task.id, answer: "No", remember: true }),
    ).toEqual({ resolved: true, queued: 2 });
    expect(memory.list().total).toBe(0);
  },
);

describe("applications on the job store", () => {
  it("keeps a one-application pay answer local, and reuses only an explicitly remembered answer on other forms", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 3) } });
    const [first, second, later] = [
      applications.claimNext()!,
      applications.claimNext()!,
      applications.claimNext()!,
    ] as const;
    const memory = applications.needsYou;
    const query = {
      key: "salary",
      prompt: "Annual salary expectation",
      reusePrompt: true,
      kind: "salary_expectation" as const,
    };
    const ask = (row: typeof first) =>
      memory.request(
        question(row.id, row.attempt, {
          scope: {},
          key: query.key,
          fieldKey: query.key,
          prompt: query.prompt,
          input: "number",
          reusePrompt: true,
        }),
      );
    const read = (id: number) =>
      memory
        .answersForQuestions(id, [query], "https://jobs.example.test")
        .map((answer) => answer.answer);
    const local = ask(first);
    if (local.status !== "needs_you") throw new Error("Missing pay question");
    memory.answer({ id: local.task.id, answer: "50000", remember: false });
    expect(read(first.id)).toEqual(["50000"]);
    expect(memory.listAnswers({}).total).toBe(0);
    expect(readSavedApplicationAnswers(jobs)).toEqual([]);
    expect(read(second.id)).toEqual([]);
    const next = ask(second);
    if (next.status !== "needs_you")
      throw new Error("Local pay answer leaked to another application");
    expect(next.task.id).not.toBe(local.task.id);
    memory.answer({ id: next.task.id, answer: "52000", remember: true });
    expect(ask(later)).toEqual({ status: "answered", answer: "52000" });
    expect(read(later.id)).toEqual(["52000"]);
    expect(read(first.id)).toEqual(["50000"]);
  });

  it("reuses saved pay answers when a wizard wraps the same questions in progress headings", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 1) } });
    const row = applications.claimNext()!;
    const memory = applications.needsYou;
    for (const [prompt, answer] of [
      ["Annual salary expectation", "50000"],
      ["Salary currency", "GBP"],
      ["Notice period", "One month"],
    ]) {
      memory.remember({
        key: prompt!,
        prompt: `Step 1 of 4: Compensation — ${prompt}`,
        answer: answer!,
        input: "text",
        scope: {},
        options: [],
      });
      const wrapped = `Step 3 of 6: Compensation — ${prompt} *`;
      expect(
        memory
          .answersForQuestions(
            row.id,
            [{ key: prompt!, prompt: wrapped, reusePrompt: true }],
            "https://jobs.example.test",
          )
          .map((found) => found.answer),
      ).toEqual([answer]);
      expect(
        memory.request(
          question(row.id, row.attempt, {
            key: prompt!,
            prompt: wrapped,
            reusePrompt: true,
            scope: {},
            input: "text",
          }),
        ),
      ).toEqual({ status: "answered", answer });
    }
    expect(memory.list().total).toBe(0);
  });

  it("keeps equal labels in different wizard sections in separate tasks and never reuses the other section's answer", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 1) } });
    const row = applications.claimNext()!;
    const memory = applications.needsYou;
    const pairs = [
      [
        "Step 2 of 6: Employment — Start date",
        "Step 3 of 6: Education — Start date",
        "2020-01-01",
      ],
      [
        "Step 4 of 7: Reference 1 — Email address",
        "Step 5 of 7: Reference 2 — Email address",
        "first@example.test",
      ],
      [
        "Step 2 of 6: Terms — I agree",
        "Step 4 of 6: Marketing — I agree",
        "Yes",
      ],
    ];
    for (const [first, second, answer] of pairs) {
      memory.remember({
        key: first!,
        prompt: first!,
        answer: answer!,
        input: "text",
        scope: {},
        options: [],
      });
      expect(
        memory
          .answersForQuestions(
            row.id,
            [
              { key: first!, prompt: first!, reusePrompt: true },
              { key: second!, prompt: second!, reusePrompt: true },
            ],
            "https://jobs.example.test",
          )
          .map((found) => found.key),
      ).toEqual([first]);
      for (const prompt of [first!, second!])
        memory.request(
          question(row.id, row.attempt, {
            key: prompt,
            fieldKey: prompt,
            prompt,
            reusePrompt: true,
            scope: {},
            input: "text",
          }),
          { reuseAnswers: false },
        );
    }
    expect(memory.list().total).toBe(6);
    expect(new Set(memory.list().rows.map((task) => task.key)).size).toBe(6);
    expect(new Set(memory.list().rows.map((task) => task.prompt)).size).toBe(6);
  });

  it("returns an unusable remembered answer to one shared question and waits for its correction", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 2) } });
    const rows = [applications.claimNext()!, applications.claimNext()!];
    const ask = (id: number, reuseAnswers = true) =>
      applications.needsYou.request(
        question(id, 1, {
          scope: {},
          key: "salary",
          fieldKey: "salary",
          prompt: "Annual salary expectation",
          input: "number",
        }),
        { reuseAnswers },
      );
    const first = ask(rows[0]!.id);
    if (first.status !== "needs_you") throw new Error("Missing question");
    ask(rows[1]!.id);
    applications.needsYou.answer({
      id: first.task.id,
      answer: "50000",
      remember: true,
    });
    const retry = applications.claimNext()!;
    const again = applications.needsYou.request(
      question(retry.id, retry.attempt, {
        scope: {},
        key: "salary",
        fieldKey: "salary",
        prompt: "Annual salary expectation",
        input: "number",
      }),
      { reuseAnswers: false },
    );
    if (again.status !== "needs_you") throw new Error("Missing correction");
    expect(again.task.id).not.toBe(first.task.id);
    expect(
      applications.needsYou.answersForQuestions(
        retry.id,
        [
          {
            key: "salary",
            prompt: "Annual salary expectation",
            reusePrompt: false,
          },
        ],
        "https://jobs.example.test",
      ),
    ).toEqual([expect.objectContaining({ answer: "50000" })]);
    expect(applications.getApplication(retry.id)?.state).toBe("needs_you");
    applications.needsYou.answer({
      id: again.task.id,
      answer: "52000",
      remember: true,
    });
    expect(
      applications.needsYou
        .answersForQuestions(
          retry.id,
          [
            {
              key: "salary",
              prompt: "Annual salary expectation",
              reusePrompt: false,
            },
          ],
          "https://jobs.example.test",
        )
        .map((row) => row.answer),
    ).toEqual(["52000"]);
    expect(applications.getApplication(retry.id)?.state).toBe("queued");
  });
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
    // Only the person's check moves an uncertain send, and only that one.
    expect(applications.resolveUncertainSend(first.id, receipt)).toBe(false);
    // The outcome must name this row's own job, application and attempt.
    expect(() =>
      applications.resolveUncertainSend(second.id, {
        ...receipt,
        id: "resolution",
        outcome: "not_submitted",
      }),
    ).toThrow("another application attempt");
    // The same check, asked first, so nothing else records a resolution
    // the row would refuse.
    const own = {
      jobId: String(second.jobId),
      applicationRecordId: `application_${second.id}`,
      runId: `application_run_${second.id}`,
      resultId: `application_${second.id}_attempt_${second.attempt}`,
    };
    expect(applications.canResolveUncertainSend(second.id, receipt)).toBe(
      false,
    );
    expect(applications.canResolveUncertainSend(second.id, own)).toBe(true);
    expect(applications.canResolveUncertainSend(first.id, own)).toBe(false);
    expect(
      applications.resolveUncertainSend(second.id, {
        ...receipt,
        id: "resolution",
        outcome: "not_submitted",
        jobId: String(second.jobId),
        applicationRecordId: `application_${second.id}`,
        runId: `application_run_${second.id}`,
        resultId: `application_${second.id}_attempt_${second.attempt}`,
      }),
    ).toBe(true);
    expect(applications.getApplication(second.id)).toMatchObject({
      state: "stopped",
      error: "You checked the site: this application was not sent.",
    });
    expect(jobs.getJob(second.jobId)?.stage).toBe("resume");
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
          [
            {
              key: "sponsorship",
              prompt: "Will you need visa sponsorship?",
              reusePrompt: false,
            },
          ],
          "https://jobs.example.test",
        )
        .map((answer) => answer.answer),
    ).toEqual(["No"]);
    expect(
      applications.needsYou.answersForQuestions(
        second.id,
        [
          {
            key: "different-question",
            prompt: "Different",
            reusePrompt: false,
          },
        ],
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
  it("applies only to jobs whose resume is approved, whatever their stage says", () => {
    const { jobs, applications } = open();
    const [approved, unapproved, noResume] = add(jobs, 3);
    jobs
      .sql("UPDATE resumes SET approved_at = NULL WHERE job_id = ?")
      .run(unapproved!);
    jobs.sql("DELETE FROM resumes WHERE job_id = ?").run(noResume!);

    expect(
      applications.applyJobs({
        selection: { ids: [approved!, unapproved!, noResume!] },
      }),
    ).toEqual({ queued: 1, unchanged: 0, notApproved: 2 });
    expect(
      applications.applyJobs({
        selection: { filter: { stage: "resume" }, except: [] },
      }),
    ).toEqual({ queued: 0, unchanged: 1, notApproved: 2 });
  });

  it("claims and freezes only jobs whose resume is still approved", () => {
    const { jobs, applications } = open();
    const [kept, unapproved] = add(jobs, 2);
    applications.applyJobs({ selection: { ids: [kept!, unapproved!] } });
    jobs
      .sql("UPDATE resumes SET approved_at = NULL WHERE job_id = ?")
      .run(unapproved!);

    expect(
      applications.selectedJobIds({
        filter: { stage: "resume" },
        except: [],
      }),
    ).toEqual([kept]);
    expect(applications.claimNext()?.jobId).toBe(kept);
    expect(applications.claimNext()).toBeNull();
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
    const us = memory.savedAnswer(
      memory.listAnswers({}).rows.find((row) => row.scope.country === "US")!.id,
    )!;
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

  it("one saved fact releases text and numeric versions, while country-dependent questions keep their scope", () => {
    const { jobs, applications } = open();
    applications.applyJobs({ selection: { ids: add(jobs, 3) } });
    const first = applications.claimNext()!,
      second = applications.claimNext()!,
      third = applications.claimNext()!;
    const memory = applications.needsYou;
    for (const [row, input, key] of [
      [first, "number", "numeric"],
      [second, "text", "textual"],
    ] as const)
      memory.request(
        question(row.id, row.attempt, {
          key,
          fieldKey: key,
          scope: {},
          prompt: "Years of analysis experience",
          input,
          reusePrompt: true,
        }),
      );
    const geographic = memory.request(
      question(third.id, third.attempt, {
        key: "sponsorship-for-specific-country",
        scope: {},
        reusePrompt: false,
      }),
    );
    memory.remember({
      key: "saved-analysis",
      scope: {},
      prompt: "Years of analysis experience",
      answer: "5",
      input: "number",
      options: [],
    });
    expect(applications.getApplication(first.id)?.state).toBe("queued");
    expect(applications.getApplication(second.id)?.state).toBe("queued");
    expect(memory.counts().question).toBe(1);
    memory.remember({
      key: "saved-sponsorship",
      scope: {},
      prompt: "Will you need visa sponsorship?",
      answer: "No",
      input: "boolean",
      options: [],
    });
    expect(applications.getApplication(third.id)?.state).toBe("needs_you");
    expect(geographic.status).toBe("needs_you");
    expect(
      memory.answersForQuestions(
        third.id,
        [
          {
            key: "sponsorship-for-specific-country",
            prompt: "Will you need visa sponsorship?",
            reusePrompt: false,
          },
        ],
        "https://jobs.example.test",
      ),
    ).toEqual([]);
  });
});

it("shares stable-key answers, kinds and proof references with Needs you and ignores unconfirmed suggestions", () => {
  const { jobs, applications } = open();
  const answers = createSavedAnswersStore(jobs);
  const first = answers.upsert({
    key: "analysis-years",
    prompt: "Years of analysis experience",
    answer: "5",
    input: "number",
    roleFamilies: ["Analysis"],
    proofEntryIds: ["proof_1"],
  });
  answers.upsert({
    key: "notice_period",
    kind: "notice_period",
    prompt: "My notice period",
    answer: "Two weeks",
  });
  answers.upsert({
    key: "suggestion",
    prompt: "Unconfirmed",
    answer: "Not mine yet",
    needsConfirmation: true,
  });
  expect(answers.get({ key: "analysis-years" })).toMatchObject({
    id: first.id,
    answer: "5",
    input: "number",
    roleFamilies: ["Analysis"],
    proofEntryIds: ["proof_1"],
  });
  expect(answers.list({ limit: 2 }).rows).toHaveLength(2);
  const matches = applications.needsYou.answersForQuestions(
    123,
    [
      {
        key: "new-question",
        prompt: "When can you start after giving notice?",
        reusePrompt: true,
        kind: "notice_period",
      },
      {
        key: "numeric",
        prompt: "Years of analysis experience",
        reusePrompt: true,
      },
    ],
    "https://replica.test",
  );
  expect(matches.map((value) => value.answer)).toEqual(["Two weeks", "5"]);
  expect(
    readSavedApplicationAnswers(jobs).map((value) => value.answer),
  ).toEqual(["5", "Two weeks"]);
  expect(
    answers.upsert({
      key: "analysis-years",
      prompt: "Years of analysis experience",
      answer: "6",
      input: "number",
    }).id,
  ).toBe(first.id);
  expect(applications.needsYou.savedAnswer(first.id)?.answer).toBe("6");
});

it("shares one access card per site through sign-in, CAPTCHA and MFA but verifies each application", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 3) } });
  const rows = [
    applications.claimNext()!,
    applications.claimNext()!,
    applications.claimNext()!,
  ];
  const memory = applications.needsYou;
  const tasks = rows.map((row, index) =>
    memory.request({
      applicationId: row.id,
      attempt: row.attempt,
      fieldKey: "site_access",
      key: `different:${index}`,
      kind: (["sign_in", "captcha", "mfa"] as const)[index]!,
      scope: { siteOrigin: "https://jobs.example.test" },
      prompt: "Finish the site step",
      input: "text",
      options: [],
    }),
  );
  expect(tasks.every((task) => task.status === "needs_you")).toBe(true);
  const task = memory.list().rows[0]!;
  expect(memory.list().rows).toHaveLength(1);
  expect(task.kind).toBe("mfa");
  expect(memory.counts()).toMatchObject({ sign_in: 0, captcha: 0, mfa: 1 });
  expect(memory.completeAccess(task.id, 999)).toBe(false);
  expect(memory.completeAccess(task.id, rows[0]!.id)).toBe(true);
  expect(applications.getApplication(rows[0]!.id)?.state).toBe("queued");
  expect(applications.getApplication(rows[1]!.id)?.state).toBe("needs_you");
  expect(memory.details(task.id)?.applications.map((row) => row.id)).toEqual(
    rows.slice(1).map((row) => row.id),
  );
  expect(memory.completeAccess(task.id, rows[0]!.id)).toBe(false);
  memory.completeAccess(task.id, rows[1]!.id);
  expect(memory.list().total).toBe(1);
  applications.stop(rows[2]!.id);
  expect(memory.list().total).toBe(0);
  expect(memory.listAnswers().total).toBe(0);
});

it("keeps access checks scoped to a site and does not skip another unanswered question", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 2) } });
  const rows = [applications.claimNext()!, applications.claimNext()!];
  const memory = applications.needsYou;
  const tasks = rows.map((row, index) =>
    memory.request({
      applicationId: row.id,
      attempt: row.attempt,
      fieldKey: "site_access",
      key: "access",
      kind: "captcha",
      scope: { siteOrigin: `https://site${index}.example.test` },
      prompt: "Complete the CAPTCHA",
      input: "text",
      options: [],
    }),
  );
  memory.request(question(rows[0]!.id, rows[0]!.attempt));
  expect(memory.list().total).toBe(3);
  const task = tasks[0]!;
  if (task.status !== "needs_you") throw new Error("Missing access task");
  memory.completeAccess(task.task.id, rows[0]!.id);
  expect(applications.getApplication(rows[0]!.id)?.state).toBe("needs_you");
  expect(memory.list().rows.map((task) => task.kind)).toEqual([
    "captcha",
    "question",
  ]);
  const pending = memory.list().rows.find((task) => task.kind === "question")!;
  memory.answer({ id: pending.id, answer: "No", remember: true });
  expect(applications.getApplication(rows[0]!.id)?.state).toBe("queued");
  expect(applications.getApplication(rows[1]!.id)?.state).toBe("needs_you");
});

it("knows the page of an unsent prepared form after a restart, and forgets it once sent", () => {
  const { jobs, applications } = open();
  const [id] = add(jobs, 1);
  applications.applyJobs({ selection: { ids: [id!] } });
  const row = applications.claimNext()!;
  const pageUrl = "https://jobs.example.test/apply/1";
  jobs
    .sql(
      `INSERT INTO application_details (application_id, attempt, resume_artifact_json, review_json, profile_digest)
       VALUES (?, ?, '{}', ?, 'digest')`,
    )
    .run(row.id, row.attempt, JSON.stringify({ siteLabel: "Jobs", pageUrl }));
  expect(applications.holdsFormAt(pageUrl)).toBe(true);
  expect(applications.holdsFormAt("https://jobs.example.test/other")).toBe(
    false,
  );
  jobs
    .sql("UPDATE applications SET state = 'submitted' WHERE id = ?")
    .run(row.id);
  expect(applications.holdsFormAt(pageUrl)).toBe(false);
});

it("clears a refused standalone letter, preserves an intervening edit, and is idempotent", () => {
  const { jobs, applications } = open();
  applications.applyJobs({ selection: { ids: add(jobs, 1) } });
  const row = applications.claimNext()!;
  const card = {
    ...reviewFixture,
    answers: [],
    letter: {
      ...reviewFixture.letter,
      text: "Old refused text",
      fields: ["Cover letter"],
    },
  };
  jobs
    .sql(
      "INSERT INTO application_details(application_id,attempt,resume_artifact_json,review_json,profile_digest) VALUES(?,?,'{}',?,'digest')",
    )
    .run(row.id, row.attempt, JSON.stringify(card));
  const read = () =>
    JSON.parse(
      String(
        jobs
          .sql(
            "SELECT review_json FROM application_details WHERE application_id=?",
          )
          .get(row.id)?.review_json,
      ),
    ) as { letter: unknown };
  expect(
    applications.discardReviewAnswers(
      row.id,
      row.attempt + 1,
      ["Cover letter"],
      "Old refused text",
    ),
  ).toBe(false);
  expect(read().letter).not.toBeNull();
  expect(
    applications.discardReviewAnswers(
      row.id,
      row.attempt,
      ["Cover letter"],
      "Earlier snapshot",
    ),
  ).toBe(true);
  expect(read().letter).not.toBeNull();
  applications.discardReviewAnswers(
    row.id,
    row.attempt,
    ["Cover letter"],
    "Old refused text",
  );
  expect(read().letter).toBeNull();
  applications.discardReviewAnswers(
    row.id,
    row.attempt,
    ["Cover letter"],
    "Old refused text",
  );
  expect(read().letter).toBeNull();
});
