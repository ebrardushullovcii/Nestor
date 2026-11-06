import type { ListingCard } from "@nestor/contracts";

/** Keep all published card evidence available for the model's profession decision. */
export function professionEvidence(card: ListingCard): string {
  return card.text
    .replace(
      /^(?:Posted\s+)?\d+\s+(?:minutes?|hours?|days?|weeks?)\s+ago\s*$/gimu,
      "",
    )
    .trim();
}

export function professionInstructions(): string {
  return 'Classify each title by actual day-to-day profession against the requested work. Return {"keep":{"0":1,"1":0,...}}, every title index once: 1 for requested work, substantially overlapping duties or genuinely ambiguous professions; 0 for clearly different functions. Read the request as additional goals and constraints. Shared industry, technology or a broad word is not shared professional duties. Never discard for location, work mode, pay, hours, contract, seniority or low expected fit. Judge languages naturally. No explanations.';
}
