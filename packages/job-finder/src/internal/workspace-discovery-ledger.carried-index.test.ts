import { expect, test, vi } from "vitest";

import {
  DiscoveryLedgerEntrySchema,
  JobPostingSchema,
} from "@nestor/contracts";

import type * as JobIdentity from "./job-identity";
import { createJobIdentityIndex } from "./job-identity";
import {
  createDiscoveryListingFingerprints,
  findDiscoveryLedgerEntry,
} from "./workspace-discovery-ledger";

vi.mock("./job-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof JobIdentity>();
  return {
    ...actual,
    createJobIdentityIndex: vi.fn(actual.createJobIdentityIndex),
  };
});
const build = vi.mocked(createJobIdentityIndex);

function entry(index: number, status: "seen" | "skipped" = "seen") {
  const posting = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: `job_${index}`,
    discoveryMethod: "browser_agent",
    collectionMethod: "careers_page",
    canonicalUrl: `https://example.com/jobs/job-${index}`,
    applicationUrl: null,
    title: `Engineer ${index}`,
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: "2026-03-19T09:00:00.000Z",
    discoveredAt: "2026-03-20T09:00:00.000Z",
    detailQuality: "card_only",
    salaryText: "$150,000",
    summary: `Role ${index}`,
    description: `Role ${index}`,
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    benefits: [],
  });
  const ledgerEntry = DiscoveryLedgerEntrySchema.parse({
    id: `ledger_${index}`,
    canonicalUrl: posting.canonicalUrl,
    applicationUrl: null,
    source: posting.source,
    sourceJobId: posting.sourceJobId,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    providerUpdatedAt: null,
    title: posting.title,
    company: posting.company,
    location: posting.location,
    postedAt: posting.postedAt,
    postedAtText: null,
    targetId: "target_one",
    collectionMethod: posting.collectionMethod,
    detailQuality: posting.detailQuality,
    fingerprints: createDiscoveryListingFingerprints(posting),
    firstSeenAt: "2026-03-20T09:00:00.000Z",
    lastSeenAt: "2026-03-20T09:00:00.000Z",
    lastAppliedAt: null,
    lastEnrichedAt: null,
    inactiveAt: null,
    latestStatus: status,
    skipReason: status === "skipped" ? "hidden" : null,
  });
  return Object.freeze(ledgerEntry);
}

const identity = (index: number) => ({
  canonicalUrl: `https://example.com/jobs/job-${index}`,
  source: "target_site",
  sourceJobId: `job_${index}`,
  providerKey: null,
  providerBoardToken: null,
  providerIdentifier: null,
});

test("a stored ledger that changed a few entries reuses the last index instead of rebuilding it", () => {
  const first = Object.freeze(
    Array.from({ length: 300 }, (_, index) => entry(index)),
  );
  build.mockClear();
  expect(findDiscoveryLedgerEntry(first, identity(5))).toBe(first[5]);
  expect(build).toHaveBeenCalledOnce();

  // What storage hands back after hiding job 5: the same frozen values,
  // job 5 replaced by its new entry, and one entry gone and one added.
  const hidden = entry(5, "skipped");
  const second = Object.freeze([
    ...first.slice(0, 5),
    ...first.slice(6, 299),
    hidden,
    entry(300),
  ]);
  build.mockClear();

  expect(findDiscoveryLedgerEntry(second, identity(5))).toBe(hidden);
  expect(findDiscoveryLedgerEntry(second, identity(300))?.id).toBe(
    "ledger_300",
  );
  expect(findDiscoveryLedgerEntry(second, identity(299))).toBeNull();
  expect(findDiscoveryLedgerEntry(second, identity(42))).toBe(first[42]);
  expect(build).not.toHaveBeenCalled();

  // The earlier ledger gave its index away; looked up again it takes the
  // index back and still answers exactly for its own entries.
  expect(findDiscoveryLedgerEntry(first, identity(299))).toBe(first[299]);
  expect(findDiscoveryLedgerEntry(first, identity(5))).toBe(first[5]);
  expect(findDiscoveryLedgerEntry(first, identity(300))).toBeNull();
  expect(build).not.toHaveBeenCalled();

  // A ledger that changed too much is indexed afresh.
  const rebuilt = Object.freeze(
    Array.from({ length: 300 }, (_, index) => entry(index + 1_000)),
  );
  expect(findDiscoveryLedgerEntry(rebuilt, identity(1_005))?.id).toBe(
    "ledger_1005",
  );
  expect(build).toHaveBeenCalledOnce();
});
