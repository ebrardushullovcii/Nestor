import { createHash } from "node:crypto";
import {
  STEP_HANDOVER_QUESTION_ID,
  UPLOAD_REPAIR_QUESTION_ID,
} from "@nestor/browser-agent";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import type {
  ApplicationAttemptQuestion,
  RequestNeedsYouInput,
  CandidateReusableAnswer,
  CandidateAnswerKind,
  RememberFormAnswerInput,
} from "@nestor/contracts";

export type FormQuestion = Pick<
  ApplicationAttemptQuestion,
  | "prompt"
  | "kind"
  | "answerControlType"
  | "answerOptions"
  | "inputConstraints"
  | "repeatedAtDifferentStep"
> &
  Partial<Pick<ApplicationAttemptQuestion, "id">>;

const normalize = normalizeFormQuestionPrompt;
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
  reusePrompt: boolean;
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
  // A refused upload belongs to this application's page, whichever files
  // it names; every other file question keeps its shared key.
  if (question.id === UPLOAD_REPAIR_QUESTION_ID)
    return {
      key: `question:${digest(`upload repair|job ${job.id}`)}`,
      input: "file",
      options: [],
      reusePrompt: false,
    };
  // A form button handed to the person is that application's own step: two
  // forms waiting on "Save and continue" are two items, each continuing only
  // its own application.
  if (question.id === STEP_HANDOVER_QUESTION_ID)
    return {
      key: `question:${digest(`step handover|job ${job.id}|${normalize(question.prompt)}`)}`,
      input: "text",
      options: [],
      reusePrompt: false,
    };
  const jobSpecific =
    question.kind === "cover_letter" ||
    question.repeatedAtDifferentStep === true;
  const place = jobSpecific
    ? `job ${job.id}`
    : geographic.has(question.kind)
      ? normalize(job.location) || `unknown place for job ${job.id}`
      : "";
  return {
    key: `question:${digest(`${normalize(question.prompt)}|${format}|${place}`)}`,
    input,
    options: input === "choice" ? options : [],
    reusePrompt:
      input !== "file" && !jobSpecific && !geographic.has(question.kind),
  };
}

export function describeSavedFormAnswer(
  prompt: string,
  answer: string,
): Pick<RememberFormAnswerInput, "key" | "input" | "options" | "answer"> {
  const input = /^(?:yes|no)$/iu.test(answer)
    ? "boolean"
    : /^[-+]?\d+(?:\.\d+)?$/u.test(answer)
      ? "number"
      : "text";
  return {
    key: `question:${digest(`${normalize(prompt)}|${input}|`)}`,
    input,
    options: [],
    answer:
      input === "boolean"
        ? answer.toLowerCase() === "yes"
          ? "Yes"
          : "No"
        : answer,
  };
}

export function toKnownFormAnswer(
  input: {
    id: string;
    prompt: string;
    answer: string;
    local: boolean;
    kind?: CandidateAnswerKind;
    roleFamilies?: string[];
    proofEntryIds?: string[];
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
    kind: input.kind && input.kind !== "other" ? input.kind : kind,
    roleFamilies: input.roleFamilies ?? [],
    proofEntryIds: input.proofEntryIds ?? [],
    ...(input.local ||
    question.kind === "cover_letter" ||
    question.kind === "salary_expectation" ||
    geographic.has(question.kind)
      ? {
          applicationScope: {
            resultId: null,
            applicationRecordId:
              input.local ||
              question.kind === "cover_letter" ||
              question.kind === "salary_expectation"
                ? `application_${applicationId}`
                : null,
            location: geographic.has(question.kind) ? location : null,
          },
        }
      : {}),
  };
}
