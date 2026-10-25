import { z } from "zod";
import {
  AnswerNeedsYouInputSchema,
  AnswerNeedsYouResultSchema,
  ApplicationTargetSchema,
  NeedsYouCountsSchema,
  NeedsYouDetailsSchema,
  NeedsYouListQuerySchema,
  NeedsYouPageSchema,
  SaveNeedsYouDraftInputSchema,
  SaveNeedsYouDraftResultSchema,
  SavedFormAnswerSchema,
  SavedFormAnswersQuerySchema,
  SavedFormAnswersPageSchema,
  SaveFormAnswerInputSchema,
  ForgetFormAnswersInputSchema,
  CreateFormAnswerInputSchema,
} from "./applications";

export const NEEDS_YOU_COMMANDS = {
  list_needs_you: {
    effect: "read",
    description:
      "One page of things only the person can do, oldest first, with counts and an optional kind or text filter.",
    input: NeedsYouListQuerySchema,
    output: NeedsYouPageSchema,
  },
  needs_you_counts: {
    effect: "read",
    description:
      "Counts of unanswered questions, sign-in steps, CAPTCHA, MFA and remembered answers.",
    input: z.object({}).strict(),
    output: NeedsYouCountsSchema,
  },
  get_need: {
    effect: "read",
    description:
      "One open task, its related applications, and the person's draft answer.",
    input: ApplicationTargetSchema,
    output: NeedsYouDetailsSchema.nullable(),
  },
  save_need_draft: {
    effect: "local_write",
    description:
      "Save a draft for this exact question. Pass its last revision; a stale write cannot replace a newer draft.",
    input: SaveNeedsYouDraftInputSchema,
    output: SaveNeedsYouDraftResultSchema,
  },
  answer_need: {
    effect: "local_write",
    description:
      "Save the person's answer to one question and continue every application it unblocks. Remember it only when the person asks.",
    input: AnswerNeedsYouInputSchema,
    output: AnswerNeedsYouResultSchema,
  },
  open_need: {
    effect: "local_write",
    description:
      "Open the exact application tab for a sign-in, CAPTCHA or MFA step. Source tickets open their own site instead.",
    input: ApplicationTargetSchema,
    output: z.boolean(),
  },
  check_need: {
    effect: "local_write",
    description:
      "Check the exact application page after the person completed a browser step. A remaining wall keeps it open. Source items use retry_source instead.",
    input: ApplicationTargetSchema,
    output: z.boolean(),
  },
  list_form_answers: {
    effect: "read",
    description:
      "One page of remembered form answers. These are managed only in Needs you.",
    input: SavedFormAnswersQuerySchema,
    output: SavedFormAnswersPageSchema,
  },
  get_form_answer: {
    effect: "read",
    description:
      "One remembered form answer, including its full text and scope.",
    input: ApplicationTargetSchema,
    output: SavedFormAnswerSchema.nullable(),
  },
  save_form_answer: {
    effect: "local_write",
    description:
      "Update the person's remembered answer, preserving the question and its scope.",
    input: SaveFormAnswerInputSchema,
    output: z.boolean(),
  },
  create_form_answer: {
    effect: "local_write",
    description:
      "Save a question and the person's answer in Needs you before a form asks. Numeric answers are reused as facts even when another form uses a text field.",
    input: CreateFormAnswerInputSchema,
    output: SavedFormAnswerSchema,
  },
  forget_form_answers: {
    effect: "local_write",
    description:
      "Forget selected remembered answers. Previously submitted applications keep their receipts.",
    input: ForgetFormAnswersInputSchema,
    output: z.number().int().nonnegative(),
  },
} as const;
export type NeedsYouCommandName = keyof typeof NEEDS_YOU_COMMANDS;
export type NeedsYouCommandInput<K extends NeedsYouCommandName> = z.input<
  (typeof NEEDS_YOU_COMMANDS)[K]["input"]
>;
export type NeedsYouCommandOutput<K extends NeedsYouCommandName> =
  NeedsYouCommandOutputs[K];
export const NEEDS_YOU_RUN_CHANNEL = "needs-you:run";
export type NeedsYouCommandOutputs = {
  [K in NeedsYouCommandName]: z.output<
    (typeof NEEDS_YOU_COMMANDS)[K]["output"]
  >;
};
