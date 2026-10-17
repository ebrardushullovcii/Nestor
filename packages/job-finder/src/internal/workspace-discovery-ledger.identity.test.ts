import { JobPostingSchema, type JobPosting } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  findDiscoveryLedgerEntry,
  recordDiscoveredPostingInLedger,
} from "./workspace-discovery-ledger";

function posting(overrides: Partial<JobPosting> = {}): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "linkedin_5112809008",
    discoveryMethod: "browser_agent",
    collectionMethod: "listing_route",
    canonicalUrl:
      "https://www.linkedin.com/jobs/view/senior-engineer-5112809008",
    applicationUrl:
      "https://job-boards.greenhouse.io/acme/jobs/5112809008?gh_src=linkedin",
    title: "Senior Software Engineer",
    company: "Acme",
    location: "Remote - United States",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: "2026-08-08T12:30:00.000Z",
    postedAtText: "8 Aug 2026",
    discoveredAt: "2026-08-09T10:00:00.000Z",
    salaryText: null,
    detailQuality: "card_only",
    description: "Build customer-facing software.",
    ...overrides,
  });
}

describe("discovery ledger shared job identity", () => {
  test("persists the application identity and reuses it for aggregator-to-ATS rediscovery", () => {
    const aggregator = posting();
    const firstLedger = recordDiscoveredPostingInLedger({
      ledger: [],
      posting: aggregator,
      targetId: "target_linkedin",
      seenAt: aggregator.discoveredAt,
      status: "seen",
    });
    const ats = posting({
      sourceJobId: "5112809008",
      collectionMethod: "api",
      canonicalUrl: "https://job-boards.greenhouse.io/acme/jobs/5112809008",
      applicationUrl:
        "https://job-boards.greenhouse.io/acme/jobs/5112809008?utm_source=direct",
      providerKey: "greenhouse",
      providerBoardToken: "acme",
      providerIdentifier: "acme",
    });

    expect(firstLedger[0]).toMatchObject({
      applicationUrl: aggregator.applicationUrl,
      location: aggregator.location,
      postedAt: aggregator.postedAt,
      postedAtText: aggregator.postedAtText,
    });
    expect(findDiscoveryLedgerEntry(firstLedger, ats)?.id).toBe(
      firstLedger[0]?.id,
    );

    const refreshedLedger = recordDiscoveredPostingInLedger({
      ledger: firstLedger,
      posting: ats,
      targetId: "target_greenhouse",
      seenAt: "2026-08-09T10:05:00.000Z",
      status: "seen",
    });
    expect(refreshedLedger).toHaveLength(1);
    expect(refreshedLedger[0]?.id).toBe(firstLedger[0]?.id);
  });

  test("does not collapse separate openings that only share title, company, location, and date", () => {
    const first = posting({
      sourceJobId: "opening-a",
      canonicalUrl: "https://careers.acme.test/jobs/opening-a",
      applicationUrl: "https://careers.acme.test/jobs/opening-a/apply",
    });
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [],
      posting: first,
      targetId: "target_acme",
      seenAt: first.discoveredAt,
      status: "seen",
    });
    const second = posting({
      sourceJobId: "opening-b",
      canonicalUrl: "https://careers.acme.test/jobs/opening-b",
      applicationUrl: "https://careers.acme.test/jobs/opening-b/apply",
    });

    expect(findDiscoveryLedgerEntry(ledger, second)).toBeNull();
    expect(
      recordDiscoveredPostingInLedger({
        ledger,
        posting: second,
        targetId: "target_acme",
        seenAt: "2026-08-09T10:05:00.000Z",
        status: "seen",
      }),
    ).toHaveLength(2);
  });
});
