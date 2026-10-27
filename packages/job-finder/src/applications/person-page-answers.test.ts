import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
  type FoundJob,
} from "@nestor/contracts";
import {
  checkClassifiedApplicationAnswers,
  buildApplyFormObservation,
} from "@nestor/browser-agent";
import { createApplicationStore } from "@nestor/db/applications";
import {
  approveOriginalResumesForTests,
  openJobStore,
} from "@nestor/db/job-store";
import { afterEach, expect, test } from "vitest";
import { rememberPersonPageAnswers } from "./person-page-answers";
import { describeFormQuestion, toKnownFormAnswer } from "./questions";

const stores: ReturnType<typeof openJobStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const prompt = "When could you start?";
const value = "11/15/2026";
const url = "https://apply.example.test/application";
const question = {
  prompt,
  kind: "availability" as const,
  answerControlType: "date" as const,
  answerOptions: [],
};
function setup() {
  const store = openJobStore(":memory:");
  stores.push(store);
  const applications = createApplicationStore(store);
  const id = store.saveFoundJobs({
    searchId: null,
    jobs: [
      {
        title: "Engineer",
        company: "Synthetic",
        location: "Remote",
        workModes: ["remote"],
        url,
        sourceId: "synthetic",
        sourceLabel: "Synthetic",
        sourceJobId: "1",
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Synthetic job",
        applyUrl: null,
      } satisfies FoundJob,
    ],
  }).added[0]!;
  approveOriginalResumesForTests(store, [id]);
  applications.applyJobs({ selection: { ids: [id] } });
  const row = applications.claimNext()!;
  const raw: RawApplyControl = {
    index: 0,
    id: "start",
    name: "start",
    tagName: "input",
    inputType: "date",
    role: "",
    label: prompt,
    groupLabel: "",
    placeholder: "Pick date...",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value,
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  };
  const page: RawApplyPage = {
    url,
    title: "Apply",
    bodyText: prompt,
    controls: [raw],
    actions: [],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    stepLabel: null,
    loading: false,
    validationErrors: [],
  };
  const job = { id, location: "Remote" };
  const known = { ...describeFormQuestion(question, job), prompt };
  const read = () =>
    applications.needsYou.answersForQuestions(
      row.id,
      [known],
      new URL(url).origin,
    );
  const remember = () =>
    rememberPersonPageAnswers({
      page,
      application: row,
      job,
      memory: applications.needsYou,
      earlierQuestions: [{ id: "start-question", prompt }],
    });
  return { store, applications, row, raw, page, job, known, read, remember };
}

test("a person's date replaces an older local answer, survives refill, and passes both Send rechecks without a Profile source", async () => {
  const f = setup();
  const requested = f.applications.needsYou.request({
    ...f.known,
    applicationId: f.row.id,
    attempt: f.row.attempt,
    fieldKey: "start-question",
    scope: {},
    kind: "question",
  });
  if (requested.status !== "needs_you")
    throw new Error("Expected the initial question");
  f.applications.needsYou.answer({
    id: requested.task.id,
    answer: "Immediately",
    remember: true,
  });
  Object.assign(f.row, f.applications.claimNext()!);
  f.raw.personAnswer = {
    pageUrl: url,
    value,
    checked: false,
    recordedAt: "2026-11-15T10:00:00Z",
  };
  expect(f.remember()).toBe(1);
  expect(f.read().map((answer) => answer.answer)).toEqual([value]);
  expect(f.applications.needsYou.forApplication(f.row.id)).toHaveLength(0);
  expect(f.remember()).toBe(1);
  const other = createApplicationStore(f.store);
  const saved = other.needsYou.answersForQuestions(
    f.row.id,
    [f.known],
    new URL(url).origin,
  );
  expect(saved.map((answer) => answer.answer)).toEqual([value]);
  const profile = CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: 1,
    baseResume: {
      id: "resume",
      fileName: "synthetic.pdf",
      uploadedAt: "2026-11-15T10:00:00Z",
    },
  });
  const client = {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: "read",
            type: "function" as const,
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                plainIndexes: [0],
                flagged: [],
                tags: [
                  {
                    index: 0,
                    kind: "other",
                    sourceId: null,
                    country: null,
                    declarationPurpose: null,
                  },
                ],
              }),
            },
          },
        ],
      }),
  };
  for (const hasPersonSource of [false, true, true]) {
    const checks = await checkClassifiedApplicationAnswers({
      client,
      sources: {
        profile,
        resumeText: null,
        documents: [],
        reusableAnswers: (hasPersonSource ? saved : []).map((answer) =>
          toKnownFormAnswer(answer, question, f.job.location, f.row.id),
        ),
        posting: {
          company: "Synthetic",
          title: "Engineer",
          location: "Remote",
          description: "",
        },
      },
      payDisclosed: false,
      answers: [{ question: prompt, answer: value }],
      formControls: buildApplyFormObservation(f.page, new Date().toISOString())
        .controls,
      formContext: { pageText: prompt, fields: [{ question: prompt, value }] },
    });
    expect(checks[0]?.supported).toBe(hasPersonSource);
  }
});

test.each([
  "site prefill",
  "unknown editor",
  "another page",
  "changed value",
  "invalid date",
])("%s never becomes a saved person answer", (reason) => {
  const f = setup();
  if (reason !== "site prefill" && reason !== "unknown editor")
    f.raw.personAnswer = {
      pageUrl: reason === "another page" ? `${url}/other` : url,
      value: reason === "changed value" ? "11/16/2026" : value,
      checked: false,
      recordedAt: "2026-11-15T10:00:00Z",
    };
  if (reason === "invalid date") f.raw.invalid = true;
  expect(f.remember()).toBe(0);
  expect(f.read()).toEqual([]);
});

test("a stale attempt cannot save an on-page answer", () => {
  const f = setup();
  f.raw.personAnswer = {
    pageUrl: url,
    value,
    checked: false,
    recordedAt: "2026-11-15T10:00:00Z",
  };
  expect(
    rememberPersonPageAnswers({
      page: f.page,
      application: { ...f.row, attempt: f.row.attempt + 1 },
      job: f.job,
      memory: f.applications.needsYou,
    }),
  ).toBe(0);
  expect(f.read()).toEqual([]);
});
