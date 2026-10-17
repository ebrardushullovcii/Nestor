import { describe, expect, test } from "vitest";
import type { JobPosting } from "@nestor/contracts";

import { createSeed } from "../workspace-service.test-fixtures";
import { selectDiscoveryBudgetPostings } from "./workspace-discovery-methods";

const seed = createSeed();
const basePosting = seed.savedJobs[0]!;
const constantAssessment = basePosting.matchAssessment;

function makePosting(input: {
  sourceJobId: string;
  title: string;
  postedAt: string | null;
  postedAtText: string | null;
  providerUpdatedAt: string | null;
  firstSeenAt: string | null;
  discoveredAt: string;
  canonicalUrl?: string;
}): JobPosting {
  return {
    ...basePosting,
    sourceJobId: input.sourceJobId,
    title: input.title,
    canonicalUrl: input.canonicalUrl ?? basePosting.canonicalUrl,
    postedAt: input.postedAt,
    postedAtText: input.postedAtText,
    providerUpdatedAt: input.providerUpdatedAt,
    firstSeenAt: input.firstSeenAt,
    discoveredAt: input.discoveredAt,
  };
}

function selectIds(input: {
  postings: JobPosting[];
  preferredCanonicalUrls?: readonly string[];
}): string[] {
  return selectDiscoveryBudgetPostings({
    postings: input.postings,
    profile: seed.profile,
    searchPreferences: seed.searchPreferences,
    limit: input.postings.length,
    ...(input.preferredCanonicalUrls
      ? { preferredCanonicalUrls: input.preferredCanonicalUrls }
      : {}),
    assessPosting: () => constantAssessment,
  }).map((posting) => posting.sourceJobId);
}

describe("selectDiscoveryBudgetPostings recency parity", () => {
  test("uses the structured postedAt instant instead of its own label, provider date, or observation time", () => {
    // Both postings expose a fresher label, provider date, and observation time
    // than their structured postedAt; the postedAt instant must still win.
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "structured_older",
          title: "Product Designer A",
          postedAt: "2026-08-20T10:00:00.000Z",
          postedAtText: "Aug 25, 2026",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-26T10:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "structured_newer",
          title: "Product Designer B",
          postedAt: "2026-08-21T10:00:00.000Z",
          postedAtText: "Aug 19, 2026",
          providerUpdatedAt: "2026-08-19T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-19T10:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["structured_newer", "structured_older"]);
  });

  test("ranks an absolute postedAtText at the label instant instead of the hidden provider date", () => {
    // The visible label is Aug 21 vs Aug 20, but the hidden provider-update
    // date is Aug 24 for both. If the label were ignored (provider date or
    // index order), the earlier-index posting would win instead.
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "labeled_older",
          title: "Product Designer A",
          postedAt: null,
          postedAtText: "Aug 20, 2026",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-25T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "labeled_newer",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: "Aug 21, 2026",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-25T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["labeled_newer", "labeled_older"]);
  });

  test("falls back to providerUpdatedAt only when no posting-date label exists", () => {
    // The no-label posting uses its Aug 24 provider date. The labeled posting
    // has the same hidden provider date but must sort at the visible Aug 22
    // label instead.
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "provider_fallback",
          title: "Product Designer A",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-19T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "labeled_older",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: "Aug 22, 2026",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-25T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["provider_fallback", "labeled_older"]);
  });

  test("keeps a relative label from borrowing the provider date and uses the observation time", () => {
    // The relative label's hidden provider date (Aug 24) is the freshest value
    // on the first posting; it must not rank above the second posting, whose
    // observation time (Aug 20) is newer than the first's (Aug 19).
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "relative_label",
          title: "Product Designer A",
          postedAt: null,
          postedAtText: "2 days ago",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-19T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "observed_newer",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-20T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["observed_newer", "relative_label"]);
  });

  test("uses firstSeenAt before discoveredAt after the shared key is unknown", () => {
    // The relative label names no instant, so firstSeenAt (Aug 21) outranks
    // the other posting's discoveredAt (Aug 20) even though the provider date
    // behind the relative label is the freshest value present.
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "relative_with_seen",
          title: "Product Designer A",
          postedAt: null,
          postedAtText: "3 hours ago",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: "2026-08-21T09:00:00.000Z",
          discoveredAt: "2026-08-19T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "observed_older",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-20T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["relative_with_seen", "observed_older"]);
  });

  test("treats an unparseable postedAt as absent while an absolute label still beats the provider date", () => {
    // PostedAt is invalid for both. The first has no label, so its provider
    // date (Aug 21) is the honest key; the second has an absolute label
    // (Aug 20) that must win over its fresher hidden provider date (Aug 24)
    // and its observation time (Aug 25).
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "invalid_posted_no_label",
          title: "Product Designer A",
          postedAt: "not-a-date",
          postedAtText: null,
          providerUpdatedAt: "2026-08-21T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-19T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "invalid_posted_labeled",
          title: "Product Designer B",
          postedAt: "not-a-date",
          postedAtText: "Aug 20, 2026",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-25T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual([
      "invalid_posted_no_label",
      "invalid_posted_labeled",
    ]);
  });

  test("blocks the provider fallback for year-less labels and sorts by observation time", () => {
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "yearless_label",
          title: "Product Designer A",
          postedAt: null,
          postedAtText: "Aug 20",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          firstSeenAt: null,
          discoveredAt: "2026-08-19T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "observed_newer",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-20T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["observed_newer", "yearless_label"]);
  });

  test("falls back to discoveredAt when no label or provider date exists at all", () => {
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "observed_older",
          title: "Product Designer A",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-24T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "observed_newer",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-25T09:00:00.000Z",
        }),
      ],
    });

    expect(selected).toEqual(["observed_newer", "observed_older"]);
  });

  test("keeps the preferred-source tie-break ahead of recency", () => {
    const preferredUrl = "https://example.com/jobs/preferred-recently-discovered";
    const selected = selectIds({
      postings: [
        makePosting({
          sourceJobId: "preferred_older",
          title: "Product Designer A",
          canonicalUrl: preferredUrl,
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-19T09:00:00.000Z",
        }),
        makePosting({
          sourceJobId: "non_preferred_newer",
          title: "Product Designer B",
          postedAt: null,
          postedAtText: null,
          providerUpdatedAt: null,
          firstSeenAt: null,
          discoveredAt: "2026-08-25T09:00:00.000Z",
        }),
      ],
      preferredCanonicalUrls: [preferredUrl],
    });

    expect(selected).toEqual(["preferred_older", "non_preferred_newer"]);
  });
});
