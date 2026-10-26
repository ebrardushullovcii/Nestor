import { expect, test } from "vitest";
import {
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import { describeFormQuestion, type FormQuestion } from "./questions";

test("the same question keeps its key across wizard headings, without discarding scope or meaningful group context", () => {
  const field: FormQuestion = {
    prompt: "Are you willing to relocate?",
    kind: "relocation",
    answerControlType: "boolean",
    answerOptions: ["Yes", "No"],
  };
  const place = { id: 1, location: "Fully remote, Worldwide" };
  const plain = describeFormQuestion(field, place).key;
  for (const prefix of [
    "Application",
    "Step 4 of 6: Eligibility questions",
    "Application — Step 2 of 3: Questions",
  ])
    expect(
      describeFormQuestion(
        { ...field, prompt: `${prefix} — ${field.prompt} *` },
        { ...place, id: 2 },
      ).key,
    ).toBe(plain);
  expect(
    describeFormQuestion(field, { ...place, location: "Germany" }).key,
  ).not.toBe(plain);
  expect(normalizeFormQuestionPrompt("Employment — From")).not.toBe(
    normalizeFormQuestionPrompt("Education — From"),
  );
  expect(
    cleanFormQuestionPrompt("Step 4 of 6: Questions — Employment — From"),
  ).toBe("Employment — From");
});
