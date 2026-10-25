import { describe, expect, test } from "vitest";
import {
  DiscoveryActivityEventSchema,
  DiscoveryRunRecordSchema,
} from "@nestor/contracts";

import {
  appendDiscoveryEvent,
  countCompletedTargetExecutions,
} from "./discovery-state";

function createRun() {
  return DiscoveryRunRecordSchema.parse({
    id: "run_incremental_activity",
    state: "running",
    startedAt: "2026-08-19T10:00:00.000Z",
    activity: [],
  });
}

function createEvent(index: number) {
  return DiscoveryActivityEventSchema.parse({
    id: `activity_${index}`,
    runId: "run_incremental_activity",
    timestamp: "2026-08-19T10:00:00.000Z",
    kind: "progress",
    stage: "target",
    targetId: `source_${index}`,
    message: `Source ${index} progress`,
    terminalState: null,
  });
}

describe("discovery state activity", () => {
  test("appends a large run history incrementally without replacing the accumulator", () => {
    const run = createRun();

    for (let index = 0; index < 511; index += 1) {
      expect(appendDiscoveryEvent(run, createEvent(index))).toBe(run);
    }

    expect(run.activity).toHaveLength(511);
    expect(run.activity[0]?.id).toBe("activity_0");
    expect(run.activity.at(-1)?.id).toBe("activity_510");
  });

  test("deduplicates an unchanged adjacent progress event", () => {
    const run = createRun();
    const first = createEvent(0);
    const duplicate = { ...first, id: "activity_duplicate" };

    appendDiscoveryEvent(run, first);
    const result = appendDiscoveryEvent(run, duplicate);

    expect(result).toBe(run);
    expect(run.activity).toEqual([first]);
  });
});

describe("finished source count", () => {
  test("never counts a source cancellation stopped mid-run as finished", () => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "run_cancelled",
      state: "cancelled",
      startedAt: "2026-08-19T10:00:00.000Z",
      targetIds: ["source_a", "source_b"],
      targetExecutions: [
        { targetId: "source_a", adapterKind: "target_site", state: "completed" },
        { targetId: "source_b", adapterKind: "target_site", state: "cancelled" },
      ],
    });

    // Stopping the run finalises the source that was still working as
    // cancelled. Reporting "2 of 2 sources finished" claimed credit for work
    // the user had just interrupted.
    expect(countCompletedTargetExecutions(run)).toBe(1);
  });

  test("counts sources that reached a real outcome", () => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "run_mixed",
      state: "completed",
      startedAt: "2026-08-19T10:00:00.000Z",
      targetIds: ["source_a", "source_b", "source_c", "source_d"],
      targetExecutions: [
        { targetId: "source_a", adapterKind: "target_site", state: "completed" },
        { targetId: "source_b", adapterKind: "target_site", state: "failed" },
        { targetId: "source_c", adapterKind: "target_site", state: "skipped" },
        { targetId: "source_d", adapterKind: "target_site", state: "running" },
      ],
    });

    expect(countCompletedTargetExecutions(run)).toBe(3);
  });
});
