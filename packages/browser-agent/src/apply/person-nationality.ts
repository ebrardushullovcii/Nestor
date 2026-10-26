/** These facts are never established by residence, location, language or work eligibility. */
export const NATIONALITY_ANSWER_REASON =
  "Residence does not establish passport country or citizenship. Please supply your answer to this question.";
export function requiresSavedNationalityAnswer(question: string): boolean {
  return nationalityQuestionIdentity(question) !== null;
}

export function nationalityQuestionIdentity(question: string): string | null {
  if (
    /\b(?:passport(?:\s+(?:issuing|issuance))?\s+country|country\s+(?:of|issuing)\s+(?:your\s+)?passport)\b/iu.test(
      question,
    )
  )
    return "passport_country";
  if (/\b(?:citizenship|nationality)\b/iu.test(question)) return "citizenship";
  if (/\bcountry\s+of\s+birth\b/iu.test(question)) return "birth_country";
  return null;
}
