import { round3SearchRun } from "./discovery-round3.test-fixture";
import type {
  DiscoveryRunRecord,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { buildJobFinderTaskCenterModel } from "../components/task-center/job-finder-task-center-model";
import {
  formatDiscoveryRunReportLabel,
  getDiscoveryRunCountEvidence,
  getDiscoveryRunReportCounts,
  hasDiscoveryRunReportCounts,
} from "./discovery-run-count-label";
import { describePlanRunCounts } from "../screens/campaigns/campaigns-screen";

/**
 * One finished run, read by every surface that describes it. Home, the Find
 * jobs banner, Search history, the plan card and Tasks all quote the frozen
 * report through these helpers, so this fixture is the whole contract: if a
 * surface can print a different number for this run, it is recomputing from
 * current inventory again.
 */
function createFinishedRun(
  report: DiscoveryRunRecord["summary"]["report"],
): DiscoveryRunRecord {
  return {
    id: "discovery_run_1",
    campaignId: "campaign_1",
    state: "completed",
    startedAt: "2026-07-31T10:00:00.000Z",
    completedAt: "2026-07-31T10:07:00.000Z",
    targetIds: ["source_a"],
    targetExecutions: [],
    activity: [],
    summary: {
      targetsPlanned: 1,
      targetsCompleted: 1,
      validJobsFound: 50,
      duplicatesMerged: 4,
      durationMs: 420_000,
      report,
    },
  } as unknown as DiscoveryRunRecord;
}

function createWorkspace(run: DiscoveryRunRecord): JobFinderRendererWorkspaceSnapshot {
  return {
    activeDiscoveryRun: null,
    applicationRecords: [],
    applyRuns: [],
    discoveryJobs: [],
    latestResumeImportRun: null,
    recentDiscoveryRuns: [run],
    searchPreferences: {
      discovery: { targets: [{ id: "source_a", label: "Mercury careers" }] },
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("frozen discovery run report", () => {
  test("names all count populations and lets newer interrupted work replace stale live activity", () => {
    const run = createFinishedRun({
      version: 1,
      measuredAt: "2026-07-31T10:07:00.000Z",
      found: 20,
      unique: 10,
      new: 10,
      saved: 10,
      retained: 7,
      worthOpening: 3,
      duplicates: 10,
    });
    run.state = "failed";
    run.runPhase = "interrupted";
    const counts = getDiscoveryRunReportCounts(run);
    expect(formatDiscoveryRunReportLabel(counts)).toBe(
      "20 postings seen · 10 unique jobs · 10 new to you · 7 kept by this plan · 10 duplicates merged",
    );
    const workspace = createWorkspace(run);
    workspace.recentDiscoveryRuns.push({
      ...run,
      id: "older-run",
      startedAt: "2026-07-31T09:00:00.000Z",
      state: "completed",
      runPhase: "complete",
    });
    const model = buildJobFinderTaskCenterModel({
      workspace,
      isDiscoveryPending: false,
      liveDiscoveryEvents: [
        { runId: "older-run", timestamp: "2026-07-31T09:07:00.000Z" },
      ],
      now: Date.parse("2026-07-31T10:10:00.000Z"),
    } as unknown as Parameters<typeof buildJobFinderTaskCenterModel>[0]);
    expect(model.items.find((item) => item.kind === "discovery")).toMatchObject(
      {
        id: run.id,
        status: "interrupted",
        stageLabel: "Search interrupted",
      },
    );
  });

  test("every surface reads the same numbers for one run", () => {
    const run = createFinishedRun({
      version: 1,
      measuredAt: "2026-07-31T10:07:00.000Z",
      found: 100,
      new: 50,
      saved: 50,
      retained: 15,
      worthOpening: 3,
      duplicates: 4,
      alreadyHere: null,
    });
    const counts = getDiscoveryRunReportCounts(run);
    const label = formatDiscoveryRunReportLabel(counts);

    expect(label).toBe("100 found · 50 new · 15 kept · 4 already here");
    expect(describePlanRunCounts(counts)).toBe(label);

    // Tasks builds its own line from the same helpers.
    const tasks = buildJobFinderTaskCenterModel({
      workspace: createWorkspace(run),
      discoveryEvents: [],
      isDiscoveryPending: false,
      now: Date.parse("2026-07-31T10:10:00.000Z"),
    } as unknown as Parameters<typeof buildJobFinderTaskCenterModel>[0]);
    const discoveryTask = tasks.items.find((item) => item.kind === "discovery");
    expect(discoveryTask?.countLabel).toContain(label);

    // The legacy evidence path, still used while a run streams, resolves to
    // the same populations rather than a second accounting.
    expect(getDiscoveryRunCountEvidence(run, null)).toEqual({
      distinctJobsRetained: 50,
      duplicatesMerged: 4,
    });
  });

  test("does not repeat found as duplicates unless every listing was already here", () => {
    expect(
      formatDiscoveryRunReportLabel({
        found: 94,
        new: 47,
        saved: 47,
        retained: 15,
        worthOpening: 3,
        duplicates: 94,
        alreadyHere: null,
      }),
    ).toBe("94 found · 47 new · 15 kept · 47 already here");
    expect(
      formatDiscoveryRunReportLabel({
        found: 94,
        new: 0,
        saved: 0,
        retained: 0,
        worthOpening: 0,
        duplicates: 94,
        alreadyHere: null,
      }),
    ).toBe("94 found · 0 new · 0 kept · all already here");
  });

  test("keeps a first search's repeats out of what the plan already had", () => {
    // Nothing existed before this run, so nothing was already here. The
    // listings two sources both returned are merges made inside this run and
    // are stated as their own fact.
    expect(
      formatDiscoveryRunReportLabel({
        found: 113,
        new: 66,
        saved: 66,
        retained: 15,
        worthOpening: 3,
        duplicates: 47,
        alreadyHere: 0,
      }),
    ).toBe("113 found · 66 new · 15 kept · 47 duplicates merged");
  });

  test("a run recorded before the report says so instead of showing zero", () => {
    const run = createFinishedRun(null);
    const counts = getDiscoveryRunReportCounts(run);

    expect(hasDiscoveryRunReportCounts(counts)).toBe(false);
    expect(formatDiscoveryRunReportLabel(counts)).toBe(
      "Counts not recorded for this run",
    );
  });
});

test("the plan card keeps new-to-device and retained counts distinct in the shared report", () => {
  const counts = getDiscoveryRunReportCounts(round3SearchRun());
  expect(describePlanRunCounts(counts)).toContain(
    "25 new to you · 22 kept by this plan · 27 duplicates merged",
  );
});

test("keeps modern accounting labels when unique inspections are unknown", () => {
  const run = round3SearchRun();
  run.summary.report!.unique = null;
  const label = formatDiscoveryRunReportLabel(getDiscoveryRunReportCounts(run));
  expect(label).toContain("52 postings seen");
  expect(label).toContain("27 duplicates merged");
  expect(label).toContain("0 rejected");
  expect(label).not.toContain("already here");
  expect(describePlanRunCounts(getDiscoveryRunReportCounts(run))).toContain(
    "52 postings seen",
  );
});
