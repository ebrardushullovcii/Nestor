import {
  resumeImportAnswer,
  type ResumeImportFieldCandidate,
  type UpsertSavedFormAnswerInput,
} from "@nestor/contracts";

/** Reusable suggestions belong to Needs you, including text awaiting confirmation. */
export function resumeImportSavedAnswers(
  candidates: readonly ResumeImportFieldCandidate[],
): UpsertSavedFormAnswerInput[] {
  return candidates.flatMap((candidate) => {
    if (
      !["auto_applied", "needs_review"].includes(candidate.resolution) ||
      candidate.target.section !== "answer_bank"
    )
      return [];
    const saved = resumeImportAnswer(candidate.target.key);
    const answer = candidate.normalizedValue ?? candidate.value;
    if (!saved || typeof answer !== "string" || !answer.trim()) return [];
    const { key, kind } = saved;
    return [
      {
        key,
        kind,
        label: candidate.label,
        prompt: candidate.label,
        answer: answer.trim(),
        input: "text",
        needsConfirmation: candidate.resolution !== "auto_applied" || kind === "work_authorization" || kind === "visa_sponsorship",
      },
    ];
  });
}
