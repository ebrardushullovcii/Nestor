import type { DiscoveryLedgerEntry, SavedJob } from "@nestor/contracts";
import { expect, test } from "vitest";

import { createSeed } from "../workspace-service.test-support";
import { projectDiscoveryJobViews } from "./listing-activity";

test("projects 10,000 jobs through one indexed ledger pass", () => {
  const base = createSeed().savedJobs[0]!;
  const jobs: SavedJob[] = [];
  const discoveryLedger: DiscoveryLedgerEntry[] = [];

  for (let index = 0; index < 10_000; index += 1) {
    const id = `listing-${index}`;
    const canonicalUrl = `https://jobs.example.com/${id}`;
    jobs.push({
      ...base,
      id,
      sourceJobId: id,
      canonicalUrl,
      applicationUrl: null,
      lastSeenAt: null,
      lastVerifiedActiveAt: null,
    });
    discoveryLedger.push({
      id: `ledger-${index}`,
      canonicalUrl,
      applicationUrl: null,
      source: base.source,
      sourceJobId: id,
      providerKey: null,
      providerBoardToken: null,
      providerIdentifier: null,
      providerUpdatedAt: null,
      title: base.title,
      company: base.company,
      location: base.location,
      postedAt: base.postedAt,
      postedAtText: base.postedAtText,
      targetId: "target-1",
      collectionMethod: "fallback_search",
      detailQuality: "card_only",
      fingerprints: null,
      firstSeenAt: "2026-08-23T08:00:00.000Z",
      lastSeenAt: "2026-08-23T09:00:00.000Z",
      lastAppliedAt: null,
      lastEnrichedAt: null,
      inactiveAt: "2026-08-23T10:00:00.000Z",
      latestStatus: "inactive",
      titleTriageOutcome: "pass",
      skipReason: null,
    });
  }

  const startedAt = performance.now();
  const views = projectDiscoveryJobViews({
    jobs,
    discoveryLedger,
    listingSignals: [],
  });
  const elapsedMs = performance.now() - startedAt;

  expect(views).toHaveLength(10_000);
  expect(views[0]?.listingActivity.status).toBe("inactive");
  expect(views.at(-1)?.listingActivity.status).toBe("inactive");
  expect(elapsedMs).toBeLessThan(2_000);
});
