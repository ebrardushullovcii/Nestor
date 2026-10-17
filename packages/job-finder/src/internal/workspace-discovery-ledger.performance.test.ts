import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";

import {
  JobPostingSchema,
  type DiscoveryLedgerEntry,
  type JobPosting,
} from "@nestor/contracts";

import {
  createDiscoveryLedgerIndex,
  createDiscoveryListingFingerprints,
} from "./workspace-discovery-ledger";

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

describe("workspace-discovery-ledger performance", () => {
  test("indexes and resolves a 10k-entry ledger within the strict wall budget", () => {
    const ledger = Array.from({ length: 10_000 }, (_, index) =>
      createLedgerEntry({
        id: `ledger_scale_${index}`,
        canonicalUrl: `https://example.com/jobs/scale-${index}`,
        sourceJobId: `scale_${index}`,
        title: `Software Engineer ${index}`,
      }),
    );

    const wallStartedAt = performance.now();
    const cpuStartedAt = process.cpuUsage();
    const index = createDiscoveryLedgerIndex(ledger);
    let resolvedCount = 0;
    for (let entryIndex = 0; entryIndex < ledger.length; entryIndex += 1) {
      const match = index.find({
        canonicalUrl: `https://example.com/jobs/scale-${entryIndex}?utm_source=replay`,
        source: "target_site",
        sourceJobId: `scale_${entryIndex}`,
        providerKey: null,
        providerBoardToken: null,
        providerIdentifier: null,
      });
      if (match?.id === `ledger_scale_${entryIndex}`) {
        resolvedCount += 1;
      }
    }
    const wallDurationMs = performance.now() - wallStartedAt;
    const cpuUsage = process.cpuUsage(cpuStartedAt);
    const cpuDurationMs = (cpuUsage.user + cpuUsage.system) / 1_000;

    console.info("workspace-discovery-ledger-scale", {
      entries: ledger.length,
      resolvedCount,
      wallDurationMs: Math.round(wallDurationMs),
      cpuDurationMs: Math.round(cpuDurationMs),
      wallBudgetMs: 2_000,
    });

    expect(resolvedCount).toBe(10_000);
    expect(wallDurationMs).toBeLessThan(2_000);
  });
});
