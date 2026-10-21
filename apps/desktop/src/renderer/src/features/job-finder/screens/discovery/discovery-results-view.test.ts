import {
  fitRecommendationValues,
  SavedJobSchema,
  type JobDiscoveryTarget,
  type JobListRow,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { matchesCollectionSearch } from "../../components/collection-search-toolbar";
import { orderDiscoveryResultsByGroup } from "./discovery-result-groups";
import {
  compareDiscoveryResults,
  type DiscoveryResultsSortDirection,
  type DiscoveryResultsSortField,
} from "./discovery-results-sort";
import {
  getDiscoveryJobSearchValues,
  getDiscoveryResultFacets,
  matchesDiscoveryJobSearch,
  sortDiscoveryResults,
} from "./discovery-results-view";

// mulberry32: a tiny deterministic PRNG so every run checks the same rows.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  "Senior Engineer",
  "Product Designer",
  "Data Analyst",
  "QA Lead",
];
const COMPANIES = ["Acme", "Globex", "Initech", "Umbrella", "Hooli"];
const LOCATIONS = ["Remote", "Berlin, Germany", "Lisbon", "London"];
const RECOMMENDATIONS = [
  "strong_fit",
  "review_before_applying",
  "skip",
  "apply_with_original",
] as const;

function createRows(count: number, seed = 7): JobListRow[] {
  const random = createRandom(seed);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)]!;
  return Array.from({ length: count }, (_, index) => {
    const score = 20 + Math.floor(random() * 80);
    const judged = random() > 0.3;
    const dated = random() > 0.25;
    const activity =
      random() > 0.7
        ? {
            status: "active" as const,
            observedAt: "2026-09-10T10:00:00.000Z",
            evidence: "last_seen_at" as const,
          }
        : { status: "unknown" as const };
    const job = SavedJobSchema.parse({
      id: `view_job_${index.toString().padStart(4, "0")}`,
      source: "target_site",
      sourceJobId: `source_${index}`,
      canonicalUrl: `https://jobs.example.test/roles/${index}`,
      applicationUrl: null,
      title: `${pick(TITLES)} ${index % 7}`,
      company: pick(COMPANIES),
      location: pick(LOCATIONS),
      workMode: random() > 0.5 ? ["remote"] : random() > 0.5 ? [] : ["hybrid"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      postedAt: dated
        ? new Date(
            Date.UTC(2026, 6, 1 + Math.floor(random() * 60)),
          ).toISOString()
        : null,
      discoveredAt: "2026-09-01T10:00:00.000Z",
      salaryText: random() > 0.5 ? "EUR 70,000" : null,
      description: "Synthetic listing.",
      status: random() > 0.9 ? "drafting" : "discovered",
      provenance:
        random() > 0.2
          ? [
              {
                targetId: `target_${index % 3}`,
                adapterKind: "auto",
                resolvedAdapterKind: "target_site",
                startingUrl: `https://board${index % 3}.example.test/jobs`,
                discoveredAt: "2026-09-01T10:00:00.000Z",
              },
            ]
          : [],
      matchAssessment: {
        score,
        recommendation: pick(RECOMMENDATIONS),
        contextFingerprint: judged ? "context" : null,
        postingFingerprint: judged ? "posting" : null,
        ...(judged
          ? {
              judgment: {
                source: "batch",
                judgedAt: "2026-10-02T10:00:00.000Z",
                score,
                recommendation: "review_before_applying",
              },
            }
          : {}),
        reasons: [],
        gaps: [],
      },
    });
    return { ...job, listingActivity: activity } as unknown as JobListRow;
  });
}

const targets = [
  { id: "target_0", label: "Board Zero" },
  { id: "target_1", label: "board one" },
] as unknown as readonly JobDiscoveryTarget[];

/** The panel's previous behavior: filter first, then sort the matches. */
function sortAfterFilter(
  jobs: readonly JobListRow[],
  field: DiscoveryResultsSortField,
  direction: DiscoveryResultsSortDirection,
): JobListRow[] {
  const sort = { direction, field };
  if (direction === "desc" && field === "fit") {
    return orderDiscoveryResultsByGroup(
      [...jobs].sort((left, right) =>
        compareDiscoveryResults(left, right, sort, 0, 0),
      ),
    );
  }
  return jobs
    .map((job, sourceIndex) => ({ job, sourceIndex }))
    .sort((left, right) =>
      compareDiscoveryResults(
        left.job,
        right.job,
        sort,
        left.sourceIndex,
        right.sourceIndex,
      ),
    )
    .map((entry) => entry.job);
}

describe("discovery results view", () => {
  const rows = createRows(400);

  it("matches exactly what the per-value search matched", () => {
    for (const query of [
      "",
      "eng",
      "REMOTE",
      "berlin, ger",
      "strong fit",
      "active",
      "drafting",
      "eur 70",
      "zzz",
      " acme ",
    ]) {
      const normalized = query.trim().toLocaleLowerCase();
      for (const job of rows) {
        expect(matchesDiscoveryJobSearch(job, normalized)).toBe(
          matchesCollectionSearch(query, getDiscoveryJobSearchValues(job)),
        );
      }
    }
  });

  it("never matches across two values", () => {
    const [row] = createRows(1);
    const job = { ...row!, title: "Platform Lead", company: "Zeta" };
    expect(matchesDiscoveryJobSearch(job, "leadzeta")).toBe(false);
    expect(matchesDiscoveryJobSearch(job, "lead")).toBe(true);
  });

  it("filters the sorted list into the same order sorting the matches gave", () => {
    const fields: readonly DiscoveryResultsSortField[] = [
      "fit",
      "recent",
      "company",
    ];
    const directions: readonly DiscoveryResultsSortDirection[] = [
      "desc",
      "asc",
    ];
    const keep = (job: JobListRow) =>
      matchesDiscoveryJobSearch(job, "e") && job.workMode.length > 0;
    for (const field of fields) {
      for (const direction of directions) {
        const sorted = sortDiscoveryResults(rows, field, direction);
        expect(sorted.filter(keep).map((job) => job.id)).toEqual(
          sortAfterFilter(rows.filter(keep), field, direction).map(
            (job) => job.id,
          ),
        );
      }
    }
  });

  it("sorts a collection once per order and keeps the result", () => {
    const first = sortDiscoveryResults(rows, "recent", "desc");
    expect(sortDiscoveryResults(rows, "recent", "desc")).toBe(first);
    expect(sortDiscoveryResults(rows, "fit", "desc")).not.toBe(first);
    expect(sortDiscoveryResults([...rows], "recent", "desc")).not.toBe(first);
  });

  it("offers the facets the collection carries", () => {
    const facets = getDiscoveryResultFacets(rows, targets);
    expect(getDiscoveryResultFacets(rows, targets)).toBe(facets);
    expect(facets.recommendationOptions).toEqual(
      fitRecommendationValues.filter((value) =>
        rows.some((job) => job.matchAssessment.recommendation === value),
      ),
    );
    expect(facets.workModeOptions).toEqual([
      "remote",
      "hybrid",
      "Not specified",
    ]);
    expect(facets.activityOptions).toEqual(["active", "unknown"]);
    expect(facets.sourceOptions).toEqual([
      "board one",
      "Board Zero",
      "board2.example.test",
      "Source unavailable",
    ]);
    const unlabelled = rows.find((job) => (job.provenance ?? []).length === 0)!;
    expect(facets.sourceLabelsByJobId.get(unlabelled.id)).toEqual([
      "Source unavailable",
    ]);
  });

  it("names rows that share title, employer, place and source", () => {
    const [base] = createRows(1, 3);
    const twin = { ...base!, id: "twin" };
    const other = { ...base!, id: "other", location: "Elsewhere" };
    const facets = getDiscoveryResultFacets([base!, twin, other], targets);
    expect([...facets.indistinguishableJobIds].sort()).toEqual(
      [base!.id, "twin"].sort(),
    );
  });

  it("relabels rows when the source list changes", () => {
    const renamed = [
      { id: "target_0", label: "Renamed board" },
    ] as unknown as readonly JobDiscoveryTarget[];
    const job = rows.find(
      (row) => row.provenance?.[0]?.targetId === "target_0",
    )!;
    expect(
      getDiscoveryResultFacets(rows, targets).sourceLabelsByJobId.get(job.id),
    ).toEqual(["Board Zero"]);
    expect(
      getDiscoveryResultFacets(rows, renamed).sourceLabelsByJobId.get(job.id),
    ).toEqual(["Renamed board"]);
  });
});
