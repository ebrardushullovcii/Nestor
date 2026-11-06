import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import meanings from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/saved-question-meanings.json";
import {
  relevantSavedAnswers,
  savedAnswerForQuestion,
  serializeApplicationData,
  storedFacts,
} from "./application-facts";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

test("saved-answer model context keeps every confirmed answer and brings exact visible questions first", () => {
  const answers = Array.from({ length: 200 }, (_, index) => ({
    id: `saved_${index}`,
    kind: "other" as const,
    label: `Question ${index}`,
    question: `Question ${index}`,
    answer: "A recorded answer. ".repeat(30),
    roleFamilies: [],
    proofEntryIds: [],
  }));
  const selected = relevantSavedAnswers(
    [...answers, { ...answers[0], id: "unconfirmed", needsConfirmation: true }],
    ["Question 199"],
  );
  expect(selected[0]?.id).toBe("saved_199");
  expect(selected).toHaveLength(answers.length + 1);
  expect(selected.some((answer) => answer.id === "unconfirmed")).toBe(true);
});

test.each(meanings.cases)(
  "current-form saved-meaning replay: $asked",
  (entry) => {
    const target = {
      ...control,
      ref: "target",
      label: entry.asked,
      groupLabel: "Application questions",
    };
    const saved = {
      id: "person-answer",
      kind: "other" as const,
      label: entry.saved,
      question: entry.saved,
      answer: entry.answer,
      roleFamilies: [],
      proofEntryIds: [],
    };
    expect(savedAnswerForQuestion(target, [saved], [target])?.id ?? null).toBe(
      entry.matches ? saved.id : null,
    );
  },
);

test.each(meanings.cases.filter((entry) => entry.matches))(
  "two current questions with one meaning stay ambiguous: $saved",
  (entry) => {
    const first = {
      ...control,
      ref: "first",
      label: entry.asked,
      groupLabel: "First section",
    };
    const second = {
      ...control,
      ref: "second",
      label: entry.saved,
      groupLabel: "Second section",
    };
    const saved = {
      id: "person-answer",
      kind: "other" as const,
      label: entry.saved,
      question: entry.saved,
      answer: entry.answer,
      roleFamilies: [],
      proofEntryIds: [],
    };
    expect(savedAnswerForQuestion(first, [saved], [first, second])).toBeNull();
  },
);

test("prompt data keeps unknown, No, zero and scoped facts without empty strings or lists", () => {
  const facts = {
    missing: null,
    blank: "",
    empty: [],
    unknown: undefined,
    answers: { sponsorship: false, years: 0, notice: "No", country: "Germany" },
    saved: [
      {
        question: "Available hours?",
        answer: "0",
        applicationScope: { hiringCountry: "Germany" },
      },
    ],
  };
  expect(JSON.parse(serializeApplicationData(facts))).toEqual({
    missing: null,
    answers: facts.answers,
    saved: facts.saved,
  });
});

const sources: ApplyAnswerSources = {
  profile: CandidateProfileSchema.parse({
    id: "facts",
    fullName: "Li Wu",
    firstName: "Li",
    lastName: "Wu",
    phone: "+12025550123",
    yearsExperience: 3,
    experiences: [
      {
        id: "role",
        companyName: "Fixture Tools",
        title: "Engineer",
        startDate: "2024-03",
      },
      { id: "draft-role", title: "Unconfirmed role", isDraft: true },
    ],
    education: [
      { id: "school", schoolName: "Fixture University", degree: "BSc" },
      { id: "draft-school", schoolName: "Unconfirmed school", isDraft: true },
    ],
    skills: ["Go", "TypeScript"],
    baseResume: {
      id: "resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-05T10:00:00.000Z",
    },
  }),
  resumeText: null,
  posting: {
    title: "Engineer",
    company: "Fixture Tools",
    location: "Remote",
    description: "Build tools.",
  },
  documents: [],
  reusableAnswers: [
    {
      id: "pay",
      kind: "salary_expectation",
      label: "Expected pay",
      question: "Expected salary",
      answer: "45000",
      roleFamilies: [],
      proofEntryIds: [],
    },
    {
      id: "confirmed",
      kind: "other",
      label: "Your answer",
      question: "Can you attend?",
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
    },
    {
      id: "draft",
      kind: "other",
      label: "Draft answer",
      question: "Question",
      answer: "Unconfirmed answer",
      needsConfirmation: true,
      roleFamilies: [],
      proofEntryIds: [],
    },
  ],
};
const control: ApplyFormControl = {
  ref: "c0",
  kind: "text",
  label: "Question",
  groupLabel: "",
  placeholder: "",
  required: true,
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  checked: false,
  options: [],
  selectedOptionLabel: "",
  invalid: false,
  validationMessage: "",
  questionKind: "other",
  answerControlType: "text",
  attestationKind: null,
  answered: false,
};

// Exact equality is mechanics; the model still chooses which fact answers a question.

test("draft records, pending answers and private pay are absent from the catalog", () => {
  const facts = storedFacts(sources, { payDisclosed: false });
  expect(facts.some((fact) => fact.sourceId.includes("draft"))).toBe(false);
  expect(
    facts.some((fact) => fact.sourceId.includes("salaryExpectations")),
  ).toBe(false);
  expect(
    facts.some((fact) => fact.sourceId.includes("workAuthorization")),
  ).toBe(false);
});
