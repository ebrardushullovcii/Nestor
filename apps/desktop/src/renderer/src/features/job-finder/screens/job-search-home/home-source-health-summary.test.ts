import { buildDiscoveryCardOnlyEvidenceWarning } from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  extractCardOnlyEvidenceWarning,
  formatDiscoveryRunSourceProblemSummary,
  isCardOnlyEvidenceWarning,
  selectCardOnlyEvidenceNotices,
  selectNewestSettledDiscoveryRun,
  summarizeDiscoveryRunSourceProblems,
  type DiscoveryRunSourceProblemInput,
} from "./home-source-health-summary";

const RAW_ERRORS = [
  "Public provider API collection failed: Lever API request timed out.",
  "Agent discovery stopped after 10 steps. Found 0 jobs.",
  "Unable to open a usable starting URL.",
];

function run(
  sources: readonly {
    targetId: string;
    health: "healthy" | "warning" | "failed" | "cancelled" | "skipped";
    warnings?: readonly string[];
    jobsFound?: number;
  }[],
  overrides: Partial<DiscoveryRunSourceProblemInput> = {},
): DiscoveryRunSourceProblemInput {
  return {
    startedAt: "2026-09-01T10:00:00.000Z",
    state: "completed",
    summary: {
      sourceHealth: sources.map((source) => ({
        health: source.health,
        targetId: source.targetId,
        warnings: source.warnings ?? [],
      })),
    },
    // A source with no recorded count omits the key entirely, exactly as an
    // absent `jobsFound` is modelled — never an explicitly `undefined` value.
    targetExecutions: sources.map((source) => ({
      ...(source.jobsFound === undefined
        ? {}
        : { jobsFound: source.jobsFound }),
      targetId: source.targetId,
    })),
    ...overrides,
  };
}

describe("isCardOnlyEvidenceWarning", () => {
  it("recognizes the canonical card-only evidence warning", () => {
    expect(
      isCardOnlyEvidenceWarning(
        buildDiscoveryCardOnlyEvidenceWarning("Example Board"),
      ),
    ).toBe(true);
    expect(
      isCardOnlyEvidenceWarning(buildDiscoveryCardOnlyEvidenceWarning("")),
    ).toBe(true);
  });

  it("never treats a raw internal error string as product copy", () => {
    for (const error of RAW_ERRORS) {
      expect(isCardOnlyEvidenceWarning(error)).toBe(false);
    }
    expect(isCardOnlyEvidenceWarning("")).toBe(false);
  });

  it("finds the caveat when production joined it onto a partial warning", () => {
    // `agent/discovery.ts` builds this exact shape:
    //   [resolvedPartial.warning, cardOnlyWarning].filter(Boolean).join(" ")
    // and a later stage can append another sentence after it.
    const caveat = buildDiscoveryCardOnlyEvidenceWarning("Example Board");
    const joinedBefore = `Stopped after the page budget. ${caveat}`;
    const joinedBetween = `Stopped after the page budget. ${caveat} The agent runtime was unavailable.`;

    for (const joined of [joinedBefore, joinedBetween]) {
      expect(isCardOnlyEvidenceWarning(joined)).toBe(true);
      // Only the caveat is extracted; the surrounding prose never reaches Home.
      expect(extractCardOnlyEvidenceWarning(joined)).toBe(caveat);
    }
  });

  it("deduplicates identical caveats and drops warnings without one", () => {
    const caveat = buildDiscoveryCardOnlyEvidenceWarning("Example Board");

    expect(
      selectCardOnlyEvidenceNotices([
        RAW_ERRORS[0]!,
        caveat,
        `Stopped after the page budget. ${caveat}`,
        RAW_ERRORS[1]!,
      ]),
    ).toEqual([caveat]);
  });
});

describe("selectNewestSettledDiscoveryRun", () => {
  it("picks the newest non-idle run by startedAt, not array order", () => {
    const newest = selectNewestSettledDiscoveryRun([
      { startedAt: "2026-09-01T09:00:00.000Z", state: "completed" as const },
      { startedAt: "2026-09-01T11:00:00.000Z", state: "failed" as const },
      { startedAt: "2026-09-01T12:00:00.000Z", state: "idle" as const },
    ]);
    expect(newest?.startedAt).toBe("2026-09-01T11:00:00.000Z");
    expect(selectNewestSettledDiscoveryRun([])).toBeNull();
  });
});

describe("summarizeDiscoveryRunSourceProblems", () => {
  it("collapses a 511-source run with 25 problem sources into disjoint counts", () => {
    const sources = [
      ...Array.from({ length: 486 }, (_unused, index) => ({
        health: "healthy" as const,
        targetId: `ok-${index}`,
      })),
      ...Array.from({ length: 18 }, (_unused, index) => ({
        health: "failed" as const,
        targetId: `failed-${index}`,
        warnings: [RAW_ERRORS[index % RAW_ERRORS.length] ?? RAW_ERRORS[0]!],
      })),
      ...Array.from({ length: 4 }, (_unused, index) => ({
        health: "warning" as const,
        jobsFound: 0,
        targetId: `empty-${index}`,
        warnings: ["Collected 0 candidate jobs."],
      })),
      ...Array.from({ length: 3 }, (_unused, index) => ({
        health: "cancelled" as const,
        targetId: `cancelled-${index}`,
        warnings: ["Discovery was cancelled before this target finished."],
      })),
    ];

    const summary = summarizeDiscoveryRunSourceProblems(run(sources));

    expect(summary).not.toBeNull();
    // R11: the three sources the person stopped are their own outcome, not
    // problems, so they are not in this total.
    expect(summary?.total).toBe(22);
    expect(summary?.userStopped).toBe(3);
    // Disjoint by construction: one health state per source, so the group
    // counts must sum exactly to the reported total.
    expect(
      summary?.groups.reduce((total, group) => total + group.count, 0),
    ).toBe(22);
    expect(summary?.groups).toEqual([
      { category: "unreadable", count: 18, label: "couldn't be read" },
      { category: "no_results", count: 4, label: "found nothing" },
    ]);
    expect(formatDiscoveryRunSourceProblemSummary(run(sources))).toBe(
      "You stopped the last search, so 3 sources did not finish. 18 sources had a problem in the last search · 18 couldn't be read. 4 sources found nothing in the last search.",
    );
  });

  // R11: "'1 HEALTHY' badge, and directly beneath it '1 source had a problem
  // in the last search · 1 stopped early' ... I pressed pause myself."
  it("names a stop the person pressed as theirs, never as a source problem", () => {
    const line = formatDiscoveryRunSourceProblemSummary(
      run([
        { health: "healthy", targetId: "ok" },
        {
          health: "cancelled",
          targetId: "stopped",
          warnings: ["Discovery was cancelled before this target finished."],
        },
      ]),
    );

    expect(line).toBe(
      "You stopped the last search, so 1 source did not finish.",
    );
    expect(line).not.toContain("problem");
    expect(line).not.toContain("stopped early");
  });

  it("omits zero categories instead of printing them", () => {
    const line = formatDiscoveryRunSourceProblemSummary(
      run([
        { health: "healthy", targetId: "ok" },
        { health: "failed", targetId: "bad", warnings: [RAW_ERRORS[0]!] },
        { health: "failed", targetId: "bad-2", warnings: [RAW_ERRORS[2]!] },
      ]),
    );

    expect(line).toBe(
      "2 sources had a problem in the last search · 2 couldn't be read",
    );
    expect(line).not.toMatch(/0 /);
  });

  it("uses singular wording for exactly one problem source", () => {
    expect(
      formatDiscoveryRunSourceProblemSummary(
        run([
          { health: "failed", targetId: "bad", warnings: [RAW_ERRORS[1]!] },
        ]),
      ),
    ).toBe("1 source had a problem in the last search · 1 couldn't be read");
  });

  it("returns nothing when the last search had no source problem", () => {
    expect(
      formatDiscoveryRunSourceProblemSummary(
        run([{ health: "healthy", targetId: "ok" }]),
      ),
    ).toBeNull();
    expect(formatDiscoveryRunSourceProblemSummary(null)).toBeNull();
  });

  it("does not invent a Home failure for a completed run with two productive sources", () => {
    const completed = run([
      {
        health: "healthy",
        jobsFound: 50,
        targetId: "we-work-remotely",
      },
      {
        health: "healthy",
        jobsFound: 47,
        targetId: "remote-ok",
        warnings: ["Collection stopped after results stopped changing."],
      },
    ]);

    expect(summarizeDiscoveryRunSourceProblems(completed)).toBeNull();
    expect(formatDiscoveryRunSourceProblemSummary(completed)).toBeNull();
  });

  it("leaves a card-only source to its own line instead of counting it twice", () => {
    const cardOnly = buildDiscoveryCardOnlyEvidenceWarning("Example Board");

    expect(
      formatDiscoveryRunSourceProblemSummary(
        run([
          {
            health: "warning",
            jobsFound: 12,
            targetId: "a",
            warnings: [cardOnly],
          },
        ]),
      ),
    ).toBeNull();
    // A source carrying a real problem alongside it is still counted once.
    expect(
      summarizeDiscoveryRunSourceProblems(
        run([
          {
            health: "failed",
            targetId: "a",
            warnings: [cardOnly, RAW_ERRORS[0]!],
          },
        ]),
      )?.total,
    ).toBe(1);
    // And a caveat joined onto real trouble must not excuse that source: the
    // exclusion is for warnings that are nothing but the caveat.
    expect(
      summarizeDiscoveryRunSourceProblems(
        run([
          {
            health: "warning",
            jobsFound: 12,
            targetId: "a",
            warnings: [`Stopped after the page budget. ${cardOnly}`],
          },
        ]),
      )?.total,
    ).toBe(1);
  });

  it("only claims 'found nothing' when the run recorded an explicit zero", () => {
    expect(
      formatDiscoveryRunSourceProblemSummary(
        run([{ health: "warning", targetId: "a", warnings: ["Slow."] }]),
      ),
    ).toBe(
      "1 source had a problem in the last search · 1 finished with a problem",
    );
  });

  it("does not call a valid empty listing a source problem", () => {
    expect(
      formatDiscoveryRunSourceProblemSummary(
        run([{ health: "warning", targetId: "empty", jobsFound: 0 }]),
      ),
    ).toBe("1 source found nothing in the last search.");
  });
});
