import { expect, test } from "vitest";
import { JobFinderIntelligenceStateSchema } from "@nordri/contracts";
import {
  mergeResumeBatchCheckpoints,
  markResumeBatchRunning,
  withResumeBatchLiveness,
} from "./resume-batch-checkpoint";
const first = {
  id: "first",
  jobIds: ["one", "two"],
  activeJobIds: ["two"],
  completedJobIds: ["one"],
  done: false,
  stopRequested: false,
  requests: [{ jobId: "two", language: "German" }],
  durationsMs: [120000],
};
test("R3-183 keeps overlapping queues and leaves a queued rewrite pending", () => {
  const second = {
    ...first,
    id: "second",
    jobIds: ["one", "three"],
    activeJobIds: [],
    completedJobIds: [],
    requests: [{ jobId: "one", level: "aggressive" as const }],
    durationsMs: [],
  };
  const saved = mergeResumeBatchCheckpoints([first], second);
  expect(saved.checkpoints).toHaveLength(2);
  expect(saved.checkpoint.jobIds).toEqual(["one", "two", "three"]);
  expect(saved.checkpoint.completedJobIds).toEqual([]);
  expect(saved.checkpoint.requests).toEqual([
    ...first.requests,
    ...second.requests,
  ]);
  const resumed = mergeResumeBatchCheckpoints(saved.checkpoints, {
    ...second,
    id: "continued",
    jobIds: saved.checkpoint.jobIds,
    requests: saved.checkpoint.requests,
    resumedBatchIds: ["first", "second"],
  });
  expect(resumed.checkpoints).toHaveLength(1);
});

test("a running receipt becomes recoverable in a restarted process", () => {
  const repository = {};
  const batch = { ...first, running: true };
  const state = JobFinderIntelligenceStateSchema.parse({
    resumeBatchCheckpoint: batch,
    resumeBatchCheckpoints: [batch],
  });
  markResumeBatchRunning(repository, batch);
  expect(
    withResumeBatchLiveness(repository, state).resumeBatchCheckpoint?.running,
  ).toBe(true);
  expect(
    withResumeBatchLiveness(
      {},
      JSON.parse(JSON.stringify(state)) as typeof state,
    ).resumeBatchCheckpoint?.running,
  ).toBe(false);
  markResumeBatchRunning(repository, {
    ...batch,
    running: false,
    stopRequested: true,
  });
  expect(
    withResumeBatchLiveness(repository, state).resumeBatchCheckpoint?.running,
  ).toBe(false);
});

test("continuing part of a checkpoint never drops jobs outside the selected campaign", () => {
  const resumed = mergeResumeBatchCheckpoints([first], {
    ...first,
    id: "partial",
    jobIds: ["one"],
    completedJobIds: [],
    resumedBatchIds: [first.id],
  });
  expect(
    resumed.checkpoints.find((batch) => batch.id === first.id)?.jobIds,
  ).toEqual(["two"]);
  expect(resumed.checkpoint.jobIds).toEqual(["two", "one"]);
});
