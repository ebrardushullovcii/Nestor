import {
  type RawApplyControl,
  type RawApplyPage,
  type RawApplySummaryRow,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { reviewFieldKey } from "./form-replay";
import { buildApplyFormObservation } from "./page-hands";
import { questionPrompt } from "./policy-executor";
import { createStepReceiptTracker } from "./step-receipts";
import type { ApplyFormObservation } from "./types";

// The native case-2 shape (council D1): a three-step wizard that removes each
// step's controls before a control-free review step listing dt/dd rows.
const ORIGIN = "https://replica.example.test";
const PAGE = `${ORIGIN}/case2/apply`;
const RESULT = "application_7_attempt_1";
const AT = "2026-11-04T01:00:00.000Z";

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
    field(3, "Referral code", referral, { required: false }),
  ]);
  tracker.observe(first);
  for (const ref of options.emailPrefilled ? ["c0", "c1"] : ["c0", "c1", "c2"])
    tracker.wrote(first, ref);
  const one = page(1, [
    field(0, "First name", "Jamie"),
    field(1, "Last name", "Example"),
    field(2, "Email", email, { inputType: "email" }),
    field(3, "Referral code", referral, { required: false }),
  ]);
  tracker.observe(one);
  if (!options.skipStepOneReceipt) tracker.advance(one, AT);
  const secondControls = (reportingValue: string) => [
    field(0, "First name", "Jamie", { readOnly: true }),
    field(1, "Referral code", referral, { readOnly: true, required: false }),
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
