import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import { describeApplicationStanding } from "./format";
import { dismissJobsTool } from "./jobs-tools";
import {
  setAppearanceTool,
  updateWorkspaceBehaviorTool,
} from "./settings-tools";

const ports = {
  publishWorkspaceUpdate: () => undefined,
} as unknown as AssistantHostPorts;

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
      { service: workspaceService, session, ports },
    );
    expect(result.summary).toBe("Appearance is now dark.");
    expect(
      (await workspaceService.getWorkspaceSnapshot()).settings.appearanceTheme,
    ).toBe("dark");
  });

  it("says when hiding a job took it off the shortlist", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const before = await workspaceService.getWorkspaceSnapshot();
    const shortlisted = before.reviewQueue[0]!.jobId;
    const result = await dismissJobsTool.execute(
      { jobIds: [shortlisted], reasons: ["role"] },
      {
        service: workspaceService,
        session: {
          assertCurrent: () => undefined,
        } as unknown as AssistantTurnSession,
        ports,
      },
    );
    const after = await workspaceService.getWorkspaceSnapshot();
    const stillShortlisted = after.reviewQueue.some(
      (item) => item.jobId === shortlisted,
    );
    expect(stillShortlisted).toBe(false);
    expect(result.summary).toContain("were on the shortlist and are no longer");
  });

  it("names the application standing from records, including a skip", () => {
    const snapshot = {
      applicationRecords: [
        {
          jobId: "job_sent",
          status: "submitted",
          lastActionLabel: "Application submitted",
        },
        {
          jobId: "job_skip",
          status: "discovered",
          lastActionLabel: "Skipped at your request.",
        },
      ],
    } as unknown as JobFinderWorkspaceSnapshot;
    expect(describeApplicationStanding(snapshot, "job_sent")).toBe("submitted");
    expect(describeApplicationStanding(snapshot, "job_skip")).toBe("skipped");
    expect(describeApplicationStanding(snapshot, "job_none")).toBe(
      "not applied",
    );
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
      { service: workspaceService, session, ports },
    );
    const settings = (await workspaceService.getWorkspaceSnapshot()).settings;
    expect(settings.collapseSideMenuWithAssistant).toBe(false);
    expect(settings.keepSessionAlive).toBeDefined();
    expect(summaries).toEqual([
      "Changed Collapse the side menu while the assistant is open: off",
    ]);
  });
});
