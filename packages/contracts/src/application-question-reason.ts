import { z } from "zod";

/** Evidence for opening an answer task, preserved across attempts and restarts. */
export const ApplicationQuestionAskReasonSchema = z.object({
  kind: z.enum(["no_source", "source_rejected", "page_refused"]),
  check: z.string().min(1).optional(),
  detail: z.string().min(1).max(4000),
});
export type ApplicationQuestionAskReason = z.infer<
  typeof ApplicationQuestionAskReasonSchema
>;
