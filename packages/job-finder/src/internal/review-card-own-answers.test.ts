import {
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReviewCardSchema,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { creditOwnApplicationAnswers } from "./review-card-own-answers";

const scope = {
  runId: "earlier_run",
  jobId: "job_1",
  applicationRecordId: "application_1",
  resultId: "earlier_result",
};
const question = ApplicationQuestionRecordSchema.parse({
  ...scope,
  id: "question_background",
  prompt: "I consent to a background check",
  detectedAt: "2026-10-03T10:00:00.000Z",
});
const answer = (text: string, sourceKind: "user" | "profile" = "user") =>
  ApplicationAnswerRecordSchema.parse({
    ...scope,
    id: `answer_${text}`,
    questionId: question.id,
    revision: 1,
    status: "suggested",
    text,
    sourceKind,
    sourceId: "earlier_request",
    createdAt: "2026-10-03T10:01:00.000Z",
  });
const card = ApplicationReviewCardSchema.parse({
  siteLabel: "Example",
  pageUrl: "https://jobs.example.test/apply",
  preparedAt: "2026-10-06T10:00:00.000Z",
  answers: [
    {
      question: "I consent to a background check",
      answer: "Yes",
      source: "your answer to this question",
      sourceId: "answerLibrary.application_background",
      written: false,
    },
  ],
});

test("a box ticked from the person's earlier answer in this application is credited to them", () => {
  const credited = creditOwnApplicationAnswers(
    card,
    [question],
    [answer("Yes, I consent")],
  );
  expect(credited?.answers[0]).toMatchObject({
    source: "your answer to this question",
    sourceId: "applicationAnswer.answer_Yes, I consent",
  });
});

test("without the person's own record the answer is left for the screen to check", () => {
  for (const records of [[], [answer("No")], [answer("Yes", "profile")]]) {
    expect(
      creditOwnApplicationAnswers(card, [question], records)?.answers[0]
        ?.sourceId,
    ).toBe("answerLibrary.application_background");
  }
  expect(creditOwnApplicationAnswers(null, [question], [])).toBeNull();
});
