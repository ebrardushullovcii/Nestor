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
import { fitRegionContains } from "./fit-regions";

export const fitLocationKinds = [
  "onsite",
  "hybrid",
  "country_remote",
  "broader_remote",
  "offered_list",
  "unknown",
] as const;
type Eligibility = "compatible" | "review" | "blocked";
export interface FitWorkPermissionEvidence {
  publishedLocation: string;
  workCountry: string;
  residence: ["met" | "conflict" | "unknown", string];
  authorization: ["met" | "conflict" | "unknown" | "not_required", string];
}
export type FitLocationEvidence = [
  Eligibility,
  string,
  (typeof fitLocationKinds)[number],
  string,
  FitWorkPermissionEvidence?,
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
  const [status, passage, kind, inferredCountries, proof] = evidence;
  const reason =
    passage.trim() || "Your work location or permission needs checking.";
  for (const check of [proof?.residence, proof?.authorization])
    if (check?.[0] === "conflict")
      return { status: "blocked", reason: check[1] || reason };
  if (status === "blocked") return { status, reason };
  const currentCode = fitCountryCode(profile.currentCountry || "", true);
  const current = new Set(currentCode ? [currentCode] : []);
  // This is a known exclusion, not missing permission: the complete published
  // region excludes the saved work country and the person will not relocate.
  if (
    currentCode &&
    profile.workEligibility.willingToRelocate === false &&
    fitRegionContains(job.location ?? "", currentCode) === false
  )
    return {
      status: "blocked",
      reason: `The published hiring region (${job.location}) excludes your ${profile.currentCountry} work location, and you are not willing to relocate.`,
    };
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
    (quote.length >= 6 ||
      fitRegionContains(passage, currentCode ?? "") !== null) &&
    (body.includes(quote) || location.includes(quote));
  // A verbatim "fully remote" quote proves a work mode, not a hiring region.
  const geographic =
    [...fitCountryNames(current), profile.currentCountry ?? ""].some(
      (name) =>
        name &&
        ` ${quote.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(
          ` ${normalized(name)} `,
        ),
    ) ||
    fitRegionContains(passage, currentCode ?? "") !== null ||
    /\b(worldwide|globally|global|anywhere in (?:the )?world|any country|all countries|europe(?:an(?!\s+(?:union|economic\s+area)\b))?|emea|apac|americas|asia|africa|oceania)\b/u.test(
      quote,
    ) ||
    (!foreign && /\b(?:anywhere|wherever)\b/u.test(quote)) ||
    // A published global-remote location corroborates a work-from-anywhere
    // passage even when the model inferred a country from unrelated text.
    (!published &&
      /\b(?:global|worldwide)\s+remote\b/u.test(location) &&
      /\bwork(?:ing)? from (?:anywhere|wherever)\b/u.test(quote));
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
    (proof?.authorization[0] === "met" &&
      permissionScopes.some((scope) => !fitCountryCode(scope, true)));
  if (
    (physical || kind === "country_remote") &&
    countries.size > 0 &&
    !permission
  )
    return {
      status: "review",
      reason: [
        proof?.authorization[0] === "unknown" && proof.authorization[1].trim()
          ? proof.authorization[1]
          : `Your profile does not confirm work authorization in ${fitCountryNames(
              countries,
            )
              .filter((_name, index) => index % 2 === 1)
              .join(" or ")}.`,
        physical
          ? "On-site or hybrid work requires permission in the work country; permission for this role still needs checking."
          : "This remote role is limited to its work country; permission for this role still needs checking.",
      ].join(" "),
    };
  if (foreign && physical && profile.workEligibility.willingToRelocate !== true)
    return {
      status: "review",
      reason:
        "This role requires moving to its work country; relocation willingness is not confirmed.",
    };
  if (status === "review")
    return {
      status,
      reason:
        [proof?.residence, proof?.authorization].find(
          (check) => check?.[0] === "unknown",
        )?.[1] || reason,
    };
  // A geographic quote establishes the listing's scope, not this person's
  // inclusion or work permission. The model must judge both against saved facts.
  // Older replies without these checks remain readable, but cannot be strong.
  if (proof && normalized(proof.publishedLocation) !== location)
    return {
      status: "review",
      reason: `Your eligibility for the published work location (${job.location || "unspecified"}) has not been established.`,
    };
  if (
    !proof ||
    proof.residence[0] === "unknown" ||
    proof.authorization[0] === "unknown"
  )
    return {
      status: "review",
      reason: !proof
        ? "Your inclusion in the hiring region and required work permission are unconfirmed."
        : proof.residence[0] === "unknown"
          ? proof.residence[1] ||
            "Your inclusion in the hiring region is unconfirmed."
          : proof.authorization[1] ||
            "Required work permission is unconfirmed.",
    };
  if (
    !proof.residence[1].trim() ||
    !proof.authorization[1].trim() ||
    (physical && proof.authorization[0] === "not_required") ||
    (proof.authorization[0] === "met" && !permissionScopes.length)
  )
    return {
      status: "review",
      reason:
        "The listing's work permission requirements have not been checked against your saved facts.",
    };
  const workCountry = fitCountryCode(proof.workCountry, true);
  if (
    !workCountry ||
    ((physical || kind === "country_remote") &&
      countries.size > 0 &&
      !countries.has(workCountry)) ||
    (!current.has(workCountry) &&
      !(
        (physical || kind === "country_remote") &&
        countries.has(workCountry) &&
        permission &&
        profile.workEligibility.willingToRelocate === true
      ))
  )
    return {
      status: "review",
      reason: !current.size
        ? "Your profile does not state your current work country."
        : "The eligibility judgment does not establish an allowed work country for you.",
    };
  if (kind === "broader_remote" && broader) {
    const outsideScope = [job.location ?? "", passage].find(
      (scope) => fitRegionContains(scope, workCountry) === false,
    );
    if (outsideScope)
      return {
        status: "review",
        reason: `The published hiring region (${outsideScope}) does not establish eligibility for your ${profile.currentCountry || workCountry} work location.`,
      };
    return { status, reason };
  }
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
      reason: !current.size
        ? "Your profile does not state your current work country."
        : "The listing does not establish where you may work.",
    };
  return { status, reason };
}
