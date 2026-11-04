import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import {
  nextPathStep,
  planReplay,
  replayStillCurrent,
  screenKey,
  type FormReplayAnswer,
} from "./form-replay";
import { buildApplyFormObservation } from "./page-hands";
import { questionPrompt } from "./policy-executor";
import type { ApplyAnswerSources } from "./types";

type Field = {
  type: "radio" | "checkbox" | "text" | "select";
  name: string;
  label: string;
  group?: string;
  checked?: boolean;
  value?: string;
  options?: string[];
};

function page(fields: Field[]) {
  return buildApplyFormObservation(
    {
      url: "https://replica.test/apply",
      title: "Apply",
      bodyText: "Apply",
      controls: fields.map((field, index) => ({
        index,
        tagName: field.type === "select" ? "select" : "input",
        inputType: field.type === "select" ? "" : field.type,
        role: "",
        id: `f${index}`,
        name: field.name,
        scopeKey: "form0",
        label: field.label,
        groupLabel: field.group ?? "",
        placeholder: "",
        autocomplete: "",
        // As on the replicas: a box group is optional per box.
        required: field.type !== "checkbox",
        invalid: false,
        validationMessage: "",
        disabled: false,
        readOnly: false,
        visible: true,
        value:
          field.value ??
          (field.type === "radio" || field.type === "checkbox"
            ? field.label
            : ""),
        checked: field.checked ?? false,
        multiple: false,
        options: field.options ?? [],
        selectedOptionLabel: field.type === "select" ? (field.value ?? "") : "",
      })),
      actions: [],
      links: [],
      clickables: [],
      headings: [],
      openedTabs: [],
      validationErrors: [],
      loading: false,
      stepLabel: "Step 1 of 1",
    },
    "2026-11-03T00:00:00Z",
  );
}

const stored = (
  observation: ReturnType<typeof page>,
  name: string,
  answer: string,
  sourceId: string,
): FormReplayAnswer => ({
  question: questionPrompt(
    observation.controls.find(
      (control) => control.label === name || control.groupLabel.endsWith(name),
    )!,
  ),
  answer,
  source: "earlier run",
  sourceId,
  written: false,
  groundedIn: [],
});

const replay = (answers: FormReplayAnswer[]) => ({
  answers,
  attachments: [],
  path: [],
});

const toggles = (plan: ReturnType<typeof planReplay>) =>
  plan.writes.map(({ write }) => [
    write.control.label,
    write.kind === "toggle" ? write.checked : write.value,
  ]);

function sources(
  reusable: ApplyAnswerSources["reusableAnswers"] = [],
): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      fullName: "Alex Vanguard",
      firstName: "Alex",
      yearsExperience: 2,
      baseResume: {
        id: "resume",
        fileName: "resume.txt",
        uploadedAt: "2026-10-01T00:00:00.000Z",
        extractionStatus: "ready",
      },
    }),
    resumeText: null,
    posting: { title: "", company: "", location: "", description: "" },
    reusableAnswers: reusable,
    documents: [],
  };
}

const saved = (id: string, question: string, answer: string) => ({
  id,
  kind: "other" as const,
  label: question,
  question,
  answer,
  roleFamilies: [],
  proofEntryIds: [],
});

const relocate = (yes: boolean, no: boolean) =>
  page([
    {
      type: "radio",
      name: "relocate",
      label: "Yes",
      group: "Are you willing to relocate?",
      checked: yes,
    },
    {
      type: "radio",
      name: "relocate",
      label: "No",
      group: "Are you willing to relocate?",
      checked: no,
    },
  ]);

test("an unchanged saved dropdown answer replaces a contradictory occupied option", () => {
  const shown = page([
    {
      type: "select",
      name: "notice",
      label: "Notice period",
      value: "Two weeks",
      options: ["Two weeks", "One month"],
    },
  ]);
  const answer = stored(
    shown,
    "Notice period",
    "One month",
    "answerLibrary.notice",
  );
  const current = replayStillCurrent({
    controls: shown.controls,
    sources: sources([saved("notice", "Notice period", "One month")]),
    approvedAttestations: [],
  });
  expect(toggles(planReplay(shown, replay([answer]), current))).toEqual([
    ["Notice period", "One month"],
  ]);
});

test("a stale checked radio is replaced by the stored member, and the exact member is kept", () => {
  const stale = relocate(true, false);
  const answer = stored(
    stale,
    "Are you willing to relocate?",
    "No",
    "answerLibrary.application_1",
  );
  expect(toggles(planReplay(stale, replay([answer])))).toEqual([["No", true]]);
  const right = relocate(false, true);
  expect(planReplay(right, replay([answer]))).toMatchObject({
    writes: [],
    kept: 1,
  });
});

const skills = (checked: string[]) =>
  page(
    ["Writing, editing", "Mentoring", "Planning"].map((label) => ({
      type: "checkbox" as const,
      name: "skills",
      label,
      group: "Select your skills",
      checked: checked.includes(label),
    })),
  );

test("a checkbox set restores exactly: stale options unticked, a comma label kept whole", () => {
  const observation = skills(["Writing, editing", "Planning"]);
  const answer = stored(
    observation,
    "Select your skills",
    '["Writing, editing","Mentoring"]',
    "answerLibrary.application_2",
  );
  // Only the differences are written: Mentoring ticked, Planning unticked.
  expect(toggles(planReplay(observation, replay([answer])))).toEqual([
    ["Mentoring", true],
    ["Planning", false],
  ]);
  const exact = skills(["Writing, editing", "Mentoring"]);
  expect(planReplay(exact, replay([answer]))).toMatchObject({
    writes: [],
    kept: 1,
  });
  // The review card shows the set comma-joined. The form's own labels split
  // it one way only, so the comma label stays one option.
  const shown = { ...answer, answer: "Writing, editing, Mentoring" };
  expect(toggles(planReplay(observation, replay([shown])))).toEqual([
    ["Mentoring", true],
    ["Planning", false],
  ]);
  // When "Writing" and "editing" are options too, two readings exist:
  // nothing is guessed.
  const ambiguous = page(
    ["Writing, editing", "Writing", "editing", "Mentoring"].map((label) => ({
      type: "checkbox" as const,
      name: "skills",
      label,
      group: "Select your skills",
    })),
  );
  const plan = planReplay(ambiguous, replay([shown]));
  expect(plan.writes).toEqual([]);
  expect(plan.missing).toHaveLength(1);
});

test("the person's changed saved answer replaces the stored one, even over a kept value", () => {
  const observation = page([
    {
      type: "select",
      name: "notice",
      label: "Notice period",
      value: "One month",
      options: ["Two weeks", "One month"],
    },
  ]);
  const answer = stored(
    observation,
    "Notice period",
    "One month",
    "answerLibrary.application_3",
  );
  const now = (value: string) =>
    replayStillCurrent({
      controls: observation.controls,
      sources: sources([saved("application_3", "Notice period", value)]),
      approvedAttestations: [],
    });
  expect(
    planReplay(observation, replay([answer]), now("One month")),
  ).toMatchObject({ writes: [], kept: 1 });
  expect(
    toggles(planReplay(observation, replay([answer]), now("Two weeks"))),
  ).toEqual([["Notice period", "Two weeks"]]);
  // Forgotten since: not restored, and not carried on as kept.
  const forgotten = planReplay(
    observation,
    replay([answer]),
    replayStillCurrent({
      controls: observation.controls,
      sources: sources(),
      approvedAttestations: [],
    }),
  );
  expect(forgotten).toMatchObject({ writes: [], kept: 0, withdrawn: [answer] });
});

test("a changed saved radio answer moves the selection rather than keeping the old member", () => {
  const observation = relocate(true, false);
  const answer = stored(
    observation,
    "Are you willing to relocate?",
    "Yes",
    "answerLibrary.application_4",
  );
  const plan = planReplay(
    observation,
    replay([answer]),
    replayStillCurrent({
      controls: observation.controls,
      sources: sources([
        saved("application_4", "Are you willing to relocate?", "No"),
      ]),
      approvedAttestations: [],
    }),
  );
  expect(toggles(plan)).toEqual([["No", true]]);
});

test("a declaration whose approval was revoked is unticked, not restored", () => {
  const observation = page([
    {
      type: "checkbox",
      name: "certify",
      label: "I certify that the information is true",
      checked: true,
      value: "yes",
    },
  ]);
  const answer = stored(
    observation,
    "I certify that the information is true",
    "Yes",
    "authority.attestation.truthfulness_certification",
  );
  const check = (approved: boolean) =>
    planReplay(
      observation,
      replay([answer]),
      replayStillCurrent({
        controls: observation.controls,
        sources: sources(),
        approvedAttestations: approved ? ["truthfulness_certification"] : [],
      }),
    );
  expect(check(true)).toMatchObject({ writes: [], kept: 1 });
  const revoked = check(false);
  expect(toggles(revoked)).toEqual([
    ["I certify that the information is true", false],
  ]);
  expect(revoked.withdrawn).toEqual([answer]);
});

test("a corrected Profile fact is not overwritten by the stored old value", () => {
  const observation = page([
    { type: "text", name: "first", label: "First name" },
  ]);
  const answer = stored(
    observation,
    "First name",
    "Alexa",
    "profile.firstName",
  );
  const plan = planReplay(
    observation,
    replay([answer]),
    replayStillCurrent({
      controls: observation.controls,
      sources: sources(),
      approvedAttestations: [],
    }),
  );
  expect(plan).toMatchObject({ writes: [], withdrawn: [answer] });
  const same = { ...answer, answer: "Alex" };
  expect(
    toggles(
      planReplay(
        observation,
        replay([same]),
        replayStillCurrent({
          controls: observation.controls,
          sources: sources(),
          approvedAttestations: [],
        }),
      ),
    ),
  ).toEqual([["First name", "Alex"]]);
});

// Captured ledgerleaf replay path (candidate 2): after a restart the recorded
// "Add another work history entry" press was replayed onto a fresh page and
// the new rows were filled from one record. An old press never adds a row.
test("a recorded add-row press is not replayed; the recorded way on is, every time", () => {
  const observation = buildApplyFormObservation(
    {
      url: "https://replica.test/ledgerleaf/apply/3",
      title: "Apply",
      bodyText: "Work history (optional)",
      controls: [],
      actions: ["Add another work history entry", "Next"].map(
        (label, index) => ({ index, label, visible: true, disabled: false }),
      ),
      links: [],
      clickables: [],
      headings: [],
      openedTabs: [],
      validationErrors: [],
      loading: false,
      stepLabel: "Step 2 of 6: 2. Work history (optional)",
    },
    "2026-11-03T00:00:00Z",
  );
  const from = screenKey(observation);
  const replayed = {
    answers: [],
    attachments: [],
    path: [
      { from, tool: "click" as const, label: "Add another work history entry" },
      { from, tool: "click" as const, label: "Next" },
    ],
  };
  for (const restart of [1, 2]) {
    const next = nextPathStep(observation, replayed, new Set());
    expect({ restart, label: next?.step.label }).toEqual({
      restart,
      label: "Next",
    });
    expect(
      next && nextPathStep(observation, replayed, new Set([next.index])),
    ).toBeNull();
  }
});
