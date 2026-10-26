import { z } from "zod";
import {
  CandidateAnswerKindSchema,
  SavedOptionFallbackSchema,
} from "./profile";

/** Facts offered to this form, retained so unrelated answer-bank edits cannot veto Send. */
export const ApplicationAnswerDependenciesSchema = z.object({
  form: z.array(
    z.object({
      key: z.string().min(1),
      prompt: z.string().min(1),
      reusePrompt: z.boolean(),
      kind: CandidateAnswerKindSchema.default("other"),
      answer: z.string(),
      optionFallback: SavedOptionFallbackSchema.nullable().optional(),
    }),
  ),
  context: z.array(
    z.object({
      id: z.number().int().positive(),
      kind: CandidateAnswerKindSchema,
      answer: z.string(),
      optionFallback: SavedOptionFallbackSchema.nullable().optional(),
      roleFamilies: z.array(z.string()),
      proofEntryIds: z.array(z.string()),
    }),
  ),
});
export type ApplicationAnswerDependencies = z.infer<
  typeof ApplicationAnswerDependenciesSchema
>;
