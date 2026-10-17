import { expect, test } from "vitest";
import { ApplicationAnswerRecordSchema } from "@nestor/contracts";
import { latestApplicationAnswerRecord } from "./grouped-manual-answer-support";

test("the repository selects the same latest answer regardless of legacy tie insertion order", () => {
  const record = (id: string, createdAt: string) =>
    ApplicationAnswerRecordSchema.parse({
      id,
      createdAt,
      questionId: "pay",
      runId: "run",
      jobId: "job",
      text: "42000 EUR",
      revision: 1,
    });
  const old = record("old", "2026-10-01T10:00:00.000Z");
  const newer = record("a", "2026-10-02T10:00:00.000Z");
  const latest = record("z", newer.createdAt);
  expect(latestApplicationAnswerRecord([old, newer, latest], "pay")).toEqual(
    latest,
  );
  expect(latestApplicationAnswerRecord([latest, newer, old], "pay")).toEqual(
    latest,
  );
  expect(latestApplicationAnswerRecord([old], "other")).toBeNull();
});
