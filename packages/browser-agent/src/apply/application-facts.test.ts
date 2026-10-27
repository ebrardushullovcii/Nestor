import meanings from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/saved-question-meanings.json";
import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import {
  savedAnswerForQuestion,
  serializeApplicationData,
  storedFactFor,
  storedFacts,
  relevantSavedAnswers,
} from "./application-facts";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

test("saved-answer model context is bounded and brings exact visible questions first", () => {
  const answers = Array.from({ length: 200 }, (_, index) => ({
    id: `saved_${index}`,
    kind: "other" as const,
    label: `Question ${index}`,
    question: `Question ${index}`,
    answer: "A recorded answer. ".repeat(30),
    roleFamilies: [],
    proofEntryIds: [],
  }));
  const selected = relevantSavedAnswers(answers, ["Question 199"]);
  expect(selected[0]?.id).toBe("saved_199");
  expect(
    JSON.stringify(
      selected.map(({ id, question, answer }) => ({ id, question, answer })),
    ).length,
  ).toBeLessThan(12500);
  expect(selected.length).toBeLessThan(answers.length);
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
test.each([
  ["profile.firstName", "Li"],
  ["profile.lastName", "Wu"],
  ["profile.skills.0", "Go"],
  ["profile.experiences.role.companyName", "Fixture Tools"],
  ["profile.experiences.role.startDate", "2024-03"],
  ["profile.education.school.schoolName", "Fixture University"],
])(
  "exact fact %s is usable without a model answer check",
  (storedFactId, value) => {
    expect(
      storedFactFor({
        sources,
        payDisclosed: true,
        control,
        value,
        storedFactId,
      })?.sourceId,
    ).toBe(storedFactId);
  },
);

test.each([
  ["profile.phone", "12025550123"],
  ["profile.firstName", "LI"],
  ["profile.experiences.role.startDate", "2024-03-01"],
  ["profile.education.school.degree", "Bachelor of Science"],
  ["missing", "Fixture Tools"],
])(
  "changed or mismatched fact %s falls back to checking",
  (storedFactId, value) => {
    expect(
      storedFactFor({
        sources,
        payDisclosed: true,
        control,
        value,
        storedFactId,
      }),
    ).toBeNull();
  },
);

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

test.each(["work_authorization", "visa_sponsorship"] as const)(
  "eligibility %s still needs its question and hiring context checked",
  (questionKind) => {
    expect(
      storedFactFor({
        sources,
        payDisclosed: true,
        control: { ...control, questionKind },
        value: "Yes",
        storedFactId: "answerLibrary.confirmed",
      }),
    ).toBeNull();
  },
);

test("expected pay is never a direct fact for current-pay questions", () => {
  expect(
    storedFactFor({
      sources,
      payDisclosed: true,
      control: { ...control, asksCurrentPay: true },
      value: "45000",
      storedFactId: "answerLibrary.pay",
    }),
  ).toBeNull();
});

test("residence cannot bypass the hiring-country check", () => {
  const profile = { ...sources.profile, currentCountry: "United States" };
  expect(
    storedFactFor({
      sources: { ...sources, profile },
      payDisclosed: true,
      control: { ...control, asksHiringCountry: true },
      value: "United States",
      storedFactId: "profile.currentCountry",
    }),
  ).toBeNull();
});

test.each([
  ["profile.yearsExperience", "3", control],
  ["answerLibrary.confirmed", "Yes", control],
  ["answerLibrary.pay", "45000", control],
])(
  "a short value from %s needs a check when it is not this question's own answer",
  (storedFactId, value, target) => {
    expect(
      storedFactFor({
        sources,
        payDisclosed: true,
        control: target,
        value,
        storedFactId,
      }),
    ).toBeNull();
  },
);

test("a saved short answer skips the check on its own question, saved pay on a pay question", () => {
  expect(
    storedFactFor({
      sources,
      payDisclosed: true,
      control: { ...control, label: "Can you attend?" },
      value: "Yes",
      storedFactId: "answerLibrary.confirmed",
    })?.sourceId,
  ).toBe("answerLibrary.confirmed");
  expect(
    storedFactFor({
      sources,
      payDisclosed: true,
      control: {
        ...control,
        label: "Expected salary",
        questionKind: "salary_expectation",
      },
      value: "45000",
      storedFactId: "answerLibrary.pay",
    })?.sourceId,
  ).toBe("answerLibrary.pay");
});
