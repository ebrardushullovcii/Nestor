import {
  normalizeFormQuestionPrompt,
  preserveTechnologyTokens,
} from "@nestor/contracts";
import { fieldNamesAnotherPerson } from "./github-username";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

const companyKey = (value: string) =>
  normalizeFormQuestionPrompt(preserveTechnologyTokens(value)).replace(
    /\s+(?:inc|incorporated|ltd|limited|llc|gmbh|plc)$/u,
    "",
  );

/** Only the named employer's plain prior-employment question, without extra conditions. */
export function priorCompanyHistory(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
): {
  company: string;
  answer: { value: "Yes" | "No"; sourceId: string } | null;
} | null {
  if (fieldNamesAnotherPerson(control)) return null;
  const question = normalizeFormQuestionPrompt(
    preserveTechnologyTokens(
      control.kind === "radio" || control.choiceGroupKey
        ? control.groupLabel
        : control.label,
    ),
  );
  const match =
    /^(?:have you|have you ever) (?:previously )?(?:worked (?:at|for)(?: or consulted (?:for|at))?|worked or consulted for|been employed by|consulted for) (.+)$/u.exec(
      question,
    );
  if (!match?.[1]) return null;
  const company = companyKey(match[1]);
  const records = sources.profile.experiences.filter(
    (record) => !record.isDraft && record.companyName?.trim(),
  );
  // A recognized company bounds the question. A trailing condition must not
  // become part of a supposed company name and authorize a compound answer.
  if (
    ![
      sources.posting.company,
      ...records.map((record) => record.companyName!),
    ].some((name) => companyKey(name) === company)
  )
    return null;
  const employer = records.find(
    (record) => companyKey(record.companyName!) === company,
  );
  if (employer)
    return {
      company,
      answer: {
        value: "Yes",
        sourceId: `profile.experiences.${employer.id}.companyName`,
      },
    };
  // An empty or unfinished history is unknown, rather than proof of no history.
  if (
    !records.length ||
    sources.profile.experiences.some((record) => record.isDraft)
  )
    return { company, answer: null };
  return {
    company,
    answer: { value: "No", sourceId: "profile.experiences#priorCompany" },
  };
}
