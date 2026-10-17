import { collapsesSideMenuWithAssistant } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../workspace-service.test-support";

describe("side menu setting", () => {
  it("is on by default and saved through the workspace behavior update", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const before = await workspaceService.getWorkspaceSnapshot();
    expect(collapsesSideMenuWithAssistant(before.settings)).toBe(true);

    const off = await workspaceService.updateWorkspaceBehavior({
      collapseSideMenuWithAssistant: false,
    });
    expect(off.settings.collapseSideMenuWithAssistant).toBe(false);
    expect(off.settings.keepSessionAlive).toBe(
      before.settings.keepSessionAlive,
    );

    const on = await workspaceService.updateWorkspaceBehavior({
      collapseSideMenuWithAssistant: true,
    });
    expect(collapsesSideMenuWithAssistant(on.settings)).toBe(true);
  });
});
