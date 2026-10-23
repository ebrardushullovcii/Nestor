import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Local recovery data, never browser credentials or submission authority. */
export const PreparedFormSnapshotSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    structure: DigestSchema,
    fields: z
      .array(
        z
          .object({
            type: z.enum([
              "text",
              "email",
              "tel",
              "url",
              "number",
              "date",
              "datetime-local",
              "month",
              "week",
              "time",
              "search",
              "checkbox",
              "radio",
              "file",
              "textarea",
              "select-one",
              "select-multiple",
            ]),
            value: z.string().max(100_000),
            checked: z.boolean(),
            selected: z.array(z.string()),
            files: z.array(
              z
                .object({
                  name: NonEmptyStringSchema,
                  type: z.string(),
                  size: z.number().int().nonnegative(),
                  sha256: DigestSchema,
                })
                .strict(),
            ),
            disabled: z.boolean(),
            readOnly: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type PreparedFormSnapshot = z.infer<typeof PreparedFormSnapshotSchema>;

export const PreparedFormAttachmentSchema = z
  .object({
    kind: z.enum(["resume_source", "resume_export", "candidate_asset"]),
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    sha256: DigestSchema,
  })
  .strict();
export type PreparedFormAttachment = z.infer<
  typeof PreparedFormAttachmentSchema
>;

export const PreparedApplicationFormSchema = z
  .object({
    /** The exact ApplyJobResult id, also used as the native tab owner. */
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    savedAt: IsoDateTimeSchema,
    snapshot: PreparedFormSnapshotSchema.nullable(),
    attachments: z.array(PreparedFormAttachmentSchema),
    reason: z
      .enum(["unsupported_form", "attachment_unavailable", "form_changed"])
      .nullable(),
  })
  .strict();
export type PreparedApplicationForm = z.infer<
  typeof PreparedApplicationFormSchema
>;

export const ApplicationPageStateSchema = z.object({
  resultId: NonEmptyStringSchema,
  state: z.enum(["open", "reopenable", "needs_preparing"]),
  reason: z
    .enum([
      "no_snapshot",
      "unsupported_form",
      "attachment_unavailable",
      "form_changed",
      "application_finished",
      "reopen_failed",
    ])
    .nullable(),
});
export const ApplicationPageStatesSchema = z.array(ApplicationPageStateSchema);
export type ApplicationPageState = z.infer<typeof ApplicationPageStateSchema>;
export const ApplicationPageStatesInputSchema = z
  .object({
    resultIds: z.array(NonEmptyStringSchema).min(1).max(200),
  })
  .strict();
export const ReopenApplicationPageInputSchema = z
  .object({ resultId: NonEmptyStringSchema })
  .strict();
export type ReopenApplicationPageInput = z.infer<
  typeof ReopenApplicationPageInputSchema
>;
export const ApplicationPageReopenProgressSchema = z.object({
  resultId: NonEmptyStringSchema,
  phase: z.enum([
    "opening",
    "refilling",
    "verifying",
    "ready",
    "needs_preparing",
    "failed",
  ]),
});
export type ApplicationPageReopenProgress = z.infer<
  typeof ApplicationPageReopenProgressSchema
>;
