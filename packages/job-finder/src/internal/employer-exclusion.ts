import {
  isGenericCompanyName,
  normalizeCompanyName,
  type CompanyEntity,
  type EmployerExclusionPreview,
  type JobSearchPreferences,
  type SavedJob,
} from "@nestor/contracts";

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./u, "")
    .replace(/\.$/u, "");
}

function exactNameKeys(company: CompanyEntity): string[] {
  return [
    normalizeCompanyName(company.canonicalName),
    ...company.aliases
      .filter((alias) => alias.identityAuthority === "user_approved_merge")
      .map((alias) => alias.normalized),
  ].filter(Boolean);
}

function hasPendingMerge(
  companyIds: ReadonlySet<string>,
  companies: readonly CompanyEntity[],
): boolean {
  return companies.some((company) =>
    company.mergeReviewCandidates.some(
      (candidate) =>
        candidate.decision === "pending" &&
        (companyIds.has(company.id) ||
          companyIds.has(candidate.candidateCompanyId)),
    ),
  );
}

export function resolveEmployerExclusionPreview(input: {
  job: Pick<SavedJob, "id" | "company" | "employerDomain">;
  searchPreferences: JobSearchPreferences;
  companies: readonly CompanyEntity[];
}): EmployerExclusionPreview {
  const displayCompanyName = input.job.company.trim();
  const normalizedCompanyName = normalizeCompanyName(displayCompanyName);
  const employerDomain = input.job.employerDomain?.trim() || null;
  const unavailable = (
    reason: Extract<
      EmployerExclusionPreview,
      { status: "unavailable" }
    >["reason"],
  ): EmployerExclusionPreview => ({
    status: "unavailable",
    jobId: input.job.id,
    reason,
    employerDomain,
  });

  if (!normalizedCompanyName || isGenericCompanyName(normalizedCompanyName)) {
    return unavailable("missing_or_generic_company");
  }
  if (
    input.searchPreferences.companyWhitelist.some(
      (value) => normalizeCompanyName(value) === normalizedCompanyName,
    )
  ) {
    return unavailable("company_whitelisted");
  }

  const nameMatches = input.companies.filter((company) =>
    exactNameKeys(company).includes(normalizedCompanyName),
  );
  if (nameMatches.length > 1) {
    return unavailable("ambiguous_company_name");
  }

  const normalizedDomain = employerDomain
    ? normalizeDomain(employerDomain)
    : null;
  const domainMatches = normalizedDomain
    ? input.companies.filter((company) =>
        company.domains.some(
          (domain) => normalizeDomain(domain.domain) === normalizedDomain,
        ),
      )
    : [];
  if (domainMatches.length > 1) {
    return unavailable("ambiguous_employer_domain");
  }
  if (nameMatches.length === 0 && domainMatches.length > 0) {
    return unavailable("provider_domain_only");
  }
  if (
    nameMatches.length === 1 &&
    domainMatches.length === 1 &&
    nameMatches[0]!.id !== domainMatches[0]!.id
  ) {
    return unavailable("company_name_domain_conflict");
  }

  const matchedIds = new Set([
    ...nameMatches.map((company) => company.id),
    ...domainMatches.map((company) => company.id),
  ]);
  if (matchedIds.size > 0 && hasPendingMerge(matchedIds, input.companies)) {
    return unavailable("pending_company_merge");
  }

  return {
    status: "available",
    jobId: input.job.id,
    displayCompanyName,
    normalizedCompanyName,
    employerDomain,
  };
}

export function appendExactEmployerExclusion(
  blacklist: readonly string[],
  displayCompanyName: string,
  normalizedCompanyName: string,
): { values: string[]; added: boolean } {
  if (
    blacklist.some(
      (value) => normalizeCompanyName(value) === normalizedCompanyName,
    )
  ) {
    return { values: [...blacklist], added: false };
  }
  return { values: [...blacklist, displayCompanyName], added: true };
}

export function removeExactEmployerExclusion(
  blacklist: readonly string[],
  normalizedCompanyName: string,
): string[] {
  return blacklist.filter(
    (value) => normalizeCompanyName(value) !== normalizedCompanyName,
  );
}
