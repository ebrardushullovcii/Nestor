import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import { assistantTestReads } from "../store-reads.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import {
  pauseActivityTool,
  setAppearanceTool,
  updateWorkspaceBehaviorTool,
} from "./settings-tools";

const portsFor = (service: object) =>
  ({
    ...assistantTestReads(service),
    publishWorkspaceUpdate: () => undefined,
  }) as unknown as AssistantHostPorts;

describe("settings and application standing the assistant reports", () => {
  it("switches the app to dark mode itself", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const session = {
      assertCurrent: () => undefined,
      recordChange: () =>
        Promise.resolve({
          receipt: { id: "receipt_1" },
          part: { type: "notice", kind: "info", text: "x" },
        }),
    } as unknown as AssistantTurnSession;
    const result = await setAppearanceTool.execute(
      { theme: "dark" },
      { service: workspaceService, session, ports: portsFor(workspaceService) },
    );
    expect(result.summary).toBe("Appearance is now dark.");
    expect(
      (await workspaceService.getWorkspaceSnapshot()).settings.appearanceTheme,
    ).toBe("dark");
  });

  it("turns off folding the side menu while the assistant is open", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const summaries: string[] = [];
    const session = {
      assertCurrent: () => undefined,
      recordChange: (change: { summary: string }) => {
        summaries.push(change.summary);
        return Promise.resolve({
          receipt: { id: "receipt_1" },
          part: { type: "notice", kind: "info", text: "x" },
        });
      },
    } as unknown as AssistantTurnSession;
    expect(updateWorkspaceBehaviorTool.parameters).toMatchObject({
      properties: { collapseSideMenuWithAssistant: { type: "boolean" } },
    });
    await updateWorkspaceBehaviorTool.execute(
      updateWorkspaceBehaviorTool.input.parse({
        collapseSideMenuWithAssistant: false,
      }),
      { service: workspaceService, session, ports: portsFor(workspaceService) },
    );
    const settings = (await workspaceService.getWorkspaceSnapshot()).settings;
    expect(settings.collapseSideMenuWithAssistant).toBe(false);
    expect(settings.keepSessionAlive).toBeDefined();
    expect(summaries).toEqual([
      "Changed Collapse the side menu while the assistant is open: off",
    ]);
  });

  it("says applications already filling keep going when work is paused", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const reads = assistantTestReads(workspaceService);
    const { ids } = reads.store.saveFoundJobs({
      searchId: null,
      jobs: [
        {
          title: "Designer",
          company: "Northfield",
          location: "Remote",
          workModes: ["remote"],
          url: "https://board.example.test/jobs/1",
          applyUrl: null,
          sourceId: "board",
          sourceLabel: "Board",
          sourceJobId: "1",
          postedAt: null,
          salaryText: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          seniority: null,
          employmentType: null,
          summary: null,
          description: "Listing",
        },
      ],
    });
    reads.store.setStage(ids, "resume");
    reads.applications.applyJobs({ selection: { ids } });
    reads.applications.claimNext();
    const session = {
      assertCurrent: () => undefined,
    } as unknown as AssistantTurnSession;
    const paused = await pauseActivityTool.execute(
      { paused: true, finishCurrent: false },
      {
        service: workspaceService,
        session,
        ports: portsFor(workspaceService),
      },
    );
    expect(paused.summary).toContain(
      "Current applications are still finishing.",
    );
  });
});
