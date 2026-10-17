import {
  compareApplicationAnswerRecency,
  type CandidateProfile,
  type ApplicationQuestionRecord,
  type ApplicationAnswerRecord,
  type ApplicationReviewCard,
} from "@nestor/contracts";

/** Old automatic answer memory is kept for the person to review, never treated as their fact. */
export function quarantineAgentAnswers(
  profile: CandidateProfile,
  questions: readonly ApplicationQuestionRecord[],
  records: readonly ApplicationAnswerRecord[],
  reviews: readonly ApplicationReviewCard[] = [],
): CandidateProfile {
  const agentSource = (sourceId: string | null | undefined) =>
    sourceId?.startsWith("written.") || sourceId?.startsWith("chosen.");
  const agentRecord = (record: ApplicationAnswerRecord) =>
    agentSource(record.sourceId) ||
    record.provenance.some(
      (source) =>
        agentSource(source.sourceId) ||
        source.label === "chosen on the form by Job Finder",
    );
  const prompts = new Map(
    questions.map((question) => [question.id, question.prompt.trim()]),
  );
  return {
    ...profile,
    answerBank: {
      ...profile.answerBank,
      customAnswers: profile.answerBank.customAnswers.map((saved) => {
        const matching = records
          .filter(
            (record) =>
              prompts.get(record.questionId) === saved.question.trim() &&
              record.text.trim() === saved.answer.trim(),
          )
          .sort(compareApplicationAnswerRecency);
        // An actual person-provided answer is evidence of their confirmation. A
        // profile/answer-library echo of the old value is not that evidence.
        if (
          matching.some(
            (record) =>
              record.sourceKind === "user" &&
              !record.sourceId?.startsWith("answerLibrary.") &&
              !agentRecord(record),
          )
        )
          return saved;
        const hasAgentRecord = matching.some(agentRecord);
        const agentReview = reviews.some((card) =>
          card.answers.some(
            (answer) =>
              answer.question.trim() === saved.question.trim() &&
              answer.answer.trim() === saved.answer.trim() &&
              (answer.written ||
                answer.source === "chosen on the form by Job Finder"),
          ),
        );
        if (!hasAgentRecord && !agentReview) return saved;
        return { ...saved, needsConfirmation: true };
      }),
    },
  };
}
