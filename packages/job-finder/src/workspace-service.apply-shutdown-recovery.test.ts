import {
  jobSourceValues,
} from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import {
  createBrowserRuntime,
} from "./workspace-service.test-support";

afterEach(() => {
  vi.useRealTimers();
});


describe("apply shutdown recovery", () => {
  test("shutdown closes owned browser sessions without loading discovery history", async () => {
    const runtime = createBrowserRuntime();
    const closeSession = vi.fn(runtime.closeSession.bind(runtime));
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      browserRuntime: { ...runtime, closeSession },
    });
    const readDiscovery = vi.spyOn(repository, "getDiscoveryState");
    await workspaceService.shutdown();
    expect(readDiscovery).not.toHaveBeenCalled();
    for (const source of jobSourceValues)
      expect(closeSession).toHaveBeenCalledWith(source);
  });


});
