import { z } from "zod";
import { CandidateAssetKindSchema } from "./candidate-assets";

/** Evidence for opening an answer task, preserved across attempts and restarts. */
export const ApplicationQuestionAskReasonSchema = z.object({
  kind: z.enum(["no_source", "source_rejected", "page_refused"]),
  check: z.string().min(1).optional(),
  detail: z.string().min(1).max(4000),
  /** The document already attempted, never its contents or local path. */
  selectedDocument: z
    .object({
      kind: CandidateAssetKindSchema,
      label: z.string().max(300),
      fileName: z.string().max(255),
    })
    .optional(),
});
export type ApplicationQuestionAskReason = z.infer<
  typeof ApplicationQuestionAskReasonSchema
>;
