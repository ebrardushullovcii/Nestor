import {
  compareApplicationAnswerRecency,
  type ApplicationAnswerRecord,
  type ApplicationQuestionRecord,
  type ApplicationReviewCard,
} from "@nestor/contracts";

const SAYS_YES = /^(yes|true|agree|i agree|accept|checked|on|1)\b/iu;

/**
 * An answer the run filled from the person's own earlier answer in this
 * application (a one-use answer) is theirs. The screen credits the person
 * only with stored evidence, so each such answer is matched here to the
 * record it came from: this application, the same question, given by the
 * person, with the same value (a ticked box matches an answer that says yes).
 */
export function creditOwnApplicationAnswers(
  card: ApplicationReviewCard | null,
  questions: readonly ApplicationQuestionRecord[],
  answers: readonly ApplicationAnswerRecord[],
): ApplicationReviewCard | null {
  if (!card) return card;
  return {
    ...card,
    answers: card.answers.map((answer) => {
      if (!answer.sourceId?.startsWith("answerLibrary.application_"))
        return answer;
      const questionIds = new Set(
        questions
          .filter((question) => question.prompt === answer.question)
          .map((question) => question.id),
      );
      const value = answer.answer.trim();
      const record = answers
        .filter(
          (entry) =>
            questionIds.has(entry.questionId) &&
            entry.sourceKind === "user" &&
            !entry.sourceId?.startsWith("answerLibrary.") &&
            entry.status !== "rejected" &&
            entry.status !== "skipped" &&
            (entry.text.trim() === value ||
              (value === "Yes" && SAYS_YES.test(entry.text.trim()))),
        )
        .sort(compareApplicationAnswerRecency)[0];
      return record
        ? {
            ...answer,
            source: "your answer to this question",
            sourceId: `applicationAnswer.${record.id}`,
          }
        : answer;
    }),
  };
}
