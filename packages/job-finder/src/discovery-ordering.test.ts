import { describe, expect, it } from "vitest";
import type { SavedJob } from "@nestor/contracts";
import {
  compareDiscoveryJobs,
  getDiscoveryListingRecencyKey,
  toSortableListingTime,
  type OrderableDiscoveryJob,
} from "./discovery-ordering";

function recency(input: {
  postedAt?: string | null;
  postedAtText?: string | null;
  providerUpdatedAt?: string | null;
}) {
  return getDiscoveryListingRecencyKey({
    postedAt: input.postedAt ?? null,
    postedAtText: input.postedAtText ?? null,
    providerUpdatedAt: input.providerUpdatedAt ?? null,
  });
}

describe("getDiscoveryListingRecencyKey", () => {
  it("prefers a parsed postedAt over every label and fallback", () => {
    expect(
      recency({
        postedAt: "2026-07-01T10:00:00.000Z",
        postedAtText: "2026-08-20",
        providerUpdatedAt: "2026-08-24T09:00:00.000Z",
      }),
    ).toEqual({
      basis: "postedAt",
      timestamp: Date.parse("2026-07-01T10:00:00.000Z"),
    });
    // A structured posting date also outranks a fresher absolute label.
    expect(
      recency({
        postedAt: "2026-07-01T10:00:00.000Z",
        postedAtText: "Aug 20, 2026",
      }),
    ).toEqual({
      basis: "postedAt",
      timestamp: Date.parse("2026-07-01T10:00:00.000Z"),
    });
  });

  it("accepts an absolute postedAtText only when no parsed postedAt exists", () => {
    const key = recency({
      postedAt: null,
      postedAtText: "2026-08-20",
      providerUpdatedAt: "2026-08-24T09:00:00.000Z",
    });

    // The visible "Posted" badge shows the label text, so newest-sort must
    // follow that exact instant instead of the hidden provider date.
    expect(key).toEqual({
      basis: "postedAtText",
      timestamp: Date.parse("2026-08-20"),
    });
  });

  it("accepts absolute human-readable posted labels", () => {
    for (const text of ["Aug 20, 2026", "20 Aug 2026", " 2026-08-20 "]) {
      const key = recency({ postedAtText: text });
      expect(key.basis).toBe("postedAtText");
      expect(key.timestamp).toBe(Date.parse(text.trim()));
    }
  });

  it("treats a posting-date label that names no instant as fully unknown", () => {
    // The exact contradiction scenario: a relative label must not let newest
    // sort borrow the hidden provider-update time behind "Posted 2 days ago".
    const key = recency({
      postedAt: null,
      postedAtText: "2 days ago",
      providerUpdatedAt: "2026-08-24T09:00:00.000Z",
    });

    expect(key).toEqual({ basis: null, timestamp: Number.NEGATIVE_INFINITY });
  });

  it.each(["2 days ago", "today", "yesterday", "just now", "3 hours ago"])(
    "keeps %s unknown instead of fabricating a date",
    (text) => {
      const key = recency({ postedAtText: text });

      // The relative text contributes no instant of its own and blocks the
      // provider fallback, because the badge visibly claims this label.
      expect(key).toEqual({ basis: null, timestamp: Number.NEGATIVE_INFINITY });
    },
  );

  it("rejects year-less date fragments rather than borrowing the current year", () => {
    for (const text of ["Aug 20", "August 20", "Posted this week"]) {
      expect(recency({ postedAtText: text }).basis).toBeNull();
    }
    // Year-less labels also block the provider fallback.
    expect(
      recency({
        postedAtText: "Aug 20",
        providerUpdatedAt: "2026-08-05T10:00:00.000Z",
      }),
    ).toEqual({ basis: null, timestamp: Number.NEGATIVE_INFINITY });
  });

  it("rejects unparseable and impossible calendar dates", () => {
    for (const text of ["not-a-date", "2026-13-45", "9999-99-99"]) {
      expect(recency({ postedAtText: text }).basis).toBeNull();
    }
  });

  it("uses an unparseable-text job's provider date only via an absent-label skip", () => {
    // No postedAtText at all: the provider fallback is the honest answer and
    // matches the badge's own "Updated" wording.
    expect(
      recency({
        postedAt: "invalid",
        providerUpdatedAt: "2026-08-05T10:00:00.000Z",
      }),
    ).toEqual({
      basis: "providerUpdatedAt",
      timestamp: Date.parse("2026-08-05T10:00:00.000Z"),
    });
  });

  it("falls back to providerUpdatedAt only when no posting-date label exists", () => {
    expect(recency({ postedAt: "2026-08-01T10:00:00.000Z" })).toEqual({
      basis: "postedAt",
      timestamp: Date.parse("2026-08-01T10:00:00.000Z"),
    });
    expect(recency({ providerUpdatedAt: "2026-08-05T10:00:00.000Z" })).toEqual({
      basis: "providerUpdatedAt",
      timestamp: Date.parse("2026-08-05T10:00:00.000Z"),
    });
  });

  it("stays unknown without any absolute source instead of using observation times", () => {
    expect(recency({})).toEqual({
      basis: null,
      timestamp: Number.NEGATIVE_INFINITY,
    });
    expect(
      recency({ postedAtText: "2 days ago", providerUpdatedAt: "broken" }),
    ).toEqual({
      basis: null,
      timestamp: Number.NEGATIVE_INFINITY,
    });
  });

  it("is a pure function of its input", () => {
    const input = {
      postedAt: "2026-08-01T10:00:00.000Z",
      postedAtText: "Aug 1, 2026",
      providerUpdatedAt: "2026-08-05T10:00:00.000Z",
    };

    expect(getDiscoveryListingRecencyKey(input)).toEqual(
      getDiscoveryListingRecencyKey(input),
    );
    // The caller's object is not mutated.
    expect(input.postedAtText).toBe("Aug 1, 2026");
  });

  it("keeps toSortableListingTime semantics as the underlying parser", () => {
    expect(toSortableListingTime(null)).toBe(Number.NEGATIVE_INFINITY);
    expect(toSortableListingTime("nope")).toBe(Number.NEGATIVE_INFINITY);
    expect(toSortableListingTime("2026-08-01T10:00:00.000Z")).toBe(
      Date.parse("2026-08-01T10:00:00.000Z"),
    );
  });
});

describe("closed listings in the default ordering", () => {
  function candidate(
    id: string,
    score: number,
    listingActivity?: OrderableDiscoveryJob["listingActivity"],
  ): OrderableDiscoveryJob {
    return {
      id,
      title: `Engineer ${id}`,
      company: "Example",
      detailQuality: "detail_enriched",
      postedAt: "2026-08-20T10:00:00.000Z",
      firstSeenAt: null,
      discoveredAt: "2026-08-20T10:00:00.000Z",
      matchAssessment: { score, recommendation: "strong_fit", gaps: [] },
      ...(listingActivity ? { listingActivity } : {}),
    } as unknown as OrderableDiscoveryJob;
  }

  it("sinks a closed listing below a lower-scoring open one", () => {
    const closedButStrong = candidate("closed", 91, {
      status: "closed",
      observedAt: "2026-08-20T10:00:00.000Z",
      signalId: "listing-text:closed",
      provenance: "system",
      explanation: "The listing's own text says it is no longer open.",
      detail: null,
      confidence: 1,
    });
    const openButWeaker = candidate("open", 48);

    expect(
      [closedButStrong, openButWeaker].sort(compareDiscoveryJobs)[0]?.id,
    ).toBe("open");
  });

  it("leaves rows without a projection ordered by fit", () => {
    const strong = candidate("strong", 91) as SavedJob;
    const weak = candidate("weak", 48) as SavedJob;

    expect([weak, strong].sort(compareDiscoveryJobs)[0]?.id).toBe("strong");
  });
});

describe("out-of-area on-site listings", () => {
  function reachCandidate(
    id: string,
    score: number,
    locationReach: SavedJob["matchAssessment"]["locationReach"],
    roleSuitability = "exact",
  ): OrderableDiscoveryJob {
    return {
      id,
      title: `Executive Assistant ${id}`,
      company: "Example",
      detailQuality: "detail_enriched",
      postedAt: "2026-08-20T10:00:00.000Z",
      firstSeenAt: null,
      discoveredAt: "2026-08-20T10:00:00.000Z",
      discoveryMethod: "agent_browser",
      matchAssessment: {
        score,
        recommendation: "strong_fit",
        gaps: [],
        locationReach,
        contextFingerprint: "context_fp",
        postingFingerprint: "posting_fp",
        dimensions: { roleSuitability: { state: roleSuitability } },
      },
    } as unknown as OrderableDiscoveryJob;
  }

  it("keeps an on-site out-of-area role below an in-area role of the same title fit", () => {
    const canadianOnsite = reachCandidate("onsite_canada", 66, "outside_area");
    const inArea = reachCandidate("in_area_ohio", 48, "in_area");

    expect(
      [canadianOnsite, inArea].sort(compareDiscoveryJobs).map((job) => job.id),
    ).toEqual(["in_area_ohio", "onsite_canada"]);
  });

  it("keeps an on-site out-of-area role below a remote role of the same title fit", () => {
    const canadianOnsite = reachCandidate("onsite_canada", 66, "outside_area");
    const remote = reachCandidate("remote_us", 48, "remote_preferred");

    expect(
      [canadianOnsite, remote].sort(compareDiscoveryJobs).map((job) => job.id),
    ).toEqual(["remote_us", "onsite_canada"]);
  });

  it("sinks an out-of-reach role below every reachable one", () => {
    // Even an exact title match a person cannot travel to is not the first
    // thing to show them.
    const exactOutside = reachCandidate("exact_outside", 66, "outside_area");
    const adjacentInArea = reachCandidate(
      "adjacent_in_area",
      48,
      "in_area",
      "adjacent",
    );

    expect(
      [exactOutside, adjacentInArea]
        .sort(compareDiscoveryJobs)
        .map((job) => job.id),
    ).toEqual(["adjacent_in_area", "exact_outside"]);
  });

  it("orders two out-of-reach roles against each other by fit", () => {
    const strong = reachCandidate("strong_outside", 66, "outside_area");
    const weak = reachCandidate("weak_outside", 48, "outside_area");

    expect(
      [weak, strong].sort(compareDiscoveryJobs).map((job) => job.id),
    ).toEqual(["strong_outside", "weak_outside"]);
  });

  it("changes nothing when the reach was never recorded", () => {
    const strong = reachCandidate("strong", 91, "unknown");
    const weak = reachCandidate("weak", 48, "unknown");

    expect(
      [weak, strong].sort(compareDiscoveryJobs).map((job) => job.id),
    ).toEqual(["strong", "weak"]);
  });
});

describe("equal displayed fit ordering", () => {
  function tiedCandidate(input: {
    id: string;
    titleFamilyMatch: "same_family" | "adjacent";
    seniorityConflict?: boolean;
    stackOverlap?: string;
    postedAt: string;
  }): SavedJob {
    return {
      id: input.id,
      title: input.id,
      company: "Example",
      detailQuality: "detail_enriched",
      discoveryMethod: "agent_browser",
      postedAt: input.postedAt,
      firstSeenAt: null,
      discoveredAt: input.postedAt,
      matchAssessment: {
        score: 54,
        recommendation: "review_before_applying",
        titleFamilyMatch: input.titleFamilyMatch,
        contextFingerprint: "context_fp",
        postingFingerprint: `posting_${input.id}`,
        reasons: input.stackOverlap
          ? [`Stack overlap includes ${input.stackOverlap}.`]
          : [],
        gaps: input.seniorityConflict
          ? [
              "The listing seniority conflicts with the saved seniority preferences.",
            ]
          : [],
      },
    } as unknown as SavedJob;
  }

  it("breaks a 54 percent tie by the model's role verdict, then recency", () => {
    const jobs = [
      tiedCandidate({
        id: "adjacent",
        titleFamilyMatch: "adjacent",
        postedAt: "2026-09-13",
      }),
      tiedCandidate({
        id: "older-exact",
        titleFamilyMatch: "same_family",
        postedAt: "2026-09-10",
      }),
      tiedCandidate({
        id: "newer-exact",
        titleFamilyMatch: "same_family",
        postedAt: "2026-09-12",
      }),
    ];

    expect(jobs.sort(compareDiscoveryJobs).map((job) => job.id)).toEqual([
      "newer-exact",
      "older-exact",
      "adjacent",
    ]);
  });

  it("sorts assessments that carry no gaps or reasons list at all", () => {
    // Assessments recorded before these fields existed (and any caller that
    // skipped schema parsing, which is how renderer fixtures reach the
    // comparator) arrive without them; ordering must read each as an empty
    // list instead of throwing while the list is being sorted.
    const withoutGaps = tiedCandidate({
      id: "no-gaps",
      titleFamilyMatch: "same_family",
      postedAt: "2026-09-12",
    });
    delete (
      withoutGaps.matchAssessment as { gaps?: unknown; reasons?: unknown }
    ).gaps;
    delete (
      withoutGaps.matchAssessment as { gaps?: unknown; reasons?: unknown }
    ).reasons;

    const jobs = [
      tiedCandidate({
        id: "seniority-conflict",
        titleFamilyMatch: "same_family",
        seniorityConflict: true,
        postedAt: "2026-09-13",
      }),
      withoutGaps,
    ];

    expect(() => jobs.sort(compareDiscoveryJobs)).not.toThrow();
    // Equal verdicts: the newer listing leads.
    expect(jobs.map((job) => job.id)).toEqual([
      "seniority-conflict",
      "no-gaps",
    ]);
  });
});

it("puts model-judged jobs above unjudged listings even when an old unjudged score was higher", () => {
  const unjudged = {
    id: "unread",
    title: "Overseas unrelated role",
    company: "Synthetic",
    matchAssessment: {
      score: 99,
      recommendation: "strong_fit",
      judgment: null,
    },
  } as SavedJob;
  const judged = {
    ...unjudged,
    id: "judged",
    title: "UK data engineer",
    matchAssessment: {
      ...unjudged.matchAssessment,
      score: 84,
      judgment: { source: "batch" },
    },
  } as SavedJob;
  expect(compareDiscoveryJobs(judged, unjudged)).toBeLessThan(0);
});
