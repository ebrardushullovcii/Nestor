import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { SourceDebugRunRecordSchema } from "@nestor/contracts";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import { describe, expect, test } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve(value: TValue): void;
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolveValue: ((value: TValue) => void) | null = null;
  const promise = new Promise<TValue>((resolve) => {
    resolveValue = resolve;
  });
  if (!resolveValue) throw new Error("Deferred promise was not initialized.");
  return { promise, resolve: resolveValue };
}

function createRunningSourceDebugRun(id: string) {
  return SourceDebugRunRecordSchema.parse({
    id,
    targetId: "target_linkedin_default",
    state: "running",
    startedAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:01:00.000Z",
    activePhase: "site_structure_mapping",
    targetLabel: "Primary target",
    targetUrl: "https://www.linkedin.com/jobs/search/",
    targetHostname: "www.linkedin.com",
    phases: ["site_structure_mapping"],
    attemptIds: [],
    phaseSummaries: [],
    instructionArtifactId: null,
  });
}

describe("discovery state writer races", () => {
  test("session refresh merges runtime observations into the latest persisted state", async () => {
    const baseRepository = createInMemoryJobFinderRepository(createSeed());
    const sessionReadStarted = createDeferred<void>();
    const releaseSessionRead = createDeferred<void>();
    const baseRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      getSessionState: (source) => {
        sessionReadStarted.resolve();
        return releaseSessionRead.promise.then(async () => ({
          ...(await baseRuntime.getSessionState(source)),
          label: "Observed after concurrent writers",
        }));
      },
    };
    const service = createJobFinderWorkspaceService({
      repository: baseRepository,
      browserRuntime,
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
    });

    const snapshotPromise = service.getWorkspaceSnapshot();
    await sessionReadStarted.promise;

    const concurrentSourceDebugRun = createRunningSourceDebugRun(
      "source_debug_concurrent_owner",
    );
    await baseRepository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.adapterKind === "target_site"
          ? { ...session, label: "Concurrent writer closed the session" }
          : session,
      ),
      activeSourceDebugRun: concurrentSourceDebugRun,
      recentSourceDebugRuns: [
        concurrentSourceDebugRun,
        ...current.recentSourceDebugRuns,
      ],
    }));

    releaseSessionRead.resolve();
    const snapshot = await snapshotPromise;

    expect(snapshot.browserSession).toMatchObject({
      label: "Observed after concurrent writers",
    });

    const persisted = await baseRepository.getDiscoveryState();
    expect(persisted.activeSourceDebugRun?.id).toBe(
      "source_debug_concurrent_owner",
    );
    expect(
      persisted.recentSourceDebugRuns.some(
        (run) => run.id === "source_debug_concurrent_owner",
      ),
    ).toBe(true);
    expect(
      persisted.sessions.find(
        (session) => session.adapterKind === "target_site",
      ),
    ).toMatchObject({ label: "Observed after concurrent writers" });
  });

  test("interrupted source-debug recovery yields to a newer owner at commit time", async () => {
    const seed = createSeed();
    seed.discovery.activeSourceDebugRun = createRunningSourceDebugRun(
      "source_debug_stale_interrupted",
    );

    const baseRepository = createInMemoryJobFinderRepository(seed);
    const newerOwnerRun = createRunningSourceDebugRun(
      "source_debug_newer_owner",
    );
    let interceptedFirstCommit = false;
    const repository: JobFinderRepository = {
      ...baseRepository,
      commitDiscoveryStateUpdate: async (update) => {
        if (!interceptedFirstCommit) {
          interceptedFirstCommit = true;
          await baseRepository.commitDiscoveryStateUpdate((current) => ({
            ...current,
            activeSourceDebugRun: newerOwnerRun,
            recentSourceDebugRuns: [
              newerOwnerRun,
              ...current.recentSourceDebugRuns,
            ],
          }));
        }
        return baseRepository.commitDiscoveryStateUpdate(update);
      },
    };
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
    });

    await service.getWorkspaceSnapshot();

    const persisted = await baseRepository.getDiscoveryState();
    expect(persisted.activeSourceDebugRun?.id).toBe("source_debug_newer_owner");
    expect(persisted.recentSourceDebugRuns.map((run) => run.id)).not.toContain(
      "source_debug_stale_interrupted",
    );
  });
});
