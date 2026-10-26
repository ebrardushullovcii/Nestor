import { AiBehaviorPreferenceSchema } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createProfileServiceHarness } from "../../profile-service.test-support";
import { assistantTestReads } from "../store-reads.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import { readSettingsTool, updateAiBehaviorTool } from "./settings-tools";

describe("sidebar search settings", () => {
  it("exposes effective defaults and changes remote treatment without losing other choices", async () => {
    const { service } = createProfileServiceHarness();
    const ports = {
      ...assistantTestReads(service),
      publishWorkspaceUpdate: () => undefined,
    } as unknown as AssistantHostPorts;
    const session = {
      assertCurrent: () => undefined,
      recordChange: () =>
        Promise.resolve({
          receipt: { id: "receipt_remote" },
          part: { type: "notice", kind: "info", text: "Saved" },
        }),
    } as unknown as AssistantTurnSession;
    const context = { service, session, ports };
    const before = await service.read();
    const behavior = AiBehaviorPreferenceSchema.parse(
      before.settings.aiBehavior ?? {},
    );
    const read = await readSettingsTool.execute({}, context);
    expect(read.data).toMatchObject({ aiBehavior: behavior });
    expect(updateAiBehaviorTool.parameters).toMatchObject({
      properties: {
        aiBehavior: {
          properties: {
            jobSearch: {
              properties: { remoteCountsAsAnyLocation: { type: "boolean" } },
            },
          },
        },
      },
    });
    const result = await updateAiBehaviorTool.execute(
      updateAiBehaviorTool.input.parse({
        aiBehavior: {
          ...behavior,
          jobSearch: {
            selectivity: "best_matches",
            remoteCountsAsAnyLocation: false,
          },
        },
      }),
      context,
    );
    const after = await service.read();
    expect(after.settings.aiBehavior).toMatchObject({
      profileAssistant: behavior.profileAssistant,
      applying: behavior.applying,
      jobSearch: {
        selectivity: "best_matches",
        remoteCountsAsAnyLocation: false,
      },
    });
    expect(result.data).toMatchObject({
      aiBehavior: { jobSearch: { remoteCountsAsAnyLocation: false } },
    });
    expect(after.profile).toEqual(before.profile);
    expect(after.searchPreferences.tailoringMode).toBe(
      before.searchPreferences.tailoringMode,
    );
  });
});
