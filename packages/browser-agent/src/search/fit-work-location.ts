import {
  sameSavedChoice,
  type CandidateProfile,
  type JobDetail,
  type SavedOptionFallback,
} from "@nestor/contracts";
import {
  fitCountryCode,
  fitCountryCodes,
  fitCountryNames,
} from "./fit-country-codes";

export const fitLocationKinds = [
  "onsite",
  "hybrid",
  "country_remote",
  "broader_remote",
  "offered_list",
  "unknown",
] as const;
type Eligibility = "compatible" | "review" | "blocked";
export type FitLocationEvidence = [
  Eligibility,
  string,
  (typeof fitLocationKinds)[number],
  string,
];
const normalized = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const intersects = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  [...left].some((country) => right.has(country));

/** Only demote. A location label or relocation assistance cannot grant work permission. */
export function assessFitWorkLocation(
  profile: CandidateProfile,
  job: Pick<JobDetail, "location" | "description" | "workModes">,
  evidence: FitLocationEvidence,
  fallbacks: readonly SavedOptionFallback[] = [],
): { status: Eligibility; reason: string } {
  const [status, passage, kind, inferredCountries] = evidence;
  const reason =
    passage.trim() || "Your work location or permission needs checking.";
  if (status === "blocked") return { status, reason };
  const currentCode = fitCountryCode(profile.currentCountry || "", true);
  const current = new Set(currentCode ? [currentCode] : []);
  const published = fitCountryCode(job.location ?? "");
  const countries = published
    ? new Set([published])
    : fitCountryCodes(inferredCountries);
  const foreign =
    current.size > 0 && countries.size > 0 && !intersects(current, countries);
  const quote = normalized(passage);
  const body = normalized(job.description);
  const location = normalized(job.location ?? "");
  const quoted =
    quote.length >= 6 && (body.includes(quote) || location.includes(quote));
  // A verbatim "fully remote" quote proves a work mode, not a hiring region.
  const geographic =
    [...fitCountryNames(current), profile.currentCountry ?? ""].some(
      (name) =>
        name &&
        ` ${quote.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(
          ` ${normalized(name)} `,
        ),
    ) ||
    /\b(worldwide|globally|global|anywhere in (?:the )?world|any country|all countries|europe(?:an(?!\s+(?:union|economic\s+area)\b))?|emea|apac|americas|asia|africa|oceania)\b/u.test(
      quote,
    ) ||
    (!foreign && /\banywhere\b/u.test(quote));
  const workScope =
    /\b(hire|hiring|remote|remotely|based|reside|residents|candidates|applicants|eligible)\b|\bwork(?:ing)? (?:from|anywhere|throughout)\b/u.test(
      quote,
    );
  const broader =
    quoted &&
    geographic &&
    ((body.includes(quote) && workScope) || location.includes(quote));
  const physical =
    !(
      kind === "broader_remote" &&
      broader &&
      /\b(remote|remotely|work from|work anywhere)\b/u.test(quote)
    ) &&
    (job.workModes.some((mode) => mode === "onsite" || mode === "hybrid") ||
      ((kind === "onsite" || kind === "hybrid") && quoted));
  const permissionScopes = [
    ...profile.workEligibility.authorizedWorkCountries,
    ...(profile.workEligibility.limitedWorkPermissions ?? []).map(
      (permission) => permission.country,
    ),
  ];
  const authorized = new Set(
    permissionScopes.flatMap((country) => {
      const code = fitCountryCode(country, true);
      return code ? [code] : [];
    }),
  );
  // Regions and other textual permission scopes need the model's interpretation.
  // An ISO lookup cannot turn their compatible verdict into missing permission.
  const permission =
    intersects(authorized, countries) ||
    permissionScopes.some((scope) => !fitCountryCode(scope, true));
  if (
    (physical || kind === "country_remote") &&
    countries.size > 0 &&
    !permission
  )
    return {
      status: "review",
      reason:
        "This role requires on-site or hybrid work without recorded permission there.",
    };
  if (foreign && physical && profile.workEligibility.willingToRelocate !== true)
    return {
      status: "review",
      reason:
        "This role requires moving to its work country; relocation willingness is not confirmed.",
    };
  if (status === "review") return { status, reason };
  if (kind === "broader_remote" && broader) return { status, reason };
  if (kind === "offered_list" && quoted) {
    const offered = fitCountryCodes(inferredCountries);
    const accepted =
      intersects(current, offered) ||
      fallbacks.some(
        (rule) =>
          (sameSavedChoice(rule.primary, profile.currentCountry ?? "") ||
            intersects(current, fitCountryCodes(rule.primary))) &&
          intersects(offered, fitCountryCodes(rule.fallback)),
      );
    if (accepted) return { status, reason };
    return {
      status: "blocked",
      reason:
        "The offered work-country list contains neither your country nor its saved fallback.",
    };
  }
  if (
    foreign &&
    !(permission && profile.workEligibility.willingToRelocate === true)
  )
    return {
      status: "review",
      reason:
        "The published work location is abroad; broader hiring eligibility is not evidenced.",
    };
  if (
    !current.size ||
    (!countries.size && !(kind === "broader_remote" && broader))
  )
    return {
      status: "review",
      reason: "The listing does not establish where you may work.",
    };
  return { status, reason };
}
