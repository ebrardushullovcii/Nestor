import {
  DiscoveryRunRecordSchema,
  JobFinderDiscoveryStateSchema,
  getDiscoveryRunPhase,
  type DiscoveryRunRecord,
  type JobFinderDiscoveryState,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { recoverInterruptedDiscoveryRuns } from "./recover-interrupted-discovery-runs";

const now = "2026-09-12T10:00:00.000Z";

/**
 * What a caller may override on the fixture. The summary is partial because
 * the schema fills the rest: a test that cares only about "this run recorded
 * no counts" should say `summary: {}` and not restate every field.
 */
type RunOverrides = Omit<Partial<DiscoveryRunRecord>, "summary"> & {
  summary?: Partial<DiscoveryRunRecord["summary"]>;
};

function run(overrides: RunOverrides = {}): DiscoveryRunRecord {
  return DiscoveryRunRecordSchema.parse({
    id: "run_1",
    state: "running",
    startedAt: "2026-09-12T09:00:00.000Z",
    summary: {
      report: {
        measuredAt: "2026-09-12T09:30:00.000Z",
        found: 50,
        saved: 15,
      },
    },
    ...overrides,
  });
}

function repositoryOver(state: JobFinderDiscoveryState) {
  let current = state;
  return {
    read: () => current,
    commitDiscoveryStateUpdate: (
      update: (value: JobFinderDiscoveryState) => JobFinderDiscoveryState,
    ) => {
      current = JobFinderDiscoveryStateSchema.parse(update(current));
      return Promise.resolve(current);
    },
  };
}

describe("recoverInterruptedDiscoveryRuns", () => {
  it("files a run stranded by the close as interrupted and names what it kept", () => {
    // "The app said 50 new jobs saved; after the restart only 15 remained",
    // and the screen then said "Nothing was deleted".
    const repository = repositoryOver(
      JobFinderDiscoveryStateSchema.parse({
        runState: "running",
        activeRun: run(),
        recentRuns: [],
      }),
    );

    return recoverInterruptedDiscoveryRuns(repository, now).then(() => {
      const state = repository.read();
      expect(state.activeRun).toBeNull();
      expect(state.runState).toBe("idle");
      const recovered = state.recentRuns[0];
      expect(recovered?.id).toBe("run_1");
      expect(getDiscoveryRunPhase(recovered!)).toBe("interrupted");
      expect(recovered?.state).toBe("failed");
      // The number comes from the run's own frozen report, never recounted.
      expect(recovered?.summary.warnings.join(" ")).toContain(
        "The 15 results it had already saved were kept",
      );
    });
  });

  it("leaves a finished run alone and stays idempotent", async () => {
    const finished = run({
      id: "run_done",
      state: "completed",
      completedAt: "2026-09-12T09:40:00.000Z",
    });
    const repository = repositoryOver(
      JobFinderDiscoveryStateSchema.parse({
        runState: "idle",
        activeRun: null,
        recentRuns: [finished],
      }),
    );

    await recoverInterruptedDiscoveryRuns(repository, now);
    const first = repository.read();
    await recoverInterruptedDiscoveryRuns(repository, now);
    const second = repository.read();

    expect(first.recentRuns[0]?.state).toBe("completed");
    expect(getDiscoveryRunPhase(first.recentRuns[0]!)).toBe("complete");
    expect(second).toEqual(first);
  });

  it("says what it can when the run recorded no counts", async () => {
    const repository = repositoryOver(
      JobFinderDiscoveryStateSchema.parse({
        runState: "running",
        activeRun: run({ summary: {} }),
        recentRuns: [],
      }),
    );

    await recoverInterruptedDiscoveryRuns(repository, now);

    expect(repository.read().recentRuns[0]?.summary.warnings.join(" ")).toBe(
      "This search stopped when the app closed. Everything it had saved before then was kept; the rest of the search did not run.",
    );
  });
});
