import { describe, expect, it } from "vitest";
import type { SavedJob } from "@nestor/contracts";
import {
  compareDiscoveryFitTieBreaks,
  compareDiscoveryJobs,
  getClearMismatchPenalty,
} from "@nestor/job-finder/discovery-ordering";
import {
  compareDiscoveryFitOrder,
  compareDiscoveryResults,
  DISCOVERY_RESULTS_DEFAULT_SORT,
} from "./discovery-results-sort";

type Recommendation = SavedJob["matchAssessment"]["recommendation"];
type DetailQuality = NonNullable<SavedJob["detailQuality"]>;
type RoleSuitabilityState =
  SavedJob["matchAssessment"]["dimensions"]["roleSuitability"]["state"];

interface JobSeed {
  company: string;
  detailQuality: DetailQuality;
  discoveredAt: string;
  firstSeenAt: string | null;
  id: string;
  postedAt: string | null;
  providerUpdatedAt: string | null;
  recommendation: Recommendation;
  roleSuitability: RoleSuitabilityState;
  score: number;
  title: string;
}

function buildJob(seed: JobSeed): SavedJob {
  return {
    company: seed.company,
    detailQuality: seed.detailQuality,
    discoveredAt: seed.discoveredAt,
    firstSeenAt: seed.firstSeenAt,
    id: seed.id,
    postedAt: seed.postedAt,
    providerUpdatedAt: seed.providerUpdatedAt,
    title: seed.title,
    matchAssessment: {
      recommendation: seed.recommendation,
      score: seed.score,
      dimensions: {
        roleSuitability: { state: seed.roleSuitability },
      },
    },
  } as unknown as SavedJob;
}

// mulberry32: tiny deterministic PRNG so every run explores the same space.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCORES = [95, 90, 85, 85, 80, 80, 80, 70] as const;
const RECOMMENDATIONS: readonly Recommendation[] = [
  "strong_fit",
  "review_before_applying",
  "skip",
  "apply_with_original",
];
const DETAIL_TIERS: readonly DetailQuality[] = [
  "card_only",
  "partial_detail",
  "detail_enriched",
];
const SUITABILITY_STATES: readonly RoleSuitabilityState[] = [
  "unknown",
  "exact",
  "adjacent",
  "conflict",
];
const TITLES = [
  "Senior Engineer",
  "senior engineer",
  "Développeur Sénior",
  "工程师",
  "İstanbul Platform Roles",
  "🚀 Platform Engineer",
] as const;
const COMPANIES = ["Acme", "acme", "Café Works", "北辰集团", "İş Bul"] as const;

function pick<T>(values: readonly T[], index: number): T {
  return values[index % values.length]!;
}

function buildCandidateSet(): SavedJob[] {
  const random = createRandom(20260823);
  return Array.from({ length: 48 }, (_, index) => {
    const pickDate = (): string | null => {
      const roll = random();
      if (roll < 0.15) return null;
      if (roll < 0.25) return "not-a-date";
      const day = 1 + Math.floor(random() * 28);
      return `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;
    };
    return buildJob({
      company: pick(COMPANIES, index),
      detailQuality: pick(DETAIL_TIERS, index),
      // Invalid dates must never crash the chain; they collapse to undated.
      discoveredAt:
        index % 17 === 0
          ? "also-not-a-date"
          : `2026-08-${String((index % 28) + 1).padStart(2, "0")}T09:00:00.000Z`,
      firstSeenAt: index % 3 === 0 ? pickDate() : null,
      id: `job-${String(index).padStart(2, "0")}`,
      postedAt: index % 2 === 0 ? pickDate() : null,
      providerUpdatedAt: index % 5 === 0 ? pickDate() : null,
      // Skips deliberately get top scores so mismatch-sinking is observable.
      recommendation: index % 7 === 0 ? "skip" : pick(RECOMMENDATIONS, index),
      roleSuitability: pick(SUITABILITY_STATES, index),
      score: pick(SCORES, index),
      title: pick(TITLES, index),
    });
  });
}

function screenOrder(jobs: readonly SavedJob[]): string[] {
  return [...jobs].sort(compareDiscoveryFitOrder).map((job) => job.id);
}

function panelOrder(
  jobs: readonly SavedJob[],
  sort = DISCOVERY_RESULTS_DEFAULT_SORT,
): string[] {
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
    .map((entry) => entry.job.id);
}

describe("discovery ordering parity", () => {
  it("binds the renderer Best-match name to the exact shared comparator", () => {
    expect(compareDiscoveryFitOrder).toBe(compareDiscoveryJobs);
  });

  it("produces identical Best-match sequences through package and renderer paths across permutations", () => {
    const candidates = buildCandidateSet();
    const canonical = [...candidates]
      .sort(compareDiscoveryJobs)
      .map((job) => job.id);
    expect(screenOrder(candidates)).toEqual(canonical);
    expect(panelOrder(candidates)).toEqual(canonical);

    const random = createRandom(97);
    for (let shuffle = 0; shuffle < 12; shuffle += 1) {
      const permuted = [...candidates];
      for (let i = permuted.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [permuted[i], permuted[j]] = [permuted[j]!, permuted[i]!];
      }
      const order = [...permuted]
        .sort(compareDiscoveryJobs)
        .map((job) => job.id);
      expect(order).toEqual(canonical);
      expect(screenOrder(permuted)).toEqual(canonical);
      expect(panelOrder(permuted)).toEqual(canonical);
    }
  });

  it("keeps the shared comparator antisymmetric and reflexive on sampled pairs", () => {
    const candidates = buildCandidateSet();
    const random = createRandom(4242);
    for (let sample = 0; sample < 200; sample += 1) {
      const left = candidates[Math.floor(random() * candidates.length)]!;
      const right = candidates[Math.floor(random() * candidates.length)]!;
      expect(Math.sign(compareDiscoveryJobs(left, right))).toBe(
        -Math.sign(compareDiscoveryJobs(right, left)),
      );
    }
    for (const job of candidates) {
      expect(compareDiscoveryJobs(job, job)).toBe(0);
    }
  });

  it("ranks fit ascending as mismatch sink then score asc then shared tie-breaks", () => {
    const candidates = buildCandidateSet().slice(0, 32);
    const expected = [...candidates].sort((left, right) => {
      const mismatchOrder =
        getClearMismatchPenalty(left) - getClearMismatchPenalty(right);
      if (mismatchOrder !== 0) return mismatchOrder;
      const byScore = right.matchAssessment.score - left.matchAssessment.score;
      if (byScore !== 0) return -byScore;
      return compareDiscoveryFitTieBreaks(left, right);
    });
    expect(panelOrder(candidates, { direction: "asc", field: "fit" })).toEqual(
      expected.map((job) => job.id),
    );
  });

  it("preserves relative order of campaign subsets in both paths", () => {
    const fullCanonical = [...buildCandidateSet()]
      .sort(compareDiscoveryJobs)
      .map((job) => job.id);
    const campaignIds = new Set(["job-03", "job-11", "job-29", "job-42"]);
    const subsetIds = fullCanonical.filter((id) => campaignIds.has(id));

    const subset = buildCandidateSet().filter((job) => campaignIds.has(job.id));
    expect([...subset].sort(compareDiscoveryJobs).map((job) => job.id)).toEqual(
      subsetIds,
    );
    expect(panelOrder(subset)).toEqual(subsetIds);
  });
});

describe("discovery pivot mismatch sinks", () => {
  const reviewable = [
    buildJob({
      company: "Zeta",
      detailQuality: "detail_enriched",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      firstSeenAt: null,
      id: "old_zeta",
      postedAt: "2026-07-01T00:00:00.000Z",
      providerUpdatedAt: null,
      recommendation: "strong_fit",
      roleSuitability: "exact",
      score: 95,
      title: "A role",
    }),
    buildJob({
      company: "Alpha",
      detailQuality: "partial_detail",
      discoveredAt: "2026-02-01T00:00:00.000Z",
      firstSeenAt: null,
      id: "dated_alpha",
      postedAt: "2026-01-01T00:00:00.000Z",
      providerUpdatedAt: null,
      recommendation: "strong_fit",
      roleSuitability: "adjacent",
      score: 90,
      title: "B role",
    }),
  ];
  // The mismatch holds the winning key for every pivot yet must still sink.
  const extremeMismatch = buildJob({
    company: "Aaa",
    detailQuality: "detail_enriched",
    discoveredAt: "2026-03-01T00:00:00.000Z",
    firstSeenAt: null,
    id: "skip_extreme",
    postedAt: "2026-12-31T00:00:00.000Z",
    providerUpdatedAt: null,
    recommendation: "skip",
    roleSuitability: "conflict",
    score: 99,
    title: "C role",
  });
  const entries = [...reviewable, extremeMismatch];

  // Reviewable rows follow each pivot's own direction; the mismatch holds
  // the winning key for every pivot yet still lands last.
  it.each([
    ["asc", "company", ["dated_alpha", "old_zeta", "skip_extreme"]],
    ["desc", "company", ["old_zeta", "dated_alpha", "skip_extreme"]],
    ["asc", "recent", ["dated_alpha", "old_zeta", "skip_extreme"]],
    ["desc", "recent", ["old_zeta", "dated_alpha", "skip_extreme"]],
  ] as const)(
    "sinks clear mismatches under %s %s pivots",
    (direction, field, expected) => {
      expect(panelOrder(entries, { direction, field })).toEqual(expected);
    },
  );

  it("breaks invalid-date partial-detail ties through identity keys in the renderer path", () => {
    const tied = [
      buildJob({
        company: "Acme",
        detailQuality: "partial_detail",
        discoveredAt: "2026-05-01T00:00:00.000Z",
        firstSeenAt: null,
        id: "tie_b",
        postedAt: "not-a-date",
        providerUpdatedAt: null,
        recommendation: "review_before_applying",
        roleSuitability: "unknown",
        score: 77,
        title: "Same Title",
      }),
      buildJob({
        company: "Acme",
        detailQuality: "partial_detail",
        discoveredAt: "2026-05-01T00:00:00.000Z",
        firstSeenAt: null,
        id: "tie_a",
        postedAt: null,
        providerUpdatedAt: "broken-date",
        recommendation: "review_before_applying",
        roleSuitability: "conflict",
        score: 77,
        title: "Same Title",
      }),
    ];

    expect(panelOrder(tied)).toEqual(["tie_a", "tie_b"]);
    expect(panelOrder(tied)).toEqual(
      [...tied].sort(compareDiscoveryJobs).map((job) => job.id),
    );
  });
});
