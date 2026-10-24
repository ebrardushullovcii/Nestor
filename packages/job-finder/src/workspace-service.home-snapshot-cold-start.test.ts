import { describe, expect, test, vi } from "vitest";

import type * as ApplicationCrm from "./internal/application-crm";
import type * as ResumeSettlement from "./internal/resume-settle-stored-drafts";

import { ensureCampaignState } from "./internal/campaign-dashboard";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

// Draft settlement and the no-response automation are held open, so a first
// view that waited for either would never answer.
const held = vi.hoisted(() => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open, calls: 0 };
  };
  return { settlement: gate(), automation: gate() };
});

vi.mock("./internal/resume-settle-stored-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof ResumeSettlement>()),
  settleStoredResumeDrafts: async () => {
    held.settlement.calls += 1;
    await held.settlement.promise;
    return 0;
  },
}));

vi.mock("./internal/application-crm", async (importOriginal) => ({
  ...(await importOriginal<typeof ApplicationCrm>()),
  runApplicationNoResponseAutomation: async () => {
    held.automation.calls += 1;
    await held.automation.promise;
  },
}));

describe("Home's first view on a cold start (ADR 0077)", () => {
  test("answers without draft settlement or automation, then starts them once", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    // A workspace that already has its plan, opened by a fresh service.
    await ensureCampaignState({
      repository: harness.repository,
      searchPreferences: await harness.repository.getSearchPreferences(),
    });

    const home = await harness.workspaceService.getWorkspaceHomeSnapshot?.();
    expect(home?.hydration.deferredCollections).toEqual(["discovery_jobs"]);
    expect(held.settlement.calls).toBe(0);
    expect(held.automation.calls).toBe(0);

    await vi.waitFor(() => {
      expect(held.settlement.calls).toBe(1);
      expect(held.automation.calls).toBe(1);
    });

    // The full snapshot still waits for both, and starts neither again.
    let fullLanded = false;
    const full = harness.workspaceService.getWorkspaceSnapshot().then(() => {
      fullLanded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fullLanded).toBe(false);
    held.settlement.open();
    held.automation.open();
    await full;
    expect(held.settlement.calls).toBe(1);
    expect(held.automation.calls).toBe(1);
  });
});
