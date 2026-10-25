const BODY_SALARY_RANGE_PATTERN =
  /\b(?:salary|compensation|pay(?:\s+range)?)\b[^.!?]{0,90}?((?:(?:USD|CAD|AUD|EUR|GBP)\s*)?(?:CA\$|A\$|\$|€|£)?\s*\d[\d,.]*(?:\s*[kK])?(?:\s*(?:-|–|—|to)\s*(?:(?:USD|CAD|AUD|EUR|GBP)\s*)?(?:CA\$|A\$|\$|€|£)?\s*\d[\d,.]*(?:\s*[kK])?)?(?:\s*(?:USD|CAD|AUD|EUR|GBP))?(?:\s*(?:\/|per\s+)?(?:hourly|daily|weekly|monthly|yearly|annually|hour|hours|hr|day|week|month|year|yr))?)/iu;

const BODY_SALARY_MONEY_MARKER_PATTERN =
  /(?:(?:(?:USD|CAD|AUD|EUR|GBP)\s*|(?:CA\$|A\$|\$|€|£)\s*)\d|\d[\d,.]*\s*(?:[kK]\b|(?:USD|CAD|AUD|EUR|GBP)\b|(?:\/\s*|per\s+)(?:hour|hr|day|week|month|year)\b|annually\b))/iu;

/**
 * Returns the explicit pay range nearest a salary/compensation/pay label in
 * the listing body. It is deliberately cue-bound: arbitrary years, user
 * counts and performance percentages elsewhere in the page are not pay.
 */
export function extractSalaryRangeFromListingBody(
  description: string,
): string | null {
  const explicitAmount =
    /(?:\b(?:USD|CAD|AUD|EUR|GBP)\s*|(?:CA\$|A\$|\$|€|£)\s*)\d[\d,.]*(?:\s*[kK])?(?:\s*(?:-|–|—|to)\s*(?:(?:USD|CAD|AUD|EUR|GBP)\s*)?(?:CA\$|A\$|\$|€|£)?\s*\d[\d,.]*(?:\s*[kK])?)?\s*(?:per\s+(?:year|month|week|day|hour)|\/(?:year|yr|month|week|day|hour|hr)|annually|yearly|monthly|weekly|daily|hourly)\b/iu;
  const labelled = BODY_SALARY_RANGE_PATTERN.exec(description)?.[1]?.trim();
  if (labelled && BODY_SALARY_MONEY_MARKER_PATTERN.test(labelled))
    return labelled;
  return explicitAmount.exec(description)?.[0]?.trim() ?? null;
}
