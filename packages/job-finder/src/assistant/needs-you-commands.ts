import {
  NEEDS_YOU_COMMANDS,
  type NeedsYouCommandName,
  type NeedsYouCommandInput,
  type NeedsYouCommandOutput,
  type NeedsYouCommandOutputs,
} from "@nestor/contracts";
import { assistantCommandTools } from "./command-tools";
import { assertPersonAnswerAuthority } from "./person-answer-authority";
import { AssistantToolError, type AssistantToolContext } from "./tool-kit";

async function answerChange<
  T extends {
    undoId: number | null;
    undoCount: number;
    answerChanges: NeedsYouCommandOutput<"save_form_answer">["answerChanges"];
  },
>(value: T, summary: string, { session }: AssistantToolContext) {
  if (!value.undoId) return { summary, data: value };
  const { part } = await session.recordChange({
    target: "app_command",
    targetId: String(value.undoId),
    summary,
    undoCommand: {
      name: "undo_form_answer_change",
      input: { undoId: value.undoId },
      expectedCount: value.undoCount,
    },
    entries: value.answerChanges.map((change) => ({
      path: ["savedAnswers", `#id:${change.id}`, "answer"],
      kind: "set",
      before: change.before ?? "Not saved",
      after: change.after ?? "Forgotten",
      index: null,
      label: change.prompt.slice(0, 200),
    })),
  });
  return { summary, data: value, parts: [part] };
}

export type RunNeedsYouCommand = <K extends NeedsYouCommandName>(
  name: K,
  input: NeedsYouCommandInput<K>,
) => Promise<NeedsYouCommandOutput<K>>;

/** The same row commands, with the existing person's-answer guard before chat writes. */
export function needsYouCommandTools(run: RunNeedsYouCommand) {
  return assistantCommandTools<
    typeof NEEDS_YOU_COMMANDS,
    NeedsYouCommandOutputs
  >(NEEDS_YOU_COMMANDS, run, {
    group: "workspace",
    replaces: {
      answer_need: ["resolve_needs_you", "answer_application_question"],
    },
    before: {
      async upsert_form_answer(input, { session }) {
        await assertPersonAnswerAuthority(session, {
          answers: [{ question: input.prompt, answer: input.answer }],
          saveForFuture: true,
        });
      },
      async create_form_answer(input, { session }) {
        await assertPersonAnswerAuthority(session, {
          answers: [{ question: input.prompt, answer: input.answer }],
          saveForFuture: true,
        });
      },
      async answer_need(input, { session }) {
        const details = await run("get_need", { id: input.id });
        if (!details || details.task.kind !== "question")
          throw new AssistantToolError(
            "not_found",
            "That question is no longer waiting.",
          );
        await assertPersonAnswerAuthority(session, {
          answers: [{ question: details.task.prompt, answer: input.answer }],
          saveForFuture: input.remember,
        });
      },
      async save_form_answer(input, { session }) {
        const value = await run("get_form_answer", { id: input.id });
        if (!value)
          throw new AssistantToolError(
            "not_found",
            "That saved answer no longer exists.",
          );
        await assertPersonAnswerAuthority(session, {
          answers: [{ question: value.prompt, answer: input.answer }],
          saveForFuture: true,
        });
      },
    },
    results: {
      list_needs_you: (page) => ({
        summary: page.total
          ? `${page.total} items need you.`
          : "Nothing is waiting on the person.",
        data: page,
      }),
      answer_need: (value, _input, context) =>
        answerChange(
          value,
          value.resolved
            ? `Answer saved. ${value.queued} applications can continue.`
            : "That question was already answered or is no longer needed.",
          context,
        ),
      create_form_answer: (value, _input, context) =>
        answerChange(
          value,
          `Saved the answer to ${value.prompt} for future forms.`,
          context,
        ),
      upsert_form_answer: (value, _input, context) =>
        answerChange(
          value,
          `Saved the answer to ${value.prompt} for future forms.`,
          context,
        ),
      save_form_answer: (value, _input, context) =>
        answerChange(
          value,
          value.saved
            ? "Updated the saved answer for future forms."
            : "That saved answer no longer exists.",
          context,
        ),
      check_need: (value) => ({
        summary: value
          ? "The browser step is complete. Applications continue."
          : "The step is still waiting. Finish it in the browser, then check again.",
        data: value,
      }),
      open_need: (value) => ({
        summary: value
          ? "Opened in the app browser."
          : "This application tab is unavailable.",
        data: value,
      }),
      retry_need: (value) => ({
        summary: value
          ? "Retrying the site. Its Needs you item stays until the site is readable."
          : "That site sign-in item is no longer waiting.",
        data: value,
      }),
      forget_form_answers: (value, _input, context) =>
        answerChange(
          value,
          `Forgot ${value.forgotten} saved answers.`,
          context,
        ),
      undo_form_answer_change: (value) => ({
        summary: `Restored ${value.changed} saved answers for future forms.${value.skipped ? " Later edits were kept." : ""} Answers already used in applications were kept.`,
        data: value,
      }),
    },
  });
}
