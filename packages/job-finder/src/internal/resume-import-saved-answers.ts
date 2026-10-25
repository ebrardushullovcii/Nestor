import type {
  ResumeImportFieldCandidate,
  UpsertSavedFormAnswerInput,
} from "@nestor/contracts";

/** Accepted reusable text goes to Needs you; it is never part of Profile. */
export function resumeImportSavedAnswers(
  candidates: readonly ResumeImportFieldCandidate[],
): UpsertSavedFormAnswerInput[] {
  return candidates.flatMap((candidate) => {
    if (
      candidate.resolution !== "auto_applied" ||
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
        needsConfirmation: false,
      },
    ];
  });
}
