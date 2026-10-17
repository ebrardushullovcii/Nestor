// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApplicationAttemptQuestionSchema } from "@nestor/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { QuestionAnswerForm } from "./actions-screen";
afterEach(cleanup);
const at = "2026-10-01T10:00:00.000Z";

test("country and two half-written answers restore while submit waits for both decisions", async () => {
  const onAnswer = vi.fn();
  const onDraftChange = vi.fn();
  const questions = ["work_authorization", "visa_sponsorship"].map((kind) =>
    ApplicationAttemptQuestionSchema.parse({
      id: kind,
      prompt:
        kind === "work_authorization"
          ? "Can you work here?"
          : "Need sponsorship?",
      kind,
      detectedAt: at,
      answerOptions: ["Yes", "No"],
    }),
  );
  const view = render(
    <QuestionAnswerForm
      requestId="request"
      questions={questions}
      draft={{
        answers: { "Can you work here?": "Yes" },
        saveForFuture: false,
        hiringCountry: "Canada",
      }}
      isPending={false}
      onAnswer={onAnswer}
      onDraftChange={onDraftChange}
    />,
  );
  expect(
    (
      view.getByLabelText(
        "Which country would hire you for this job?",
      ) as HTMLInputElement
    ).value,
  ).toBe("Canada");
  const submit = view.getByRole("button", {
    name: /Answer and continue/,
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(view.getByLabelText("Need sponsorship?"), {
    target: { value: "No" },
  });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith(
      [
        { questionId: "work_authorization", answer: "Yes" },
        { questionId: "visa_sponsorship", answer: "No" },
      ],
      false,
      "Canada",
    ),
  );
});

test("conflict wording is visible but remains unconfirmed until the person uses and submits it", async () => {
  const onAnswer = vi.fn();
  const wording =
    "I enjoy improving reporting systems. I am looking for 20–30 hours a week, remote or in Toronto.";
  const question = ApplicationAttemptQuestionSchema.parse({
    id: "motivation",
    prompt: "Why this role?",
    detectedAt: at,
    note: "The job requires full-time work in Boston.",
    suggestedAnswers: [
      {
        id: "suggestion",
        text: wording,
        sourceKind: "prior_answer",
        sourceId: "review.c0",
      },
    ],
  });
  const view = render(
    <QuestionAnswerForm
      requestId="request"
      questions={[question]}
      isPending={false}
      onAnswer={onAnswer}
    />,
  );
  expect(view.getByText(wording)).toBeTruthy();
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(view.getByRole("button", { name: "Use this wording" }));
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    wording,
  );
  expect(
    (view.getByRole("textbox") as HTMLTextAreaElement).value,
  ).not.toContain("The job requires");
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: /Answer and continue/ }));
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith(
      [{ questionId: "motivation", answer: wording }],
      true,
    ),
  );
});

test("a mounted answer form refreshes saved values without saving them back", async () => {
  const onDraftChange = vi.fn();
  const props = {
    requestId: "request",
    questions: ["Start", "Interview"].map((prompt) =>
      ApplicationAttemptQuestionSchema.parse({
        id: prompt,
        prompt,
        detectedAt: at,
      }),
    ),
    isPending: false,
    onAnswer: vi.fn(),
    onDraftChange,
  };
  const view = render(
    <QuestionAnswerForm
      {...props}
      draft={{
        answers: { Start: "Monday", Interview: "Tuesday" },
        saveForFuture: false,
      }}
    />,
  );
  view.rerender(
    <QuestionAnswerForm
      {...props}
      draft={{
        answers: { Start: "Friday", Interview: "Tuesday" },
        saveForFuture: false,
      }}
    />,
  );
  expect((view.getByLabelText("Start") as HTMLInputElement).value).toBe(
    "Friday",
  );
  expect((view.getByLabelText("Interview") as HTMLInputElement).value).toBe(
    "Tuesday",
  );
  expect(onDraftChange).not.toHaveBeenCalled();
  fireEvent.change(view.getByLabelText("Interview"), {
    target: { value: "Thursday" },
  });
  await waitFor(() =>
    expect(onDraftChange).toHaveBeenCalledWith({
      answers: { Start: "Friday", Interview: "Thursday" },
      saveForFuture: false,
    }),
  );
});
