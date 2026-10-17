import type { DiscoveryLedgerEntry, JobPosting } from "@nestor/contracts";

import { classifyDiscoveryPostingFreshness } from "./workspace-discovery-ledger";

export type DiscoveryRefreshDisposition =
  | "refresh_now"
  | "defer"
  | "do_not_refresh";

export type DiscoveryRefreshReason =
  | "new_listing"
  | "material_change"
  | "reactivated_listing"
  | "legacy_fingerprint"
  | "provider_update"
  | "card_only_ttl"
  | "detail_ttl"
  | "handled_listing";

export type DiscoveryRefreshDecision = {
  classification: "new" | "unchanged" | "changed" | "reactivated";
  disposition: DiscoveryRefreshDisposition;
  reason: DiscoveryRefreshReason;
  nextRefreshAt: string | null;
};

type RefreshPosting = Pick<
  JobPosting,
  | "applicationUrl"
  | "title"
  | "company"
  | "location"
  | "workMode"
  | "applyPath"
  | "easyApplyEligible"
  | "postedAt"
  | "postedAtText"
  | "providerUpdatedAt"
  | "salaryText"
  | "employmentType"
  | "department"
  | "team"
  | "detailQuality"
  | "summary"
  | "description"
  | "keySkills"
  | "responsibilities"
  | "minimumQualifications"
  | "preferredQualifications"
  | "seniority"
  | "screeningHints"
  | "benefits"
>;

const CARD_ONLY_REFRESH_TTL_MS = 24 * 60 * 60 * 1_000;
const DETAIL_REFRESH_TTL_MS = 7 * CARD_ONLY_REFRESH_TTL_MS;

function addMilliseconds(value: string, durationMs: number): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp + durationMs).toISOString();
}

export function createDiscoveryRefreshDecision(input: {
  ledgerEntry: DiscoveryLedgerEntry | null;
  posting: RefreshPosting;
  evaluatedAt: string;
}): DiscoveryRefreshDecision {
  const { classification } = classifyDiscoveryPostingFreshness({
    ledgerEntry: input.ledgerEntry,
    posting: input.posting,
  });
  const immediate = (
    reason: Extract<
      DiscoveryRefreshReason,
      | "new_listing"
      | "material_change"
      | "reactivated_listing"
      | "legacy_fingerprint"
      | "provider_update"
    >,
  ): DiscoveryRefreshDecision => ({
    classification,
    disposition: "refresh_now",
    reason,
    nextRefreshAt: input.evaluatedAt,
  });

  if (!input.ledgerEntry) {
    return immediate("new_listing");
  }
  if (
    input.ledgerEntry.latestStatus === "applied" ||
    input.ledgerEntry.latestStatus === "skipped"
  ) {
    return {
      classification,
      disposition: "do_not_refresh",
      reason: "handled_listing",
      nextRefreshAt: null,
    };
  }
  if (classification === "reactivated") {
    return immediate("reactivated_listing");
  }
  if (!input.ledgerEntry.fingerprints) {
    return immediate("legacy_fingerprint");
  }
  const incomingProviderTimestamp = input.posting.providerUpdatedAt
    ? Date.parse(input.posting.providerUpdatedAt)
    : Number.NaN;
  const ledgerProviderTimestamp = input.ledgerEntry.providerUpdatedAt
    ? Date.parse(input.ledgerEntry.providerUpdatedAt)
    : Number.NaN;
  if (
    Number.isFinite(incomingProviderTimestamp) &&
    (!Number.isFinite(ledgerProviderTimestamp) ||
      incomingProviderTimestamp > ledgerProviderTimestamp)
  ) {
    return immediate("provider_update");
  }
  if (classification === "changed") {
    return immediate("material_change");
  }

  const usesCardOnlySchedule =
    input.posting.detailQuality === "card_only" ||
    input.ledgerEntry.detailQuality === "card_only";
  const reason: DiscoveryRefreshReason = usesCardOnlySchedule
    ? "card_only_ttl"
    : "detail_ttl";
  const verifiedAt = usesCardOnlySchedule
    ? input.ledgerEntry.lastSeenAt
    : (input.ledgerEntry.lastEnrichedAt ?? input.ledgerEntry.lastSeenAt);
  const nextRefreshAt = addMilliseconds(
    verifiedAt,
    usesCardOnlySchedule ? CARD_ONLY_REFRESH_TTL_MS : DETAIL_REFRESH_TTL_MS,
  );
  const evaluatedTimestamp = Date.parse(input.evaluatedAt);

  if (
    nextRefreshAt === null ||
    !Number.isFinite(evaluatedTimestamp) ||
    evaluatedTimestamp >= Date.parse(nextRefreshAt)
  ) {
    return {
      classification,
      disposition: "refresh_now",
      reason,
      nextRefreshAt: input.evaluatedAt,
    };
  }

  return {
    classification,
    disposition: "defer",
    reason,
    nextRefreshAt,
  };
}
