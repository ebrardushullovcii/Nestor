import { z } from "zod";
/** A model decision about an already-issued send; this tool never presses anything. */
export const ApplySendOutcomeDecisionSchema = z
  .object({
    sendCallId: z.string().min(1),
    outcome: z.enum(["confirmed", "failed", "uncertain"]),
    evidence: z.string().min(1),
  })
  .strict();
export type ApplySendOutcomeDecision = z.infer<
  typeof ApplySendOutcomeDecisionSchema
>;

/** A field question or an explicit model-selected handoff on the open page. */
export const ApplyPersonRequestSchema = z.union([
  z.string(),
  z
    .object({
      onPage: z.enum(["sign_in", "captcha", "mfa", "passkey", "other"]),
      instructions: z.string(),
    })
    .strict(),
]);
export type ApplyPersonRequest = z.infer<typeof ApplyPersonRequestSchema>;
