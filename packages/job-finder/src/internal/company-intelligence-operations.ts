/**
 * Pure, immutable company intelligence operations.
 *
 * Reconciliation is deliberately conservative: job ownership requires one
 * exact normalized canonical name or user-approved alias. Domains are research
 * evidence only. Ambiguous or near matches never merge silently; they surface
 * as explicit `pending` merge-review candidates that require a user decision.
 *
 * Mutating operations validate their inputs and return private values without
 * mutating the inputs. Reconciliation validates new fields as they are added
 * instead of reparsing the entire growing company graph. Ids and timestamps
 * are supplied by the caller; the operations never mint them themselves.
 */

import {
  ApplicationRecordSchema,
  type ApplicationRecord,
  ApplicationStatusSchema,
  type ApplicationStatus,
  CompanyDomainSchema,
  type CompanyDomain,
  CompanyEntitySchema,
  type CompanyEntity,
  CompanyIntelligenceMutationInputSchema,
  type CompanyIntelligenceMutationInput,
  CompanyMergeReviewCandidateSchema,
  type CompanyMergeReviewCandidate,
  CompanySourceHistoryRefSchema,
  type CompanySourceHistoryRef,
  IsoDateTimeSchema,
  isListableCompanyName,
  NonEmptyStringSchema,
  normalizeCompanyName,
  ReviewCompanyMergeInputSchema,
  type ReviewCompanyMergeInput,
  SavedJobSchema,
  type SavedJob,
  SetCompanyPreferenceInputSchema,
  type SetCompanyPreferenceInput,
} from "@nestor/contracts";

import { yieldToEventLoop } from "@nestor/core";
import { buildJobIdentityAliases, type JobIdentityInput } from "./job-identity";
// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export { normalizeCompanyName } from "@nestor/contracts";

/**
 * Normalizes an employer domain for exact comparison: lowercase, trimmed, a
 * single trailing dot removed, and a leading `www.` label stripped. The result
 * is still an exact comparison key; only cosmetic variants collapse.
 */
export function normalizeEmployerDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.+$/u, "")
    .replace(/^www\./u, "");
}

function tokenSet(value: string): string[] {
  return value.split(/\s+/u).filter(Boolean);
}

function isSpecificCompanyName(name: string): boolean {
  return isListableCompanyName(name);
}

function isListableCompanyEntity(company: { canonicalName: string }): boolean {
  return isListableCompanyName(company.canonicalName);
}

/**
 * Drops legacy placeholder/generic/utility-chrome company shells and any
 * merge-review edges that pointed at them. New evidence already refuses to
 * create these entities; this pass cleans rows that predate that guard.
 */
function purgeUnlistableCompanies(
  companies: readonly CompanyEntity[],
  now: string,
): CompanyEntity[] {
  const purgedIds = new Set<string>();
  const retained: CompanyEntity[] = [];
  for (const company of companies) {
    if (!isListableCompanyEntity(company)) {
      purgedIds.add(company.id);
      continue;
    }
    retained.push(company);
  }
  if (purgedIds.size === 0) {
    return [...companies];
  }
  return retained.map((company) => {
    const mergeReviewCandidates = company.mergeReviewCandidates.filter(
      (candidate) => !purgedIds.has(candidate.candidateCompanyId),
    );
    if (mergeReviewCandidates.length === company.mergeReviewCandidates.length) {
      return company;
    }
    return CompanyEntitySchema.parse({
      ...company,
      mergeReviewCandidates,
      updatedAt: nextCompanyIntelligenceUpdatedAt(now, company.updatedAt),
    });
  });
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface ZodIssueLike {
  message?: string;
}

interface ZodErrorLike {
  issues: readonly ZodIssueLike[];
}

function firstIssueMessage(error: ZodErrorLike): string {
  return error.issues[0]?.message ?? "Invalid value.";
}

export function nextCompanyIntelligenceUpdatedAt(
  now: string,
  ...currentUpdatedAts: readonly (string | null)[]
): string {
  return new Date(
    Math.max(
      Date.parse(now),
      ...currentUpdatedAts.map((updatedAt) =>
        updatedAt === null
          ? Number.NEGATIVE_INFINITY
          : Date.parse(updatedAt) + 1,
      ),
    ),
  ).toISOString();
}

function addToIndex(
  index: Map<string, string[]>,
  key: string,
  id: string,
): void {
  if (!key) return;
  const existing = index.get(key);
  if (existing) {
    // Each company is indexed in one pass. A duplicate key for that company
    // can only be adjacent; scanning a popular shared domain is quadratic.
    if (existing[existing.length - 1] !== id) existing.push(id);
  } else {
    index.set(key, [id]);
  }
}

function unionStrings(
  first: readonly string[],
  second: readonly string[],
): string[] {
  const seen = new Set(first);
  const result = [...first];
  for (const value of second) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function unionById<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
): T[] {
  const seen = new Set(first.map((item) => item.id));
  const result = first.map((item) => ({ ...item }));
  for (const item of second) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({ ...item });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type ReconcileCompaniesFailure = {
  code: "invalid_input";
  message: string;
};

export type CreatedMergeCandidateSummary = {
  companyId: string;
  candidateCompanyId: string;
  reason: string;
};

export type ReconcileCompaniesSummary = {
  createdCompanyIds: string[];
  matchedCompanyIds: string[];
  ambiguousEvidenceCount: number;
  unresolvableEvidenceCount: number;
  createdMergeCandidates: CreatedMergeCandidateSummary[];
};

export type ReconcileCompaniesResult =
  | {
      ok: true;
      companies: CompanyEntity[];
      summary: ReconcileCompaniesSummary;
    }
  | { ok: false; failure: ReconcileCompaniesFailure };

type CompanyJobEvidence = Pick<
  SavedJob,
  | "id"
  | "company"
  | "employerDomain"
  | "source"
  | "firstSeenAt"
  | "lastSeenAt"
  | "lastVerifiedActiveAt"
  | "discoveredAt"
> & { listingHosts?: readonly string[] };
type CompanyApplicationEvidence = Pick<
  ApplicationRecord,
  "id" | "jobId" | "company" | "lastUpdatedAt"
>;
type Evidence =
  | { kind: "job"; job: CompanyJobEvidence }
  | { kind: "application"; record: CompanyApplicationEvidence };

// Cache only immutable inputs, and only the facts reconciliation uses. Keeping
// parsed SavedJobs here would retain every listing and provenance collection.
const immutableJobEvidence = new WeakMap<SavedJob, CompanyJobEvidence>();
const immutableApplicationEvidence = new WeakMap<
  ApplicationRecord,
  CompanyApplicationEvidence
>();

function listingHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return normalizeEmployerDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

function readCompanyJobEvidence(
  job: SavedJob,
):
  | { ok: true; evidence: CompanyJobEvidence }
  | { ok: false; error: ZodErrorLike } {
  const cached = immutableJobEvidence.get(job);
  if (cached) return { ok: true, evidence: cached };
  // Repository rows are typed internal input. Company ownership uses scalar
  // facts and sighting links; inspecting/freezing the whole row opens lazy
  // listing bodies and provenance facts that this decision never reads.
  const frozenRow =
    Object.isFrozen(job) &&
    Object.isFrozen(job.provenance) &&
    job.provenance.every(Object.isFrozen);
  const value = job;
  const hosts = new Set<string>();
  const addHost = (url: string | null | undefined): void => {
    const host = listingHost(url);
    if (host) hosts.add(host);
  };
  addHost(value.canonicalUrl);
  addHost(value.applicationUrl);
  for (const sighting of value.provenance) {
    addHost(sighting.startingUrl);
    addHost(sighting.listingUrl);
    addHost(sighting.applicationUrl);
    addHost(sighting.pageApplyUrl);
  }
  const evidence: CompanyJobEvidence = {
    id: value.id,
    company: value.company,
    employerDomain: value.employerDomain,
    source: value.source,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    lastVerifiedActiveAt: value.lastVerifiedActiveAt,
    discoveredAt: value.discoveredAt,
    listingHosts: [...hosts],
  };
  if (frozenRow) immutableJobEvidence.set(job, evidence);
  return { ok: true, evidence };
}

function readCompanyApplicationEvidence(
  record: ApplicationRecord,
):
  | { ok: true; evidence: CompanyApplicationEvidence }
  | { ok: false; error: ZodErrorLike } {
  const cached = immutableApplicationEvidence.get(record);
  if (cached) return { ok: true, evidence: cached };
  const parsed = ApplicationRecordSchema.safeParse(record);
  if (!parsed.success) return { ok: false, error: parsed.error };
  const value = parsed.data;
  const evidence: CompanyApplicationEvidence = {
    id: value.id,
    jobId: value.jobId,
    company: value.company,
    lastUpdatedAt: value.lastUpdatedAt,
  };
  if (deeplyFrozen(record)) immutableApplicationEvidence.set(record, evidence);
  return { ok: true, evidence };
}

type CompanyMembership = {
  jobIds: Set<string>;
  applicationRecordIds: Set<string>;
  domains: Set<string>;
  aliases: Set<string>;
  sourceHistory: Map<string, CompanySourceHistoryRef>;
  sourceApplications: Map<string, Set<string>>;
};

function companyMembership(company: CompanyEntity): CompanyMembership {
  const sourceHistory = new Map<string, CompanySourceHistoryRef>();
  const sourceApplications = new Map<string, Set<string>>();
  for (const ref of company.sourceHistory) {
    if (sourceHistory.has(ref.sourceId)) continue;
    sourceHistory.set(ref.sourceId, ref);
    sourceApplications.set(ref.sourceId, new Set(ref.applicationRecordIds));
  }
  return {
    jobIds: new Set(company.jobIds),
    applicationRecordIds: new Set(company.applicationRecordIds),
    domains: new Set(
      company.domains.map((domain) => normalizeEmployerDomain(domain.domain)),
    ),
    aliases: new Set([
      normalizeCompanyName(company.canonicalName),
      ...company.aliases.map((alias) => alias.normalized),
    ]),
    sourceHistory,
    sourceApplications,
  };
}

type CompanyIndexes = {
  byId: Map<string, number>;
  domainIndex: Map<string, string[]>;
  nameIndex: Map<string, string[]>;
  /** Company pairs with a merge-review candidate either way round. */
  recordedPairs: Map<string, Set<string>>;
  /** Ambiguous groups already flagged in this pass. */
  flaggedGroups: WeakMap<readonly string[], number>;
  memberships: Map<string, CompanyMembership>;
  sharedListingHosts: Set<string>;
};

function hasCompanyPair(
  indexes: CompanyIndexes,
  firstId: string,
  secondId: string,
): boolean {
  const [primary, secondary] =
    firstId < secondId ? [firstId, secondId] : [secondId, firstId];
  return indexes.recordedPairs.get(primary)?.has(secondary) ?? false;
}

function recordCompanyPair(
  indexes: CompanyIndexes,
  firstId: string,
  secondId: string,
): void {
  const [primary, secondary] =
    firstId < secondId ? [firstId, secondId] : [secondId, firstId];
  const pairs = indexes.recordedPairs.get(primary);
  if (pairs) pairs.add(secondary);
  else indexes.recordedPairs.set(primary, new Set([secondary]));
}

type Resolution =
  | { status: "matched"; companyId: string }
  | { status: "ambiguous"; companyIds: string[]; reason: string }
  | { status: "none" };

function buildIndexes(companies: readonly CompanyEntity[]): CompanyIndexes {
  const byId = new Map<string, number>();
  const domainIndex = new Map<string, string[]>();
  const nameIndex = new Map<string, string[]>();
  const indexes: CompanyIndexes = {
    byId,
    domainIndex,
    nameIndex,
    recordedPairs: new Map(),
    flaggedGroups: new WeakMap(),
    memberships: new Map(),
    sharedListingHosts: new Set(),
  };

  for (let index = 0; index < companies.length; index += 1) {
    const company = companies[index]!;
    byId.set(company.id, index);
    indexes.memberships.set(company.id, companyMembership(company));
    for (const candidate of company.mergeReviewCandidates) {
      recordCompanyPair(indexes, company.id, candidate.candidateCompanyId);
    }
    for (const domain of company.domains) {
      addToIndex(
        domainIndex,
        normalizeEmployerDomain(domain.domain),
        company.id,
      );
    }
    addToIndex(
      nameIndex,
      normalizeCompanyName(company.canonicalName),
      company.id,
    );
    for (const alias of company.aliases) {
      if (alias.identityAuthority === "user_approved_merge") {
        addToIndex(nameIndex, alias.normalized, company.id);
      }
    }
  }

  return indexes;
}

function resolveEvidence(
  indexes: CompanyIndexes,
  evidence: Evidence,
): Resolution {
  const name =
    evidence.kind === "job" ? evidence.job.company : evidence.record.company;
  const domain = evidence.kind === "job" ? evidence.job.employerDomain : null;

  const normalizedName = normalizeCompanyName(name);
  const normalizedDomain =
    domain !== null && domain.trim() !== ""
      ? normalizeEmployerDomain(domain)
      : null;
  const nameMatches = normalizedName
    ? (indexes.nameIndex.get(normalizedName) ?? [])
    : [];
  const domainMatches = normalizedDomain
    ? (indexes.domainIndex.get(normalizedDomain) ?? [])
    : [];
  if (!isSpecificCompanyName(name)) return { status: "none" };

  if (nameMatches.length > 1) {
    return {
      status: "ambiguous",
      companyIds: nameMatches,
      reason: `Multiple companies claim the company name "${normalizedName}".`,
    };
  }

  if (
    nameMatches.length === 1 &&
    domainMatches.length === 1 &&
    nameMatches[0] !== domainMatches[0] &&
    (normalizedDomain === null ||
      !indexes.sharedListingHosts.has(normalizedDomain))
  ) {
    return {
      status: "ambiguous",
      companyIds: [nameMatches[0]!, domainMatches[0]!],
      reason: `Company name "${normalizedName}" and employer domain "${normalizedDomain}" resolve to different companies.`,
    };
  }

  if (nameMatches.length === 1) {
    return { status: "matched", companyId: nameMatches[0]! };
  }
  return { status: "none" };
}

function resolveCurrentJobOwner(
  companies: readonly CompanyEntity[],
  job: SavedJob,
): string | null {
  const resolution = resolveEvidence(buildIndexes(companies), {
    kind: "job",
    job,
  });
  return resolution.status === "matched" ? resolution.companyId : null;
}

function attachEvidence(input: {
  working: CompanyEntity[];
  indexes: CompanyIndexes;
  companyId: string;
  evidence: Evidence;
  now: string;
  jobSourceById: ReadonlyMap<string, string>;
  created: CreatedMergeCandidateSummary[];
}): void {
  const { working, indexes, companyId, evidence, now, jobSourceById, created } =
    input;
  const index = indexes.byId.get(companyId);
  if (index === undefined) return;
  // working is schema-parsed and privately owned by this reconciliation.
  // Append to its arrays once instead of cloning the growing company per job.
  const company = working[index]!;
  const membership = indexes.memberships.get(companyId)!;
  let changed = false;

  if (evidence.kind === "job") {
    if (!membership.jobIds.has(evidence.job.id)) {
      membership.jobIds.add(evidence.job.id);
      company.jobIds.push(evidence.job.id);
      changed = true;
    }
    const rawDomain = evidence.job.employerDomain;
    if (rawDomain !== null && rawDomain.trim() !== "") {
      const normalizedDomain = normalizeEmployerDomain(rawDomain);
      if (!membership.domains.has(normalizedDomain)) {
        const parsedDomain = CompanyDomainSchema.safeParse({
          domain: normalizedDomain,
          primary: company.domains.length === 0,
          verifiedAt: null,
        });
        if (parsedDomain.success) {
          company.domains.push(parsedDomain.data);
          membership.domains.add(normalizedDomain);
          addToIndex(indexes.domainIndex, normalizedDomain, companyId);
          changed = true;
          for (const otherId of indexes.sharedListingHosts.has(normalizedDomain)
            ? []
            : (indexes.domainIndex.get(normalizedDomain) ?? [])) {
            if (otherId === companyId) continue;
            const candidate = ensureMergeCandidates(
              working,
              indexes,
              companyId,
              otherId,
              `Multiple companies share the employer domain "${normalizedDomain}".`,
              now,
            );
            if (candidate) created.push(candidate);
          }
        }
      }
    }
  } else if (!membership.applicationRecordIds.has(evidence.record.id)) {
    membership.applicationRecordIds.add(evidence.record.id);
    company.applicationRecordIds.push(evidence.record.id);
    changed = true;
  }

  const rawName =
    evidence.kind === "job" ? evidence.job.company : evidence.record.company;
  const normalizedName = normalizeCompanyName(rawName);
  if (normalizedName !== "" && !membership.aliases.has(normalizedName)) {
    company.aliases.push({
      alias: rawName,
      normalized: normalizedName,
      confidence: 1,
      identityAuthority: "unknown",
    });
    membership.aliases.add(normalizedName);
    changed = true;
    const conflictingNameMatches = (
      indexes.nameIndex.get(normalizedName) ?? []
    ).filter((id) => id !== companyId);
    if (conflictingNameMatches.length > 0) {
      flagAmbiguousPair(
        working,
        indexes,
        [companyId, ...conflictingNameMatches],
        `Observed company name "${normalizedName}" conflicts with another company's authoritative name.`,
        now,
        created,
      );
    }
  }

  const sourceId =
    evidence.kind === "job"
      ? evidence.job.source
      : (jobSourceById.get(evidence.record.jobId) ?? "application_record");
  const firstSeenAt =
    evidence.kind === "job"
      ? (evidence.job.firstSeenAt ?? evidence.job.discoveredAt ?? now)
      : evidence.record.lastUpdatedAt;
  const lastSeenAt =
    evidence.kind === "job"
      ? (evidence.job.lastSeenAt ??
        evidence.job.lastVerifiedActiveAt ??
        evidence.job.discoveredAt ??
        now)
      : evidence.record.lastUpdatedAt;
  const applicationRecordId =
    evidence.kind === "job" ? null : evidence.record.id;
  const existing = membership.sourceHistory.get(sourceId);
  if (!existing) {
    const ref = CompanySourceHistoryRefSchema.parse({
      id: sourceId,
      sourceId,
      firstSeenAt,
      lastSeenAt,
      applicationRecordIds:
        applicationRecordId === null ? [] : [applicationRecordId],
    });
    company.sourceHistory.push(ref);
    membership.sourceHistory.set(sourceId, ref);
    membership.sourceApplications.set(
      sourceId,
      new Set(ref.applicationRecordIds),
    );
    changed = true;
  } else {
    if (Date.parse(firstSeenAt) < Date.parse(existing.firstSeenAt)) {
      existing.firstSeenAt = firstSeenAt;
      changed = true;
    }
    if (Date.parse(lastSeenAt) > Date.parse(existing.lastSeenAt)) {
      existing.lastSeenAt = lastSeenAt;
      changed = true;
    }
    const applicationIds = membership.sourceApplications.get(sourceId)!;
    if (
      applicationRecordId !== null &&
      !applicationIds.has(applicationRecordId)
    ) {
      applicationIds.add(applicationRecordId);
      existing.applicationRecordIds.push(applicationRecordId);
      changed = true;
    }
  }

  if (changed) {
    company.updatedAt = nextCompanyIntelligenceUpdatedAt(
      now,
      company.updatedAt,
    );
  }
}

function createCompanyEntity(input: {
  evidence: Evidence;
  id: string;
  now: string;
  jobSourceById: ReadonlyMap<string, string>;
}): CompanyEntity {
  const { evidence, id, now, jobSourceById } = input;
  const rawName =
    evidence.kind === "job" ? evidence.job.company : evidence.record.company;
  const rawDomain =
    evidence.kind === "job" ? evidence.job.employerDomain : null;
  const normalizedDomain =
    rawDomain !== null && rawDomain.trim() !== ""
      ? normalizeEmployerDomain(rawDomain)
      : null;

  let domains: CompanyDomain[] = [];
  if (normalizedDomain !== null) {
    const parsedDomain = CompanyDomainSchema.safeParse({
      domain: normalizedDomain,
      primary: true,
      verifiedAt: null,
    });
    if (parsedDomain.success) domains = [parsedDomain.data];
  }

  const sourceId =
    evidence.kind === "job"
      ? evidence.job.source
      : (jobSourceById.get(evidence.record.jobId) ?? "application_record");
  const firstSeenAt =
    evidence.kind === "job"
      ? (evidence.job.firstSeenAt ?? evidence.job.discoveredAt ?? now)
      : evidence.record.lastUpdatedAt;
  const lastSeenAt =
    evidence.kind === "job"
      ? (evidence.job.lastSeenAt ??
        evidence.job.lastVerifiedActiveAt ??
        evidence.job.discoveredAt ??
        now)
      : evidence.record.lastUpdatedAt;

  return CompanyEntitySchema.parse({
    id,
    canonicalName: rawName.trim(),
    aliases: [],
    domains,
    preference: "neutral",
    preferenceReason: null,
    mergeReviewCandidates: [],
    contacts: [],
    notes: [],
    sourceHistory: [
      CompanySourceHistoryRefSchema.parse({
        id: sourceId,
        sourceId,
        firstSeenAt,
        lastSeenAt,
        applicationRecordIds:
          evidence.kind === "application" ? [evidence.record.id] : [],
      }),
    ],
    jobIds: evidence.kind === "job" ? [evidence.job.id] : [],
    applicationRecordIds:
      evidence.kind === "application" ? [evidence.record.id] : [],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Creates a `pending` merge-review candidate between two companies when none
 * has been recorded in either direction. The primary side is deterministic:
 * the company with the earliest `createdAt`, then the lexicographically
 * smaller id. A previously decided pair is never re-flagged.
 */
function ensureMergeCandidates(
  working: CompanyEntity[],
  indexes: CompanyIndexes,
  firstId: string,
  secondId: string,
  reason: string,
  now: string,
): CreatedMergeCandidateSummary | null {
  if (firstId === secondId) return null;
  const firstIndex = indexes.byId.get(firstId);
  const secondIndex = indexes.byId.get(secondId);
  if (firstIndex === undefined || secondIndex === undefined) return null;

  const first = working[firstIndex]!;
  const second = working[secondIndex]!;

  const firstCreatedAt = Date.parse(first.createdAt);
  const secondCreatedAt = Date.parse(second.createdAt);
  const firstIsPrimary =
    firstCreatedAt < secondCreatedAt ||
    (firstCreatedAt === secondCreatedAt && first.id < second.id);
  const primary = firstIsPrimary ? first : second;
  const secondary = firstIsPrimary ? second : first;
  if (hasCompanyPair(indexes, primary.id, secondary.id)) return null;
  recordCompanyPair(indexes, primary.id, secondary.id);

  const updatedAt = nextCompanyIntelligenceUpdatedAt(now, primary.updatedAt);

  const candidate = CompanyMergeReviewCandidateSchema.parse({
    candidateCompanyId: secondary.id,
    reason,
    decision: "pending",
    decidedAt: null,
    requiresUserDecision: true,
  });

  // The company and the candidate are both parsed already; parsing the whole
  // company again for each new pair made a crowded domain cubic.
  primary.mergeReviewCandidates.push(candidate);
  primary.updatedAt = updatedAt;

  return { companyId: primary.id, candidateCompanyId: secondary.id, reason };
}

function flagAmbiguousPair(
  working: CompanyEntity[],
  indexes: CompanyIndexes,
  ids: readonly string[],
  reason: string,
  now: string,
  created: CreatedMergeCandidateSummary[],
): void {
  // Every job of a shared domain resolves to the same group; its pairs
  // need flagging once a pass, not once per job.
  if (indexes.flaggedGroups.get(ids) === ids.length) return;
  indexes.flaggedGroups.set(ids, ids.length);
  for (let firstIndex = 0; firstIndex < ids.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < ids.length;
      secondIndex += 1
    ) {
      const candidate = ensureMergeCandidates(
        working,
        indexes,
        ids[firstIndex]!,
        ids[secondIndex]!,
        reason,
        now,
      );
      if (candidate !== null) created.push(candidate);
    }
  }
}

// Business/legal suffixes describe a kind of company, not an employer identity.
// These affect advisory similarity only; exact ownership still uses all tokens.
const COMMON_COMPANY_TOKENS = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "companies",
  "ltd",
  "limited",
  "llc",
  "llp",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "bv",
  "nv",
  "group",
  "holding",
  "holdings",
  "international",
  "global",
  "solutions",
  "service",
  "services",
  "system",
  "systems",
  "technology",
  "technologies",
  "tech",
  "software",
  "lab",
  "labs",
  "laboratories",
  "consulting",
  "partners",
  "ventures",
  "enterprise",
  "enterprises",
  "business",
  "businesses",
]);
const COMMON_LISTING_LABELS = new Set([
  "jobs",
  "job",
  "careers",
  "career",
  "apply",
]);

type CompanySimilarity = {
  normalizedName: string;
  tokens: Set<string>;
  numericKey: string;
  exactNames: Set<string>;
  domains: string[];
};

function companySimilarity(
  company: CompanyEntity,
  indexes: CompanyIndexes,
): CompanySimilarity {
  const normalizedName = normalizeCompanyName(company.canonicalName);
  const tokens = tokenSet(normalizedName);
  return {
    normalizedName,
    tokens: new Set(
      tokens.filter(
        (token) => !COMMON_COMPANY_TOKENS.has(token) && !/^\d+$/u.test(token),
      ),
    ),
    numericKey: [...new Set(tokens.filter((token) => /^\d+$/u.test(token)))]
      .sort()
      .join(" "),
    exactNames: new Set([
      normalizedName,
      ...company.aliases.map((alias) => alias.normalized),
    ]),
    domains: company.domains
      .map((domain) => normalizeEmployerDomain(domain.domain))
      .filter((domain) => !indexes.sharedListingHosts.has(domain)),
  };
}

function namesAreNear(
  first: CompanySimilarity,
  second: CompanySimilarity,
): boolean {
  if (first.normalizedName === second.normalizedName) return false;
  if (
    first.numericKey &&
    second.numericKey &&
    first.numericKey !== second.numericKey
  )
    return false;
  if (first.tokens.size === 0 || second.tokens.size === 0) return false;
  let shared = 0;
  for (const token of first.tokens) if (second.tokens.has(token)) shared += 1;
  if (shared === 0) return false;
  const shorterLength = Math.min(first.tokens.size, second.tokens.size);
  if (shared === shorterLength) return true;
  return shared / (first.tokens.size + second.tokens.size - shared) >= 0.5;
}

function domainLabel(domain: string): string | null {
  const label = domain.split(".")[0];
  return label &&
    !COMMON_LISTING_LABELS.has(label) &&
    !COMMON_COMPANY_TOKENS.has(label)
    ? label
    : null;
}

function companiesShareExactName(
  first: CompanySimilarity,
  second: CompanySimilarity,
): boolean {
  for (const name of first.exactNames) {
    if (name && second.exactNames.has(name)) return true;
  }
  return false;
}

function domainsAreNear(
  first: CompanySimilarity,
  second: CompanySimilarity,
): { near: boolean; firstDomain: string | null; secondDomain: string | null } {
  for (const firstDomain of first.domains) {
    for (const secondDomain of second.domains) {
      if (firstDomain === secondDomain) continue;
      const label = domainLabel(firstDomain);
      if (label !== null && label === domainLabel(secondDomain)) {
        return { near: true, firstDomain, secondDomain };
      }
    }
  }
  return { near: false, firstDomain: null, secondDomain: null };
}

function identifySharedListingHosts(
  indexes: CompanyIndexes,
  jobs: readonly CompanyJobEvidence[],
): void {
  const ownerByHost = new Map<string, string>();
  const employerDomains = new Set(indexes.domainIndex.keys());
  for (const job of jobs) {
    if (job.employerDomain)
      employerDomains.add(normalizeEmployerDomain(job.employerDomain));
  }
  const observe = (host: string, owner: string): void => {
    const previous = ownerByHost.get(host);
    if (previous !== undefined && previous !== owner)
      indexes.sharedListingHosts.add(host);
    else ownerByHost.set(host, owner);
  };
  for (const job of jobs) {
    if (!isSpecificCompanyName(job.company)) continue;
    const name = normalizeCompanyName(job.company);
    const owners = indexes.nameIndex.get(name);
    const owner =
      owners?.length === 1 ? `company:${owners[0]!}` : `name:${name}`;
    for (const host of job.listingHosts ?? []) {
      observe(host, owner);
      // A supplied employer domain may be the parent of the listing host.
      // Inspect DNS label boundaries, without guessing a provider or suffix.
      let suffix = host;
      while (suffix.includes(".")) {
        if (employerDomains.has(suffix)) observe(suffix, owner);
        suffix = suffix.slice(suffix.indexOf(".") + 1);
      }
    }
  }
}

function removeUnsupportedDerivedCandidates(
  working: CompanyEntity[],
  indexes: CompanyIndexes,
  now: string,
): void {
  const features = working.map((company) =>
    companySimilarity(company, indexes),
  );
  for (let index = 0; index < working.length; index += 1) {
    const company = working[index]!;
    const feature = features[index]!;
    const retained = company.mergeReviewCandidates.filter((candidate) => {
      // A person's decisions and other kinds of identity conflict stand.
      if (
        candidate.decision !== "pending" ||
        !/^(Similar company name|Similar employer domain|Multiple companies share the employer domain) /u.test(
          candidate.reason,
        )
      )
        return true;
      const otherIndex = indexes.byId.get(candidate.candidateCompanyId);
      if (otherIndex === undefined) return true;
      const other = features[otherIndex]!;
      return (
        namesAreNear(feature, other) ||
        feature.domains.some((domain) => other.domains.includes(domain)) ||
        domainsAreNear(feature, other).near
      );
    });
    if (retained.length === company.mergeReviewCandidates.length) continue;
    company.mergeReviewCandidates = retained;
    company.updatedAt = nextCompanyIntelligenceUpdatedAt(
      now,
      company.updatedAt,
    );
  }
  // A removed suggestion cannot keep its pair reserved: new evidence later in
  // this reconciliation may supply a valid reason to suggest that same pair.
  indexes.recordedPairs.clear();
  for (const company of working) {
    for (const candidate of company.mergeReviewCandidates) {
      recordCompanyPair(indexes, company.id, candidate.candidateCompanyId);
    }
  }
}

/** Only informative name tokens or employer domains produce new suggestions. */
function applyNearConflictCandidates(
  working: CompanyEntity[],
  indexes: CompanyIndexes,
  now: string,
  created: CreatedMergeCandidateSummary[],
): void {
  const features = working.map((company) =>
    companySimilarity(company, indexes),
  );
  // Numeric identities get separate buckets: "Employer 1" and "Employer 2"
  // must neither generate a suggestion nor require scanning every employer.
  const tokenIndex = new Map<string, Map<string, number[]>>();
  const domainIndex = new Map<string, number[]>();
  for (let index = 0; index < working.length; index += 1) {
    const feature = features[index]!;
    for (const token of feature.tokens) {
      let buckets = tokenIndex.get(token);
      if (!buckets) {
        buckets = new Map();
        tokenIndex.set(token, buckets);
      }
      const bucket = buckets.get(feature.numericKey);
      if (bucket) bucket.push(index);
      else buckets.set(feature.numericKey, [index]);
    }
    for (const label of new Set(feature.domains.map(domainLabel))) {
      if (!label) continue;
      const bucket = domainIndex.get(label);
      if (bucket) bucket.push(index);
      else domainIndex.set(label, [index]);
    }
  }

  for (let firstIndex = 0; firstIndex < working.length; firstIndex += 1) {
    const first = working[firstIndex]!;
    const firstFeature = features[firstIndex]!;
    const possible = new Set<number>();
    const add = (ids: readonly number[]): void => {
      for (const id of ids) if (id > firstIndex) possible.add(id);
    };
    for (const token of firstFeature.tokens) {
      const buckets = tokenIndex.get(token)!;
      if (firstFeature.numericKey) {
        add(buckets.get(firstFeature.numericKey) ?? []);
        add(buckets.get("") ?? []);
      } else {
        for (const bucket of buckets.values()) add(bucket);
      }
    }
    for (const label of new Set(firstFeature.domains.map(domainLabel))) {
      if (label) add(domainIndex.get(label) ?? []);
    }
    for (const secondIndex of possible) {
      const second = working[secondIndex]!;
      if (hasCompanyPair(indexes, first.id, second.id)) continue;
      const secondFeature = features[secondIndex]!;
      if (companiesShareExactName(firstFeature, secondFeature)) continue;
      // Exact employer-domain conflicts were already recorded on attachment.
      if (
        firstFeature.domains.some((domain) =>
          secondFeature.domains.includes(domain),
        )
      )
        continue;
      const reasons: string[] = [];
      if (namesAreNear(firstFeature, secondFeature)) {
        reasons.push(
          `Similar company name "${first.canonicalName}" vs "${second.canonicalName}".`,
        );
      }
      const domainNear = domainsAreNear(firstFeature, secondFeature);
      if (domainNear.near) {
        reasons.push(
          `Similar employer domain "${domainNear.firstDomain}" vs "${domainNear.secondDomain}".`,
        );
      }
      if (reasons.length === 0) continue;
      const candidate = ensureMergeCandidates(
        working,
        indexes,
        first.id,
        second.id,
        reasons.join(" "),
        now,
      );
      if (candidate) created.push(candidate);
    }
  }
}

/**
 * Reconciles companies from jobs and application records.
 *
 * Matching is conservative: exactly one canonical name or user-approved alias
 * must match. A unique conflicting domain fails closed; shared or ambiguous
 * domains are research evidence and do not veto that name owner. Ambiguous
 * matches are never attached and instead produce pending merge candidates.
 * Near-name and near-domain conflicts also produce explicit pending
 * candidates. Existing listable companies are preserved; legacy
 * placeholder/generic shells are purged. New companies receive caller-provided
 * ids and the caller-provided `now` timestamp.
 */
type ReconcileCompaniesInput = {
  companies: readonly CompanyEntity[];
  jobs: readonly SavedJob[];
  applicationRecords: readonly ApplicationRecord[];
  now: string;
  createCompanyId: (identity: {
    normalizedName: string;
    normalizedDomain: string | null;
  }) => string;
};

export function reconcileCompanies(
  input: ReconcileCompaniesInput,
): ReconcileCompaniesResult {
  const steps = reconcileCompanySteps(input);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** The same ownership decisions, without holding main for the full inventory. */
export async function reconcileCompaniesInTurns(
  input: ReconcileCompaniesInput,
): Promise<ReconcileCompaniesResult> {
  await yieldToEventLoop();
  const steps = reconcileCompanySteps(input);
  let started = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - started >= 8) {
      await yieldToEventLoop();
      started = performance.now();
    }
  }
}

function* reconcileCompanySteps(
  input: ReconcileCompaniesInput,
): Generator<void, ReconcileCompaniesResult, void> {
  const nowResult = IsoDateTimeSchema.safeParse(input.now);
  if (!nowResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "now must be a valid ISO datetime.",
      },
    };
  }
  const now = nowResult.data;

  const companiesResult = CompanyEntitySchema.array().safeParse(
    input.companies,
  );
  if (!companiesResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(companiesResult.error),
      },
    };
  }
  const jobs: CompanyJobEvidence[] = [];
  for (const job of input.jobs) {
    yield;
    const result = readCompanyJobEvidence(job);
    if (!result.ok)
      return {
        ok: false,
        failure: {
          code: "invalid_input",
          message: firstIssueMessage(result.error),
        },
      };
    jobs.push(result.evidence);
  }
  const records: CompanyApplicationEvidence[] = [];
  for (const record of input.applicationRecords) {
    yield;
    const result = readCompanyApplicationEvidence(record);
    if (!result.ok)
      return {
        ok: false,
        failure: {
          code: "invalid_input",
          message: firstIssueMessage(result.error),
        },
      };
    records.push(result.evidence);
  }

  const working: CompanyEntity[] = companiesResult.data;

  const seenIds = new Set<string>();
  for (const company of working) {
    yield;
    if (seenIds.has(company.id)) {
      return {
        ok: false,
        failure: {
          code: "invalid_input",
          message: `Duplicate company id "${company.id}".`,
        },
      };
    }
    seenIds.add(company.id);
  }

  const indexes = buildIndexes(working);
  identifySharedListingHosts(indexes, jobs);
  removeUnsupportedDerivedCandidates(working, indexes, now);

  const jobSourceById = new Map<string, string>();
  for (const job of jobs) {
    yield;
    if (!jobSourceById.has(job.id)) jobSourceById.set(job.id, job.source);
  }

  const summary: ReconcileCompaniesSummary = {
    createdCompanyIds: [],
    matchedCompanyIds: [],
    ambiguousEvidenceCount: 0,
    unresolvableEvidenceCount: 0,
    createdMergeCandidates: [],
  };
  const matchedCompanyIds = new Set<string>();
  const recordMatch = (companyId: string): void => {
    if (matchedCompanyIds.has(companyId)) return;
    matchedCompanyIds.add(companyId);
    summary.matchedCompanyIds.push(companyId);
  };

  const processEvidence = (
    evidence: Evidence,
    requiredCompanyId?: string,
  ): string | null => {
    const resolution = resolveEvidence(indexes, evidence);

    if (
      resolution.status === "matched" &&
      (requiredCompanyId === undefined ||
        resolution.companyId === requiredCompanyId)
    ) {
      attachEvidence({
        working,
        indexes,
        companyId: resolution.companyId,
        evidence,
        now,
        jobSourceById,
        created: summary.createdMergeCandidates,
      });
      recordMatch(resolution.companyId);
      return resolution.companyId;
    }

    if (resolution.status === "ambiguous" && requiredCompanyId === undefined) {
      summary.ambiguousEvidenceCount += 1;
      flagAmbiguousPair(
        working,
        indexes,
        resolution.companyIds,
        resolution.reason,
        now,
        summary.createdMergeCandidates,
      );
      return null;
    }

    if (requiredCompanyId !== undefined) {
      attachEvidence({
        working,
        indexes,
        companyId: requiredCompanyId,
        evidence,
        now,
        jobSourceById,
        created: summary.createdMergeCandidates,
      });
      recordMatch(requiredCompanyId);
      return requiredCompanyId;
    }

    const rawName =
      evidence.kind === "job" ? evidence.job.company : evidence.record.company;
    const normalizedName = normalizeCompanyName(rawName);
    if (!isSpecificCompanyName(rawName)) {
      summary.unresolvableEvidenceCount += 1;
      return null;
    }

    const rawDomain =
      evidence.kind === "job" ? evidence.job.employerDomain : null;
    const normalizedDomain =
      rawDomain !== null && rawDomain.trim() !== ""
        ? normalizeEmployerDomain(rawDomain)
        : null;

    const identity = { normalizedName, normalizedDomain };
    const idResult = NonEmptyStringSchema.safeParse(
      input.createCompanyId(identity),
    );
    if (!idResult.success) {
      throw new Error(
        "createCompanyId must return a non-empty string id for a new company.",
      );
    }
    const newId = idResult.data;
    if (indexes.byId.has(newId)) {
      throw new Error(
        `createCompanyId returned an id that already exists: "${newId}".`,
      );
    }

    const company = createCompanyEntity({
      evidence,
      id: newId,
      now,
      jobSourceById,
    });

    indexes.byId.set(newId, working.length);
    indexes.memberships.set(newId, companyMembership(company));
    working.push(company);
    for (const domain of company.domains) {
      const existingDomainMatches =
        indexes.domainIndex.get(normalizeEmployerDomain(domain.domain)) ?? [];
      addToIndex(
        indexes.domainIndex,
        normalizeEmployerDomain(domain.domain),
        newId,
      );
      // The companies already on this domain were paired as each joined;
      // only the new company's pairs can be new.
      for (const existingId of indexes.sharedListingHosts.has(
        normalizeEmployerDomain(domain.domain),
      )
        ? []
        : existingDomainMatches) {
        flagAmbiguousPair(
          working,
          indexes,
          [existingId, newId],
          `Multiple companies share the employer domain "${normalizeEmployerDomain(domain.domain)}".`,
          now,
          summary.createdMergeCandidates,
        );
      }
    }
    addToIndex(
      indexes.nameIndex,
      normalizeCompanyName(company.canonicalName),
      newId,
    );
    summary.createdCompanyIds.push(newId);
    return newId;
  };

  try {
    const currentJobOwnerById = new Map<string, string | null>();
    for (const job of jobs) {
      yield;
      currentJobOwnerById.set(job.id, processEvidence({ kind: "job", job }));
    }
    const currentApplicationOwnerById = new Map<string, string | null>();
    for (const record of records) {
      yield;
      const relatedJobOwner = currentJobOwnerById.get(record.jobId);
      if (relatedJobOwner === undefined) {
        summary.unresolvableEvidenceCount += 1;
        continue;
      }
      const owner =
        relatedJobOwner === null
          ? null
          : processEvidence({ kind: "application", record }, relatedJobOwner);
      currentApplicationOwnerById.set(record.id, owner);
    }

    for (let index = 0; index < working.length; index += 1) {
      yield;
      const company = working[index]!;
      const jobIds = company.jobIds.filter((jobId) => {
        const owner = currentJobOwnerById.get(jobId);
        return owner === undefined || owner === company.id;
      });
      const applicationRecordIds = company.applicationRecordIds.filter(
        (recordId) => {
          const owner = currentApplicationOwnerById.get(recordId);
          return owner === undefined || owner === company.id;
        },
      );
      if (
        jobIds.length === company.jobIds.length &&
        applicationRecordIds.length === company.applicationRecordIds.length
      ) {
        continue;
      }
      company.jobIds = jobIds;
      company.applicationRecordIds = applicationRecordIds;
      company.updatedAt = nextCompanyIntelligenceUpdatedAt(
        now,
        company.updatedAt,
      );
    }
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: error instanceof Error ? error.message : "Invalid input.",
      },
    };
  }

  const listableCompanies = purgeUnlistableCompanies(working, now);
  const listableIndexes =
    listableCompanies.length === working.length
      ? indexes
      : buildIndexes(listableCompanies);
  listableIndexes.sharedListingHosts = indexes.sharedListingHosts;

  applyNearConflictCandidates(
    listableCompanies,
    listableIndexes,
    now,
    summary.createdMergeCandidates,
  );

  return {
    ok: true,
    // Inputs, newly attached fields and candidates were already parsed. These
    // privately owned values need no second deep copy of the complete graph.
    companies: listableCompanies,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Company preference
// ---------------------------------------------------------------------------

export type SetCompanyPreferenceFailure =
  | { code: "invalid_input"; message: string }
  | { code: "company_not_found"; message: string };

export type SetCompanyPreferenceResult =
  | { ok: true; companies: CompanyEntity[]; company: CompanyEntity }
  | { ok: false; failure: SetCompanyPreferenceFailure };

/**
 * Sets a company preference explicitly. An explicit user preference clears any
 * inferred preference reason and stamps the caller-provided `now` as the
 * update time. Returns a fresh, schema-parsed company list.
 */
export function setCompanyPreference(input: {
  companies: readonly CompanyEntity[];
  input: SetCompanyPreferenceInput;
  now: string;
}): SetCompanyPreferenceResult {
  const nowResult = IsoDateTimeSchema.safeParse(input.now);
  if (!nowResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "now must be a valid ISO datetime.",
      },
    };
  }
  const now = nowResult.data;

  const companiesResult = CompanyEntitySchema.array().safeParse(
    input.companies,
  );
  if (!companiesResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(companiesResult.error),
      },
    };
  }

  const commandResult = SetCompanyPreferenceInputSchema.safeParse(input.input);
  if (!commandResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(commandResult.error),
      },
    };
  }
  const command = commandResult.data;

  const index = companiesResult.data.findIndex(
    (company) => company.id === command.companyId,
  );
  if (index < 0) {
    return {
      ok: false,
      failure: {
        code: "company_not_found",
        message: `Company "${command.companyId}" does not exist.`,
      },
    };
  }

  const nextCompany = CompanyEntitySchema.parse({
    ...companiesResult.data[index]!,
    preference: command.preference,
    preferenceReason: null,
    updatedAt: nextCompanyIntelligenceUpdatedAt(
      now,
      companiesResult.data[index]!.updatedAt,
    ),
  });

  const companies = companiesResult.data.map((company, companyIndex) =>
    companyIndex === index ? nextCompany : company,
  );

  return { ok: true, companies, company: nextCompany };
}

// ---------------------------------------------------------------------------
// Merge review
// ---------------------------------------------------------------------------

export type ReviewCompanyMergeFailure =
  | { code: "invalid_input"; message: string }
  | { code: "company_not_found"; message: string }
  | { code: "candidate_not_found"; message: string }
  | {
      code: "candidate_already_decided";
      message: string;
      currentDecision: "approved_merge" | "rejected";
    }
  | { code: "candidate_company_not_found"; message: string };

export type ReviewCompanyMergeResult =
  | {
      ok: true;
      companies: CompanyEntity[];
      company: CompanyEntity;
      merged: CompanyEntity | null;
    }
  | { ok: false; failure: ReviewCompanyMergeFailure };

function dedupeCandidates(
  candidates: readonly CompanyMergeReviewCandidate[],
): CompanyMergeReviewCandidate[] {
  const seen = new Set<string>();
  const result: CompanyMergeReviewCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateCompanyId)) continue;
    seen.add(candidate.candidateCompanyId);
    result.push(candidate);
  }
  return result;
}

function mergeRefLists(
  first: readonly CompanySourceHistoryRef[],
  second: readonly CompanySourceHistoryRef[],
): CompanySourceHistoryRef[] {
  const bySourceId = new Map<string, CompanySourceHistoryRef>();
  const result: CompanySourceHistoryRef[] = [];
  for (const ref of first) {
    bySourceId.set(ref.sourceId, ref);
    result.push(ref);
  }
  for (const ref of second) {
    const existing = bySourceId.get(ref.sourceId);
    if (!existing) {
      bySourceId.set(ref.sourceId, ref);
      result.push(ref);
      continue;
    }
    const existingIndex = result.indexOf(existing);
    const merged = CompanySourceHistoryRefSchema.parse({
      ...existing,
      firstSeenAt:
        Date.parse(existing.firstSeenAt) <= Date.parse(ref.firstSeenAt)
          ? existing.firstSeenAt
          : ref.firstSeenAt,
      lastSeenAt:
        Date.parse(existing.lastSeenAt) >= Date.parse(ref.lastSeenAt)
          ? existing.lastSeenAt
          : ref.lastSeenAt,
      applicationRecordIds: unionStrings(
        existing.applicationRecordIds,
        ref.applicationRecordIds,
      ),
    });
    bySourceId.set(ref.sourceId, merged);
    if (existingIndex >= 0) result[existingIndex] = merged;
  }
  return result;
}

/**
 * Deterministically merges `target` into `primary` and returns a fresh,
 * schema-parsed entity. The primary company keeps its id, canonical name,
 * preference, and preference reason; every job, application, contact, note,
 * and source id from both sides is preserved, and the target's canonical name
 * becomes an alias. The earliest `createdAt` is kept and `updatedAt` is
 * stamped with the caller-provided `now`.
 */
function mergeCompanies(
  primary: CompanyEntity,
  target: CompanyEntity,
  now: string,
): CompanyEntity {
  const updatedAt = nextCompanyIntelligenceUpdatedAt(
    now,
    primary.updatedAt,
    target.updatedAt,
  );
  const primaryCanonicalNormalized = normalizeCompanyName(
    primary.canonicalName,
  );
  const aliases = primary.aliases.map((alias) => ({ ...alias }));
  const aliasIndexByKey = new Map(
    aliases.map((alias, index) => [alias.normalized, index] as const),
  );
  const addOrUpgradeAlias = (alias: CompanyEntity["aliases"][number]): void => {
    if (alias.normalized === primaryCanonicalNormalized) return;
    const existingIndex = aliasIndexByKey.get(alias.normalized);
    if (existingIndex === undefined) {
      aliasIndexByKey.set(alias.normalized, aliases.length);
      aliases.push({ ...alias });
      return;
    }
    if (
      alias.identityAuthority === "user_approved_merge" &&
      aliases[existingIndex]?.identityAuthority === "unknown"
    ) {
      aliases[existingIndex] = {
        ...aliases[existingIndex],
        identityAuthority: "user_approved_merge",
      };
    }
  };
  const targetCanonicalNormalized = normalizeCompanyName(target.canonicalName);
  if (targetCanonicalNormalized) {
    addOrUpgradeAlias({
      alias: target.canonicalName,
      normalized: targetCanonicalNormalized,
      confidence: 1,
      identityAuthority: "user_approved_merge",
    });
  }
  for (const alias of target.aliases) {
    addOrUpgradeAlias(alias);
  }

  const domainKeys = new Set<string>();
  const domains: CompanyDomain[] = [];
  let primaryAssigned = false;
  for (const domain of [...primary.domains, ...target.domains]) {
    const key = normalizeEmployerDomain(domain.domain);
    if (domainKeys.has(key)) continue;
    domainKeys.add(key);
    const primaryFlag = domain.primary && !primaryAssigned;
    if (primaryFlag) primaryAssigned = true;
    domains.push({ ...domain, primary: primaryFlag });
  }

  const mergeReviewCandidates = dedupeCandidates([
    ...primary.mergeReviewCandidates.filter(
      (candidate) => candidate.candidateCompanyId !== target.id,
    ),
    ...target.mergeReviewCandidates.filter(
      (candidate) =>
        candidate.candidateCompanyId !== primary.id &&
        candidate.candidateCompanyId !== target.id,
    ),
  ]);

  return CompanyEntitySchema.parse({
    id: primary.id,
    canonicalName: primary.canonicalName,
    aliases,
    domains,
    preference: primary.preference,
    preferenceReason: primary.preferenceReason,
    mergeReviewCandidates,
    contacts: unionById(primary.contacts, target.contacts),
    notes: unionById(primary.notes, target.notes),
    salaryOfferEvidence: unionById(
      primary.salaryOfferEvidence,
      target.salaryOfferEvidence,
    ),
    sourceHistory: mergeRefLists(primary.sourceHistory, target.sourceHistory),
    jobIds: unionStrings(primary.jobIds, target.jobIds),
    applicationRecordIds: unionStrings(
      primary.applicationRecordIds,
      target.applicationRecordIds,
    ),
    createdAt:
      Date.parse(primary.createdAt) <= Date.parse(target.createdAt)
        ? primary.createdAt
        : target.createdAt,
    updatedAt,
  });
}

/**
 * Accepts or rejects a pending merge-review candidate. Rejection records the
 * decision and timestamp on the candidate. Acceptance deterministically
 * merges the candidate company into the reviewing company, preserving every
 * job/application/contact/note/source id and alias, and removes the absorbed
 * company. Merge candidates on other companies that reference the absorbed
 * company are remapped to the surviving company.
 */
export function reviewCompanyMerge(input: {
  companies: readonly CompanyEntity[];
  input: ReviewCompanyMergeInput;
  now: string;
}): ReviewCompanyMergeResult {
  const nowResult = IsoDateTimeSchema.safeParse(input.now);
  if (!nowResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "now must be a valid ISO datetime.",
      },
    };
  }
  const now = nowResult.data;

  const companiesResult = CompanyEntitySchema.array().safeParse(
    input.companies,
  );
  if (!companiesResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(companiesResult.error),
      },
    };
  }

  const commandResult = ReviewCompanyMergeInputSchema.safeParse(input.input);
  if (!commandResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(commandResult.error),
      },
    };
  }
  const command = commandResult.data;

  if (command.candidateId === command.companyId) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "A company cannot merge with itself.",
      },
    };
  }

  const primaryIndex = companiesResult.data.findIndex(
    (company) => company.id === command.companyId,
  );
  if (primaryIndex < 0) {
    return {
      ok: false,
      failure: {
        code: "company_not_found",
        message: `Company "${command.companyId}" does not exist.`,
      },
    };
  }
  const primary = companiesResult.data[primaryIndex]!;

  const candidate = primary.mergeReviewCandidates.find(
    (entry) => entry.candidateCompanyId === command.candidateId,
  );
  if (!candidate) {
    return {
      ok: false,
      failure: {
        code: "candidate_not_found",
        message: `Company "${command.companyId}" has no merge candidate for "${command.candidateId}".`,
      },
    };
  }
  if (candidate.decision !== "pending") {
    return {
      ok: false,
      failure: {
        code: "candidate_already_decided",
        message: `Merge candidate "${command.candidateId}" was already ${candidate.decision}.`,
        currentDecision: candidate.decision,
      },
    };
  }

  if (command.decision === "rejected") {
    const updatedAt = nextCompanyIntelligenceUpdatedAt(now, primary.updatedAt);
    const nextPrimary = CompanyEntitySchema.parse({
      ...primary,
      mergeReviewCandidates: primary.mergeReviewCandidates.map((entry) =>
        entry.candidateCompanyId === command.candidateId
          ? CompanyMergeReviewCandidateSchema.parse({
              ...entry,
              decision: "rejected",
              decidedAt: updatedAt,
            })
          : entry,
      ),
      updatedAt,
    });

    const companies = companiesResult.data.map((company, companyIndex) =>
      companyIndex === primaryIndex ? nextPrimary : company,
    );

    return { ok: true, companies, company: nextPrimary, merged: null };
  }

  const targetIndex = companiesResult.data.findIndex(
    (company) => company.id === command.candidateId,
  );
  if (targetIndex < 0) {
    return {
      ok: false,
      failure: {
        code: "candidate_company_not_found",
        message: `Merge candidate company "${command.candidateId}" does not exist.`,
      },
    };
  }
  const target = companiesResult.data[targetIndex]!;

  const merged = mergeCompanies(primary, target, now);

  const companies = companiesResult.data
    .map((company, companyIndex) => {
      if (companyIndex === primaryIndex) return merged;
      if (company.id === command.candidateId) return null;
      if (
        company.mergeReviewCandidates.some(
          (entry) => entry.candidateCompanyId === command.candidateId,
        )
      ) {
        const updatedAt = nextCompanyIntelligenceUpdatedAt(
          now,
          company.updatedAt,
        );
        return CompanyEntitySchema.parse({
          ...company,
          mergeReviewCandidates: dedupeCandidates(
            company.mergeReviewCandidates.map((entry) =>
              entry.candidateCompanyId === command.candidateId
                ? CompanyMergeReviewCandidateSchema.parse({
                    ...entry,
                    candidateCompanyId: merged.id,
                  })
                : entry,
            ),
          ),
          updatedAt,
        });
      }
      return company;
    })
    .filter((company): company is CompanyEntity => company !== null);

  return { ok: true, companies, company: merged, merged };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

const OPEN_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "discovered",
  "shortlisted",
  "drafting",
  "ready_for_review",
  "approved",
  "submitted",
  "assessment",
  "interview",
  "offer",
]);

const ALL_APPLICATION_STATUSES =
  ApplicationStatusSchema.options as readonly ApplicationStatus[];

export type CompanyOpeningsProjection = {
  companyId: string;
  current: SavedJob[];
  previous: SavedJob[];
  currentCount: number;
  previousCount: number;
  totalCount: number;
  lastOpenedAt: string | null;
};

function compareOpenedAtDescending(first: SavedJob, second: SavedJob): number {
  const firstOpenedAt = first.postedAt ?? first.discoveredAt;
  const secondOpenedAt = second.postedAt ?? second.discoveredAt;
  const difference = Date.parse(secondOpenedAt) - Date.parse(firstOpenedAt);
  if (difference !== 0) return difference;
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

/**
 * Projects a company's linked openings from `company.jobIds`: current openings
 * (active statuses) and previous openings (closed statuses), each sorted most
 * recent first. Outputs are freshly schema-parsed `SavedJob` values.
 */
export function projectCompanyOpenings(input: {
  company: CompanyEntity;
  jobs: readonly SavedJob[];
}): CompanyOpeningsProjection {
  const company = CompanyEntitySchema.parse(input.company);
  const jobIds = new Set(company.jobIds);
  const linked = SavedJobSchema.array().parse(
    input.jobs.filter((job) => jobIds.has(job.id)),
  );
  const current: SavedJob[] = [];
  const previous: SavedJob[] = [];
  for (const job of linked) {
    if (OPEN_APPLICATION_STATUSES.has(job.status)) {
      current.push(job);
    } else {
      previous.push(job);
    }
  }
  current.sort(compareOpenedAtDescending);
  previous.sort(compareOpenedAtDescending);

  let lastOpenedAt: string | null = null;
  for (const job of linked) {
    const openedAt = job.postedAt ?? job.discoveredAt;
    if (
      lastOpenedAt === null ||
      Date.parse(openedAt) > Date.parse(lastOpenedAt)
    ) {
      lastOpenedAt = openedAt;
    }
  }

  return {
    companyId: company.id,
    current,
    previous,
    currentCount: current.length,
    previousCount: previous.length,
    totalCount: linked.length,
    lastOpenedAt,
  };
}

export type CompanyApplicationHistoryProjection = {
  companyId: string;
  records: ApplicationRecord[];
  totalCount: number;
  statusCounts: Record<ApplicationStatus, number>;
  earliestUpdatedAt: string | null;
  latestUpdatedAt: string | null;
};

/**
 * Projects a company's application history from `company.applicationRecordIds`,
 * newest first, with per-status counts. Outputs are freshly schema-parsed
 * `ApplicationRecord` values.
 */
export function projectCompanyApplicationHistory(input: {
  company: CompanyEntity;
  applicationRecords: readonly ApplicationRecord[];
}): CompanyApplicationHistoryProjection {
  const company = CompanyEntitySchema.parse(input.company);
  const recordIds = new Set(company.applicationRecordIds);
  const records = ApplicationRecordSchema.array().parse(
    input.applicationRecords.filter((record) => recordIds.has(record.id)),
  );
  const sorted = records.sort((first, second) => {
    const difference =
      Date.parse(second.lastUpdatedAt) - Date.parse(first.lastUpdatedAt);
    if (difference !== 0) return difference;
    return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  });

  const statusCounts = Object.fromEntries(
    ALL_APPLICATION_STATUSES.map((status) => [status, 0]),
  ) as Record<ApplicationStatus, number>;
  for (const record of sorted) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
  }

  return {
    companyId: company.id,
    records: sorted,
    totalCount: sorted.length,
    statusCounts,
    earliestUpdatedAt:
      sorted.length === 0 ? null : sorted.at(-1)!.lastUpdatedAt,
    latestUpdatedAt: sorted.length === 0 ? null : sorted[0]!.lastUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Local company intelligence mutations (contacts, notes, salary/offer evidence)
// ---------------------------------------------------------------------------

export type CompanyIntelligenceMutationFailure =
  | { code: "invalid_input"; message: string }
  | { code: "company_not_found"; message: string }
  | { code: "company_changed"; message: string }
  | { code: "contact_not_found"; message: string }
  | { code: "note_not_found"; message: string }
  | { code: "job_not_found"; message: string }
  | { code: "job_company_mismatch"; message: string }
  | { code: "application_record_not_found"; message: string }
  | { code: "application_record_mismatch"; message: string }
  | { code: "evidence_not_found"; message: string };

export type CompanyIntelligenceMutationResult =
  | { ok: true; companies: CompanyEntity[]; company: CompanyEntity }
  | { ok: false; failure: CompanyIntelligenceMutationFailure };

function replaceCompany(
  companies: readonly CompanyEntity[],
  index: number,
  company: CompanyEntity,
): CompanyEntity[] {
  return companies.map((entry, entryIndex) =>
    entryIndex === index ? company : entry,
  );
}

/**
 * Applies a typed local company-intelligence mutation immutably. The command
 * is compare-and-swapped against `expectedUpdatedAt` so a company changed by a
 * concurrent merge/edit is never overwritten. Upserts replace the matching id
 * while preserving the original `createdAt`; removals are no-op failures when
 * the referenced item does not exist. All outputs are freshly schema-parsed.
 */
export function applyCompanyIntelligenceMutation(input: {
  companies: readonly CompanyEntity[];
  jobs?: readonly SavedJob[];
  applicationRecords?: readonly ApplicationRecord[];
  input: CompanyIntelligenceMutationInput;
  now: string;
}): CompanyIntelligenceMutationResult {
  const nowResult = IsoDateTimeSchema.safeParse(input.now);
  if (!nowResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "now must be a valid ISO datetime.",
      },
    };
  }
  const now = nowResult.data;

  const companiesResult = CompanyEntitySchema.array().safeParse(
    input.companies,
  );
  if (!companiesResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(companiesResult.error),
      },
    };
  }

  const commandResult = CompanyIntelligenceMutationInputSchema.safeParse(
    input.input,
  );
  if (!commandResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(commandResult.error),
      },
    };
  }
  const command = commandResult.data;

  const index = companiesResult.data.findIndex(
    (company) => company.id === command.companyId,
  );
  if (index < 0) {
    return {
      ok: false,
      failure: {
        code: "company_not_found",
        message: `Company "${command.companyId}" does not exist.`,
      },
    };
  }

  const company = companiesResult.data[index]!;
  if (company.updatedAt !== command.expectedUpdatedAt) {
    return {
      ok: false,
      failure: {
        code: "company_changed",
        message:
          "This company changed since you opened it. Refresh before editing.",
      },
    };
  }

  const updatedAt = nextCompanyIntelligenceUpdatedAt(now, company.updatedAt);

  let next: CompanyEntity | null = null;

  if (command.mutation.type === "upsert_contact") {
    const contact = command.mutation.contact;
    const existing = company.contacts.find((entry) => entry.id === contact.id);
    const contacts = existing
      ? company.contacts.map((entry) =>
          entry.id === contact.id
            ? { ...contact, createdAt: entry.createdAt, updatedAt }
            : entry,
        )
      : [...company.contacts, { ...contact, updatedAt }];
    next = CompanyEntitySchema.parse({
      ...company,
      contacts,
      updatedAt,
    });
  } else if (command.mutation.type === "remove_contact") {
    const removeContact = command.mutation;
    if (
      !company.contacts.some((entry) => entry.id === removeContact.contactId)
    ) {
      return {
        ok: false,
        failure: {
          code: "contact_not_found",
          message: `Contact "${removeContact.contactId}" does not exist.`,
        },
      };
    }
    next = CompanyEntitySchema.parse({
      ...company,
      contacts: company.contacts.filter(
        (entry) => entry.id !== removeContact.contactId,
      ),
      updatedAt,
    });
  } else if (command.mutation.type === "add_note") {
    next = CompanyEntitySchema.parse({
      ...company,
      notes: [...company.notes, command.mutation.note],
      updatedAt,
    });
  } else if (command.mutation.type === "remove_note") {
    const removeNote = command.mutation;
    if (!company.notes.some((entry) => entry.id === removeNote.noteId)) {
      return {
        ok: false,
        failure: {
          code: "note_not_found",
          message: `Note "${removeNote.noteId}" does not exist.`,
        },
      };
    }
    next = CompanyEntitySchema.parse({
      ...company,
      notes: company.notes.filter((entry) => entry.id !== removeNote.noteId),
      updatedAt,
    });
  } else if (command.mutation.type === "upsert_salary_offer_evidence") {
    const evidence = command.mutation.evidence;
    const job =
      evidence.jobId === null
        ? null
        : (input.jobs ?? []).find((entry) => entry.id === evidence.jobId);
    if (evidence.jobId !== null && !job) {
      return {
        ok: false,
        failure: {
          code: "job_not_found",
          message: `Job "${evidence.jobId}" does not exist.`,
        },
      };
    }
    if (
      job &&
      (!company.jobIds.includes(job.id) ||
        resolveCurrentJobOwner(companiesResult.data, job) !== company.id)
    ) {
      return {
        ok: false,
        failure: {
          code: "job_company_mismatch",
          message: `Job "${job.id}" does not belong to company "${company.id}".`,
        },
      };
    }
    const applicationRecord =
      evidence.applicationRecordId === null
        ? null
        : (input.applicationRecords ?? []).find(
            (entry) => entry.id === evidence.applicationRecordId,
          );
    if (evidence.applicationRecordId !== null && !applicationRecord) {
      return {
        ok: false,
        failure: {
          code: "application_record_not_found",
          message: `Application record "${evidence.applicationRecordId}" does not exist.`,
        },
      };
    }
    if (
      applicationRecord &&
      (applicationRecord.jobId !== evidence.jobId ||
        !job ||
        !company.applicationRecordIds.includes(applicationRecord.id) ||
        resolveCurrentJobOwner(companiesResult.data, job) !== company.id)
    ) {
      return {
        ok: false,
        failure: {
          code: "application_record_mismatch",
          message: `Application record "${applicationRecord.id}" does not belong to the selected job and company.`,
        },
      };
    }
    const existing = company.salaryOfferEvidence.find(
      (entry) => entry.id === evidence.id,
    );
    const salaryOfferEvidence = existing
      ? company.salaryOfferEvidence.map((entry) =>
          entry.id === evidence.id
            ? { ...evidence, createdAt: entry.createdAt, updatedAt }
            : entry,
        )
      : [...company.salaryOfferEvidence, { ...evidence, updatedAt }];
    next = CompanyEntitySchema.parse({
      ...company,
      salaryOfferEvidence,
      updatedAt,
    });
  } else if (command.mutation.type === "remove_salary_offer_evidence") {
    const removeEvidence = command.mutation;
    if (
      !company.salaryOfferEvidence.some(
        (entry) => entry.id === removeEvidence.evidenceId,
      )
    ) {
      return {
        ok: false,
        failure: {
          code: "evidence_not_found",
          message: `Salary/offer evidence "${removeEvidence.evidenceId}" does not exist.`,
        },
      };
    }
    next = CompanyEntitySchema.parse({
      ...company,
      salaryOfferEvidence: company.salaryOfferEvidence.filter(
        (entry) => entry.id !== removeEvidence.evidenceId,
      ),
      updatedAt,
    });
  } else {
    const unreachable: never = command.mutation;
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: `Unsupported company intelligence mutation: ${String(unreachable)}`,
      },
    };
  }

  if (next === null) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "The company mutation could not be applied.",
      },
    };
  }

  const companies = replaceCompany(companiesResult.data, index, next);
  return { ok: true, companies, company: next };
}

// ---------------------------------------------------------------------------
// Duplicate job detection within a company
// ---------------------------------------------------------------------------

export type CompanyDuplicateJobKind = "exact" | "possible";

export type CompanyDuplicateJobGroup = {
  id: string;
  kind: CompanyDuplicateJobKind;
  reason: string;
  jobIds: string[];
};

function toJobIdentityInput(job: SavedJob): JobIdentityInput {
  return {
    source: job.source,
    sourceJobId: job.sourceJobId,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    providerKey: job.providerKey,
    providerBoardToken: job.providerBoardToken,
    providerIdentifier: job.providerIdentifier,
    title: job.title,
    company: job.company,
    location: job.location,
    postedAt: job.postedAt,
    postedAtText: job.postedAtText,
  };
}

/**
 * Detects duplicate job postings inside one company using the same collision-
 * safe identity aliases as discovery. A pair sharing any strong identity alias
 * (provider/source posting id, employer application URL, or canonical listing
 * URL) is an `exact` duplicate. A pair sharing only corroborating or possible
 * aliases (for example normalized title + company + location + posted date)
 * is a `possible` duplicate that is surfaced for review, never auto-merged.
 *
 * The projection is conservative: weak facts never collapse two postings, and
 * a job with no shared alias is simply not a duplicate.
 */
export function projectCompanyDuplicateJobs(input: {
  company: CompanyEntity;
  jobs: readonly SavedJob[];
}): CompanyDuplicateJobGroup[] {
  const company = CompanyEntitySchema.parse(input.company);
  const jobIds = new Set(company.jobIds);
  const linked = SavedJobSchema.array().parse(
    input.jobs.filter((job) => jobIds.has(job.id)),
  );
  if (linked.length < 2) return [];

  const aliasesByJob = linked.map((job) =>
    buildJobIdentityAliases(toJobIdentityInput(job)),
  );
  const strongIndex = new Map<string, number[]>();
  const weakIndex = new Map<string, number[]>();
  for (let index = 0; index < linked.length; index += 1) {
    for (const alias of aliasesByJob[index]!) {
      const target = alias.confidence === "strong" ? strongIndex : weakIndex;
      const matches = target.get(alias.key);
      if (matches) matches.push(index);
      else target.set(alias.key, [index]);
    }
  }

  const groups: CompanyDuplicateJobGroup[] = [];
  // Only matching pairs are retained. Unrelated jobs no longer allocate an
  // entry in a quadratic visited-pair set.
  const recorded = new Map<string, Set<string>>();
  for (let firstIndex = 0; firstIndex < linked.length; firstIndex += 1) {
    const first = linked[firstIndex]!;
    const exact = new Set<number>();
    const possible = new Set<number>();
    for (const alias of aliasesByJob[firstIndex]!) {
      const target = alias.confidence === "strong" ? strongIndex : weakIndex;
      const matches = alias.confidence === "strong" ? exact : possible;
      for (const index of target.get(alias.key) ?? []) {
        if (index > firstIndex) matches.add(index);
      }
    }
    for (const secondIndex of [...new Set([...exact, ...possible])].sort(
      (a, b) => a - b,
    )) {
      const second = linked[secondIndex]!;
      const [primary, secondary] =
        first.id < second.id ? [first.id, second.id] : [second.id, first.id];
      const previous = recorded.get(primary);
      if (previous?.has(secondary)) continue;
      if (previous) previous.add(secondary);
      else recorded.set(primary, new Set([secondary]));
      const sharedStrong = exact.has(secondIndex);
      groups.push({
        id: sharedStrong
          ? `duplicate_${first.id}_${second.id}`
          : `duplicate_possible_${first.id}_${second.id}`,
        kind: sharedStrong ? "exact" : "possible",
        reason: sharedStrong
          ? `"${first.title}" at ${first.company} matches an identical posting already saved here.`
          : `"${first.title}" at ${first.company} may repeat "${second.title}" from ${second.location}. Review before treating them as the same role.`,
        jobIds: [first.id, second.id].sort(),
      });
    }
  }

  return groups.sort((firstGroup, secondGroup) => {
    const firstJobId = firstGroup.jobIds[0] ?? "";
    const secondJobId = secondGroup.jobIds[0] ?? "";
    return firstJobId < secondJobId ? -1 : firstJobId > secondJobId ? 1 : 0;
  });
}
