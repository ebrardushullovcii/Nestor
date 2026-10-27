import { approveOriginalResumesForTests } from "@nestor/db/job-store";
import { describe, expect, it } from "vitest";

import { createProfileServiceHarness } from "../../profile-service.test-support";
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
    const { service } = createProfileServiceHarness();
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
      { service, session, ports: portsFor(service) },
    );
    expect(result.summary).toBe("Appearance is now dark.");
    expect(
      (await service.read()).settings.appearanceTheme,
    ).toBe("dark");
  });

  it("turns off folding the side menu while the assistant is open", async () => {
    const { service } = createProfileServiceHarness();
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
      { service, session, ports: portsFor(service) },
    );
    const settings = (await service.read()).settings;
    expect(settings.collapseSideMenuWithAssistant).toBe(false);
    expect(settings.writeResumesOnShortlist).toBeDefined();
    expect(summaries).toEqual([
      "Changed Collapse the side menu while the assistant is open: off",
    ]);
  });

  it("says applications already filling keep going when work is paused", async () => {
    const { service } = createProfileServiceHarness();
    const reads = assistantTestReads(service);
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
    approveOriginalResumesForTests(reads.store, ids);
    reads.applications.applyJobs({ selection: { ids } });
    reads.applications.claimNext();
    const session = {
      assertCurrent: () => undefined,
    } as unknown as AssistantTurnSession;
    const paused = await pauseActivityTool.execute(
      { paused: true, finishCurrent: false },
      {
        service,
        session,
        ports: portsFor(service),
      },
    );
    expect(paused.summary).toContain(
      "Current applications are still finishing.",
    );
  });
});
