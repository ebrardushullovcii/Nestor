import {
  compareApplicationAnswerRecency,
  type ApplicationAnswerRecord,
  type ApplicationQuestionRecord,
  type CandidateProfile,
} from "@nestor/contracts";
import {
  createReusableAnswerForQuestion,
  eligibilityAnswerScope,
} from "./workspace-answer-memory";

function isExecutableUserAnswer(
  answer: ApplicationAnswerRecord | undefined,
): answer is ApplicationAnswerRecord {
  return (
    answer?.sourceKind === "user" &&
    !answer.sourceId?.startsWith("answerLibrary.") &&
    (answer.status === "suggested" || answer.status === "filled") &&
    answer.value?.type !== "asset_ref" &&
    answer.text.trim().length > 0
  );
}

export function mergeApplicationAnswersIntoExecutionProfile(input: {
  profile: CandidateProfile;
  questionRecords: readonly ApplicationQuestionRecord[];
  answerRecords: readonly ApplicationAnswerRecord[];
  idPrefix: string;
  applicationRecordId?: string;
  jobLocation?: string | null;
}): CandidateProfile {
  const answerById = new Map(
    input.answerRecords.map((answer) => [answer.id, answer] as const),
  );
  const answersByQuestionId = new Map<string, ApplicationAnswerRecord[]>();
  for (const answer of input.answerRecords) {
    const current = answersByQuestionId.get(answer.questionId) ?? [];
    current.push(answer);
    answersByQuestionId.set(answer.questionId, current);
  }

  const applicationAnswers = input.questionRecords.flatMap((question) => {
    if (
      input.applicationRecordId &&
      question.applicationRecordId !== input.applicationRecordId
    )
      return [];
    const belongsToQuestion = (answer: ApplicationAnswerRecord) =>
      answer.sourceKind === "user" &&
      !answer.sourceId?.startsWith("answerLibrary.") &&
      answer.applicationRecordId === question.applicationRecordId;
    const selected = question.selectedAnswerId
      ? answerById.get(question.selectedAnswerId)
      : undefined;
    const latest =
      (selected && belongsToQuestion(selected) ? selected : undefined) ??
      [...(answersByQuestionId.get(question.id) ?? [])]
        .filter(belongsToQuestion)
        .sort(compareApplicationAnswerRecency)[0];
    if (!isExecutableUserAnswer(latest)) {
      return [];
    }

    return [
      createReusableAnswerForQuestion({
        answer: latest.text,
        prompt: question.prompt,
        kind: question.kind,
        idPrefix: input.idPrefix,
        applicationScope: eligibilityAnswerScope({
          kind: question.kind,
          resultId: question.resultId,
          applicationRecordId: question.applicationRecordId ?? null,
          location: input.jobLocation,
          ...(latest.hiringCountry
            ? { hiringCountry: latest.hiringCountry }
            : {}),
        }) ?? {
          resultId: question.resultId,
          applicationRecordId: question.applicationRecordId ?? null,
          location: null,
        },
      }),
    ];
  });
  if (applicationAnswers.length === 0) {
    return input.profile;
  }

  return {
    ...input.profile,
    answerBank: {
      ...input.profile.answerBank,
      customAnswers: [
        ...applicationAnswers,
        ...input.profile.answerBank.customAnswers,
      ],
    },
  };
}
