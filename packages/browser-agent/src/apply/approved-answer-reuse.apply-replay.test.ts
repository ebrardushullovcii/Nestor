import { type CandidateReusableAnswer } from "@nestor/contracts";
import { expect, test } from "vitest";
import { savedAnswerForQuestion } from "./application-facts";
import type { ApplyFormControl } from "./types";

const question = "How/when did you start coding?";
const answer =
  "My first recorded engineering role began at Fictional Tools in March 2020. I built internal services.";
const saved: CandidateReusableAnswer = {
  id: "application_approved-response",
  kind: "other",
  label: question,
  question,
  answer,
  roleFamilies: [],
  proofEntryIds: [],
  applicationScope: {
    applicationRecordId: "application_1",
    resultId: null,
    location: null,
  },
};
const field = (ref: string, groupLabel = question): ApplyFormControl => ({
  ref,
  kind: "long_text",
  label: question,
  groupLabel,
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
});

test("only the same question reuses the approval; a distinct section or duplicate target stays ambiguous", () => {
  const current = field("current");
  expect(savedAnswerForQuestion(current, [saved], [current])).toBe(saved);
  const otherSection = field("reference", "Professional reference");
  expect(
    savedAnswerForQuestion(otherSection, [saved], [otherSection]),
  ).toBeNull();
  const second = field("second");
  expect(
    savedAnswerForQuestion(current, [saved], [current, second]),
  ).toBeNull();
  expect(
    savedAnswerForQuestion(
      current,
      [{ ...saved, needsConfirmation: true }],
      [current],
    ),
  ).toBeNull();
});
