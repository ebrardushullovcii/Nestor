import { ApplicationReviewCardSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import { mergeApplyReviewCards } from "./agent-application-preparation";

const address = "https://example.test/application";
const fieldKey = (step: number, question: string, url = address) =>
  `${url}|Screen ${step}|field:text:0|${question}`;

function completeCard() {
  const answers = Array.from({ length: 6 }, (_, index) => ({
    fieldKey: fieldKey(index + 1, `Question ${index + 1}`),
    question: `Question ${index + 1}`,
    answer: `Answer ${index + 1}`,
    source: index === 4 ? "your answer to this question" : "your profile",
    sourceId: index === 4 ? "applicationAnswer.verified" : "profile.fact",
    written: false,
  }));
  return ApplicationReviewCardSchema.parse({
    siteLabel: "Synthetic form",
    pageUrl: address,
    preparedAt: "2026-10-06T10:00:00.000Z",
    answers,
    observedFieldKeys: answers.map((answer) => answer.fieldKey),
    attachments: [
      {
        fieldKey: fieldKey(2, "Resume"),
        field: "Resume",
        label: "Your resume",
        fileName: "synthetic.pdf",
      },
    ],
  });
}

function observedCard(steps: number[]) {
  const previous = completeCard();
  const answers = previous.answers
    .filter((_, index) => steps.includes(index + 1))
    .map((answer) => ({
      ...answer,
      source: "the filled application form",
      sourceId: "observed.current",
    }));
  return ApplicationReviewCardSchema.parse({
    ...previous,
    answers,
    attachments: [],
    observedFieldKeys: answers.map((answer) => answer.fieldKey),
  });
}

test("repeated preparations on the last step retain every earlier answer and source", () => {
  const original = completeCard();
  let previous = original;
  for (let run = 0; run < 4; run += 1) {
    previous = mergeApplyReviewCards(previous, observedCard([6]), {
      freshPreparation: true,
    })!;
    expect(previous.answers).toEqual(original.answers);
    expect(previous.attachments).toEqual(original.attachments);
  }
});

test("restarting at the first step and stopping at the second drops later answers", () => {
  const previous = mergeApplyReviewCards(completeCard(), observedCard([6]), {
    freshPreparation: true,
  })!;
  const restarted = mergeApplyReviewCards(previous, observedCard([1, 2]), {
    freshPreparation: true,
  })!;
  expect(restarted.answers.map((answer) => answer.question)).toEqual([
    "Question 1",
    "Question 2",
  ]);
  expect(restarted.attachments).toEqual([]);
});

test("a removed field on an observed step disappears while other steps remain", () => {
  const previous = completeCard();
  previous.answers.push({
    ...previous.answers[5]!,
    question: "Removed question",
    fieldKey: fieldKey(6, "Removed question"),
  });
  previous.attachments.push({
    fieldKey: fieldKey(6, "Removed upload"),
    field: "Removed upload",
    label: "Portfolio",
    fileName: "removed.pdf",
  });
  const current = observedCard([6]);
  current.answers[0]!.answer = "Changed answer";
  const merged = mergeApplyReviewCards(previous, current, {
    freshPreparation: true,
  })!;
  expect(merged.answers).toHaveLength(6);
  expect(merged.answers[5]).toMatchObject({
    answer: "Changed answer",
    source: "the filled application form",
  });
  expect(merged.attachments).toEqual(completeCard().attachments);
});

test.each(["different address", "different step", "different fields"])(
  "a changed form drops the prior answers (%s)",
  (change) => {
    const current = observedCard([6]);
    const answer = current.answers[0]!;
    answer.fieldKey =
      change === "different address"
        ? fieldKey(6, answer.question, "https://example.test/replacement")
        : change === "different step"
          ? fieldKey(7, answer.question)
          : fieldKey(6, "Replacement question");
    if (change === "different fields") answer.question = "Replacement question";
    current.observedFieldKeys = [answer.fieldKey];
    const merged = mergeApplyReviewCards(completeCard(), current, {
      freshPreparation: true,
    })!;
    expect(merged.answers).toEqual(current.answers);
    expect(merged.attachments).toEqual([]);
  },
);

test("loading the form's start before reaching its last step counts as a restart", () => {
  const current = observedCard([1, 6]);
  expect(
    mergeApplyReviewCards(completeCard(), current, {
      freshPreparation: true,
    })!.answers.map((answer) => answer.question),
  ).toEqual(["Question 1", "Question 6"]);
});

test("a continuation does not revive fields removed from its observed step", () => {
  const previous = completeCard();
  previous.answers.push({
    ...previous.answers[5]!,
    question: "Removed question",
    fieldKey: fieldKey(6, "Removed question"),
  });
  expect(
    mergeApplyReviewCards(previous, observedCard([6]))!.answers,
  ).toHaveLength(6);
});

test("a later run may continue a step reached by a previous continuation", () => {
  const previous = completeCard();
  const current = observedCard([6]);
  current.answers[0]!.fieldKey = fieldKey(3, current.answers[0]!.question);
  current.observedFieldKeys = [current.answers[0]!.fieldKey];
  const partial = ApplicationReviewCardSchema.parse({
    ...previous,
    answers: previous.answers.slice(0, 2),
    observedFieldKeys: previous.observedFieldKeys!.slice(0, 2),
  });
  const continued = mergeApplyReviewCards(partial, current)!;
  const rerun = mergeApplyReviewCards(continued, current, {
    freshPreparation: true,
  })!;
  expect(rerun.answers).toEqual(continued.answers);
});

test("legacy cards with only the last run's observations retain their earlier steps", () => {
  const previous = completeCard();
  previous.observedFieldKeys = observedCard([6]).observedFieldKeys;
  expect(
    mergeApplyReviewCards(previous, observedCard([6]), {
      freshPreparation: true,
    })!.answers,
  ).toEqual(previous.answers);
});

test("a new recorded source replaces the previous source even when the value is unchanged", () => {
  const current = observedCard([6]);
  current.answers[0]!.source = "your Settings (on by default)";
  current.answers[0]!.sourceId = "settings.declaration";
  const merged = mergeApplyReviewCards(completeCard(), current, {
    freshPreparation: true,
  })!;
  expect(merged.answers).toHaveLength(6);
  expect(merged.answers[5]).toEqual(current.answers[0]);
});

test("revisiting the first screen does not change the recorded form start", () => {
  const continued = mergeApplyReviewCards(completeCard(), observedCard([1]))!;
  expect(continued.observedFieldKeys?.[0]).toBe(fieldKey(1, "Question 1"));
  expect(
    mergeApplyReviewCards(continued, observedCard([1, 2]), {
      freshPreparation: true,
    })!.answers,
  ).toHaveLength(2);
});

test("without observed-step evidence a fresh preparation drops unseen answers", () => {
  const current = observedCard([6]);
  delete current.observedFieldKeys;
  expect(
    mergeApplyReviewCards(completeCard(), current, {
      freshPreparation: true,
    })!.answers,
  ).toHaveLength(1);
});

test("a run that returns to earlier screens does not carry unobserved later answers", () => {
  const current = observedCard([6, 2]);
  current.observedFieldKeys = [
    fieldKey(6, "Question 6"),
    fieldKey(2, "Question 2"),
  ];
  expect(
    mergeApplyReviewCards(completeCard(), current, {
      freshPreparation: true,
    })!.answers.map((answer) => answer.question),
  ).toEqual(["Question 2", "Question 6"]);
});
