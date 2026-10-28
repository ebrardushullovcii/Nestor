import { describe, expect, it } from "vitest";
import {
  APPLICATION_COMMANDS,
  AssistantInstructionGrantSchema,
  RESUME_COMMANDS,
  TRACKER_COMMANDS,
} from "@nestor/contracts";

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
          "send_application",
          ...Object.entries(APPLICATION_COMMANDS)
            .filter(([, command]) => command.effect === "read")
            .map(([name]) => name),
        ]),
      );
    } finally {
      await world.shutdown();
    }
  });
  it("exposes the same ready application through every Apply read and refuses an ungranted send", async () => {
    const world = await createAssistantLaneWorld(
      "scripted",
      "ready_application",
    );
    const context = {
      session: {
        assertCurrent() {},
        grants: { list: () => Promise.resolve([]) },
      },
    } as never;
    const run = (name: string, input: unknown) =>
      world.commands
        .find((tool) => tool.name === name)!
        .execute(input, context);
    try {
      const ready = {
        id: 1,
        jobId: 1,
        company: "Northwind Labs",
        state: "ready",
      };
      expect((await run("list_application_work", {})).data).toMatchObject({
        rows: [ready],
      });
      expect(
        (await run("applications_for_jobs", { jobIds: [1] })).data,
      ).toMatchObject([ready]);
      expect(
        (await run("get_application_details", { id: 1 })).data,
      ).toMatchObject({
        application: ready,
        resumeFileName: "riley-okafor.txt",
        reviewCard: { waitingOnYou: [] },
      });
      await expect(run("send_application", { id: 1 })).rejects.toMatchObject({
        kind: "refused",
      });
      expect(world.recorder.sends).toEqual([]);
      const granted = {
        session: {
          assertCurrent() {},
          grants: {
            list: () =>
              Promise.resolve([
                AssistantInstructionGrantSchema.parse({
                  id: "lane_grant",
                  conversationId: "lane_conversation",
                  sourceMessageId: "lane_message",
                  action: "prepare_and_send",
                  jobIds: ["1"],
                  status: "active",
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }),
              ]),
          },
        },
      } as never;
      const send = world.commands.find(
        (tool) => tool.name === "send_application",
      )!;
      expect((await send.execute({ id: 1 }, granted)).data).toBe(true);
      expect(world.recorder.sends).toEqual([["1"]]);
      expect(
        (await run("applications_for_jobs", { jobIds: [1] })).data,
      ).toMatchObject([{ ...ready, state: "submitted" }]);
      expect(
        (await run("get_application_details", { id: 1 })).data,
      ).toMatchObject({ receipt: { outcome: "submitted" } });
      expect((await send.execute({ id: 1 }, granted)).data).toBe(false);
      expect(world.recorder.sends).toEqual([["1"]]);
    } finally {
      await world.shutdown();
    }
  });
  it("starts the Apply-settings change case in the other mode", async () => {
    const world = await createAssistantLaneWorld("scripted", "send_by_default");
    try {
      expect((await world.snapshot()).settings.applicationAutomationMode).toBe(
        "autonomous_submit",
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
