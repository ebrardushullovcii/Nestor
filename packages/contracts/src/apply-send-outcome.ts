import { z } from "zod";
/** A model decision about an already-issued send; this tool never presses anything. */
export const ApplySendOutcomeDecisionSchema = z
  .object({
    sendCallId: z.string().min(1),
    outcome: z.enum(["confirmed", "failed", "uncertain", "waiting"]),
    evidence: z.string().min(1),
  })
  .strict();
export type ApplySendOutcomeDecision = z.infer<
  typeof ApplySendOutcomeDecisionSchema
>;
/** Without a sendCallId, finish reports the latest send call. */
export const ApplyFinishSendOutcomeSchema =
  ApplySendOutcomeDecisionSchema.partial({ sendCallId: true });
export type ApplyFinishSendOutcome = z.infer<
  typeof ApplyFinishSendOutcomeSchema
>;

/** A field question, one question for several fields, or a browser handoff. */
export const ApplyPersonRequestSchema = z.union([
  z.string(),
  z
    .object({
      refs: z.array(z.string().min(1)).min(2),
      question: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      onPage: z.enum([
        "sign_in",
        "captcha",
        "mfa",
        "passkey",
        "other",
        "own_browser",
      ]),
      instructions: z.string(),
    })
    .strict(),
]);
export type ApplyPersonRequest = z.infer<typeof ApplyPersonRequestSchema>;
