import { createHash } from "node:crypto";
import type {
  ApplicationAnswerDependencies,
  CandidateProfile,
  CandidateReusableAnswer,
  FormAnswerLookup,
} from "@nestor/contracts";
import type { ApplicationStore } from "@nestor/db/applications";

export const profileFactsDigest = (profile: CandidateProfile): string =>
  createHash("sha256").update(JSON.stringify(profile)).digest("hex");

/** The same scoped reader is used when filling and immediately before sending. */
export function applicationAnswerDependencies(
  memory: ApplicationStore["needsYou"],
  applicationId: number,
  origin: string,
  context: CandidateReusableAnswer[],
) {
  const seen = new Map<string, ApplicationAnswerDependencies["form"][number]>();
  return {
    read(questions: FormAnswerLookup[]) {
      const matches = memory.answersForQuestions(
        applicationId,
        questions,
        origin,
      );
      for (const match of matches) {
        const query = questions.find((question) => question.key === match.key)!;
        // Keep both versions if a fact changes during preparation: neither may be silently blessed.
        seen.set(
          JSON.stringify([query.key, match.answer, match.optionFallback]),
          {
            ...query,
            kind: query.kind ?? "other",
            answer: match.answer,
            optionFallback: match.optionFallback ?? null,
          },
        );
      }
      return matches;
    },
    snapshot(): ApplicationAnswerDependencies {
      return {
        form: [...seen.values()],
        context: context.map((answer) => ({
          id: Number(answer.id.replace(/^form_answer_/u, "")),
          kind: answer.kind,
          answer: answer.answer,
          optionFallback: answer.optionFallback ?? null,
          roleFamilies: answer.roleFamilies,
          proofEntryIds: answer.proofEntryIds,
        })),
      };
    },
  };
}

export function applicationAnswersUnchanged(
  memory: ApplicationStore["needsYou"],
  applicationId: number,
  origin: string,
  proof: ApplicationAnswerDependencies | undefined,
): boolean {
  if (!proof) return false;
  const current = new Map(
    memory
      .answersForQuestions(applicationId, proof.form, origin)
      .map((answer) => [answer.key, answer]),
  );
  return (
    proof.form.every(
      (answer) =>
        current.get(answer.key)?.answer === answer.answer &&
        JSON.stringify(current.get(answer.key)?.optionFallback ?? null) ===
          JSON.stringify(answer.optionFallback ?? null),
    ) &&
    proof.context.every((answer) => {
      const saved = memory.savedAnswer(answer.id);
      return (
        !!saved &&
        !saved.needsConfirmation &&
        saved.kind === answer.kind &&
        saved.answer === answer.answer &&
        JSON.stringify(saved.optionFallback ?? null) ===
          JSON.stringify(answer.optionFallback ?? null) &&
        JSON.stringify(saved.roleFamilies) ===
          JSON.stringify(answer.roleFamilies) &&
        JSON.stringify(saved.proofEntryIds) ===
          JSON.stringify(answer.proofEntryIds)
      );
    })
  );
}
