import type { ApplyQueue } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import {
  describeApplyQueue,
  listApplyQueueWaitingJobIds,
} from "./apply-queue-view";

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
  it("counts a finished queue by what happened, not by what started", () => {
    const at = (minute: number) =>
      `2026-10-23T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const results = [
      { jobId: "a", state: "submitted", startedAt: at(1), updatedAt: at(2) },
      { jobId: "c", state: "failed", startedAt: at(1), updatedAt: at(3) },
      {
        jobId: "d",
        state: "awaiting_review",
        startedAt: at(1),
        updatedAt: at(4),
      },
      // An earlier press's success does not count for this queue.
      {
        jobId: "c",
        state: "submitted",
        startedAt: at(0),
        updatedAt: "2026-10-22T09:00:00.000Z",
      },
    ] as const;
    const done = {
      ...base,
      state: "done" as const,
      startedJobIds: ["a", "c", "d"],
    };
    expect(describeApplyQueue(done, { results })).toMatchObject({
      title: "Applied to 1 of 4 jobs",
      detail: "1 sent · 1 ready for you to send · 1 failed · 1 not started",
    });
    expect(
      describeApplyQueue({ ...done, mode: "prepare_only" }, { results })?.title,
    ).toBe("Filled in applications for 2 of 4 jobs");
    expect(
      describeApplyQueue(done, {
        results: results.map((result) => ({
          ...result,
          state: "failed" as const,
        })),
      })?.title,
    ).toBe("Apply queue finished · none sent");
  });

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
      detail:
        "Too many application attempts failed, so this plan paused. · 1 not applied",
      primary: { label: "Continue", action: "continue" },
    });
  });

  it("offers Dismiss once finished and no longer holds its jobs", () => {
    const done = {
      ...base,
      state: "done" as const,
      startedJobIds: ["a", "c", "d"],
    };
    expect(describeApplyQueue(done)).toMatchObject({
      title: "Applied to 3 jobs",
      secondary: { action: "dismiss" },
    });
    expect(listApplyQueueWaitingJobIds(done)).toEqual([]);
    expect(listApplyQueueWaitingJobIds(base)).toEqual(["c", "d"]);
  });
});
