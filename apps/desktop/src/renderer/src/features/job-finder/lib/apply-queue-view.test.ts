import type { ApplyQueue } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { describeApplyQueue, listApplyQueueWaitingJobIds } from "./apply-queue-view";

const base: ApplyQueue = {
  id: "queue_1",
  mode: "autonomous_submit",
  state: "running",
  jobIds: ["a", "b", "c", "d"],
  startedJobIds: ["a"],
  skipped: [{ jobId: "b", reason: "Its resume waits for your review." }],
  activeRunId: "run_1",
  pausedReason: null,
  resumesAt: null,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
};

describe("describeApplyQueue", () => {
  it("says what a running queue is doing, with Pause and Stop", () => {
    expect(describeApplyQueue(base)).toMatchObject({
      title: "Applying to 4 jobs",
      detail: "1 started · 2 to go · ten at a time · 1 not applied",
      active: true,
      primary: { action: "pause" },
      secondary: { action: "stop" },
    });
  });

  it("names fill-only work as filling in, not applying", () => {
    expect(describeApplyQueue({ ...base, mode: "prepare_only" })?.title).toBe(
      "Filling in applications for 4 jobs",
    );
  });

  it("keeps a refusal to its first sentence and offers Continue", () => {
    expect(
      describeApplyQueue({
        ...base,
        state: "paused",
        pausedReason:
          "Too many application attempts failed, so this plan paused. Open Safeguards to resolve it.",
      }),
    ).toMatchObject({
      title: "Applying to 4 jobs · paused",
      detail: "Too many application attempts failed, so this plan paused. · 1 not applied",
      primary: { label: "Continue", action: "continue" },
    });
  });

  it("offers Dismiss once finished and no longer holds its jobs", () => {
    const done = { ...base, state: "done" as const, startedJobIds: ["a", "c", "d"] };
    expect(describeApplyQueue(done)).toMatchObject({
      title: "Applied to 3 jobs",
      secondary: { action: "dismiss" },
    });
    expect(listApplyQueueWaitingJobIds(done)).toEqual([]);
    expect(listApplyQueueWaitingJobIds(base)).toEqual(["c", "d"]);
  });
});
