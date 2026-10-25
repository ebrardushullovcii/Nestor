import type {
  DiscoveryActivityEvent,
  DiscoveryRunRecord,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  formatDiscoveryResultBandLabel,
  formatDiscoveryResultBandTotal,
  formatDiscoveryRunCountLabel,
  formatLastSearchSummarySentence,
  formatSearchFinishedStatusLine,
  getDiscoveryRunCountEvidence,
} from "./discovery-run-count-label";

function createRun(
  summary: Partial<DiscoveryRunRecord["summary"]> = {},
): DiscoveryRunRecord {
  return {
    id: "run_1",
    state: "completed",
    startedAt: "2026-08-25T10:00:00.000Z",
    completedAt: "2026-08-25T10:01:00.000Z",
    targetIds: ["source_a"],
    targetExecutions: [],
    activity: [],
    summary: {
      targetsPlanned: 1,
      targetsCompleted: 1,
      validJobsFound: 0,
      durationMs: 60_000,
      ...summary,
    },
  } as unknown as DiscoveryRunRecord;
}

function createEvent(
  overrides: Partial<DiscoveryActivityEvent> = {},
): DiscoveryActivityEvent {
  return {
    id: "event_1",
    runId: "run_1",
    timestamp: "2026-08-25T10:00:30.000Z",
    kind: "progress",
    stage: "scoring",
    message: "Scoring matches",
    ...overrides,
  } as unknown as DiscoveryActivityEvent;
}

function formatLabel(distinctJobsRetained: number, duplicatesMerged: number) {
  return formatDiscoveryRunCountLabel({
    distinctJobsRetained,
    duplicatesMerged,
  });
}

describe("formatDiscoveryRunCountLabel", () => {
  it("shows zero retained without inventing volume", () => {
    expect(formatLabel(0, 0)).toBe("0 new jobs saved");
  });

  it("uses singular phrasing for exactly one kept job", () => {
    expect(formatLabel(1, 0)).toBe("1 new job saved");
  });

  it("uses plural phrasing for several kept jobs", () => {
    expect(formatLabel(4, 0)).toBe("4 new jobs saved");
  });

  it("displays the distinct count directly instead of subtracting duplicates", () => {
    // Regression: the summary's distinct total must never lose the duplicate
    // counter again (the old label claimed "34 unique retained").
    const label = formatLabel(67, 33);

    expect(label).toBe("67 new jobs saved · 33 duplicates merged");
    expect(label).not.toContain("34");
    expect(label).not.toMatch(/\bfound\b/i);
  });

  it("uses singular duplicate phrasing for one merged listing", () => {
    expect(formatLabel(2, 1)).toBe("2 new jobs saved · 1 duplicate merged");
  });

  it("keeps duplicate context on a run that kept nothing new", () => {
    const label = formatLabel(0, 15);

    expect(label).toBe("0 new jobs saved · 15 duplicates merged");
    expect(label).not.toMatch(/\bfound\b/i);
  });

  it("normalizes nonsensical counts to zero without going negative", () => {
    expect(formatLabel(-5, -3)).toBe("0 new jobs saved");
    expect(formatLabel(Number.NaN, 2.9)).toBe(
      "0 new jobs saved · 2 duplicates merged",
    );
  });
});

describe("getDiscoveryRunCountEvidence", () => {
  it("passes the settled summary through unchanged because it already excludes duplicates", () => {
    const evidence = getDiscoveryRunCountEvidence(
      createRun({ validJobsFound: 67, duplicatesMerged: 33 }),
      null,
    );

    expect(evidence).toEqual({
      distinctJobsRetained: 67,
      duplicatesMerged: 33,
    });
  });

  it("derives distinct additions from live persistence-stage review volume while the summary has not caught up", () => {
    // The event's jobsFound is review volume (duplicates included), so its
    // own duplicate counter is what turns 100 reviewed into 67 retained.
    const evidence = getDiscoveryRunCountEvidence(
      createRun(),
      createEvent({
        stage: "persistence",
        jobsFound: 100,
        duplicatesMerged: 33,
      }),
    );

    expect(evidence).toEqual({
      distinctJobsRetained: 67,
      duplicatesMerged: 33,
    });
  });

  it("treats terminal events as merged-result evidence too", () => {
    const evidence = getDiscoveryRunCountEvidence(
      null,
      createEvent({
        kind: "success",
        stage: "target",
        terminalState: "completed",
        jobsFound: 100,
        duplicatesMerged: 33,
      }),
    );

    expect(evidence).toEqual({
      distinctJobsRetained: 67,
      duplicatesMerged: 33,
    });
  });

  it("ignores pre-merge stages whose candidate totals share no base with duplicates", () => {
    const evidence = getDiscoveryRunCountEvidence(
      null,
      createEvent({ stage: "scoring", jobsFound: 50, duplicatesMerged: 6 }),
    );

    expect(evidence).toEqual({ distinctJobsRetained: 0, duplicatesMerged: 0 });
  });

  it("never mixes bases once the summary holds settled volume", () => {
    // A fresher per-target persistence event must not be maxed into (or
    // subtracted from) the cumulative summary; the settled numbers win.
    const evidence = getDiscoveryRunCountEvidence(
      createRun({ validJobsFound: 6, duplicatesMerged: 6 }),
      createEvent({
        stage: "persistence",
        jobsFound: 50,
        duplicatesMerged: 40,
      }),
    );

    expect(evidence).toEqual({
      distinctJobsRetained: 6,
      duplicatesMerged: 6,
    });
  });

  it("falls back to zero evidence when neither source reports anything", () => {
    expect(getDiscoveryRunCountEvidence(null, null)).toEqual({
      distinctJobsRetained: 0,
      duplicatesMerged: 0,
    });
    expect(getDiscoveryRunCountEvidence(createRun(), createEvent())).toEqual({
      distinctJobsRetained: 0,
      duplicatesMerged: 0,
    });
  });

  it("reads nullable event fields as absent rather than breaking the derivation", () => {
    const evidence = getDiscoveryRunCountEvidence(
      null,
      createEvent({
        stage: "persistence",
        jobsFound: null,
        duplicatesMerged: null,
      }),
    );

    expect(evidence).toEqual({ distinctJobsRetained: 0, duplicatesMerged: 0 });
  });
});

describe("formatLastSearchSummarySentence", () => {
  it("does not repeat the verb the shared count label already carries", () => {
    expect(
      formatLastSearchSummarySentence({
        runCountLabel: "15 new jobs saved · 35 duplicates merged",
        savedByRun: 15,
        keptInPlan: 15,
      }),
    ).toBe("Your last search: 15 new jobs saved · 35 duplicates merged.");
  });

  it("names both populations when the plan kept fewer than the run saved", () => {
    // Home must never print a volume the screen it links to does not list.
    expect(
      formatLastSearchSummarySentence({
        runCountLabel: "50 new jobs saved",
        savedByRun: 50,
        keptInPlan: 15,
      }),
    ).toBe(
      "Your last search: 50 new jobs saved on this device · 15 kept in this search.",
    );
  });

  it("gives the two populations different words", () => {
    // Regression: both numbers used to be introduced as "kept" — "50 new jobs
    // kept" beside "the 15 kept in this search" — so one screen
    // appeared to contradict itself. "Saved" is the device population and
    // "kept" belongs to the active plan; each number carries exactly one of
    // them, which is also the vocabulary Find jobs prints.
    const runCountLabel = formatDiscoveryRunCountLabel({
      distinctJobsRetained: 50,
      duplicatesMerged: 0,
    });
    expect(runCountLabel).not.toContain("kept");

    const sentence = formatLastSearchSummarySentence({
      runCountLabel,
      savedByRun: 50,
      keptInPlan: 15,
    });
    expect(sentence).not.toContain("50 new jobs kept");
    expect(sentence).not.toContain("15 saved");
    expect(sentence).toContain("50 new jobs saved on this device");
    expect(sentence).toContain("15 kept in this search");
  });

  it("reconciles the finished-search status line with the plan count", () => {
    // Home printed "Search finished · 50 new jobs saved" beside Find jobs'
    // "15 jobs kept in this search plan", so one search read as two
    // contradictory numbers. Both populations are now stated with the noun
    // that separates them, in the same clause the card's other sentence uses.
    expect(
      formatSearchFinishedStatusLine({
        runCountLabel: "50 new jobs saved",
        savedByRun: 50,
        keptInPlan: 15,
      }),
    ).toBe(
      "Search finished · 50 new jobs saved on this device · 15 kept in this search.",
    );

    // One population, nothing to reconcile: the run's own label stands, so a
    // duplicate count is not dropped for no reason.
    expect(
      formatSearchFinishedStatusLine({
        runCountLabel: "15 new jobs saved · 35 duplicates merged",
        savedByRun: 15,
        keptInPlan: 15,
      }),
    ).toBe(
      "Search finished · 15 new jobs saved · 35 duplicates merged, all on this device.",
    );

    // A run that kept nothing new has no second population to name.
    expect(
      formatSearchFinishedStatusLine({
        runCountLabel: "0 new jobs saved · 4 duplicates merged",
        savedByRun: 0,
        keptInPlan: 12,
      }),
    ).toBe(
      "Search finished · 0 new jobs saved · 4 duplicates merged, all on this device.",
    );

    // Singular phrasing survives the shared clause.
    expect(
      formatSearchFinishedStatusLine({
        runCountLabel: "1 new job saved",
        savedByRun: 1,
        keptInPlan: 0,
      }),
    ).toBe(
      "Search finished · 1 new job saved on this device · 0 kept in this search.",
    );
  });

  it("keeps the single-run phrasing when no run volume is known", () => {
    expect(
      formatLastSearchSummarySentence({
        runCountLabel: "0 new jobs saved · 4 duplicates merged",
        savedByRun: 0,
        keptInPlan: 12,
      }),
    ).toBe("Your last search: 0 new jobs saved · 4 duplicates merged.");
  });
});

describe("formatDiscoveryResultBandTotal", () => {
  it("describes the plan population the list actually shows", () => {
    expect(
      formatDiscoveryResultBandTotal({ worthOpening: 1, alsoFound: 14 }),
    ).toBe("15 jobs kept in this search.");
    expect(
      formatDiscoveryResultBandTotal({ worthOpening: 1, alsoFound: 0 }),
    ).toBe("1 job kept in this search.");
  });
});

describe("formatDiscoveryResultBandLabel", () => {
  it("leads with what was found when nothing earned a score", () => {
    expect(
      formatDiscoveryResultBandLabel({
        worthOpening: 0,
        titleMatches: 13,
        alsoFound: 2,
      }),
    ).toBe("13 awaiting assessment · 2 also found");
  });

  it("keeps the recommended count in front once a row has earned one", () => {
    expect(
      formatDiscoveryResultBandLabel({
        worthOpening: 1,
        titleMatches: 14,
        alsoFound: 0,
      }),
    ).toBe("1 worth opening · 14 awaiting assessment · 0 also found");
  });

  it("is unchanged when no row was left unscored", () => {
    expect(
      formatDiscoveryResultBandLabel({ worthOpening: 0, alsoFound: 3 }),
    ).toBe("0 worth opening · 3 also found");
  });
});
