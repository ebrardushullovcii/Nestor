import {
  DiscoveryAdapterSessionStateSchema,
  DiscoveryRunRecordSchema,
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
  test("changes only the session states and keeps every run", async () => {
    const temp = await createTempRepository("discovery-sessions-");
    const repository = await temp.createRepository();
    try {
      await repository.commitDiscoveryStateUpdate((current) => ({
        ...current,
        recentRuns: [
          DiscoveryRunRecordSchema.parse({
            id: "run_kept",
            state: "completed",
            startedAt: "2026-10-20T08:00:00.000Z",
            completedAt: "2026-10-20T08:30:00.000Z",
            summary: {},
          }),
        ],
      }));
      // Warm both caches the way a refresh does.
      await repository.getDiscoveryState();
      await repository.readDiscoveryDisplayProjection();

      const sessions = await repository.commitDiscoverySessions!((current) => [
        ...current,
        session,
      ]);

      expect(sessions).toEqual([session]);
      const canonical = await repository.getDiscoveryState();
      expect(canonical.sessions).toEqual([session]);
      expect(canonical.recentRuns.map((run) => run.id)).toEqual(["run_kept"]);
      const display = await repository.readDiscoveryDisplayProjection();
      expect(display.sessions).toEqual([session]);
      expect(display.recentRuns.map((run) => run.id)).toEqual(["run_kept"]);
    } finally {
      await repository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

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
