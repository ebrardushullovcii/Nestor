import { readFileSync } from "node:fs";
import path from "node:path";
import { SourceInstructionArtifactSchema } from "@nestor/contracts";
import { afterEach, beforeEach, expect, test } from "vitest";
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
