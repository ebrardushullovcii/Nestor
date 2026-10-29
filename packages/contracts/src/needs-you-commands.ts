import { z } from "zod";
import {
  AnswerNeedsYouInputSchema,
  AnswerNeedsYouResultSchema,
  ApplicationTargetSchema,
  NeedsYouCountsSchema,
  NeedsYouTaskSchema,
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
  SavedFormAnswerKeySchema,
  UpsertSavedFormAnswerInputSchema,
} from "./applications";

export const SavedFormAnswerChangeSchema = z.object({
  id: z.number().int().positive(),
  prompt: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

const AnswerChangeSchema = z.object({
  undoId: z.number().int().positive().nullable(),
  undoCount: z.number().int().nonnegative(),
  answerChanges: z.array(SavedFormAnswerChangeSchema),
});

export const NeedsYouSelectionQuerySchema = z
  .object({
    tab: z.enum(["tasks", "saved"]),
    ids: z.array(z.number().int().positive()).max(2000),
    text: z.string().trim().max(200).default(""),
    kind: NeedsYouListQuerySchema.shape.kind,
  })
  .strict();
export type NeedsYouSelectionQuery = z.input<
  typeof NeedsYouSelectionQuerySchema
>;

export const NEEDS_YOU_COMMANDS = {
  validate_needs_you_selection: {
    effect: "read",
    description:
      "Checks supplied task or saved-answer IDs against the complete store, independent of loaded pages. Returns existing IDs and those matching the current filters; it never changes selection or answers.",
    input: NeedsYouSelectionQuerySchema,
    output: z
      .object({
        existingIds: z.array(z.number().int().positive()),
        matchingIds: z.array(z.number().int().positive()),
      })
      .strict(),
  },
  application_needs: {
    effect: "read",
    description:
      "The current questions and browser steps for one exact application work id.",
    input: ApplicationTargetSchema,
    output: z.array(NeedsYouTaskSchema),
  },
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
      "Save the person's answer to one question and continue every application it unblocks. A multi_choice question takes a JSON array of its chosen options. Remember it only when the person asks.",
    input: AnswerNeedsYouInputSchema,
    output: AnswerNeedsYouResultSchema.merge(AnswerChangeSchema),
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
  retry_need: {
    effect: "external",
    description:
      "Retry a site's Needs you sign-in item after the person finishes in the browser. The item stays until that site is actually readable. Use check_need for application browser steps.",
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
  get_form_answer_by_key: {
    effect: "read",
    description:
      "Read a saved answer by its stable key and optional country/site scope.",
    input: SavedFormAnswerKeySchema,
    output: SavedFormAnswerSchema.nullable(),
  },
  upsert_form_answer: {
    effect: "local_write",
    description:
      "Save the person's reusable answer by stable key, including its kind, proof references and optional scope. All answer text lives in Needs you.",
    input: UpsertSavedFormAnswerInputSchema,
    output: SavedFormAnswerSchema.merge(AnswerChangeSchema),
  },
  save_form_answer: {
    effect: "local_write",
    description:
      "Update the person's remembered answer, preserving the question and its scope.",
    input: SaveFormAnswerInputSchema,
    output: z.object({ saved: z.boolean() }).merge(AnswerChangeSchema),
  },
  create_form_answer: {
    effect: "local_write",
    description:
      "Save a question and the person's answer in Needs you before a form asks. Numeric answers are reused as facts even when another form uses a text field.",
    input: CreateFormAnswerInputSchema,
    output: SavedFormAnswerSchema.merge(AnswerChangeSchema),
  },
  forget_form_answers: {
    effect: "local_write",
    description:
      "Forget selected remembered answers. Previously submitted applications keep their receipts.",
    input: ForgetFormAnswersInputSchema,
    output: z
      .object({ forgotten: z.number().int().nonnegative() })
      .merge(AnswerChangeSchema),
  },
  undo_form_answer_change: {
    effect: "local_write",
    description:
      "Undo one saved-answer change, keeping later edits. This restores memory for future forms; it cannot retract answers already used or submitted.",
    input: z.object({ undoId: z.number().int().positive() }).strict(),
    output: z.object({
      changed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  },
} as const;
export type NeedsYouCommandName = keyof typeof NEEDS_YOU_COMMANDS;
export type NeedsYouCommandInput<K extends NeedsYouCommandName> = z.input<
  (typeof NEEDS_YOU_COMMANDS)[K]["input"]
>;
export type NeedsYouCommandOutput<K extends NeedsYouCommandName> =
  NeedsYouCommandOutputs[K];
export { NEEDS_YOU_RUN_CHANNEL } from "./ipc-channels";
export type NeedsYouCommandOutputs = {
  [K in NeedsYouCommandName]: z.output<
    (typeof NEEDS_YOU_COMMANDS)[K]["output"]
  >;
};
