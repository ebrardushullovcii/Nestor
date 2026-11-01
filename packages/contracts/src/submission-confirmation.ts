/**
 * Receipt statements rather than a bag of success words. Keeping their text
 * lets a caller distinguish a fresh acknowledgement from stale page copy.
 * This is textual evidence only; automatic sends also need their final response.
 * Self-contained so trusted browser observers can serialize this exact reader.
 */
export function readApplicationSubmissionConfirmationEvidence(
  pageText: string,
): { messages: string[]; refused: boolean } {
  const text = pageText.normalize("NFKC").replace(/[’‘]/gu, "'").toLowerCase();
  const parts = (text.match(/[^.!?\n]+[.!?]?/gu) ?? []).map((part) =>
    part.replace(/\s+/gu, " ").trim(),
  );
  const refused = parts.some((sentence) => {
    if (
      /\b(?:if|when|once|unless|until|example|faq|previous|earlier)\b/u.test(
        sentence,
      )
    )
      return false;
    return (
      (/\bapplication\b/u.test(sentence) &&
        /\b(?:could\s+not|couldn't|cannot|can't|unable\s+to|failed\s+to|did\s+not|didn't)\s+(?:be\s+)?(?:successfully\s+)?(?:send|submit|receive|process|sent|submitted|received|processed)\b/u.test(
          sentence,
        )) ||
      /\b(?:application\b[^.!?\n]{0,60}\b(?:not|never)\s+(?:(?:yet|be|been|successfully)\s+)*(?:sent|submitted|received|accepted)|no\s+application\s+(?:(?:was|has\s+been)\s+)?(?:sent|submitted|received))\b/u.test(
        sentence,
      ) ||
      /\b(?:submission|application)\s+(?:(?:has|was|is)\s+)?(?:failed|unsuccessful|rejected)|\b(?:error|problem)\s+(?:while\s+)?(?:sending|submitting|receiving|processing)\s+(?:your\s+)?application\b/u.test(
        sentence,
      ) ||
      /^(?:not|never)\s+(?:yet\s+)?(?:sent|submitted|received)\b/u.test(
        sentence,
      ) ||
      /^(?:sorry[, :]*)?(?:we\s+)?(?:unable\s+to|could\s+not|couldn't|cannot|can't|failed\s+to)\s+(?:send|submit)\s*(?::|[.!]?$)/u.test(
        sentence,
      )
    );
  });
  if (refused) return { messages: [], refused: true };
  if (
    parts.some((sentence) =>
      /^(?:(?:your\s+)?application|submission)\s+(?:(?:is|still)\s+)?(?:pending|processing|in\s+progress|awaiting\s+(?:validation|approval))\b/u.test(
        sentence,
      ),
    )
  )
    return { messages: [], refused: false };
  const acknowledgement =
    /\b(?:(?:your )?application\s+(?:(?:has been|was|is)\s+)?(?:successfully\s+)?(?:submitted|received|sent|accepted)\b|we(?:\s+have|'ve)?\s+(?:successfully\s+)?received\s+your\s+application\b|(?:you(?:\s+have|'ve)?|we(?:\s+have|'ve)?)\s+(?:successfully\s+)?submitted\s+your\s+application\b|thank\s+you\s+for\s+(?:applying|(?:submitting\s+)?your\s+application)\b|thanks\s+for\s+(?:applying|your\s+application)\b|(?:you\s+(?:have\s+)?)?successfully\s+applied\s+(?:for|to)\b)/u;
  const messages = new Set<string>();
  let preceding = "";
  for (const sentence of parts) {
    const detailed =
      /\byour\s+application\s+for\s+[^.!?\n]{1,200}\s+(?:has\s+been|was|is)\s+(?:successfully\s+)?(submitted|received|sent|accepted)\b/u.exec(
        sentence,
      );
    const match = acknowledgement.exec(sentence) ?? detailed;
    const prior = preceding;
    preceding = sentence;
    if (!match || sentence.endsWith("?")) continue;
    const prefix = sentence.slice(0, match.index);
    if (
      /\b(?:if|when|once|unless|until|before|click|press|select|example|faq|previous|earlier|no|not)\b/u.test(
        prefix,
      ) ||
      /\b(?:message|wording|text)\s+(?:has|will|should|would)|\bis\s+(?:the|a)\s+(?:receipt|confirmation|success)\s+message\b/u.test(
        sentence,
      ) ||
      /\b(?:only\s+(?:after|if|when)|by\s+clicking|applying\s+changes|yesterday|last\s+(?:year|month|week)|previously)\b/u.test(
        sentence,
      ) ||
      /\b(?:example|following\s+message|you\s+(?:will|should)\s+see)\b[^.!?]*:$/u.test(
        prior,
      )
    )
      continue;
    // Only the bounded acknowledgement phrase crosses the browser boundary.
    // Surrounding sentences can contain answers or contact details.
    messages.add(
      detailed && match === detailed
        ? `your application ${detailed[1]}`
        : match[0].trim().slice(0, 160),
    );
  }
  return { messages: [...messages].slice(0, 20), refused: false };
}

/** A refusal to send/receive an application overrides optimistic thank-you copy. */
export function hasApplicationSubmissionRefusal(pageText: string): boolean {
  return readApplicationSubmissionConfirmationEvidence(pageText).refused;
}

export function applicationSubmissionConfirmationMessages(
  pageText: string,
): string[] {
  return readApplicationSubmissionConfirmationEvidence(pageText).messages;
}

export function hasApplicationSubmissionConfirmation(
  pageText: string,
): boolean {
  return applicationSubmissionConfirmationMessages(pageText).length > 0;
}

/** Preserve the site's own labelled reference; never invent one from a URL or job id. */
export function submissionConfirmationSummary(pageText: string): string {
  const normalized = pageText.normalize("NFKC").replace(/\s+/gu, " ");
  const lower = normalized.toLowerCase();
  const acknowledgement = Math.max(
    -1,
    ...applicationSubmissionConfirmationMessages(normalized).map((message) =>
      lower.lastIndexOf(message),
    ),
  );
  const receipt =
    acknowledgement < 0
      ? ""
      : normalized.slice(acknowledgement, acknowledgement + 500);
  const reference = (
    receipt.match(
      /\bconfirmation(?:\s+(?:number|reference|id))?\s*[:#]\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{1,100})/iu,
    )?.[1] ??
    receipt.match(
      /(?<!job\s)\b(?:application\s+)?reference(?:\s+(?:number|id))?\s*[:#]\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{1,100})/iu,
    )?.[1]
  )?.replace(/[.]+$/u, "");
  return reference
    ? `The site confirmed receipt. Reference: ${reference}.`
    : "The site confirmed receipt of the application.";
}
