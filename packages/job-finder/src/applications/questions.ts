import { createHash } from "node:crypto";
import type {
  ApplicationAttemptQuestion,
  RequestNeedsYouInput,
  CandidateReusableAnswer,
} from "@nestor/contracts";

export type FormQuestion = Pick<
  ApplicationAttemptQuestion,
  "prompt" | "kind" | "answerControlType" | "answerOptions" | "inputConstraints"
>;

const normalize = (value: string) =>
  value
    .toLocaleLowerCase("en")
    .replace(/^application\s*[—–-]\s*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
const geographic = new Set([
  "work_authorization",
  "visa_sponsorship",
  "relocation",
]);

/** A semantic question and its answer format, scoped to the actual role's place. */
export function describeFormQuestion(
  question: FormQuestion,
  job: { id: number; location: string },
): {
  key: string;
  input: RequestNeedsYouInput["input"];
  options: string[];
} {
  const options = [
    ...new Set(
      question.answerOptions.map((value) => value.trim()).filter(Boolean),
    ),
  ];
  const yesNo =
    options.length === 2 &&
    options.some((v) => /^yes$/iu.test(v)) &&
    options.some((v) => /^no$/iu.test(v));
  const input: RequestNeedsYouInput["input"] =
    yesNo || question.answerControlType === "boolean"
      ? "boolean"
      : question.inputConstraints?.type === "number"
        ? "number"
        : question.answerControlType === "file"
          ? "file"
          : options.length > 0
            ? "choice"
            : "text";
  const format =
    input === "choice"
      ? `${input}:${options.map(normalize).sort().join("|")}`
      : input;
  const place = geographic.has(question.kind)
    ? normalize(job.location) || `unknown place for job ${job.id}`
    : "";
  return {
    key: `question:${digest(`${normalize(question.prompt)}|${format}|${place}`)}`,
    input,
    options: input === "choice" ? options : [],
  };
}

export function toKnownFormAnswer(
  input: {
    id: string;
    prompt: string;
    answer: string;
    local: boolean;
  },
  question: FormQuestion,
  location: string,
  applicationId: number,
): CandidateReusableAnswer {
  const kind = [
    "work_authorization",
    "visa_sponsorship",
    "relocation",
    "travel",
    "notice_period",
    "availability",
    "salary_expectation",
    "self_intro",
    "career_transition",
  ].includes(question.kind)
    ? (question.kind as CandidateReusableAnswer["kind"])
    : "other";
  return {
    id: `${input.local ? "application" : "remembered"}_${input.id}`,
    label: input.prompt,
    question: input.prompt,
    answer: input.answer,
    kind,
    roleFamilies: [],
    proofEntryIds: [],
    ...(input.local || geographic.has(question.kind)
      ? {
          applicationScope: {
            resultId: null,
            applicationRecordId: input.local
              ? `application_${applicationId}`
              : null,
            location: geographic.has(question.kind) ? location : null,
          },
        }
      : {}),
  };
}
