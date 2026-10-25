import {
  DiscoveryAdapterSessionStateSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";

const session = DiscoveryAdapterSessionStateSchema.parse({
  adapterKind: "target_site",
  status: "ready",
  driver: "embedded_browser_agent",
  label: "Browser ready",
  lastCheckedAt: "2026-10-21T08:00:00.000Z",
});

describe("commitDiscoverySessions", () => {

  test("survives a reopen", async () => {
    const temp = await createTempRepository("discovery-sessions-reopen-");
    const first = await temp.createRepository();
    await first.commitDiscoverySessions!(() => [session]);
    await first.close();
    const reopened = await temp.createRepository();
    try {
      expect((await reopened.getDiscoveryState()).sessions).toEqual([session]);
    } finally {
      await reopened.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});
