import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SourceInstructionArtifactSchema } from "@nestor/contracts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createTempRepository } from "../file-repository.test-support";
import { openJobStore, type JobStore } from "./job-store";
import { createActivityControlStore } from "./activity-control";
import { createSiteInstructionsStore } from "./site-instructions";

const artifact = (id: string, targetId: string) =>
  SourceInstructionArtifactSchema.parse({
    ...(JSON.parse(
      readFileSync(
        path.join(
          __dirname,
          "stored-json/source-instruction-artifact.full.json",
        ),
        "utf8",
      ),
    ) as object),
    id,
    targetId,
  });

let store: JobStore;
beforeEach(() => {
  store = openJobStore(":memory:");
});
afterEach(() => store.close());

test("site instructions are kept per site and removed with it", () => {
  const instructions = createSiteInstructionsStore(store);
  instructions.upsert(artifact("a", "site-1"));
  instructions.upsert(artifact("b", "site-2"));
  instructions.upsert({ ...artifact("a", "site-1"), notes: "Changed" });
  expect(instructions.list().map((row) => [row.id, row.notes])).toEqual([
    ["a", "Changed"],
    ["b", "synthetic"],
  ]);
  instructions.deleteForSite("site-1");
  expect(instructions.list().map((row) => row.id)).toEqual(["b"]);
  instructions.replace([]);
  expect(instructions.list()).toEqual([]);
});

test("background work runs until paused, and the pause keeps its reason", () => {
  const control = createActivityControlStore(store);
  expect(control.read()).toEqual({
    paused: false,
    pausedAt: null,
    reason: null,
  });
  control.save({
    paused: true,
    pausedAt: "2026-10-26T00:00:00.000Z",
    reason: "Taking a break",
    pauseBehavior: "finish_current",
  });
  expect(control.read()).toEqual({
    paused: true,
    pausedAt: "2026-10-26T00:00:00.000Z",
    reason: "Taking a break",
    pauseBehavior: "finish_current",
  });
  control.save({ paused: false, pausedAt: null, reason: null });
  expect(control.read()).toEqual({
    paused: false,
    pausedAt: null,
    reason: null,
  });
});

test("the old workspace repository keeps instructions and the pause in the job store", async () => {
  const fixture = await createTempRepository("nestor-site-instructions-");
  const repository = await fixture.createRepository();
  try {
    await repository.upsertSourceInstructionArtifact(artifact("a", "site-1"));
    await repository.saveActivityControl({
      paused: true,
      pausedAt: "2026-10-26T00:00:00.000Z",
      reason: null,
    });
    const jobs = openJobStore(`${fixture.filePath}.jobs.sqlite`);
    try {
      expect(
        createSiteInstructionsStore(jobs)
          .list()
          .map((row) => row.id),
      ).toEqual(["a"]);
      expect(createActivityControlStore(jobs).read().paused).toBe(true);
    } finally {
      jobs.close();
    }
    expect((await repository.listSourceInstructionArtifacts()).length).toBe(1);
    expect((await repository.getActivityControl()).paused).toBe(true);
    const old = new DatabaseSync(fixture.filePath, { readOnly: true });
    try {
      expect(
        old
          .prepare("SELECT COUNT(*) AS n FROM source_instruction_artifacts")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      old.close();
    }
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});
