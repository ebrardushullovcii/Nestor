import { describe, expect, it } from "vitest";
import type { SavedJob } from "@nestor/contracts";
import { createSavedJob } from "../workspace-service.test-fixtures";
import {
  countDiscoveryListingCapture,
  describeDiscoveryListingCapture,
  getSavedJobListingCaptureState,
} from "./discovery-listing-capture";

function job(overrides: Partial<SavedJob> = {}): SavedJob {
  return createSavedJob({
    id: "job_capture",
    source: "target_site",
    sourceJobId: "1",
    discoveryMethod: "browser_agent",
    canonicalUrl: "https://jobs.example.test/1",
    applicationUrl: null,
    title: "Executive Assistant",
    company: "Example Co",
    location: "Chicago, IL",
    workMode: [],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-09-05T09:58:00.000Z",
    firstSeenAt: "2026-09-05T09:58:00.000Z",
    lastSeenAt: "2026-09-05T09:58:00.000Z",
    lastVerifiedActiveAt: null,
    salaryText: null,
    summary: null,
    description: "Executive Assistant",
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    keywordSignals: [],
    benefits: [],
    status: "discovered",
    matchAssessment: { score: 48, reasons: [], gaps: [] },
    provenance: [],
    ...overrides,
  } as Parameters<typeof createSavedJob>[0]);
}

describe("getSavedJobListingCaptureState", () => {
  it("reports a card-only job nobody has read as not attempted", () => {
    expect(getSavedJobListingCaptureState(job())).toBe("not_attempted");
  });

  it("reports a job whose body was read as captured", () => {
    expect(
      getSavedJobListingCaptureState(
        job({
          detailQuality: "detail_enriched",
          description: "A long listing body ".repeat(30),
        }),
      ),
    ).toBe("captured");
  });

  it("reports an attempted read that yielded nothing as blocked, not as unread", () => {
    expect(
      getSavedJobListingCaptureState(
        job({
          listingDetailFetch: {
            attemptedAt: "2026-09-05T10:00:00.000Z",
            outcome: "blocked",
            method: null,
            detail: "The page wants a signed-in visitor.",
          },
        }),
      ),
    ).toBe("blocked");
  });

  it("re-derives the state for a row stored before the field existed", () => {
    const stored = job({
      listingDetailFetch: {
        attemptedAt: "2026-09-05T10:00:00.000Z",
        outcome: "fetch_failed",
        method: null,
        detail: "The page did not respond in time.",
      },
    });
    expect(
      getSavedJobListingCaptureState({
        ...stored,
        listingDetailCapture: { state: "not_attempted", textHash: null },
      }),
    ).toBe("blocked");
  });
});

describe("describeDiscoveryListingCapture", () => {
  it("states every kept job's capture state, naming refusals and the backlog separately", () => {
    const counts = countDiscoveryListingCapture([
      job({
        detailQuality: "detail_enriched",
        description: "A long listing body ".repeat(30),
      }),
      job({
        id: "job_blocked",
        listingDetailFetch: {
          attemptedAt: "2026-09-05T10:00:00.000Z",
          outcome: "blocked",
          method: null,
          detail: "The page wants a signed-in visitor.",
        },
      }),
      job({ id: "job_pending" }),
    ]);
    expect(counts).toEqual({
      blocked: 1,
      captured: 1,
      notAttempted: 1,
      total: 3,
    });
    expect(describeDiscoveryListingCapture(counts)).toBe(
      "Read the full listing for 1 of 3 kept jobs; 1 listing page gave nothing to read; 1 is still to read on the next search.",
    );
  });

  it("says so plainly when there was nothing to read", () => {
    expect(
      describeDiscoveryListingCapture(countDiscoveryListingCapture([])),
    ).toBe("No jobs were kept, so there was nothing to read.");
  });

  it("counts a rate-limited page as still to read, not as one that gave nothing", () => {
    const counts = countDiscoveryListingCapture([
      job({
        id: "job_rate_limited",
        listingDetailFetch: {
          attemptedAt: "2026-09-05T10:00:00.000Z",
          outcome: "blocked",
          method: null,
          detail: "The site asked Job Finder to slow down (HTTP 429).",
          retryAfterAt: "2026-09-05T10:00:02.000Z",
        },
      }),
    ]);
    expect(counts).toMatchObject({ blocked: 0, notAttempted: 1 });
  });
});
