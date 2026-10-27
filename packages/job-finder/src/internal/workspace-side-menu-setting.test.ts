import { collapsesSideMenuWithAssistant } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createProfileServiceHarness } from "../profile-service.test-support";

describe("side menu setting", () => {
  it("is on by default and saved through the workspace behavior update", async () => {
    const { profileWork } = createProfileServiceHarness();
    const before = await profileWork.read();
    expect(collapsesSideMenuWithAssistant(before.settings)).toBe(true);

    const off = await profileWork.updateWorkspaceBehavior({
      collapseSideMenuWithAssistant: false,
    });
    expect(off.settings.collapseSideMenuWithAssistant).toBe(false);
    expect(off.settings.writeResumesOnShortlist).toBe(
      before.settings.writeResumesOnShortlist,
    );

    const on = await profileWork.updateWorkspaceBehavior({
      collapseSideMenuWithAssistant: true,
    });
    expect(collapsesSideMenuWithAssistant(on.settings)).toBe(true);
  });
});
