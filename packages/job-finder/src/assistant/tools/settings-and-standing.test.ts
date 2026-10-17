import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import { getApplicationTool, sendApplicationsTool } from "./application-tools";
import { describeApplicationStanding } from "./format";
import { dismissJobsTool } from "./jobs-tools";
import {
  setAppearanceTool,
  updateApplySettingsTool,
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

  it("lists the files an application's form was given", async () => {
    const snapshot = {
      applyJobResults: [
        {
          id: "result_1",
          runId: "run_1",
          jobId: "job_1",
          state: "submitted",
          updatedAt: "2026-09-27T10:00:00.000Z",
        },
      ],
      applicationRecords: [],
    };
    const result = await getApplicationTool.execute(
      { jobId: "job_1" },
      {
        service: {
          getWorkspaceSnapshot: () => Promise.resolve(snapshot),
          getApplyRunDetails: () =>
            Promise.resolve({
              questionRecords: [],
              answerRecords: [],
              artifactRefs: [],
              reviewCard: {
                attachments: [
                  {
                    label: "Portfolio",
                    fileName: "jamie-portfolio.pdf",
                    field: "portfolio",
                  },
                ],
              },
            }),
        } as never,
        session: {} as AssistantTurnSession,
        ports,
      },
    );
    expect((result.data as { attachedFiles: unknown[] }).attachedFiles).toEqual(
      [{ fileName: "jamie-portfolio.pdf", field: "Portfolio" }],
    );
  });

  it("sends on the person's instruction without changing the default mode", () => {
    expect(sendApplicationsTool.description).toMatch(
      /never change settings to send/u,
    );
    expect(updateApplySettingsTool.description).toMatch(
      /use send_applications and leave this alone/u,
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
