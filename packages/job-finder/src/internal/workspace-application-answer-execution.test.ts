import {
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { applicationAnswersForExecution } from "./workspace-application-answer-execution";

const now = "2026-08-10T10:00:00.000Z";

function question(id: string, selectedAnswerId: string | null) {
  return ApplicationQuestionRecordSchema.parse({
    id,
    runId: "run-1",
    jobId: "job-1",
    resultId: "result-1",
    prompt: `Prompt for ${id}`,
    kind: "other",
    isRequired: true,
    detectedAt: now,
    selectedAnswerId,
    status: selectedAnswerId ? "answered" : "detected",
  });
}

function answer(input: {
  id: string;
  questionId: string;
  text: string;
  revision: number;
  status?: "suggested" | "rejected";
}) {
  return ApplicationAnswerRecordSchema.parse({
    id: input.id,
    runId: "run-1",
    jobId: "job-1",
    resultId: "result-1",
    questionId: input.questionId,
    status: input.status ?? "suggested",
    text: input.text,
    value:
      input.status === "rejected" ? null : { type: "text", value: input.text },
    revision: input.revision,
    sourceKind: "user",
    createdAt: now,
  });
}

describe("application answers in prepare-only execution", () => {
  it("injects every selected user-reviewed answer ahead of reusable profile answers", () => {
    const merged = applicationAnswersForExecution({
      questionRecords: [
        question("question-1", "answer-1"),
        question("question-2", "answer-2"),
      ],
      answerRecords: [
        answer({
          id: "answer-1",
          questionId: "question-1",
          text: "First",
          revision: 1,
        }),
        answer({
          id: "answer-2",
          questionId: "question-2",
          text: "Second",
          revision: 1,
        }),
      ],
      idPrefix: "application-run-1",
    });

    expect(merged.slice(0, 2)).toEqual([
      expect.objectContaining({
        question: "Prompt for question-1",
        answer: "First",
      }),
      expect.objectContaining({
        question: "Prompt for question-2",
        answer: "Second",
      }),
    ]);
  });

  it("does not resurrect an answer whose latest revision was cleared", () => {
    const merged = applicationAnswersForExecution({
      questionRecords: [question("question-1", null)],
      answerRecords: [
        answer({
          id: "answer-old",
          questionId: "question-1",
          text: "Old",
          revision: 1,
        }),
        answer({
          id: "answer-cleared",
          questionId: "question-1",
          text: "Answer cleared by the user",
          revision: 2,
          status: "rejected",
        }),
      ],
      idPrefix: "application-run-1",
    });

    expect(merged).toEqual([]);
  });
  it("honors an explicit selection of an older answer despite a newer revision", () => {
    const merged = applicationAnswersForExecution({
      questionRecords: [question("question-1", "answer-old")],
      answerRecords: [
        answer({
          id: "answer-old",
          questionId: "question-1",
          text: "Old",
          revision: 1,
        }),
        answer({
          id: "answer-new",
          questionId: "question-1",
          text: "Two weeks",
          revision: 2,
        }),
      ],
      idPrefix: "application-run-1",
    });
    expect(merged[0]?.answer).toBe("Old");
  });
});

it("keeps the person's pay answers scoped to this application's execution profile", () => {
  const salary = {
    ...question("salary", "salary_answer"),
    prompt: "Expected salary",
    kind: "salary_expectation" as const,
  };
  const currency = {
    ...question("currency", "currency_answer"),
    prompt: "Salary currency",
  };
  const merged = applicationAnswersForExecution({
    questionRecords: [salary, currency],
    answerRecords: [
      answer({
        id: "salary_answer",
        questionId: "salary",
        text: "90000",
        revision: 1,
      }),
      answer({
        id: "currency_answer",
        questionId: "currency",
        text: "EUR",
        revision: 1,
      }),
    ],
    idPrefix: "application_request_pay",
  });
  expect(merged.slice(0, 2)).toEqual([
    expect.objectContaining({
      question: "Expected salary",
      answer: "90000",
    }),
    expect.objectContaining({
      question: "Salary currency",
      answer: "EUR",
    }),
  ]);
  for (const entry of merged.slice(0, 2)) {
    expect(entry.id).toMatch(/^application_request_pay_/);
  }
});

it("an application's own currency survives a newer library-seeded suggestion", () => {
  const own = answer({
    id: "own_currency",
    questionId: "currency",
    text: "GBP",
    revision: 1,
  });
  const library = {
    ...answer({
      id: "seeded_currency",
      questionId: "currency",
      text: "EUR",
      revision: 2,
    }),
    sourceId: "answerLibrary.other_job_currency",
  };
  const merged = applicationAnswersForExecution({
    questionRecords: [
      { ...question("currency", library.id), prompt: "Currency" },
    ],
    answerRecords: [own, library],
    idPrefix: "application_this",
  });
  expect(merged[0]).toMatchObject({
    question: "Currency",
    answer: "GBP",
  });
});

it("Prepare again keeps one-use eligibility on the same application even after a newer agent suggestion", () => {
  const own = {
    ...answer({
      id: "own",
      questionId: "eligibility",
      text: "Yes",
      revision: 1,
    }),
    applicationRecordId: "application_a",
    hiringCountry: "Germany",
    saveScope: "application_once" as const,
  };
  const proposed = {
    ...own,
    id: "agent",
    sourceKind: "profile" as const,
    text: "No",
    revision: 2,
  };
  const currentQuestion = {
    ...question("eligibility", proposed.id),
    kind: "work_authorization" as const,
    applicationRecordId: "application_a",
    resultId: "prepare_again",
    prompt: "Are you authorized to work in Germany?",
  };
  const merged = applicationAnswersForExecution({
    questionRecords: [currentQuestion],
    answerRecords: [own, proposed],
    idPrefix: "application_a",
    applicationRecordId: "application_a",
    jobLocation: "Hamburg, Germany",
  });
  expect(merged[0]).toMatchObject({
    question: currentQuestion.prompt,
    answer: "Yes",
    applicationScope: {
      resultId: "prepare_again",
      applicationRecordId: "application_a",
      location: "Hamburg, Germany",
      hiringCountry: "Germany",
    },
  });
  expect(
    applicationAnswersForExecution({
      questionRecords: [currentQuestion],
      answerRecords: [own, proposed],
      idPrefix: "application_b",
      applicationRecordId: "application_b",
      jobLocation: "Hamburg, Germany",
    }),
  ).toEqual([]);
});
