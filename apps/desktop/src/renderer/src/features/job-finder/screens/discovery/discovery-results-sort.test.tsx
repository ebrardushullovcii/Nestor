// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { SavedJob } from "@nestor/contracts";
import {
  compareDiscoveryResults,
  DISCOVERY_RESULTS_DEFAULT_SORT,
  getListingRecencyTimestamp,
  useDiscoveryResultsSort,
} from "./discovery-results-sort";
import { getPostedDateLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import { renderHook } from "@testing-library/react";

function createJob(
  id: string,
  overrides: Partial<{
    company: string;
    discoveredAt: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    postedAt: string | null;
    postedAtText: string | null;
    providerUpdatedAt: string | null;
    recommendation: SavedJob["matchAssessment"]["recommendation"];
    score: number;
    title: string;
  }> = {},
): { index: number; job: SavedJob } {
  return {
    index: Number.parseInt(id, 10),
    job: {
      company: overrides.company ?? "Acme",
      discoveredAt:
        overrides.discoveredAt === undefined
          ? "2026-08-01T10:00:00.000Z"
          : overrides.discoveredAt,
      id,
      firstSeenAt: overrides.firstSeenAt ?? null,
      lastSeenAt: overrides.lastSeenAt ?? null,
      postedAt: overrides.postedAt ?? null,
      postedAtText: overrides.postedAtText ?? null,
      providerUpdatedAt: overrides.providerUpdatedAt ?? null,
      title: overrides.title ?? `Role ${id}`,
      matchAssessment: {
        recommendation: overrides.recommendation ?? "strong_fit",
        score: overrides.score ?? 80,
      },
    } as unknown as SavedJob,
  };
}

function sortEntries(
  entries: readonly { index: number; job: SavedJob }[],
  sort = DISCOVERY_RESULTS_DEFAULT_SORT,
): string[] {
  return entries
    .slice()
    .sort((left, right) =>
      compareDiscoveryResults(
        left.job,
        right.job,
        sort,
        left.index,
        right.index,
      ),
    )
    .map((entry) => entry.job.id);
}

describe("compareDiscoveryResults", () => {
  const entries = [
    createJob("3", { score: 90 }),
    createJob("1", { score: 94 }),
    createJob("2", { score: 94 }),
    createJob("0", { score: 22 }),
  ];

  it("keeps the default fit ranking identical to the incoming order", () => {
    expect(sortEntries(entries)).toEqual(["1", "2", "3", "0"]);
  });

  it("flips fit direction without losing tie stability", () => {
    expect(sortEntries(entries, { direction: "asc", field: "fit" })).toEqual([
      "0",
      "3",
      "1",
      "2",
    ]);
  });

  it.each(["asc", "desc"] as const)(
    "sinks clear mismatches below reviewable jobs for %s fit sorts",
    (direction) => {
      const withMismatch = [
        createJob("4", { recommendation: "skip", score: 99 }),
        createJob("5", { score: 10 }),
      ];
      expect(sortEntries(withMismatch, { direction, field: "fit" })).toEqual([
        "5",
        "4",
      ]);
    },
  );

  it("sorts companies alphabetically and reverses on descending", () => {
    const companies = [
      createJob("7", { company: "northstar", score: 10 }),
      createJob("8", { company: "Acme", score: 90 }),
      createJob("9", { company: "Brunt", score: 50 }),
    ];

    expect(
      sortEntries(companies, { direction: "asc", field: "company" }),
    ).toEqual(["8", "9", "7"]);
    expect(
      sortEntries(companies, { direction: "desc", field: "company" }),
    ).toEqual(["7", "9", "8"]);
  });

  it("breaks company ties by title and equal titles by source order", () => {
    const tied = [
      createJob("12", { company: "Acme", title: "Designer II" }),
      createJob("11", { company: "Acme", title: "Designer I" }),
      createJob("13", { company: "Acme", title: "Designer I" }),
    ];

    expect(sortEntries(tied, { direction: "asc", field: "company" })).toEqual([
      "11",
      "13",
      "12",
    ]);
  });

  it("uses listing-origin dates and keeps undated jobs last in both directions", () => {
    const dated = [
      createJob("20", {
        discoveredAt: "2026-08-23T10:00:00.000Z",
        postedAt: "2026-08-01T10:00:00.000Z",
      }),
      createJob("21", {
        discoveredAt: "2026-08-02T10:00:00.000Z",
        postedAt: "2026-08-12T10:00:00.000Z",
      }),
      createJob("22", {
        discoveredAt: "2026-08-24T10:00:00.000Z",
        firstSeenAt: "2026-08-24T10:00:00.000Z",
        lastSeenAt: "2026-08-25T10:00:00.000Z",
      }),
      createJob("23", {
        providerUpdatedAt: "2026-08-20T09:00:00.000Z",
      }),
    ];

    expect(sortEntries(dated, { direction: "desc", field: "recent" })).toEqual([
      "23",
      "21",
      "20",
      "22",
    ]);
    expect(sortEntries(dated, { direction: "asc", field: "recent" })).toEqual([
      "20",
      "21",
      "23",
      "22",
    ]);
  });

  it("prefers a parseable posted date and otherwise falls back to the provider date", () => {
    expect(
      getListingRecencyTimestamp(
        createJob("30", {
          postedAt: "2026-08-01T10:00:00.000Z",
          providerUpdatedAt: "2026-08-20T10:00:00.000Z",
        }).job,
      ),
    ).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(
      getListingRecencyTimestamp(
        createJob("31", {
          postedAt: "not-a-date",
          providerUpdatedAt: "2026-08-05T10:00:00.000Z",
        }).job,
      ),
    ).toBe(Date.parse("2026-08-05T10:00:00.000Z"));
    expect(
      getListingRecencyTimestamp(
        createJob("32", {
          discoveredAt: "2026-08-23T10:00:00.000Z",
          firstSeenAt: "2026-08-23T10:00:00.000Z",
          lastSeenAt: "2026-08-24T10:00:00.000Z",
          postedAt: "invalid",
          providerUpdatedAt: "also-invalid",
        }).job,
      ),
    ).toBeNull();
  });

  it.each(["asc", "desc"] as const)(
    "preserves canonical source order for equal listing dates when sorting %s",
    (direction) => {
      const tied = [
        createJob("40", { postedAt: "2026-08-10T10:00:00.000Z" }),
        createJob("41", {
          providerUpdatedAt: "2026-08-10T10:00:00.000Z",
        }),
      ];

      expect(sortEntries(tied, { direction, field: "recent" })).toEqual([
        "40",
        "41",
      ]);
    },
  );
});

describe("listing recency versus displayed posted label", () => {
  // The badge shows `postedAtText` verbatim when present, so the newest-sort
  // key must agree with what the row displays: an absolute label sorts by its
  // own instant, and a relative label never gains a fabricated date.
  it.each([
    ["50", { postedAtText: "2026-08-20" }, Date.parse("2026-08-20")],
    ["51", { postedAtText: "Aug 20, 2026" }, Date.parse("Aug 20, 2026")],
  ] as const)(
    "sorts by the exact instant the absolute label %s shows",
    (id, overrides, expected) => {
      const entry = createJob(id, { ...overrides });
      const badge = getPostedDateLabel({
        postedAt: entry.job.postedAt,
        postedAtText: entry.job.postedAtText,
        providerUpdatedAt: entry.job.providerUpdatedAt,
      });

      expect(badge?.label).toBe("Posted");
      expect(getListingRecencyTimestamp(entry.job)).toBe(expected);
    },
  );

  it("keeps a relative label unsorted instead of inventing its instant", () => {
    const relativeOnly = createJob("52", { postedAtText: "3 days ago" });
    const badge = getPostedDateLabel({
      postedAt: null,
      postedAtText: "3 days ago",
      providerUpdatedAt: null,
    });

    expect(badge).toEqual({ label: "Posted", value: "3 days ago" });
    expect(getListingRecencyTimestamp(relativeOnly.job)).toBeNull();
  });

  it("never ranks the three-field case by its hidden provider update", () => {
    // Visible truth: "Posted 3 days ago". Hidden field: providerUpdatedAt.
    // Newest must treat the row as unknown rather than rank it by the field
    // the badge never displays.
    const entry = createJob("54", {
      postedAt: null,
      postedAtText: "3 days ago",
      providerUpdatedAt: "2026-08-24T09:00:00.000Z",
    });

    expect(getListingRecencyTimestamp(entry.job)).toBeNull();
  });

  it("uses the provider date only when no posting-date label exists at all", () => {
    expect(
      getListingRecencyTimestamp(
        createJob("55", {
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
        }).job,
      ),
    ).toBe(Date.parse("2026-08-24T09:00:00.000Z"));
    expect(
      getListingRecencyTimestamp(
        createJob("56", {
          postedAt: "invalid",
          providerUpdatedAt: "2026-08-24T09:00:00.000Z",
        }).job,
      ),
    ).toBe(Date.parse("2026-08-24T09:00:00.000Z"));
  });

  it("orders rows exactly as their visible recency evidence ranks them", () => {
    const entries = [
      createJob("60", { postedAt: "2026-07-01T10:00:00.000Z" }),
      createJob("61", { postedAtText: "2026-08-20" }),
      createJob("62", {
        postedAt: "2026-07-20T10:00:00.000Z",
        postedAtText: "Aug 1, 2026",
      }),
      createJob("63", { postedAtText: "just now" }),
    ];

    // 61's absolute label (Aug 20) outranks the older structured dates; 62
    // follows its own parsed postedAt (Jul 20); 63 has only a relative label
    // and sinks as unknown in both directions.
    expect(
      sortEntries(entries, { direction: "desc", field: "recent" }),
    ).toEqual(["61", "62", "60", "63"]);
    expect(sortEntries(entries, { direction: "asc", field: "recent" })).toEqual(
      ["60", "62", "61", "63"],
    );
  });

  it("sinks the three-field contradiction pair below dated rows in both directions", () => {
    const entries = [
      createJob("70", {
        postedAt: null,
        postedAtText: "2 days ago",
        providerUpdatedAt: "2026-08-24T09:00:00.000Z",
      }),
      // Strictly older visible evidence, but rankable.
      createJob("71", { postedAt: "2026-06-01T10:00:00.000Z" }),
    ];

    for (const direction of ["desc", "asc"] as const) {
      expect(sortEntries(entries, { direction, field: "recent" })).toEqual([
        "71",
        "70",
      ]);
    }
  });
});

describe("useDiscoveryResultsSort", () => {
  it("persists a chosen sort and restores it on the next mount", () => {
    window.localStorage.clear();
    const first = renderHook(() => useDiscoveryResultsSort());
    first.result.current.setSortField("company");
    first.rerender();

    const second = renderHook(() => useDiscoveryResultsSort());
    expect(second.result.current.sort).toEqual({
      direction: "asc",
      field: "company",
    });
    first.unmount();
    second.unmount();
    window.localStorage.clear();
  });

  it("lands on a sensible default direction when switching pivots", () => {
    window.localStorage.clear();
    const mounted = renderHook(() => useDiscoveryResultsSort());

    mounted.result.current.setSortField("company");
    mounted.rerender();
    expect(mounted.result.current.sort).toEqual({
      direction: "asc",
      field: "company",
    });

    mounted.result.current.setSortField("fit");
    mounted.rerender();
    expect(mounted.result.current.sort).toEqual({
      direction: "desc",
      field: "fit",
    });
    mounted.unmount();
    window.localStorage.clear();
  });

  it("ignores corrupted persisted preferences and falls back to fit", () => {
    window.localStorage.setItem(
      "nestor.job-finder.discovery.results-sort.v1",
      JSON.stringify({ direction: "sideways", field: "salary" }),
    );

    const mounted = renderHook(() => useDiscoveryResultsSort());
    expect(mounted.result.current.sort).toEqual(DISCOVERY_RESULTS_DEFAULT_SORT);
    mounted.unmount();
    window.localStorage.clear();
  });
});
