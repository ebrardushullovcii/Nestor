import type {
  ResumeImportFieldCandidate,
  UpsertSavedFormAnswerInput,
  CandidateAnswerKind,
} from "@nestor/contracts";

const ANSWER_KINDS: Readonly<Record<string, CandidateAnswerKind>> = {
  workAuthorization: "work_authorization", visaSponsorship: "visa_sponsorship",
  relocation: "relocation", travel: "travel", noticePeriod: "notice_period",
  availability: "availability", salaryExpectations: "salary_expectation",
  selfIntroduction: "self_intro", careerTransition: "career_transition",
};

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
    const kind = ANSWER_KINDS[candidate.target.key];
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
        needsConfirmation: candidate.resolution !== "auto_applied" || kind === "work_authorization" || kind === "visa_sponsorship",
      },
    ];
  });
}
