import {
  NEEDS_YOU_COMMANDS,
  type NeedsYouCommandName,
  type NeedsYouCommandInput,
  type NeedsYouCommandOutput,
  type NeedsYouCommandOutputs,
} from "@nestor/contracts";
import { assistantCommandTools } from "./command-tools";
import { assertPersonAnswerAuthority } from "./person-answer-authority";
import { AssistantToolError } from "./tool-kit";

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
      answer_need: (value) => ({
        summary: value.resolved
          ? `Answer saved. ${value.queued} applications can continue.`
          : "That question was already answered or is no longer needed.",
        data: value,
      }),
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
      forget_form_answers: (value) => ({
        summary: `Forgot ${value} saved answers.`,
        data: value,
      }),
    },
  });
}
