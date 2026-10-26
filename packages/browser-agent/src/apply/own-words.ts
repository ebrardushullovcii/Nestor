/** A site's writing rule cannot be overridden by a model's fact-check verdict. */
export const OWN_WORDS_REASON =
  "This form asks for your own words. Write this answer yourself; Job Finder will use it unchanged.";

export function requiresOwnWords(text: string): boolean {
  return /\b(?:in\s+your\s+own\s+words|(?:do\s+not|don['’]t|must\s+not|never)\s+use\s+(?:generative\s+)?(?:ai|artificial\s+intelligence)|ai[\s-]*generated\s+(?:answers?|text|responses?|content)\s+(?:(?:are|is)\s+)?(?:not\s+(?:allowed|permitted|accepted)|prohibited|forbidden))\b/iu.test(
    text.normalize("NFKC"),
  );
}
