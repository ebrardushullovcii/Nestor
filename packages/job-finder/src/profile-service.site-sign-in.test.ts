import { describe, expect, test, vi } from "vitest";

import { createSourceDebugServiceHarness } from "./source-debug.test-support";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
} from "./profile-service.test-support";

describe("a site check that meets a sign-in page", () => {
  test("asks for the sign-in in Needs you, and a check that gets through settles it", async () => {
    const sourceAccess = { request: vi.fn(), complete: vi.fn() };
    const blocked = createSourceDebugServiceHarness({
      aiClient: createAgentAiClient(),
      browserRuntime: createAgentBrowserRuntime([], {
        phaseCompletionModeByPhase: { site_structure_mapping: "blocked_auth" },
        phaseCompletionReasonByPhase: {
          site_structure_mapping: "Sign in to see the job list.",
        },
      }),
      sourceAccess,
    });
    await blocked.seeded;
    const site = blocked.jobSites.enabled()[0]!;

    const paused = await blocked.service.runSourceDebug(String(site.id));
    expect(paused.state).toBe("paused_manual");
    expect(sourceAccess.request).toHaveBeenCalledExactlyOnceWith(
      site.id,
      expect.stringMatching(/\S/),
    );
    expect(sourceAccess.complete).not.toHaveBeenCalled();

    const signedIn = createSourceDebugServiceHarness({
      aiClient: createAgentAiClient(),
      browserRuntime: createAgentBrowserRuntime([]),
      sourceAccess,
    });
    await signedIn.seeded;
    const checked = await signedIn.service.runSourceDebug(String(site.id));
    expect(checked.state).toBe("completed");
    expect(sourceAccess.complete).toHaveBeenCalledExactlyOnceWith(site.id);
  });
});
