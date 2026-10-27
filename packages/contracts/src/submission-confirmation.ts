/** Textual evidence only; automatic sends also require their final response. */
export function hasApplicationSubmissionConfirmation(
  pageText: string,
): boolean {
  const text = pageText.toLowerCase().replace(/\s+/gu, " ").trim();
  return (
    /\b(?:your )?application (?:(?:has been|was|is) )?(?:successfully )?(?:submitted|received|completed)\b/u.test(
      text,
    ) ||
    [
      "thank you for applying",
      "thanks for applying",
      "we have received your application",
      "successfully applied",
      "application complete",
    ].some((signal) => text.includes(signal))
  );
}

/** Preserve the site's own labelled reference; never invent one from a URL or job id. */
export function submissionConfirmationSummary(pageText: string): string {
  const reference = pageText
    .match(
      /\b(?:confirmation(?:\s+(?:number|reference|id))?|(?:application\s+)?reference(?:\s+(?:number|id))?)\s*[:#]\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{1,100})/iu,
    )?.[1]
    ?.replace(/[.]+$/u, "");
  return reference
    ? `The site confirmed receipt. Reference: ${reference}.`
    : "The site confirmed receipt of the application.";
}
