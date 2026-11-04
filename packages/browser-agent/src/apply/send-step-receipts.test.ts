import {
  CandidateProfileSchema,
  type ApplyStepReceipt,
  type RawApplyControl,
  type RawApplyPage,
  type RawApplySummaryRow,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { reviewFieldKey } from "./form-replay";
import { buildApplyFormObservation } from "./page-hands";
import { questionPrompt } from "./policy-executor";
import { createStepReceiptTracker } from "./step-receipts";
import type { ApplyAnswerSources, ApplyFormObservation } from "./types";

// The native case-2 shape (council D1): a three-step wizard that removes each
// step's controls before a control-free review step listing dt/dd rows.
const ORIGIN = "https://replica.example.test";
const PAGE = `${ORIGIN}/case2/apply`;
const RESULT = "application_7_attempt_1";
const AT = "2026-11-04T01:00:00.000Z";
const RESUME =
  "Jamie Example\nEmail: jamie@clientnest.example\nLocation: Berlin, Germany\n\nFrontend Engineer - Clientnest Replica (fictional)\nBuild React interfaces and maintain accessible forms.\nReporting routine: I submit weekly reports\n";

function sources(overrides: Record<string, unknown> = {}): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      firstName: "Jamie",
      lastName: "Example",
      fullName: "Jamie Example",
      email: "jamie@clientnest.example",
      currentCity: "Berlin",
      currentCountry: "Germany",
      yearsExperience: 6,
      baseResume: {
        id: "resume",
        fileName: "jamie-synthetic-resume.txt",
        uploadedAt: "2026-11-01T00:00:00.000Z",
        extractionStatus: "ready",
        textContent: RESUME,
      },
      ...overrides,
    }),
    resumeText: RESUME,
    posting: {
      title: "Frontend Engineer",
      company: "Clientnest Replica",
      location: "Berlin, Germany",
      description: "Build React interfaces.",
    },
    reusableAnswers: [],
    documents: [],
  };
}

function field(
  index: number,
  label: string,
  value: string,
  extra: Partial<RawApplyControl> = {},
): RawApplyControl {
  return {
    index,
    tagName: "input",
    inputType: "text",
    role: "",
    id: `f${index}`,
    name: `f${index}`,
    label,
    groupLabel: "",
    placeholder: "",
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
    ...extra,
  };
}

function page(
  step: number,
  controls: RawApplyControl[],
  summaryRows?: RawApplySummaryRow[],
): ApplyFormObservation {
  const raw: RawApplyPage = {
    url: PAGE,
    title: "Clientnest Replica application",
    bodyText: `Step ${step} of 3`,
    controls,
    actions: [
      step === 3
        ? {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
          }
        : {
            index: 0,
            label: "Save and Continue",
            visible: true,
            disabled: false,
            inForm: true,
            submitsForm: false,
          },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
    ...(summaryRows ? { summaryRows } : {}),
  };
  return buildApplyFormObservation(raw, AT);
}

/** The same repeat marking the run's question occurrences make. */
function repeated(observation: ApplyFormObservation, refs: string[]) {
  for (const control of observation.controls)
    if (refs.includes(control.ref))
      control.repeatedQuestion = {
        prompt: `${control.label} (repeated question on step 2)`,
        step: "step 2",
      };
  return observation;
}

const ROWS: RawApplySummaryRow[] = [
  { label: "First name", value: "Jamie" },
  { label: "Last name", value: "Example" },
  { label: "Email", value: "jamie@clientnest.example" },
  { label: "Referral code", value: "LOCAL-REFERRAL-27" },
  { label: "Reporting routine", value: "I submit weekly reports" },
  { label: "Resume", value: "jamie-synthetic-resume.txt" },
];

/**
 * Runs the attempt as the agent records it: each step observed first, its
 * own writes, then the confirmed press from the filled page. Returns the
 * stored receipts and the review card answers keyed as the card keys them.
 */
function attempt(
  options: {
    email?: string;
    emailPrefilled?: boolean;
    referral?: string;
    reporting?: string;
    skipStepOneReceipt?: boolean;
    unconfirmed?: boolean;
  } = {},
) {
  const email = options.email ?? "jamie@clientnest.example";
  const referral = options.referral ?? "LOCAL-REFERRAL-27";
  const reporting = options.reporting ?? "I submit weekly reports";
  const tracker = createStepReceiptTracker(RESULT);
  const first = page(1, [
    field(0, "First name", ""),
    field(1, "Last name", ""),
    field(2, "Email", options.emailPrefilled ? email : "", {
      inputType: "email",
    }),
    field(3, "Referral code", referral),
  ]);
  tracker.observe(first);
  for (const ref of options.emailPrefilled ? ["c0", "c1"] : ["c0", "c1", "c2"])
    tracker.wrote(first, ref);
  const one = page(1, [
    field(0, "First name", "Jamie"),
    field(1, "Last name", "Example"),
    field(2, "Email", email, { inputType: "email" }),
    field(3, "Referral code", referral),
  ]);
  tracker.observe(one);
  if (!options.skipStepOneReceipt) tracker.advance(one, AT);
  const secondControls = (reportingValue: string) => [
    field(0, "First name", "Jamie", { readOnly: true }),
    field(1, "Referral code", referral, { readOnly: true }),
    field(2, "Describe your reporting routine", reportingValue, {
      tagName: "textarea",
    }),
  ];
  const second = repeated(page(2, secondControls("")), ["c0", "c1"]);
  tracker.observe(second);
  tracker.wrote(second, "c2");
  const two = repeated(page(2, secondControls(reporting)), ["c0", "c1"]);
  tracker.observe(two);
  tracker.advance(two, AT);
  if (options.unconfirmed) tracker.unconfirmed(two, AT);
  const review = page(3, [], ROWS);
  const receipts = tracker.finish(review, AT);
  const card = [
    ...one.controls.map((control) => ({ step: one, control })),
    ...two.controls.map((control) => ({ step: two, control })),
  ].map(({ step, control }) => ({
    question: questionPrompt(control),
    answer: control.value,
    fieldKey: reviewFieldKey(step, control),
  }));
  return { receipts, card, review };
}

function client(options: { unread?: boolean } = {}): LLMClient {
  return {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((messages, tools) => {
      const name = tools[0].function.name;
      const payload = JSON.parse(
        String(messages.find((message) => message.role === "user")?.content),
      ) as unknown;
      if (name === "report_question_kinds") {
        if (options.unread)
          return Promise.reject(new Error("The question read timed out."));
        const questions = payload as { index: number; question: string }[];
        return Promise.resolve({
          toolCalls: [
            {
              id: "read",
              type: "function" as const,
              function: {
                name,
                arguments: JSON.stringify({
                  plainIndexes: questions.map((question) => question.index),
                  flagged: [],
                  tags: questions.map(({ index, question }) => ({
                    index,
                    kind: /reporting/iu.test(question)
                      ? "factual_summary"
                      : "other",
                    country: null,
                    sourceId: /^first name/iu.test(question)
                      ? "profile.firstName"
                      : /^last name/iu.test(question)
                        ? "profile.lastName"
                        : /^email/iu.test(question)
                          ? "profile.email"
                          : /reporting/iu.test(question)
                            ? "resume.text"
                            : null,
                  })),
                }),
              },
            },
          ],
        });
      }
      const answers =
        (payload as { answers?: { proposedAnswer: string }[] }).answers ?? [];
      return Promise.resolve({
        toolCalls: [
          {
            id: "check",
            type: "function" as const,
            function: {
              name,
              arguments: JSON.stringify({
                // Only the resume-grounded statement is supported.
                checks: answers.map((answer, index) => ({
                  index,
                  supported:
                    answer.proposedAnswer === "I submit weekly reports",
                  reason: "The resume states this.",
                  evidence: [
                    {
                      kind: "applicant_fact",
                      claim: answer.proposedAnswer,
                      source: "resume",
                      path: "",
                      quote: "Reporting routine: I submit weekly reports",
                    },
                  ],
                })),
              }),
            },
          },
        ],
      });
    }),
  };
}

function send(
  run: ReturnType<typeof attempt>,
  overrides: Partial<
    Parameters<typeof checkClassifiedApplicationAnswers>[0]
  > = {},
) {
  return checkClassifiedApplicationAnswers({
    client: client(),
    sources: sources(),
    payDisclosed: false,
    application: {
      jobId: "7",
      applicationId: RESULT,
      resultId: RESULT,
      startingUrl: PAGE,
    },
    answers: run.card,
    formControls: run.review.controls,
    summaryRows: run.review.summaryRows ?? [],
    stepReceipts: run.receipts,
    sendPage: { origin: ORIGIN, stepIndex: 3, stepTotal: 3 },
    formContext: { pageText: run.review.bodyTextExcerpt, fields: [] },
    ...overrides,
  });
}

test("a confirmed advance records pre-press values under the card's own field keys", () => {
  const run = attempt();
  const advances = run.receipts.filter((receipt) => receipt.kind === "advance");
  expect(
    advances.map((receipt) => [receipt.stepIndex, receipt.stepTotal]),
  ).toEqual([
    [1, 3],
    [2, 3],
  ]);
  const fields = advances.flatMap((receipt) => receipt.fields);
  // Every card answer has exactly one receipt field with its key, repeats too.
  for (const answer of run.card)
    expect(
      fields.filter((entry) => entry.fieldKey === answer.fieldKey),
    ).toEqual([expect.objectContaining({ value: answer.answer })]);
  expect(
    Object.fromEntries(fields.map((entry) => [entry.label, entry.provenance])),
  ).toEqual({
    "First name": "executor_write",
    "Last name": "executor_write",
    Email: "executor_write",
    "Referral code": "site_unchanged",
    "First name (repeated question on step 2)": "site_unchanged",
    "Referral code (repeated question on step 2)": "site_unchanged",
    "Describe your reporting routine": "executor_write",
  });
  expect(run.receipts.at(-1)?.kind).toBe("final");
  expect(run.receipts.every((receipt) => receipt.resultId === RESULT)).toBe(
    true,
  );
});

test("provenance: a refused write is still Nestor's, a reformatted value is what the page showed", () => {
  const tracker = createStepReceiptTracker(RESULT);
  const before = page(1, [
    field(0, "Referral code", "SITE-1"),
    field(1, "Phone", ""),
  ]);
  tracker.observe(before);
  // Nestor tried to change the prefilled value; the site refused and kept it.
  tracker.wrote(before, "c0");
  tracker.wrote(before, "c1");
  const after = page(1, [
    field(0, "Referral code", "SITE-1"),
    field(1, "Phone", "+49301234"),
  ]);
  tracker.observe(after);
  tracker.advance(after, AT);
  const [receipt] = tracker.finish(null, AT);
  expect(
    receipt?.fields.map((entry) => [
      entry.label,
      entry.value,
      entry.provenance,
    ]),
  ).toEqual([
    ["Referral code", "SITE-1", "executor_write"],
    ["Phone", "+49301234", "executor_write"],
  ]);
  // A value the site changed after Nestor first saw it is not unchanged.
  const drifting = createStepReceiptTracker(RESULT);
  drifting.observe(page(1, [field(0, "Referral code", "SITE-1")]));
  const changed = page(1, [field(0, "Referral code", "SITE-2")]);
  drifting.observe(changed);
  drifting.advance(changed, AT);
  expect(drifting.finish(null, AT)[0]?.fields[0]?.provenance).toBe(
    "observed_unverified",
  );
});

test("Send binds all seven earlier-step answers through receipts, rows and current sources", async () => {
  const checks = await send(attempt());
  expect(checks.map((check) => check.supported)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(checks.some((check) => check.priorStep)).toBe(false);
  expect(checks[3]?.reason).toBe(
    "The site filled this and Nestor left it unchanged.",
  );
});

test.each([
  [
    "a review row value that differs from the receipt",
    () => {
      const run = attempt();
      run.review.summaryRows = ROWS.map((row) =>
        row.label === "Referral code" ? { ...row, value: "OTHER-9" } : row,
      );
      return send(run, { summaryRows: run.review.summaryRows });
    },
    "unverified",
  ],
  [
    "a card value that differs from the receipt",
    () => {
      const run = attempt();
      run.card[6] = { ...run.card[6], answer: "I submit monthly reports" };
      return send(run);
    },
    "unverified",
  ],
  [
    "a clamped card value",
    () => {
      const run = attempt();
      run.card[6] = { ...run.card[6], answer: "I submit weekly" };
      return send(run);
    },
    "unverified",
  ],
  ["no review rows", () => send(attempt(), { summaryRows: [] }), "unverified"],
  [
    "an ambiguous row: the same label twice with different values",
    () =>
      send(attempt(), {
        summaryRows: [...ROWS, { label: "Referral code", value: "OTHER-9" }],
      }),
    "unverified",
  ],
  [
    "a receipt from another attempt",
    () =>
      send(attempt(), {
        application: {
          jobId: "7",
          applicationId: "application_7_attempt_2",
          resultId: "application_7_attempt_2",
          startingUrl: PAGE,
        },
      }),
    "no_receipt",
  ],
  [
    "a page on another origin",
    () =>
      send(attempt(), {
        sendPage: {
          origin: "https://other.example.test",
          stepIndex: 3,
          stepTotal: 3,
        },
      }),
    "unverified",
  ],
  [
    "rows in another frame",
    () =>
      send(attempt(), {
        summaryRows: ROWS.map((row) => ({
          ...row,
          frame: { origin: ORIGIN, pathname: "/embedded" },
        })),
      }),
    "unverified",
  ],
  [
    "an unconfirmed press in this attempt",
    () => send(attempt({ unconfirmed: true })),
    "unverified",
  ],
  [
    "a step the person continued (no receipt)",
    () => send(attempt({ skipStepOneReceipt: true })),
    "no_receipt",
  ],
])(
  "%s never sends: the whole send stays with the person",
  async (_name, run, reason) => {
    const checks = await run();
    expect(checks.some((check) => !check.supported)).toBe(true);
    expect(checks.find((check) => check.priorStep)?.priorStep).toBe(reason);
  },
);

test("a Profile change after the receipt fails the current-source check", async () => {
  const checks = await send(attempt(), {
    sources: sources({ firstName: "Jordan", fullName: "Jordan Example" }),
  });
  expect(checks[0]?.supported).toBe(false);
  expect(checks[0]?.priorStep).toBeUndefined();
});

test("a wrong prefilled email is a Profile field, never a site-unchanged pass", async () => {
  const checks = await send(
    attempt({ emailPrefilled: true, email: "someone@other.example" }),
    {
      summaryRows: ROWS.map((row) =>
        row.label === "Email"
          ? { ...row, value: "someone@other.example" }
          : row,
      ),
    },
  );
  expect(checks[2]?.supported).toBe(false);
});

test.each([
  ["a prefilled salary", "Expected salary", "90000"],
  ["a prefilled signature", "Signature", "Jamie Example"],
  ["a prefilled citizenship", "Citizenship", "German"],
])("%s is never accepted as site-unchanged", async (_name, label, value) => {
  const tracker = createStepReceiptTracker(RESULT);
  const one = page(1, [field(0, label, value)]);
  tracker.observe(one);
  tracker.advance(one, AT);
  const review = page(3, [], [{ label, value }]);
  const checks = await checkClassifiedApplicationAnswers({
    client: client(),
    sources: sources(),
    payDisclosed: false,
    application: {
      jobId: "7",
      applicationId: RESULT,
      resultId: RESULT,
      startingUrl: PAGE,
    },
    answers: [
      {
        question: label,
        answer: value,
        fieldKey: reviewFieldKey(one, one.controls[0]),
      },
    ],
    formControls: [],
    summaryRows: review.summaryRows ?? [],
    stepReceipts: tracker.finish(review, AT),
    sendPage: { origin: ORIGIN, stepIndex: 3, stepTotal: 3 },
    formContext: { pageText: "Step 3 of 3", fields: [] },
  });
  expect(checks[0]?.supported).toBe(false);
  expect(checks[0]?.reason).not.toBe(
    "The site filled this and Nestor left it unchanged.",
  );
});

test.each([
  ["another person's prefilled first name", "First name", "Alex"],
  ["another person's prefilled email", "Email", "alex@other.example"],
])("%s left unchanged is never site-unchanged", async (_name, label, value) => {
  const tracker = createStepReceiptTracker(RESULT);
  const one = page(1, [field(0, label, value)]);
  tracker.observe(one);
  tracker.advance(one, AT);
  const review = page(3, [], [{ label, value }]);
  const receipts = tracker.finish(review, AT);
  expect(receipts[0]?.fields[0]?.provenance).toBe("site_unchanged");
  const checks = await checkClassifiedApplicationAnswers({
    client: client(),
    sources: sources(),
    payDisclosed: false,
    application: {
      jobId: "7",
      applicationId: RESULT,
      resultId: RESULT,
      startingUrl: PAGE,
    },
    answers: [
      {
        question: label,
        answer: value,
        fieldKey: reviewFieldKey(one, one.controls[0]),
      },
    ],
    formControls: [],
    summaryRows: review.summaryRows ?? [],
    stepReceipts: receipts,
    sendPage: { origin: ORIGIN, stepIndex: 3, stepTotal: 3 },
    formContext: { pageText: "Step 3 of 3", fields: [] },
  });
  expect(checks[0]?.supported).toBe(false);
  expect(checks[0]?.reason).not.toBe(
    "The site filled this and Nestor left it unchanged.",
  );
});

test("an unread question at Send is never passed as site-unchanged", async () => {
  const checks = await send(attempt(), { client: client({ unread: true }) });
  expect(checks[3]?.supported).toBe(false);
});

test("a choice group's earlier-step answer stays with the person", async () => {
  const tracker = createStepReceiptTracker(RESULT);
  const one = page(1, [
    field(0, "React", "React", {
      inputType: "checkbox",
      checked: true,
      groupLabel: "Skills",
    }),
    field(1, "Vue", "Vue", {
      inputType: "checkbox",
      checked: false,
      groupLabel: "Skills",
    }),
  ]);
  tracker.observe(one);
  tracker.advance(one, AT);
  const stepReceipts: ApplyStepReceipt[] = tracker.finish(
    page(3, [], ROWS),
    AT,
  );
  const member = one.controls[0];
  const checks = await checkClassifiedApplicationAnswers({
    client: client(),
    sources: sources(),
    payDisclosed: false,
    application: {
      jobId: "7",
      applicationId: RESULT,
      resultId: RESULT,
      startingUrl: PAGE,
    },
    answers: [
      {
        question: questionPrompt(member),
        answer: stepReceipts[0].fields[0]?.value ?? "",
        fieldKey: reviewFieldKey(one, member),
      },
    ],
    formControls: [],
    summaryRows: [{ label: questionPrompt(member), value: "React" }],
    stepReceipts,
    sendPage: { origin: ORIGIN, stepIndex: 3, stepTotal: 3 },
    formContext: { pageText: "Step 3 of 3", fields: [] },
  });
  expect(checks[0]).toMatchObject({
    supported: false,
    priorStep: "unverified",
  });
});

test("a single-page form without receipts keeps today's live-control rule", async () => {
  const run = attempt();
  const checks = await send(run, {
    sendPage: { origin: ORIGIN, stepIndex: null, stepTotal: null },
  });
  expect(checks.every((check) => !check.supported)).toBe(true);
  expect(checks.some((check) => check.priorStep)).toBe(false);
  expect(checks[0]?.reason).toBe("The question is no longer present.");
});
