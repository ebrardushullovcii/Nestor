import { describe, expect, test } from "vitest";

import {
  JobPostingSchema,
  type DiscoveryLedgerEntry,
  type JobPosting,
} from "@nestor/contracts";

import { createDiscoveryListingFingerprints } from "./workspace-discovery-ledger";
import { createDiscoveryRefreshDecision } from "./workspace-discovery-refresh-schedule";

function createPosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "job_1",
    discoveryMethod: "browser_agent",
    collectionMethod: "careers_page",
    canonicalUrl: "https://example.com/jobs/job-1",
    applicationUrl: "https://example.com/jobs/job-1/apply",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: "2026-03-19T09:00:00.000Z",
    discoveredAt: "2026-03-20T09:00:00.000Z",
    salaryText: "$150,000",
    detailQuality: "detail_enriched",
    summary: "Build reliable customer-facing software.",
    description:
      "Build reliable customer-facing software with TypeScript and React.",
    keySkills: ["TypeScript", "React"],
    responsibilities: ["Ship reliable product improvements."],
    minimumQualifications: ["Five years of software engineering experience."],
    preferredQualifications: [],
    benefits: ["Health insurance"],
    ...overrides,
  });
}

function createLedgerEntry(
  overrides: Partial<DiscoveryLedgerEntry> = {},
): DiscoveryLedgerEntry {
  const posting = createPosting({
    detailQuality: overrides.detailQuality ?? "detail_enriched",
  });
  return {
    id: "ledger_1",
    canonicalUrl: posting.canonicalUrl,
    applicationUrl: posting.applicationUrl,
    source: posting.source,
    sourceJobId: posting.sourceJobId,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    providerUpdatedAt: posting.providerUpdatedAt,
    title: posting.title,
    company: posting.company,
    location: posting.location,
    postedAt: posting.postedAt,
    postedAtText: posting.postedAtText,
    targetId: "target_one",
    collectionMethod: posting.collectionMethod,
    detailQuality: posting.detailQuality,
    fingerprints: createDiscoveryListingFingerprints(posting),
    firstSeenAt: "2026-03-20T09:00:00.000Z",
    lastSeenAt: "2026-03-20T09:00:00.000Z",
    lastAppliedAt: null,
    lastEnrichedAt: "2026-03-20T09:05:00.000Z",
    inactiveAt: null,
    latestStatus: "enriched",
    titleTriageOutcome: "pass",
    skipReason: null,
    ...overrides,
  };
}

describe("workspace-discovery-refresh-schedule", () => {
  test("refreshes new, materially changed, legacy, and reactivated listings now", () => {
    const evaluatedAt = "2026-03-20T10:00:00.000Z";
    const decisions = [
      createDiscoveryRefreshDecision({
        ledgerEntry: null,
        posting: createPosting(),
        evaluatedAt,
      }),
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry(),
        posting: createPosting({ title: "Senior Software Engineer" }),
        evaluatedAt,
      }),
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry({ fingerprints: null }),
        posting: createPosting(),
        evaluatedAt,
      }),
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry({
          latestStatus: "inactive",
          inactiveAt: "2026-03-20T09:00:00.000Z",
        }),
        posting: createPosting(),
        evaluatedAt,
      }),
    ];

    expect(decisions.map((decision) => decision.reason)).toEqual([
      "new_listing",
      "material_change",
      "legacy_fingerprint",
      "reactivated_listing",
    ]);
    expect(
      decisions.every((decision) => decision.disposition === "refresh_now"),
    ).toBe(true);
    expect(
      decisions.every((decision) => decision.nextRefreshAt === evaluatedAt),
    ).toBe(true);
  });

  test("refreshes immediately when the provider reports a newer update", () => {
    const previousPosting = createPosting({
      providerUpdatedAt: "2026-03-20T09:30:00.000Z",
    });
    const decision = createDiscoveryRefreshDecision({
      ledgerEntry: createLedgerEntry({
        providerUpdatedAt: previousPosting.providerUpdatedAt,
        fingerprints: createDiscoveryListingFingerprints(previousPosting),
      }),
      posting: createPosting({
        providerUpdatedAt: "2026-03-20T09:45:00.000Z",
      }),
      evaluatedAt: "2026-03-20T10:00:00.000Z",
    });

    expect(decision).toEqual({
      classification: "changed",
      disposition: "refresh_now",
      reason: "provider_update",
      nextRefreshAt: "2026-03-20T10:00:00.000Z",
    });
  });

  test("uses a one-day card deadline and a seven-day enriched deadline", () => {
    expect(
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry(),
        posting: createPosting({ detailQuality: "card_only" }),
        evaluatedAt: "2026-03-20T10:00:00.000Z",
      }),
    ).toEqual({
      classification: "unchanged",
      disposition: "defer",
      reason: "card_only_ttl",
      nextRefreshAt: "2026-03-21T09:00:00.000Z",
    });
    expect(
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry(),
        posting: createPosting(),
        evaluatedAt: "2026-03-20T10:00:00.000Z",
      }),
    ).toEqual({
      classification: "unchanged",
      disposition: "defer",
      reason: "detail_ttl",
      nextRefreshAt: "2026-03-27T09:05:00.000Z",
    });
  });

  test("refreshes expired evidence but never schedules handled listings", () => {
    expect(
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry(),
        posting: createPosting(),
        evaluatedAt: "2026-03-28T09:05:00.000Z",
      }),
    ).toEqual({
      classification: "unchanged",
      disposition: "refresh_now",
      reason: "detail_ttl",
      nextRefreshAt: "2026-03-28T09:05:00.000Z",
    });
    expect(
      createDiscoveryRefreshDecision({
        ledgerEntry: createLedgerEntry({ latestStatus: "applied" }),
        posting: createPosting({ title: "Senior Software Engineer" }),
        evaluatedAt: "2026-03-28T09:05:00.000Z",
      }),
    ).toEqual({
      classification: "changed",
      disposition: "do_not_refresh",
      reason: "handled_listing",
      nextRefreshAt: null,
    });
  });
});
