import type {
  ApplicationQuestionKind,
  CandidateAnswerKind,
  CandidateReusableAnswer,
} from "@nestor/contracts";

export function normalizeAnswerQuestion(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function mapQuestionKindToCandidateAnswerKind(
  kind: ApplicationQuestionKind,
): CandidateAnswerKind {
  switch (kind) {
    case "work_authorization":
      return "work_authorization";
    case "visa_sponsorship":
      return "visa_sponsorship";
    case "salary_expectation":
      return "salary_expectation";
    case "availability":
      return "availability";
    case "notice_period":
      return "notice_period";
    case "relocation":
      return "relocation";
    case "travel":
      return "travel";
    default:
      return "other";
  }
}

function stableAnswerId(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function createReusableAnswerForQuestion(input: {
  answer: string;
  prompt: string;
  kind: ApplicationQuestionKind;
  idPrefix?: string;
  applicationScope?: CandidateReusableAnswer["applicationScope"];
}): CandidateReusableAnswer {
  return {
    id: `${input.idPrefix ?? "answer_memory"}_${stableAnswerId(`${input.prompt}\n${input.applicationScope?.hiringCountry ?? input.applicationScope?.location ?? ""}`)}`,
    kind: mapQuestionKindToCandidateAnswerKind(input.kind),
    label: input.prompt.slice(0, 120),
    question: input.prompt,
    answer: input.answer,
    roleFamilies: [],
    proofEntryIds: [],
    ...(input.applicationScope
      ? { applicationScope: input.applicationScope }
      : {}),
  };
}

export function eligibilityAnswerScope(input: {
  kind: ApplicationQuestionKind;
  resultId: string | null;
  applicationRecordId: string | null;
  location: string | null | undefined;
  hiringCountry?: string;
}): CandidateReusableAnswer["applicationScope"] {
  return input.kind === "work_authorization" ||
    input.kind === "visa_sponsorship"
    ? {
        resultId: input.resultId,
        applicationRecordId: input.applicationRecordId,
        location: input.location?.trim() || null,
        ...(input.hiringCountry ? { hiringCountry: input.hiringCountry } : {}),
      }
    : undefined;
}
