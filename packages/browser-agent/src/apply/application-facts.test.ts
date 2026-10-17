import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import { storedFactFor, storedFacts } from "./application-facts";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

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
    answerBank: { salaryExpectations: "45000", workAuthorization: "Yes" },
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
      storedFactId: "profile.answerBank.salaryExpectations",
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
  ["profile.answerBank.salaryExpectations", "45000", control],
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
      control: { ...control, questionKind: "salary_expectation" },
      value: "45000",
      storedFactId: "profile.answerBank.salaryExpectations",
    })?.sourceId,
  ).toBe("profile.answerBank.salaryExpectations");
});
