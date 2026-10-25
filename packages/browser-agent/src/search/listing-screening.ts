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

/** Give a small classifier only examples for the person's requested professions. */
export function professionInstructions(goals: RoleScreenGoals): string {
  const roles = [
    ...goals.targetRoles,
    ...(goals.strategy === "target_roles" ? [] : goals.relatedRoles),
  ]
    .map(words)
    .join("; ");
  const guides: string[] = [];
  if (/\b(?:backend|back end|platform)\b/u.test(roles))
    guides.push(
      "Requested backend/platform work includes backend software, fullstack, APIs, distributed systems/storage, cloud infrastructure (including containers and virtualisation/virtualization), SRE/DevOps and ambiguous software engineer titles. A product/domain/team name does not establish a different engineering function; do not infer frontend from an app/product name. Explicit graphics/frontend/mobile/embedded/kernel/hardware/QA, helpdesk, presales, evangelism and people-management functions differ unless duties overlap the requested work. Software maintenance/sustaining and distributed-systems software testing can contain backend duties. Engineering Lead is ambiguous; Engineering Manager normally manages people rather than doing IC work.",
    );
  if (
    /\b(?:(?:data|business intelligence|bi) analyst|analytics engineer)\b/u.test(
      roles,
    )
  )
    guides.push(
      "Requested analysis/BI work includes hands-on reporting/analytics in operations, sales/revenue, finance or people analytics, and analytics engineering/data science where duties overlap. Analytics engineering means data models, pipelines and analytics, not generic software or systems hosting. Infrastructure, SRE/DevOps, generic Software Engineer/Systems Engineer, ML research scientists, and executive/department leadership are different functions unless explicitly requested or actual card duties show analysis work. An analytics manager can still analyze; data/analytics/research in a team or product name alone does not establish overlap. Senior Data Analyst is the same profession as Data Analyst.",
    );
  return (
    'Classify each title by actual day-to-day profession against the requested work. Return {"keep":{"0":1,"1":0,...}}, every title index once: 1 for requested work, substantially overlapping duties or genuinely ambiguous professions; 0 for clearly different functions. target_roles includes synonyms; related_roles also includes the requested related professions; wide_net adds transferable neighboring duties. Read the request as additional goals and constraints. Shared industry, technology or a broad word is not shared professional duties. Never discard for location, work mode, pay, hours, contract, seniority or low expected fit. Judge languages naturally. No explanations. ' +
    guides.join(" ")
  );
}
