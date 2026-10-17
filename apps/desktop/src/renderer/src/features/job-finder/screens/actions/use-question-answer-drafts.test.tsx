// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import {
  type SaveUserActionAnswerDraftInput,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { useQuestionAnswerDrafts } from "./use-question-answer-drafts";

test("restores a durable draft on either screen without treating it as submitted", async () => {
  const saveUserActionAnswerDraft = vi
    .fn<(input: SaveUserActionAnswerDraftInput) => Promise<void>>()
    .mockResolvedValue(undefined);
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { jobFinder: { saveUserActionAnswerDraft } },
  });
  const request = UserActionRequestSchema.parse({
    id: "request",
    dedupeKey: "dates",
    kind: "manual_answer",
    state: "awaiting_user",
    revision: 1,
    title: "Two dates",
    summary: "Enter both dates",
    scope: {
      type: "application",
      source: "target_site",
      runId: "run",
      jobId: "job",
      resultId: "result",
      applicationRecordId: "app",
    },
    verification: { type: "page_blocker_absent", blockerFingerprint: "dates" },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    answerDraft: {
      answers: { Start: "2026-11-02", Interview: "" },
      saveForFuture: false,
    },
  });
  const first = renderHook(() =>
    useQuestionAnswerDrafts({ requests: [request] }),
  );
  expect(first.result.current.answerDrafts.current.get(request.id)).toEqual(
    request.answerDraft,
  );
  const edited = {
    answers: { Start: "2026-11-03", Interview: "" },
    saveForFuture: false,
  };
  await act(() => first.result.current.updateAnswerDraft(request, edited));
  expect(saveUserActionAnswerDraft.mock.calls[0]?.[0]).toMatchObject({
    requestId: request.id,
    expectedRevision: 1,
    draft: { answers: { Start: "2026-11-03" } },
  });
  expect(typeof saveUserActionAnswerDraft.mock.calls[0]?.[0].editedAt).toBe(
    "number",
  );
  first.unmount();
  const second = renderHook(() =>
    useQuestionAnswerDrafts({
      requests: [{ ...request, answerDraft: edited }],
    }),
  );
  expect(second.result.current.answerDrafts.current.get(request.id)).toEqual(
    edited,
  );
  expect(saveUserActionAnswerDraft).toHaveBeenCalledTimes(1);
});

test("both mounted screens take newer workspace drafts while stale refreshes keep live edits", async () => {
  const saveUserActionAnswerDraft = vi
    .fn<(input: SaveUserActionAnswerDraftInput) => Promise<void>>()
    .mockResolvedValue(undefined);
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { jobFinder: { saveUserActionAnswerDraft } },
  });
  const request = UserActionRequestSchema.parse({
    id: "request",
    dedupeKey: "dates",
    kind: "manual_answer",
    state: "awaiting_user",
    revision: 1,
    title: "Dates",
    summary: "Dates",
    scope: {
      type: "application",
      source: "target_site",
      runId: "run",
      jobId: "job",
      resultId: "result",
      applicationRecordId: "app",
    },
    verification: { type: "page_blocker_absent", blockerFingerprint: "dates" },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  });
  const needs = renderHook(
    ({ current }) => useQuestionAnswerDrafts({ requests: [current] }),
    { initialProps: { current: request } },
  );
  await act(() =>
    needs.result.current.updateAnswerDraft(request, {
      answers: { Start: "Monday", Interview: "Tuesday" },
      saveForFuture: false,
    }),
  );
  const firstTime = saveUserActionAnswerDraft.mock.calls[0]![0].editedAt;
  if (firstTime === undefined) throw new Error("Missing first edit timestamp");
  const saved = {
    ...request,
    answerDraft: {
      answers: { Start: "Monday", Interview: "Tuesday" },
      saveForFuture: false,
    },
    answerDraftFieldUpdatedAt: {
      "answer:Start": firstTime,
      "answer:Interview": firstTime,
      saveForFuture: firstTime,
    },
  };
  const applications = renderHook(
    ({ current }) => useQuestionAnswerDrafts({ requests: [current] }),
    { initialProps: { current: saved } },
  );
  expect(
    applications.result.current.answerDrafts.current.get(request.id),
  ).toEqual(saved.answerDraft);
  await act(() =>
    applications.result.current.updateAnswerDraft(saved, {
      answers: { Start: "Friday" },
      saveForFuture: false,
    }),
  );
  expect(saveUserActionAnswerDraft.mock.calls[1]![0].draft).toEqual({
    answers: { Start: "Friday" },
  });
  const secondTime = saveUserActionAnswerDraft.mock.calls[1]![0].editedAt;
  if (secondTime === undefined)
    throw new Error("Missing second edit timestamp");
  const latest = {
    ...saved,
    answerDraft: {
      ...saved.answerDraft,
      answers: { Start: "Friday", Interview: "Tuesday" },
    },
    answerDraftFieldUpdatedAt: {
      ...saved.answerDraftFieldUpdatedAt,
      "answer:Start": secondTime,
    },
  };
  needs.rerender({ current: latest });
  expect(
    needs.result.current.answerDrafts.current.get(request.id)?.answers,
  ).toEqual(latest.answerDraft.answers);
  applications.rerender({ current: saved });
  expect(
    applications.result.current.answerDrafts.current.get(request.id)?.answers,
  ).toEqual(latest.answerDraft.answers);
});
