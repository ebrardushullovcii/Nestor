/** A site's writing rule cannot be overridden by a model's fact-check verdict. */
export const OWN_WORDS_REASON =
  "This form asks for your own words. Write this answer yourself; Job Finder will use it unchanged.";

export function requiresOwnWords(text: string): boolean {
  const normalized = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘-]/gu, " ");
  const rules = [
    /\b(?:in\s+your\s+own\s+words|(?:do\s+not|don[ ']*t|must\s+not|never)\s+use\s+(?:generative\s+)?(?:ai|artificial\s+intelligence|chatgpt)|ai[\s-]*generated\s+(?:answers?|text|responses?|content)\s+(?:(?:are|is)\s+)?(?:not\s+(?:allowed|permitted|accepted)|prohibited|forbidden))\b/iu,
    /\b(?:write\s+(?:your\s+)?(?:answer|response)\s+yourself|written\s+by\s+(?:the\s+)?applicant|without\s+using\s+(?:ai|chatgpt|artificial\s+intelligence)|(?:use\s+of\s+)?(?:ai|chatgpt)(?:\s+tools)?\s+(?:is|are)\s+(?:prohibited|forbidden|not\s+(?:allowed|permitted)))\b/iu,
    /\b(?:eigenen\s+worten|(?:schreiben|verfassen).{0,60}antwort.{0,30}selbst|antwort.{0,50}(?:bewerber|bewerberin).{0,30}(?:verfasst|geschrieben)|(?:nutzung|verwendung).{0,30}\bki\b.{0,30}(?:verboten|nicht\s+erlaubt)|(?:verwenden|benutzen).{0,30}kein.{0,15}(?:ki|chatgpt))\b/iu,
    /\b(?:(?:vos|tes)\s+propres\s+mots|(?:redigez|ecrivez).{0,60}(?:vous\s+meme|toi\s+meme)|reponse.{0,30}(?:redigee|ecrite).{0,30}(?:candidat|candidate)|n[ ']*utilise[rz]?\s+pas.{0,15}(?:ia|chatgpt)|(?:outils|utilisation).{0,30}(?:ia|chatgpt).{0,40}(?:interdit|pas\s+autorise[es]*|non\s+autorise[es]*)|sans\s+utiliser\s+(?:ia|chatgpt))\b/iu,
    /\b(?:(?:tus|sus)\s+propias\s+palabras|(?:escribe|escriba|redacta|redacte).{0,60}(?:tu\s+mism[oa]|usted\s+mism[oa])|respuesta.{0,40}(?:escrita|redactada).{0,30}(?:solicitante|candidato)|no\s+(?:se\s+)?(?:uses?|usen?|utilices?|permite[n]?).{0,40}(?:ia|chatgpt)|sin\s+usar\s+(?:ia|chatgpt))\b/iu,
  ];
  return rules.some((rule) => rule.test(normalized));
}

/** Retain the instruction's scope; the boolean alone loses which field it names. */
export function formWritingInstructions(
  page:
    | {
        bodyTextExcerpt: string;
        ownWordsRequired?: boolean;
      }
    | null
    | undefined,
): string {
  const text = page?.bodyTextExcerpt ?? "";
  return page?.ownWordsRequired && !requiresOwnWords(text)
    ? `${text}\nIn your own words`
    : text;
}

export function ownWordsAppliesToQuestion(
  instructions: string,
  question: string,
): boolean {
  if (requiresOwnWords(question)) return true;
  const letter =
    /\b(?:cover\s+letter|application\s+letter|anschreiben|lettre\s+de\s+motivation|carta\s+de\s+(?:presentacion|apresentacao))\b/iu;
  return instructions.split(/[\n.!?;]+/u).some((clause) => {
    if (!requiresOwnWords(clause)) return false;
    return (
      !letter.test(clause.normalize("NFKD").replace(/\p{M}/gu, "")) ||
      letter.test(question.normalize("NFKD").replace(/\p{M}/gu, ""))
    );
  });
}
