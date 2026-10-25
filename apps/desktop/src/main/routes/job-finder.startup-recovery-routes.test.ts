import type { IpcMain } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockDismissJobFinderStartupDatabaseRecoveryNotice,
  mockGetJobFinderStartupDatabaseRecoveryFact,
  mockGetJobFinderStartupResetRecoveryFact,
} = vi.hoisted(() => ({
  mockDismissJobFinderStartupDatabaseRecoveryNotice: vi.fn(),
  mockGetJobFinderStartupDatabaseRecoveryFact: vi.fn(),
  mockGetJobFinderStartupResetRecoveryFact: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

vi.mock("../services/job-finder", () => ({
  defaultBenchmarkCases: [],
  getDesktopTestDelayMs: vi.fn(() => 0),
  getJobFinderWorkspaceService: vi.fn(),
  importResumeFromSourcePath: vi.fn(),
  isDesktopTestApiEnabled: vi.fn(() => false),
  loadApplyQueueDemoState: vi.fn(),
  loadResumeWorkspaceDemoState: vi.fn(),
  parseResumeImportPathPayload: vi.fn(),
  resetJobFinderWorkspace: vi.fn(),
  runDesktopResumeImportBenchmark: vi.fn(),
  runDesktopResumeQualityBenchmark: vi.fn(),
  setJobFinderWorkspaceServiceTestEnv: vi.fn(),
  getJobFinderStartupResetRecoveryFact:
    mockGetJobFinderStartupResetRecoveryFact,
  dismissJobFinderStartupDatabaseRecoveryNotice:
    mockDismissJobFinderStartupDatabaseRecoveryNotice,
  getJobFinderStartupDatabaseRecoveryFact:
    mockGetJobFinderStartupDatabaseRecoveryFact,
}));

import { registerJobFinderRouteHandlers } from "./job-finder";

type RegisteredHandler = (
  event: { sender: object },
  payload: unknown,
) => Promise<unknown>;

function registerAndFindHandler(channel: string): RegisteredHandler {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcMain = {
    handle: vi.fn((registeredChannel: string, handler: RegisteredHandler) => {
      handlers.set(registeredChannel, handler);
    }),
  } as unknown as IpcMain;
  registerJobFinderRouteHandlers(ipcMain);

  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Startup recovery handler was not registered: ${channel}`);
  }
  return handler;
}

function invokeHandler(channel: string): Promise<unknown> {
  return Promise.resolve().then(() =>
    registerAndFindHandler(channel)({ sender: {} }, undefined),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("job-finder startup recovery route boundary", () => {
  it("returns schema-parsed startup reset recovery facts", async () => {
    const fact = {
      status: "completed",
      token: "reset-token-1",
      completedAt: "2026-08-24T09:30:00.000Z",
    };
    mockGetJobFinderStartupResetRecoveryFact.mockReturnValue(fact);

    await expect(
      invokeHandler("job-finder:get-startup-reset-recovery"),
    ).resolves.toEqual(fact);
  });

  it("rejects malformed startup reset recovery facts instead of forwarding them", async () => {
    mockGetJobFinderStartupResetRecoveryFact.mockReturnValue({
      status: "degraded",
      reason: "not-a-real-reason",
      quarantinedFileName: null,
    });

    await expect(
      invokeHandler("job-finder:get-startup-reset-recovery"),
    ).rejects.toThrow(/reason/);
  });

  it("returns schema-parsed startup database recovery facts", async () => {
    const fact = {
      status: "blocked",
      incidentId: "incident-2",
      outcome: "salvage-required",
      candidates: [
        { kind: "backup", status: "invalid", failedStage: "integrity-check" },
      ],
      quarantineBasenames: ["workspace.sqlite.quarantine-1"],
    };
    mockGetJobFinderStartupDatabaseRecoveryFact.mockResolvedValue(fact);

    await expect(
      registerAndFindHandler("job-finder:get-startup-database-recovery")({
        sender: {},
      }, undefined),
    ).resolves.toEqual(fact);
  });

  it("rejects malformed startup database recovery facts instead of forwarding them", async () => {
    mockGetJobFinderStartupDatabaseRecoveryFact.mockResolvedValue({
      status: "blocked",
      incidentId: "incident-2",
      outcome: "salvage-required",
      candidates: [
        { kind: "backup", status: "invalid", failedStage: null },
      ],
      quarantineBasenames: [],
    });

    await expect(
      registerAndFindHandler("job-finder:get-startup-database-recovery")({
        sender: {},
      }, undefined),
    ).rejects.toThrow();
  });

  it("parses dismissal responses through the contract schema", async () => {
    const fact = {
      status: "restored",
      incidentId: "incident-1",
      restoredFrom: "backup",
      lossWindow: {
        detectedAtIso: "2026-08-20T10:00:00.000Z",
        quarantinedDatabaseModifiedAtIso: null,
        restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
      },
      quarantinedArtifactBasenames: [],
      restoredAtIso: "2026-08-20T10:05:00.000Z",
      dismissedAtIso: null,
    };
    mockDismissJobFinderStartupDatabaseRecoveryNotice.mockResolvedValue({
      ...fact,
      dismissedAtIso: "2026-08-21T08:00:00.000Z",
    });

    await expect(
      registerAndFindHandler(
        "job-finder:dismiss-startup-database-recovery-notice",
      )({ sender: {} }, undefined),
    ).resolves.toEqual({
      ...fact,
      dismissedAtIso: "2026-08-21T08:00:00.000Z",
    });
    expect(
      mockDismissJobFinderStartupDatabaseRecoveryNotice,
    ).toHaveBeenCalledWith();
  });
});
