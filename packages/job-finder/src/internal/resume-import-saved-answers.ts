import type {
  ResumeImportFieldCandidate,
  UpsertSavedFormAnswerInput,
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
    const kind =
      candidate.target.key === "selfIntroduction"
        ? "self_intro"
        : candidate.target.key === "careerTransition"
          ? "career_transition"
          : null;
    const answer = candidate.normalizedValue ?? candidate.value;
    if (!kind || typeof answer !== "string" || !answer.trim()) return [];
    return [
      {
        key: `resume_import:${kind}`,
        kind,
        label: candidate.label,
        prompt: candidate.label,
        answer: answer.trim(),
        input: "text",
        needsConfirmation: candidate.resolution !== "auto_applied",
      },
    ];
  });
}
