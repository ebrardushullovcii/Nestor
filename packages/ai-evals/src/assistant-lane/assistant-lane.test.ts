import { describe, expect, it } from "vitest";
import { RESUME_COMMANDS, TRACKER_COMMANDS } from "@nestor/contracts";

import { ASSISTANT_LANE_CASES, uncoveredInventoryEntries } from "./cases";
import { runAssistantLaneCase } from "./run";
import { createAssistantLaneWorld } from "./world";

describe("assistant eval lane", () => {
  it("offers the desktop resume and tracker command sets, including writes", async () => {
    const world = await createAssistantLaneWorld("scripted");
    try {
      expect(world.commandNames).toEqual(
        expect.arrayContaining([
          ...Object.keys(RESUME_COMMANDS),
          ...Object.keys(TRACKER_COMMANDS),
        ]),
      );
    } finally {
      await world.shutdown();
    }
  });
  it("has a case for every inventory entry mapped to tools", () => {
    expect(uncoveredInventoryEntries()).toEqual([]);
  });

  const scripted = ASSISTANT_LANE_CASES.filter((evalCase) => evalCase.scripted);

  it.each(scripted.map((evalCase) => [evalCase.id, evalCase] as const))(
    "passes %s on the scripted model",
    async (_id, evalCase) => {
      const result = await runAssistantLaneCase(evalCase, "scripted", {
        turnTimeoutMs: 20_000,
      });
      expect(result.error, result.error ?? "").toBeNull();
      expect(result.failures).toEqual([]);
    },
    30_000,
  );
});
