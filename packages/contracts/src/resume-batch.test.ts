import { expect, test } from "vitest";
import {
  AssistantResumeBatchStateSchema,
  estimateResumeBatchMinutesLeft,
  ResumeBatchGenerationInputSchema,
  ResumeBatchGenerationResultSchema,
} from "./index";

test("batch checkpoints keep every queued job and bound only active admission", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `job_${i}`);
  const batch = {
    id: "batch",
    jobIds: ids,
    activeJobIds: ids.slice(0, 100),
    completedJobIds: [],
    done: false,
    stopRequested: false,
  };
  expect(AssistantResumeBatchStateSchema.parse(batch).jobIds).toHaveLength(200);
  expect(
    AssistantResumeBatchStateSchema.safeParse({
      ...batch,
      activeJobIds: ids.slice(0, 101),
    }).success,
  ).toBe(false);
  expect(
    ResumeBatchGenerationInputSchema.safeParse({
      batchId: "batch",
      jobId: "job",
      surprise: "ignored",
    }).success,
  ).toBe(false);
  expect(
    ResumeBatchGenerationResultSchema.safeParse({
      jobId: "job",
      outcome: "written",
      workspace: {},
    }).success,
  ).toBe(false);
});

test("rolling queue estimates use measured throughput while old assistant estimates retain two writers", () => {
  expect(estimateResumeBatchMinutesLeft([60_000, 60_000], 100)).toBe(50);
  expect(
    estimateResumeBatchMinutesLeft([60_000, 60_000], 100, {
      elapsedMs: 60_000,
      completedCount: 50,
    }),
  ).toBe(2);
  expect(
    estimateResumeBatchMinutesLeft([60_000], 100, {
      elapsedMs: 60_000,
      completedCount: 1,
    }),
  ).toBeNull();
});

test("provider blocks are typed receipts and survive checkpoint serialization", () => {
  const providerBlock = {
    reason: "funding",
    message: "The AI provider rejected the request for insufficient funds.",
  };
  expect(
    ResumeBatchGenerationResultSchema.parse({
      jobId: "one",
      outcome: "blocked",
      providerBlock,
    }),
  ).toMatchObject({ providerBlock });
  expect(
    ResumeBatchGenerationResultSchema.safeParse({
      jobId: "one",
      outcome: "blocked",
    }).success,
  ).toBe(false);
  expect(
    ResumeBatchGenerationResultSchema.safeParse({
      jobId: "one",
      outcome: "written",
      providerBlock,
    }).success,
  ).toBe(false);
  const batch = {
    id: "queue",
    jobIds: ["one", "two"],
    activeJobIds: [],
    completedJobIds: [],
    done: false,
    stopRequested: true,
    running: false,
    providerBlock,
  };
  expect(
    AssistantResumeBatchStateSchema.parse(JSON.parse(JSON.stringify(batch))),
  ).toEqual(batch);
});
