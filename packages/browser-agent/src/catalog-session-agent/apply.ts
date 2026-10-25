import type {
  ApplyExecutionResult,
  ApplyRecoveryContext,
  CandidateProfile,
  SavedJob,
} from "@nestor/contracts";
import { normalizeText, tokenize } from "./shared";

function buildProfileAnswerProvenance(input: {
  sourceKind:
    | "profile"
    | "proof_bank"
    | "resume"
    | "job"
    | "prior_answer"
    | "source_debug"
    | "user";
  sourceId: string | null;
  label: string;
  snippet: string | null;
}) {
  return {
    id: `answer_provenance_${input.sourceKind}_${input.sourceId ?? input.label}`,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    label: input.label,
    snippet: input.snippet,
  };
}

function matchesCustomAnswerPrompt(input: {
  prompt: string;
  question: string;
  label: string;
}) {
  const promptTokens = new Set(tokenize(input.prompt));
  const candidateTokens = new Set(
    [...tokenize(input.question), ...tokenize(input.label)].filter(Boolean),
  );
  let sharedTokenCount = 0;

  for (const token of candidateTokens) {
    if (promptTokens.has(token)) {
      sharedTokenCount += 1;
    }
  }

  return sharedTokenCount >= 2;
}

function buildCustomAnswerSuggestions(input: {
  profile: CandidateProfile;
  prompt: string;
  preferredKinds?: readonly string[];
  questionId: string;
}) {
  const preferredKinds = new Set(input.preferredKinds ?? []);

  return input.profile.answerBank.customAnswers
    .filter(
      (entry) =>
        preferredKinds.has(entry.kind) ||
        matchesCustomAnswerPrompt({
          prompt: input.prompt,
          question: entry.question,
          label: entry.label,
        }),
    )
    .map((entry, index) => ({
      id: `suggested_answer_${input.questionId}_custom_${index + 1}`,
      text: entry.answer,
      sourceKind: "profile" as const,
      sourceId: entry.id,
      confidenceLabel: "saved custom answer",
      provenance: [
        buildProfileAnswerProvenance({
          sourceKind: "profile",
          sourceId: entry.id,
          label: entry.label,
          snippet: entry.answer,
        }),
      ],
    }));
}

function mergeSuggestedAnswers(
  values: ReadonlyArray<
    ApplyExecutionResult["questions"][number]["suggestedAnswers"][number]
  >,
) {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const key = normalizeText(value.text);

    if (!key || seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [value];
  });
}

export function buildScreeningQuestions(input: {
  job: SavedJob;
  profile: CandidateProfile;
  now: string;
}) {
  const normalizedDescription = normalizeText(input.job.description);
  const questions: ApplyExecutionResult["questions"] = [];

  const pushQuestion = (
    question: ApplyExecutionResult["questions"][number],
  ) => {
    questions.push(question);
  };

  if (
    normalizedDescription.includes("work authorization") ||
    normalizedDescription.includes("visa sponsorship")
  ) {
    const questionId = `question_${input.job.id}_work_auth`;
    const prompt =
      "Can you confirm your work authorization or visa sponsorship status?";
    const answerText =
      input.profile.answerBank.workAuthorization ??
      (input.profile.workEligibility.authorizedWorkCountries.length > 0
        ? `Authorized to work in ${input.profile.workEligibility.authorizedWorkCountries.join(", ")}.`
        : null);
    const sponsorshipText =
      input.profile.answerBank.visaSponsorship ??
      (input.profile.workEligibility.requiresVisaSponsorship === true
        ? "Requires visa sponsorship."
        : input.profile.workEligibility.requiresVisaSponsorship === false
          ? "Does not require visa sponsorship."
          : null);

    pushQuestion({
      id: questionId,
      prompt,
      kind: "work_authorization",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...[answerText, sponsorshipText]
          .filter((value): value is string => Boolean(value))
          .map((value, index) => ({
            id: `suggested_answer_${input.job.id}_work_auth_${index + 1}`,
            text: value,
            sourceKind: "profile" as const,
            sourceId: input.profile.id,
            confidenceLabel: "profile default",
            provenance: [
              buildProfileAnswerProvenance({
                sourceKind: "profile",
                sourceId: input.profile.id,
                label: "Profile work eligibility",
                snippet: value,
              }),
            ],
          })),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["work_authorization", "visa_sponsorship"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (normalizedDescription.includes("salary expectation")) {
    const questionId = `question_${input.job.id}_salary`;
    const prompt = "What are your salary expectations for this role?";
    const answerText = input.profile.answerBank.salaryExpectations;

    pushQuestion({
      id: questionId,
      prompt,
      kind: "salary_expectation",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${input.job.id}_salary`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "profile default",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Profile salary expectations",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["salary_expectation"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (normalizedDescription.includes("portfolio")) {
    const questionId = `question_${input.job.id}_portfolio`;
    const prompt =
      "Please share a portfolio, case study, or public work sample.";
    const preferredLinkId =
      input.profile.applicationIdentity.preferredLinkIds[0] ?? null;
    const preferredLink = preferredLinkId
      ? (input.profile.links.find((link) => link.id === preferredLinkId) ??
        null)
      : (input.profile.links.find(
          (link) => link.kind === "portfolio" || link.kind === "case_study",
        ) ?? null);
    const answerText = preferredLink?.url ?? input.profile.portfolioUrl ?? null;

    pushQuestion({
      id: questionId,
      prompt,
      kind: "portfolio",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${input.job.id}_portfolio`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: preferredLink?.id ?? input.profile.id,
                confidenceLabel: preferredLink
                  ? "preferred public link"
                  : "profile portfolio",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: preferredLink?.id ?? input.profile.id,
                    label: preferredLink?.label ?? "Portfolio link",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["other"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (normalizedDescription.includes("relocation")) {
    const questionId = `question_${input.job.id}_relocation`;
    const prompt = "Are you open to relocation for this role?";
    const answerText = input.profile.answerBank.relocation;

    pushQuestion({
      id: questionId,
      prompt,
      kind: "relocation",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${questionId}`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "profile default",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Profile relocation answer",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["relocation"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (normalizedDescription.includes("travel")) {
    const questionId = `question_${input.job.id}_travel`;
    const prompt = "Can you support the travel expectations for this role?";
    const answerText = input.profile.answerBank.travel;

    pushQuestion({
      id: questionId,
      prompt,
      kind: "travel",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${questionId}`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "profile default",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Profile travel answer",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["travel"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (
    normalizedDescription.includes("notice period") ||
    normalizedDescription.includes("start date") ||
    normalizedDescription.includes("availability")
  ) {
    const questionId = `question_${input.job.id}_availability`;
    const prompt =
      "What is your notice period and earliest available start date?";
    const answerText =
      input.profile.answerBank.noticePeriod ??
      input.profile.answerBank.availability;

    pushQuestion({
      id: questionId,
      prompt,
      kind: normalizedDescription.includes("notice period")
        ? "notice_period"
        : "availability",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${questionId}`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "profile default",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Profile availability answer",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["notice_period", "availability"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (
    normalizedDescription.includes("introduce yourself") ||
    normalizedDescription.includes("about yourself")
  ) {
    const questionId = `question_${input.job.id}_intro`;
    const prompt = "Please introduce yourself briefly for this role.";
    const answerText = input.profile.answerBank.selfIntroduction;

    pushQuestion({
      id: questionId,
      prompt,
      kind: "other",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${questionId}`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "profile default",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Profile self introduction",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["self_intro"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (
    normalizedDescription.includes("why are you leaving") ||
    normalizedDescription.includes("career transition")
  ) {
    const questionId = `question_${input.job.id}_career_transition`;
    const prompt =
      "How would you explain your current transition or why you are exploring a new role?";
    const answerText = input.profile.answerBank.careerTransition;

    pushQuestion({
      id: questionId,
      prompt,
      kind: "other",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(answerText
          ? [
              {
                id: `suggested_answer_${questionId}`,
                text: answerText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "profile default",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Profile career-transition answer",
                    snippet: answerText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          preferredKinds: ["career_transition"],
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (
    normalizedDescription.includes("email") ||
    normalizedDescription.includes("phone")
  ) {
    const questionId = `question_${input.job.id}_contact`;
    const prompt = "Which contact details should we use for this application?";
    const contactText = [
      input.profile.applicationIdentity.preferredEmail ?? input.profile.email,
      input.profile.applicationIdentity.preferredPhone ?? input.profile.phone,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" | ");

    pushQuestion({
      id: questionId,
      prompt,
      kind: "personal_info",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: mergeSuggestedAnswers([
        ...(contactText
          ? [
              {
                id: `suggested_answer_${questionId}`,
                text: contactText,
                sourceKind: "profile" as const,
                sourceId: input.profile.id,
                confidenceLabel: "application identity defaults",
                provenance: [
                  buildProfileAnswerProvenance({
                    sourceKind: "profile",
                    sourceId: input.profile.id,
                    label: "Application contact defaults",
                    snippet: contactText,
                  }),
                ],
              },
            ]
          : []),
        ...buildCustomAnswerSuggestions({
          profile: input.profile,
          prompt,
          questionId,
        }),
      ]),
      submittedAnswer: null,
      status: "detected",
    });
  }

  return questions;
}

export function buildApplyReplay(
  job: SavedJob,
  recoveryContext?: ApplyRecoveryContext,
) {
  const lastUrl = job.applicationUrl ?? job.canonicalUrl;
  const checkpointUrls = Array.from(
    new Set([
      ...(recoveryContext?.latestCheckpoint?.url
        ? [recoveryContext.latestCheckpoint.url]
        : []),
      ...(recoveryContext?.checkpointUrls ?? []),
      ...(lastUrl ? [lastUrl] : []),
    ]),
  );

  return {
    sourceInstructionArtifactId: null,
    sourceDebugEvidenceRefIds: [],
    lastUrl:
      recoveryContext?.latestCheckpoint?.url ??
      recoveryContext?.checkpointUrls?.[0] ??
      lastUrl,
    checkpointUrls,
  };
}
