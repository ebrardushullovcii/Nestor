import type { ListingCard, RoleScreenGoals } from "@nestor/contracts";

const words = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const rank =
  /^(?:(?:senior|sr|junior|jr|staff|principal|lead|graduate|entry level) )+/u;

/** Positive shortcut only. Anything ambiguous still goes to profession judgment. */
export function clearRoleMatch(title: string, goals: RoleScreenGoals): boolean {
  const candidate = words(title).replace(rank, "");
  const roles =
    goals.strategy === "target_roles"
      ? goals.targetRoles
      : [...goals.targetRoles, ...goals.relatedRoles];
  return roles.some((role) => {
    const profession = words(role).replace(rank, "");
    return (
      profession.split(" ").length >= 2 &&
      (candidate === profession || candidate.startsWith(`${profession} `))
    );
  });
}

/** Profession screening needs duties/team evidence, not pay, place or provider metadata. */
export function professionEvidence(card: ListingCard): string {
  try {
    const value: unknown = JSON.parse(card.text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      const categories =
        row.categories && typeof row.categories === "object"
          ? (row.categories as Record<string, unknown>)
          : {};
      return [
        row.department,
        row.team,
        categories.department,
        categories.team,
        row.summary,
        row.description,
      ]
        .filter((part): part is string => typeof part === "string")
        .join("; ")
        .slice(0, 300);
    }
  } catch {
    /* Plain visible cards are also useful evidence. */
  }
  return card.text.replaceAll(card.title, "").trim().slice(0, 300);
}

/** A provider already supplied the body: challenge a negative title verdict with
 * explicit duties in the requested profession, without another network read. */
export function roleDutyEvidence(
  card: ListingCard,
  goals: RoleScreenGoals,
): string | null {
  if (!card.listingText) return null;
  const titleWords = new Set(words(card.title).split(" "));
  const roles =
    goals.strategy === "target_roles"
      ? goals.targetRoles
      : [...goals.targetRoles, ...goals.relatedRoles];
  for (const role of roles) {
    const tokens = words(role).replace(rank, "").split(" ");
    const profession = tokens.pop();
    if (!profession || !titleWords.has(profession) || !tokens.length) continue;
    const paragraph = card.listingText.split(/\n\s*\n/u).find((paragraph) => {
      const facts = words(paragraph).split(" ");
      return (
        tokens.every((token) => facts.includes(token)) &&
        /\b(?:build|design|develop|operat|writ|maintain|implement)\w*/iu.test(
          paragraph,
        )
      );
    });
    if (paragraph) return paragraph.slice(0, 600);
  }
  return null;
}
