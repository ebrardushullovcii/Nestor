// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UserActionRequestSchema } from "@nestor/contracts";
import { ApplicationAnswerStepCard } from "./applications-answer-step";
afterEach(cleanup);
it("offers Skip beside the waiting application's questions without authorizing a send", () => {
  const at = "2026-10-05T10:00:00.000Z";
  const request = UserActionRequestSchema.parse({
    id: "request",
    revision: 1,
    dedupeKey: "request",
    kind: "manual_answer",
    state: "awaiting_user",
    scope: {
      type: "application",
      runId: "run",
      jobId: "job",
      applicationRecordId: "application",
      source: "target_site",
    },
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: "question",
    },
    title: "Answer needed",
    summary: "Answer needed",
    createdAt: at,
    updatedAt: at,
  });
  const onCommand = vi.fn();
  render(
    <ApplicationAnswerStepCard
      step={{
        request,
        questions: [
          {
            id: "question",
            prompt: "Notice period",
            kind: "other",
            isRequired: true,
            detectedAt: at,
            answerOptions: [],
            suggestedAnswers: [],
            submittedAnswer: null,
            status: "detected",
          },
        ],
        isPending: false,
        onCommand,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Skip this job" }));
  expect(onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: request.id,
      action: "cancel",
      submitAuthorized: false,
    }),
  );
  expect(screen.getByText(/history is kept/)).toBeTruthy();
});

it("shows the same step prefix on a multi-choice skills question", () => {
  const at = "2026-10-05T10:00:00.000Z";
  const request = UserActionRequestSchema.parse({
    id: "skills_request",
    revision: 1,
    dedupeKey: "skills_request",
    kind: "manual_answer",
    state: "awaiting_user",
    scope: {
      type: "application",
      runId: "run",
      jobId: "job",
      applicationRecordId: "application",
      source: "target_site",
    },
    verification: { type: "page_blocker_absent", blockerFingerprint: "skills" },
    title: "Answer needed",
    summary: "Answer needed",
    createdAt: at,
    updatedAt: at,
  });
  render(
    <ApplicationAnswerStepCard
      step={{
        request,
        isPending: false,
        onCommand: vi.fn(),
        questions: [
          {
            id: "skills",
            prompt: "Step 3 of 6: Skills — Select your skills",
            kind: "other",
            isRequired: true,
            answerControlType: "multi_choice",
            detectedAt: at,
            answerOptions: ["Analysis", "Coordination"],
            suggestedAnswers: [],
            submittedAnswer: null,
            status: "detected",
          },
        ],
      }}
    />,
  );
  expect(
    screen.getByRole("group", {
      name: "Step 3 of 6: Skills — Select your skills",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Analysis" })).toBeTruthy();
});
