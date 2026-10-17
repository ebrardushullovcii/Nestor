import {
  compareApplicationAnswerRecency,
  mergeUserActionAnswerDraft,
} from "@nordri/contracts";
import { useEffect, useRef, useState } from "react";
import type {
  ApplicationAttemptListRow,
  ApplyRunDetails,
  JobFinderApplyRunDetailsQuery,
  UserActionRequest,
} from "@nordri/contracts";
import { listPendingApplicationQuestions } from "../applications/applications-status";
import type { QuestionAnswerDraft } from "./actions-screen";

let lastEditTime = 0;

export function useQuestionAnswerDrafts(props: {
  applicationAttempts?: readonly ApplicationAttemptListRow[];
  requests: readonly UserActionRequest[];
  onGetApplyRunDetails?: (
    query: JobFinderApplyRunDetailsQuery,
  ) => Promise<ApplyRunDetails>;
}) {
  // The request is the durable draft scope; this map also protects live edits
  // while a submitted-answer read is in flight.
  const answerDrafts = useRef(new Map<string, QuestionAnswerDraft>());
  const fieldTimes = useRef(new Map<string, Record<string, number>>());
  const restoredDrafts = useRef(new Set<string>());
  const [restoredApplications, setRestoredApplications] = useState<
    ReadonlySet<string>
  >(new Set());
  for (const request of props.requests) {
    if (!request.answerDraft) continue;
    const current = answerDrafts.current.get(request.id);
    if (!current) {
      answerDrafts.current.set(request.id, request.answerDraft);
      fieldTimes.current.set(
        request.id,
        request.answerDraftFieldUpdatedAt ?? {},
      );
      continue;
    }
    let merged = {
      answerDraft: current,
      answerDraftFieldUpdatedAt: fieldTimes.current.get(request.id) ?? {},
    };
    for (const [key, value] of Object.entries(request.answerDraft.answers)) {
      const result = mergeUserActionAnswerDraft(
        merged,
        { answers: { [key]: value } },
        request.answerDraftFieldUpdatedAt?.[`answer:${key}`] ?? 1,
      );
      merged = {
        answerDraft: result.answerDraft!,
        answerDraftFieldUpdatedAt: result.answerDraftFieldUpdatedAt!,
      };
    }
    for (const key of ["saveForFuture", "hiringCountry"] as const) {
      const result = mergeUserActionAnswerDraft(
        merged,
        { [key]: request.answerDraft[key] },
        request.answerDraftFieldUpdatedAt?.[key] ?? 1,
      );
      merged = {
        answerDraft: result.answerDraft!,
        answerDraftFieldUpdatedAt: result.answerDraftFieldUpdatedAt!,
      };
    }
    answerDrafts.current.set(request.id, merged.answerDraft);
    fieldTimes.current.set(request.id, merged.answerDraftFieldUpdatedAt);
  }
  async function updateAnswerDraft(
    request: UserActionRequest,
    draft: QuestionAnswerDraft,
  ): Promise<void> {
    const previous = answerDrafts.current.get(request.id);
    const answers = Object.fromEntries(
      Object.entries(draft.answers).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(previous?.answers[key]),
      ),
    );
    const patch = {
      answers,
      ...(draft.saveForFuture !== previous?.saveForFuture
        ? { saveForFuture: draft.saveForFuture }
        : {}),
      ...(draft.hiringCountry !== previous?.hiringCountry
        ? { hiringCountry: draft.hiringCountry }
        : {}),
    };
    const editedAt = (lastEditTime = Math.max(Date.now(), lastEditTime + 1));
    const merged = mergeUserActionAnswerDraft(
      {
        answerDraft: previous,
        answerDraftFieldUpdatedAt: fieldTimes.current.get(request.id),
      },
      patch,
      editedAt,
    );
    answerDrafts.current.set(request.id, merged.answerDraft!);
    fieldTimes.current.set(request.id, merged.answerDraftFieldUpdatedAt!);
    await window.nordri.jobFinder.saveUserActionAnswerDraft({
      requestId: request.id,
      expectedRevision: request.revision,
      draft: patch,
      editedAt,
    });
  }
  useEffect(() => {
    if (!props.onGetApplyRunDetails) return;
    let cancelled = false;
    const started: string[] = [];
    for (const request of props.requests) {
      if (
        !["pending", "awaiting_user", "still_blocked"].includes(
          request.state,
        ) ||
        request.kind !== "manual_answer" ||
        request.scope.type !== "application" ||
        !request.scope.applicationRecordId ||
        restoredDrafts.current.has(request.id)
      )
        continue;
      const applicationRecordId = request.scope.applicationRecordId;
      const existing = answerDrafts.current.get(request.id);
      if (
        existing &&
        (Object.keys(existing.answers).length > 0 || !existing.saveForFuture)
      )
        continue;
      const previous = [...props.requests]
        .filter(
          (entry) =>
            entry.id !== request.id &&
            entry.kind === "manual_answer" &&
            entry.scope.type === "application" &&
            entry.scope.applicationRecordId === applicationRecordId &&
            entry.updatedAt <= request.updatedAt,
        )
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0];
      if (!previous || previous.scope.type !== "application") continue;
      restoredDrafts.current.add(request.id);
      started.push(request.id);
      void props
        .onGetApplyRunDetails({
          runId: previous.scope.runId,
          jobId: previous.scope.jobId,
          applicationRecordId,
        })
        .then((details) => {
          if (cancelled) return;
          const edited = answerDrafts.current.get(request.id);
          if (
            edited &&
            (Object.keys(edited.answers).length > 0 || !edited.saveForFuture)
          )
            return;
          const records = [...details.answerRecords]
            .filter(
              (answer) =>
                answer.applicationRecordId === applicationRecordId &&
                answer.sourceKind === "user" &&
                (!answer.sourceId?.startsWith("answerLibrary.") ||
                  answer.sourceId.startsWith("answerLibrary.application_")),
            )
            .sort(compareApplicationAnswerRecency);
          const questions = listPendingApplicationQuestions({
            applicationAttempts: props.applicationAttempts ?? [],
            applicationRecordId,
            jobId:
              previous.scope.type === "application" ? previous.scope.jobId : "",
          });
          const answers: QuestionAnswerDraft["answers"] = {};
          for (const question of questions) {
            const samePrompt = (details.questionRecords ?? []).filter(
              (record) =>
                record.applicationRecordId === applicationRecordId &&
                record.prompt.trim() === question.prompt.trim(),
            );
            const matchingQuestionIds = new Set(
              samePrompt.map((record) => record.id),
            );
            const answer = records.find(
              (entry) =>
                entry.questionId === question.id ||
                entry.questionId ===
                  `apply_question_${applicationRecordId}_${question.id}` ||
                (questions.filter((entry) => entry.prompt === question.prompt)
                  .length === 1 &&
                  matchingQuestionIds.has(entry.questionId)),
            );
            if (
              !answer ||
              answer.status === "rejected" ||
              answer.value?.type === "asset_ref"
            )
              continue;
            let value: string | string[] = answer.text;
            if (question.answerControlType === "multi_choice") {
              try {
                const parsed: unknown = JSON.parse(answer.text);
                if (
                  Array.isArray(parsed) &&
                  parsed.every((entry) => typeof entry === "string")
                )
                  value = parsed;
              } catch {
                /* Keep a legacy text answer available for review. */
              }
            }
            const key =
              questions.filter((entry) => entry.prompt === question.prompt)
                .length > 1
                ? question.id
                : question.prompt;
            answers[key] = value;
          }
          if (!Object.keys(answers).length) return;
          answerDrafts.current.set(request.id, {
            answers,
            saveForFuture: records[0]?.saveScope === "reusable_profile",
          });
          setRestoredApplications(
            (current) => new Set([...current, request.id]),
          );
        })
        .catch(() => {
          /* A failed read leaves the current editable form intact. */
        });
    }
    return () => {
      cancelled = true;
      for (const requestId of started) restoredDrafts.current.delete(requestId);
    };
  }, [props.onGetApplyRunDetails, props.requests, props.applicationAttempts]);
  return { answerDrafts, restoredApplications, updateAnswerDraft };
}
