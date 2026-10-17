import { expect, it } from "vitest";
import {
  ApplyRunDetailsSchema,
  ApplicationReviewCardSchema,
} from "@nestor/contracts";
import { withPersonAnswerSources } from "./application-review-source";
it("keeps a person's checkbox-group answer attributed to them when the form changes separators", () => {
  const at = "2026-10-05T10:00:00.000Z";
  const card = ApplicationReviewCardSchema.parse({
    siteLabel: "Example",
    pageUrl: "https://example.test/apply",
    preparedAt: at,
    answers: [
      {
        question: "Work areas",
        answer: "Finance; Reporting",
        source: "the filled application form",
        written: false,
        groundedIn: [],
      },
    ],
    attachments: [],
    letter: null,
    waitingOnYou: [],
  });
  const details = ApplyRunDetailsSchema.parse({
    run: {
      id: "run",
      source: "target_site",
      mode: "single_job_auto",
      state: "completed",
      summary: "Prepared",
      detail: "Ready to review",
      jobIds: ["job"],
      createdAt: at,
      updatedAt: at,
    },
    questionRecords: [
      {
        id: "question",
        runId: "run",
        jobId: "job",
        prompt: "Work areas",
        detectedAt: at,
        answerControlType: "multi_choice",
        selectedAnswerId: "answer",
      },
    ],
    answerRecords: [
      {
        id: "answer",
        runId: "run",
        jobId: "job",
        questionId: "question",
        text: "Reporting, Finance",
        sourceKind: "user",
        status: "filled",
        createdAt: at,
      },
    ],
  });
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "your answer to this question",
  );
  details.answerRecords[0]!.text = '["Reporting","Finance"]';
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "your answer to this question",
  );
  details.answerRecords[0]!.text = '["Reporting","Communication, mentoring"]';
  card.answers[0]!.answer = "Communication, mentoring; Reporting";
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "the filled application form",
  );
  card.answers[0]!.answer = '["Communication, mentoring","Reporting"]';
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "your answer to this question",
  );
  details.questionRecords[0]!.selectedAnswerId = null;
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "your answer to this question",
  );
  details.answerRecords[0]!.sourceId = "answerLibrary.saved_motivation";
  details.answerRecords[0]!.provenance = [
    {
      id: "source",
      sourceKind: "user",
      sourceId: "answerLibrary.saved_motivation",
      label: 'your saved answer "Platform work motivation"',
      snippet: null,
    },
  ];
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    'your saved answer "Platform work motivation"',
  );
  details.answerRecords[0]!.sourceKind = "profile";
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    'your saved answer "Platform work motivation"',
  );
  // An unused suggestion is never evidence that the person supplied a filled value.
  details.answerRecords[0]!.status = "suggested";
  card.answers[0]!.source = "your answer to this question";
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "the filled application form",
  );
  details.answerRecords[0]!.status = "filled";
  details.answerRecords[0]!.sourceId = "authority.attestation.background_check";
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "your Settings (on by default)",
  );
});

it("does not label an unused zero suggestion as the person's answer", () => {
  const at = "2026-10-05T10:00:00Z";
  const card = ApplicationReviewCardSchema.parse({
    siteLabel: "Example",
    preparedAt: at,
    answers: [
      {
        question: "Years of reporting experience",
        answer: "0",
        source: "the filled application form",
        written: false,
        groundedIn: [],
      },
    ],
  });
  const details = ApplyRunDetailsSchema.parse({
    run: {
      id: "run",
      state: "completed",
      summary: "Prepared",
      detail: "Ready",
      jobIds: ["job"],
      createdAt: at,
      updatedAt: at,
    },
    questionRecords: [
      {
        id: "question",
        runId: "run",
        jobId: "job",
        prompt: "Years of reporting experience",
        detectedAt: at,
      },
    ],
    answerRecords: [
      {
        id: "suggestion",
        runId: "run",
        jobId: "job",
        questionId: "question",
        text: "0",
        sourceKind: "user",
        status: "suggested",
        createdAt: at,
      },
    ],
  });
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "the filled application form",
  );
  details.answerRecords[0]!.status = "filled";
  details.answerRecords[0]!.sourceKind = "prior_answer";
  details.answerRecords[0]!.sourceId = "generated.reporting";
  details.answerRecords[0]!.provenance = [
    {
      id: "source",
      sourceId: "generated.reporting",
      sourceKind: "prior_answer",
      label: "your profile",
      snippet: null,
    },
  ];
  expect(withPersonAnswerSources(card, details).answers[0]).toMatchObject({
    source: "your profile",
    written: true,
    groundedIn: ["your profile"],
  });
});

it("credits an answer the person gave in the app, stored as a suggestion until the form takes it", () => {
  const at = "2026-10-05T10:00:00.000Z";
  const card = ApplicationReviewCardSchema.parse({
    siteLabel: "Example",
    pageUrl: "https://example.test/apply",
    preparedAt: at,
    answers: [
      {
        question: "Expected salary",
        answer: "55000",
        source: "your answer to this question",
        written: false,
        groundedIn: [],
      },
    ],
    attachments: [],
    letter: null,
    waitingOnYou: [],
  });
  const details = ApplyRunDetailsSchema.parse({
    run: {
      id: "run",
      source: "target_site",
      mode: "single_job_auto",
      state: "completed",
      summary: "Prepared",
      detail: "Ready to review",
      jobIds: ["job"],
      createdAt: at,
      updatedAt: at,
    },
    questionRecords: [
      {
        id: "question",
        runId: "run",
        jobId: "job",
        prompt: "Expected salary",
        detectedAt: at,
        answerControlType: "text",
        selectedAnswerId: "answer",
      },
    ],
    answerRecords: [
      {
        id: "answer",
        runId: "run",
        jobId: "job",
        questionId: "question",
        text: "55000",
        sourceKind: "user",
        status: "suggested",
        createdAt: at,
      },
    ],
  });
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "your answer to this question",
  );
  // A rejected answer of theirs is not what went out.
  details.answerRecords[0]!.status = "rejected";
  expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
    "the filled application form",
  );
});

it.each([
  ["answerLibrary.saved_declaration", "your answer to this question"],
  ["applicationAnswer.approved_answer", "your answer to this question"],
  [
    "authority.attestation.background_check_consent",
    "your Settings (on by default)",
  ],
])(
  "keeps the run's declaration source %s without a question record",
  (sourceId, source) => {
    const at = "2026-10-06T10:00:00.000Z";
    const card = ApplicationReviewCardSchema.parse({
      siteLabel: "Example",
      preparedAt: at,
      answers: [
        {
          question: "I consent to a background check",
          answer: "Yes",
          source,
          sourceId,
          written: false,
        },
      ],
    });
    const details = ApplyRunDetailsSchema.parse({
      run: {
        id: "run",
        state: "completed",
        summary: "Prepared",
        detail: "Ready",
        jobIds: ["job"],
        createdAt: at,
        updatedAt: at,
      },
    });
    expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
      source,
    );
  },
);

it.each([
  undefined,
  "observed.c0",
  "generated.experience",
  "answerLibrary.application_unused_suggestion",
  "profile.experience",
])(
  "downgrades an unsupported claim about the person's zero answer (source id %s)",
  (sourceId) => {
    const at = "2026-10-06T10:00:00.000Z";
    const card = ApplicationReviewCardSchema.parse({
      siteLabel: "Example",
      preparedAt: at,
      answers: [
        {
          question: "Years of experience",
          answer: "0",
          source: "your answer to this question",
          ...(sourceId ? { sourceId } : {}),
          written: false,
        },
      ],
    });
    const details = ApplyRunDetailsSchema.parse({
      run: {
        id: "run",
        state: "completed",
        summary: "Prepared",
        detail: "Ready",
        jobIds: ["job"],
        createdAt: at,
        updatedAt: at,
      },
    });
    expect(withPersonAnswerSources(card, details).answers[0]?.source).toBe(
      "the filled application form",
    );
  },
);
