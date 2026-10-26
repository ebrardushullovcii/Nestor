import path from "node:path";
import type * as FsPromises from "node:fs/promises";
import type * as ContractsModule from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockMkdir,
  mockOpen,
  mockReadFile,
  mockReaddir,
  mockRename,
  mockRm,
  mockStat,
  mockWriteFile,
  mockGetApplicationDocumentsDirectory,
  mockGetBrowserAgentProfileDirectory,
  mockGetCandidateAssetsDirectory,
  mockGetJobFinderDocumentsDirectory,
  mockGetJobFinderResetIntentFilePath,
  mockGetJobFinderResetInvalidIntentMarkerFilePath,
  mockGetJobFinderResetTrashDirectory,
  mockGetJobFinderResetTrashRootDirectory,
  mockGetJobFinderUserDataDirectory,
  mockResolveJobFinderWorkspaceRelativePath,
  mockGetJobFinderWorkspaceService,
  mockResetWorkspace,
  mockCloseBrowser,
  mockClearPersonPause,
  mockClearBrowserStorage,
  mockClearBrowserCache,
  mockSetActivityControl,
  mockResetJobStore,
  mockSavePause,
  mockDiscardJobSearch,
  mockResetAssistantStore,
} = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockOpen: vi.fn(),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockStat: vi.fn(),
  mockWriteFile: vi.fn(),
  mockGetApplicationDocumentsDirectory: vi.fn(),
  mockGetBrowserAgentProfileDirectory: vi.fn(),
  mockGetCandidateAssetsDirectory: vi.fn(),
  mockGetJobFinderDocumentsDirectory: vi.fn(),
  mockGetJobFinderResetIntentFilePath: vi.fn(),
  mockGetJobFinderResetInvalidIntentMarkerFilePath: vi.fn(),
  mockGetJobFinderResetTrashDirectory: vi.fn(),
  mockGetJobFinderResetTrashRootDirectory: vi.fn(),
  mockGetJobFinderUserDataDirectory: vi.fn(),
  mockResolveJobFinderWorkspaceRelativePath: vi.fn(),
  mockGetJobFinderWorkspaceService: vi.fn(),
  mockResetWorkspace: vi.fn(),
  mockCloseBrowser: vi.fn(),
  mockClearPersonPause: vi.fn(),
  mockClearBrowserStorage: vi.fn(),
  mockClearBrowserCache: vi.fn(),
  mockSetActivityControl: vi.fn(),
  mockResetJobStore: vi.fn(),
  mockSavePause: vi.fn(),
  mockDiscardJobSearch: vi.fn(),
  mockResetAssistantStore: vi.fn(),
}));

vi.mock("@nestor/db/job-store", () => ({
  resetJobStore: mockResetJobStore,
  RESET_IN_PROGRESS_PAUSE: { paused: true, pausedAt: null, reason: "held" },
  createActivityControlStore: () => ({ save: mockSavePause }),
}));
vi.mock("../job-store", () => ({ getJobStore: () => ({ store: true }) }));
vi.mock("../job-commands", () => ({ discardJobSearch: mockDiscardJobSearch }));

vi.mock("../assistant/assistant-service", () => ({
  shutdownAssistantHost: vi.fn(),
  resetAssistantStore: mockResetAssistantStore,
}));

vi.mock("../browser/embedded-browser", () => ({
  getEmbeddedBrowser: () => ({
    close: mockCloseBrowser,
    clearPersonPause: mockClearPersonPause,
    getSession: () => ({
      clearStorageData: mockClearBrowserStorage,
      clearCache: mockClearBrowserCache,
    }),
  }),
}));

// Resolved so the fake root is native on both platforms. On Windows the code
// under test builds its paths with path.join/path.resolve, which turn a
// "/user-data" root into "D:\user-data"; expectations spelled with "/" then
// matched nothing and the whole suite failed on separators rather than on
// behaviour.
const userDataRoot = path.resolve("/user-data");
const trashPathSegment = `${path.sep}trash${path.sep}`;

/** A path under the fake workspace root, spelled the way this platform does. */
function workspacePath(...segments: string[]): string {
  return path.join(userDataRoot, ...segments);
}

/**
 * The quarantined marker keeps its name and place; only the separator differs
 * by platform, so this asserts the shape without pinning one.
 */
function expectQuarantinedInvalidMarkerPath(value: string): void {
  expect(
    value.startsWith(workspacePath("job-finder-reset-intent.invalid-")),
  ).toBe(true);
  expect(value.endsWith(".json")).toBe(true);
}
const documentsRelativePath = "documents/resumes";
const candidateAssetsRelativePath = "documents/candidate-assets";
const applicationDocumentsRelativePath = "documents/application-documents";
const browserProfileRelativePath = "browser-agent/default";
const allResetSourceRelativePaths = [
  documentsRelativePath,
  candidateAssetsRelativePath,
  applicationDocumentsRelativePath,
  browserProfileRelativePath,
  "exports",
];
const intentMarkerPath = workspacePath("job-finder-reset-intent.json");
const maxMarkerBytes = 64 * 1024;

function trashDirectoryPath(token: string) {
  return workspacePath("trash", `job-finder-reset-${token}`);
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    mkdir: mockMkdir,
    open: mockOpen,
    readFile: mockReadFile,
    readdir: mockReaddir,
    rename: mockRename,
    rm: mockRm,
    stat: mockStat,
    writeFile: mockWriteFile,
  };
});

const snapshotParse = vi.hoisted(() => ({ fail: false }));
vi.mock("@nestor/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof ContractsModule>()),
  JobFinderWorkspaceSnapshotSchema: {
    parse: (value: unknown) => {
      if (snapshotParse.fail) {
        snapshotParse.fail = false;
        throw new Error("The workspace snapshot could not be read.");
      }
      return value;
    },
  },
}));

vi.mock("./paths", () => ({
  getApplicationDocumentsDirectory: mockGetApplicationDocumentsDirectory,
  getBrowserAgentProfileDirectory: mockGetBrowserAgentProfileDirectory,
  getCandidateAssetsDirectory: mockGetCandidateAssetsDirectory,
  getJobFinderDocumentsDirectory: mockGetJobFinderDocumentsDirectory,
  getJobFinderResetIntentFilePath: mockGetJobFinderResetIntentFilePath,
  getJobFinderResetInvalidIntentMarkerFilePath:
    mockGetJobFinderResetInvalidIntentMarkerFilePath,
  getJobFinderResetTrashDirectory: mockGetJobFinderResetTrashDirectory,
  getJobFinderResetTrashRootDirectory: mockGetJobFinderResetTrashRootDirectory,
  getJobFinderUserDataDirectory: mockGetJobFinderUserDataDirectory,
  resolveJobFinderWorkspaceRelativePath:
    mockResolveJobFinderWorkspaceRelativePath,
}));

vi.mock("./workspace-service", () => ({
  getJobFinderWorkspaceService: mockGetJobFinderWorkspaceService,
}));

import {
  beginJobFinderWorkspaceResetFileMoves,
  completeJobFinderWorkspaceReset,
  getJobFinderStartupResetRecoveryFact,
  JobFinderResetFileMoveError,
  recoverPendingJobFinderWorkspaceReset,
  resetJobFinderBrowser,
  resetJobFinderWorkspace,
  sweepStaleJobFinderResetArtifacts,
} from "./reset-workspace";

const defaultResetToken = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function installDefaultPathMocks() {
  mockGetJobFinderUserDataDirectory.mockReturnValue(userDataRoot);
  mockGetJobFinderDocumentsDirectory.mockReturnValue(
    workspacePath(documentsRelativePath),
  );
  mockGetCandidateAssetsDirectory.mockReturnValue(
    workspacePath(candidateAssetsRelativePath),
  );
  mockGetApplicationDocumentsDirectory.mockReturnValue(
    workspacePath(applicationDocumentsRelativePath),
  );
  mockGetBrowserAgentProfileDirectory.mockReturnValue(
    workspacePath(browserProfileRelativePath),
  );
  mockGetJobFinderResetIntentFilePath.mockReturnValue(intentMarkerPath);
  mockGetJobFinderResetInvalidIntentMarkerFilePath.mockImplementation(
    (suffix: string) =>
      workspacePath(`job-finder-reset-intent.invalid-${suffix}.json`),
  );
  mockGetJobFinderResetTrashDirectory.mockImplementation(trashDirectoryPath);
  mockGetJobFinderResetTrashRootDirectory.mockReturnValue(
    workspacePath("trash"),
  );
  mockResolveJobFinderWorkspaceRelativePath.mockImplementation(
    (relativePath: string) => path.resolve(userDataRoot, relativePath),
  );
}

function buildValidMarkerRaw(input?: {
  token?: string;
  overrides?: Record<string, unknown>;
}) {
  const token = input?.token ?? defaultResetToken;

  return JSON.stringify({
    version: 1,
    token,
    createdAt: "2026-08-01T10:00:00.000Z",
    entries: allResetSourceRelativePaths.map((sourcePath) => ({
      sourcePath,
      trashPath: `trash/job-finder-reset-${token}/${sourcePath}`,
    })),
    ...(input?.overrides ?? {}),
  });
}

function enoentError() {
  const error = new Error("no such file or directory") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function busyError(message = "device or resource busy") {
  return Object.assign(new Error(message), { code: "EBUSY" });
}

function exdevError() {
  return Object.assign(new Error("cross-device link not permitted"), {
    code: "EXDEV",
  });
}

let fileSystemEventLog: string[] = [];

function installTrackingFileSystemMocks(input?: {
  rmErrorForTokenizedTrash?: Error;
}) {
  fileSystemEventLog = [];
  mockWriteFile.mockImplementation((filePath: string) => {
    fileSystemEventLog.push(`write:${String(filePath)}`);
    return Promise.resolve();
  });
  mockMkdir.mockImplementation((directoryPath: string) => {
    fileSystemEventLog.push(`mkdir:${String(directoryPath)}`);
    return Promise.resolve();
  });
  mockOpen.mockImplementation((targetPath: string) => {
    fileSystemEventLog.push(`open:${String(targetPath)}`);
    return Promise.resolve({
      sync: () => {
        fileSystemEventLog.push(`fsync:${String(targetPath)}`);
        return Promise.resolve();
      },
      close: () => {
        fileSystemEventLog.push(`close:${String(targetPath)}`);
        return Promise.resolve();
      },
    });
  });
  mockRename.mockImplementation((from: string, to: string) => {
    fileSystemEventLog.push(`rename:${String(from)}->${String(to)}`);
    return Promise.resolve();
  });
  mockRm.mockImplementation((target: string) => {
    if (
      input?.rmErrorForTokenizedTrash &&
      String(target).startsWith(workspacePath("trash") + path.sep)
    ) {
      return Promise.reject(input.rmErrorForTokenizedTrash);
    }
    fileSystemEventLog.push(`rm:${String(target)}`);
    return Promise.resolve();
  });
}

function installOrderedResetMoveMocks(input: {
  failOnMoveIndex: number | null;
  moveFailure: Error;
  failRollback?: boolean;
}) {
  let moveIndex = 0;

  mockRename.mockImplementation((from: string, to: string) => {
    const fromPath = String(from);
    const toPath = String(to);

    if (toPath === intentMarkerPath) {
      fileSystemEventLog.push(`rename:${fromPath}->${toPath}`);
      return Promise.resolve();
    }

    if (toPath.includes(trashPathSegment)) {
      const shouldFail =
        input.failOnMoveIndex !== null && moveIndex === input.failOnMoveIndex;
      moveIndex += 1;
      if (shouldFail) {
        return Promise.reject(input.moveFailure);
      }
      fileSystemEventLog.push(`rename:${fromPath}->${toPath}`);
      return Promise.resolve();
    }

    if (fromPath.includes(trashPathSegment)) {
      if (input.failRollback) {
        return Promise.reject(input.moveFailure);
      }
      fileSystemEventLog.push(`rename:${fromPath}->${toPath}`);
      return Promise.resolve();
    }

    return Promise.reject(
      new Error(`unexpected rename ${fromPath}->${toPath}`),
    );
  });
}

beforeEach(() => {
  installDefaultPathMocks();
  installTrackingFileSystemMocks();
  mockReadFile.mockRejectedValue(enoentError());
  mockStat.mockRejectedValue(enoentError());
  mockReaddir.mockRejectedValue(enoentError());
  mockGetJobFinderWorkspaceService.mockResolvedValue({
    resetWorkspace: mockResetWorkspace,
    setActivityControl: mockSetActivityControl,
  });
  mockResetWorkspace.mockImplementation(
    async (
      _seed: unknown,
      options?: { beforeStateReset?: () => Promise<void> },
    ) => {
      await options?.beforeStateReset?.();
      return { snapshotMarker: "test-snapshot" };
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

test("browser reset for restore keeps the global pause without latching a person-close pause", async () => {
  const snapshot = { snapshotMarker: "paused-workspace" };
  const getWorkspaceSnapshot = vi.fn(() => Promise.resolve(snapshot));
  mockGetJobFinderWorkspaceService.mockResolvedValueOnce({
    setActivityControl: mockSetActivityControl,
    getWorkspaceSnapshot,
  });

  expect(await resetJobFinderBrowser()).toBe(snapshot);
  expect(mockSetActivityControl).toHaveBeenCalledExactlyOnceWith({
    paused: true,
    reason: "Browser reset",
  });
  expect(mockCloseBrowser).toHaveBeenCalledExactlyOnceWith(true);
  expect(mockClearPersonPause).toHaveBeenCalledOnce();
  expect(mockClearBrowserStorage).toHaveBeenCalledOnce();
  expect(mockClearBrowserCache).toHaveBeenCalledOnce();
  expect(mockSetActivityControl.mock.invocationCallOrder[0]).toBeLessThan(
    mockCloseBrowser.mock.invocationCallOrder[0]!,
  );
  expect(mockClearBrowserCache.mock.invocationCallOrder[0]).toBeLessThan(
    mockClearPersonPause.mock.invocationCallOrder[0]!,
  );
  expect(mockResetWorkspace).not.toHaveBeenCalled();
});

/** Whether anything lowered the pause; saves of a held pause don't count. */
const pauseLowered = () =>
  mockSavePause.mock.calls.some(
    ([control]) => (control as { paused: boolean }).paused === false,
  );

describe("the pause through a reset", () => {
  test.each([
    [
      "the workspace reset",
      () => mockResetWorkspace.mockRejectedValueOnce(new Error("locked")),
    ],
    [
      "the job-store clear",
      () =>
        mockResetJobStore.mockImplementationOnce(() => {
          throw new Error("locked");
        }),
    ],
    [
      "the Assistant's store",
      () => mockResetAssistantStore.mockRejectedValueOnce(new Error("locked")),
    ],
    [
      "the snapshot",
      () => {
        snapshotParse.fail = true;
      },
    ],
  ])("a failure in %s leaves work paused", async (_stage, inject) => {
    inject();
    await expect(resetJobFinderWorkspace()).rejects.toThrow();
    expect(pauseLowered()).toBe(false);
  });

  test("a finished reset lowers the pause as its very last step", async () => {
    await resetJobFinderWorkspace();
    const saves = mockSavePause.mock.calls.map(
      ([control]) => (control as { paused: boolean }).paused,
    );
    expect(saves.at(-1)).toBe(false);
    expect(saves.slice(0, -1)).not.toContain(false);
    const lowered = mockSavePause.mock.invocationCallOrder.at(-1)!;
    for (const step of [mockResetJobStore, mockResetAssistantStore, mockRm])
      expect(Math.max(...step.mock.invocationCallOrder)).toBeLessThan(lowered);
  });

  test("startup recovery lowers the pause only once it has finished", async () => {
    mockStat.mockResolvedValue({ size: 256, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    mockResetAssistantStore.mockRejectedValueOnce(new Error("locked"));
    await expect(
      recoverPendingJobFinderWorkspaceReset({ reset: vi.fn() }),
    ).rejects.toThrow();
    expect(pauseLowered()).toBe(false);

    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    await recoverPendingJobFinderWorkspaceReset({ reset: vi.fn() });
    expect(pauseLowered()).toBe(true);
  });
});

describe("resetJobFinderWorkspace", () => {
  test("stops work and clears live pages and storage before resetting records", async () => {
    const order: string[] = [];
    mockSetActivityControl.mockImplementationOnce(() => {
      order.push("pause");
      return Promise.resolve();
    });
    mockCloseBrowser.mockImplementationOnce(() => {
      order.push("close");
      return Promise.resolve();
    });
    mockClearBrowserStorage.mockImplementationOnce(() => {
      order.push("storage");
      return Promise.resolve();
    });
    mockClearBrowserCache.mockImplementationOnce(() => {
      order.push("cache");
      return Promise.resolve();
    });
    mockResetWorkspace.mockImplementationOnce(
      async (
        _seed: unknown,
        options: { beforeStateReset: () => Promise<void> },
      ) => {
        order.push("records");
        await options.beforeStateReset();
        return { snapshotMarker: "test-snapshot" };
      },
    );
    await resetJobFinderWorkspace();
    expect(order).toEqual(["pause", "close", "storage", "cache", "records"]);
    expect(mockCloseBrowser).toHaveBeenCalledWith(true);
  });

  test("stops the search first and clears the job store before marking the reset done", async () => {
    const markerRemoved = () =>
      mockRm.mock.calls.some(([target]) => target === intentMarkerPath);
    let removedBeforeStoreReset: boolean | null = null;
    mockResetJobStore.mockImplementationOnce(() => {
      removedBeforeStoreReset = markerRemoved();
    });
    await resetJobFinderWorkspace();
    expect(mockDiscardJobSearch).toHaveBeenCalledTimes(1);
    expect(mockResetJobStore).toHaveBeenCalledWith({ store: true });
    expect(removedBeforeStoreReset).toBe(false);
    expect(markerRemoved()).toBe(true);
  });

  test("clears the Assistant's store, grants included, before marking the reset done", async () => {
    const markerRemoved = () =>
      mockRm.mock.calls.some(([target]) => target === intentMarkerPath);
    let removedBeforeAssistantReset: boolean | null = null;
    mockResetAssistantStore.mockImplementationOnce(() => {
      removedBeforeAssistantReset = markerRemoved();
      return Promise.resolve();
    });
    await resetJobFinderWorkspace();
    expect(removedBeforeAssistantReset).toBe(false);
    expect(markerRemoved()).toBe(true);

    mockResetAssistantStore.mockRejectedValueOnce(new Error("locked"));
    mockRm.mockClear();
    await expect(resetJobFinderWorkspace()).rejects.toThrow(
      "Restart Nestor to finish the reset",
    );
    expect(markerRemoved()).toBe(false);
  });

  test("keeps the reset marker so the next start clears the store when clearing it fails", async () => {
    mockResetJobStore.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(resetJobFinderWorkspace()).rejects.toThrow(
      "Restart Nestor to finish the reset",
    );
    expect(mockRm).not.toHaveBeenCalledWith(intentMarkerPath, {
      force: true,
    });
    // The store kept its queue, so work stays paused until a reset finishes.
    expect(mockSavePause).toHaveBeenCalledWith({
      paused: true,
      pausedAt: null,
      reason: "held",
    });
  });

  test("does not delete records or report success when browser clearing fails", async () => {
    mockClearBrowserStorage.mockRejectedValueOnce(
      new Error("Storage could not be cleared"),
    );
    await expect(resetJobFinderWorkspace()).rejects.toThrow(
      "Storage could not be cleared",
    );
    expect(mockResetWorkspace).not.toHaveBeenCalled();
    expect(fileSystemEventLog).toEqual([]);
  });
  test("creates no marker, trash, or file moves when the workspace reset is blocked", async () => {
    mockResetWorkspace.mockRejectedValueOnce(
      new Error(
        "Job Finder workspace reset is unavailable while discovery is still running.",
      ),
    );

    await expect(resetJobFinderWorkspace()).rejects.toThrow(
      "workspace reset is unavailable while discovery is still running",
    );

    expect(mockResetWorkspace).toHaveBeenCalledTimes(1);
    expect(fileSystemEventLog).toEqual([]);
  });

  test("keeps files set aside and reports the safe state without undoing anything when the database reset fails after the moves", async () => {
    mockResetWorkspace.mockImplementationOnce(
      async (
        _seed: unknown,
        options?: { beforeStateReset?: () => Promise<void> },
      ) => {
        await options?.beforeStateReset?.();
        throw new Error("workspace database reset failed");
      },
    );

    let caughtError: unknown;
    try {
      await resetJobFinderWorkspace();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const failure = caughtError as Error;
    expect(failure.message).toContain(
      "before the workspace database change could be confirmed",
    );
    expect(failure.message).toContain(
      "will finish safely the next time the app starts",
    );
    expect((failure.cause as Error).message).toContain(
      "workspace database reset failed",
    );

    const rollbackRenames = fileSystemEventLog.filter((event) => {
      if (!event.startsWith("rename:")) {
        return false;
      }
      const [, destination] = event.split("->");
      return (
        !destination!.includes(trashPathSegment) &&
        allResetSourceRelativePaths.some((sourcePath) =>
          destination!.endsWith(sourcePath),
        )
      );
    });
    expect(rollbackRenames).toEqual([]);
    expect(mockRm).not.toHaveBeenCalledWith(intentMarkerPath, {
      force: true,
    });

    mockStat.mockResolvedValue({ size: 256, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    const repository = { reset: vi.fn() };
    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "completed", token: defaultResetToken });
  });

  test("writes the durable intent marker before any destructive rename, then completes cleanup after the reset succeeds", async () => {
    const snapshot = await resetJobFinderWorkspace();

    expect(snapshot).toEqual({ snapshotMarker: "test-snapshot" });

    const markerWriteEvents = fileSystemEventLog.filter((event) =>
      event.startsWith("write:"),
    );
    expect(markerWriteEvents).toHaveLength(1);

    const markerPayload = JSON.parse(
      String(mockWriteFile.mock.calls[0]?.[1]),
    ) as {
      version: number;
      token: string;
      createdAt: string;
      entries: { sourcePath: string; trashPath: string }[];
    };

    expect(markerPayload.version).toBe(1);
    expect(markerPayload.token).toMatch(/^[a-zA-Z0-9-]{8,64}$/);
    expect(markerPayload.entries).toEqual(
      allResetSourceRelativePaths.map((sourcePath) => ({
        sourcePath,
        trashPath: `trash/job-finder-reset-${markerPayload.token}/${sourcePath}`,
      })),
    );

    const markerWriteIndex = fileSystemEventLog.indexOf(markerWriteEvents[0]!);
    const firstRenameIndex = fileSystemEventLog.findIndex((event) =>
      event.startsWith("rename:"),
    );
    expect(firstRenameIndex).toBeGreaterThan(markerWriteIndex);

    const renameTargets = fileSystemEventLog
      .filter((event) => event.startsWith("rename:"))
      .map((event) => event.split("->")[1]);
    expect(renameTargets).toEqual([
      intentMarkerPath,
      ...allResetSourceRelativePaths.map(
        (sourcePath) =>
          workspacePath("trash", `job-finder-reset-${markerPayload.token}`, sourcePath),
      ),
    ]);

    const markerRemovalIndex = fileSystemEventLog.indexOf(
      `rm:${intentMarkerPath}`,
    );
    const parentFlushAfterMarkerRemovalIndex = fileSystemEventLog.indexOf(
      `fsync:${userDataRoot}`,
      markerRemovalIndex,
    );
    const trashCleanupIndex = fileSystemEventLog.indexOf(
      `rm:${trashDirectoryPath(markerPayload.token)}`,
    );
    expect(markerRemovalIndex).toBeGreaterThan(firstRenameIndex);
    expect(parentFlushAfterMarkerRemovalIndex).toBeGreaterThan(
      markerRemovalIndex,
    );
    expect(trashCleanupIndex).toBeGreaterThan(
      parentFlushAfterMarkerRemovalIndex,
    );
    // The first full reset loads the workspace service, which alone came
    // close to the 5-second default on a busy machine.
  }, 20_000);

  test("syncs the marker file before the atomic rename and best-effort flushes the parent directory", async () => {
    await beginJobFinderWorkspaceResetFileMoves();

    const temporaryMarkerPath = String(mockWriteFile.mock.calls[0]?.[0]);

    expect(fileSystemEventLog.slice(0, 7)).toEqual([
      `write:${temporaryMarkerPath}`,
      `open:${temporaryMarkerPath}`,
      `fsync:${temporaryMarkerPath}`,
      `close:${temporaryMarkerPath}`,
      `rename:${temporaryMarkerPath}->${intentMarkerPath}`,
      `open:${userDataRoot}`,
      `fsync:${userDataRoot}`,
    ]);
  });

  test("tolerates an unsupported parent-directory flush without failing the marker write", async () => {
    mockOpen.mockImplementation((targetPath: string) => {
      if (String(targetPath) === userDataRoot) {
        return Promise.reject(
          Object.assign(new Error("not supported"), { code: "EPERM" }),
        );
      }
      return Promise.resolve({
        sync: () => Promise.resolve(),
        close: () => Promise.resolve(),
      });
    });

    const intent = await beginJobFinderWorkspaceResetFileMoves();

    expect(intent.entries.map((entry) => entry.sourcePath)).toEqual(
      allResetSourceRelativePaths,
    );
    expect(fileSystemEventLog).toContain(
      `rename:${intentMarkerPath}.${intent.token}.tmp->${intentMarkerPath}`,
    );
  });

  test("surfaces a trash cleanup warning without undoing the successful reset", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    installTrackingFileSystemMocks({
      rmErrorForTokenizedTrash: new Error("trash cleanup failed"),
    });

    try {
      const snapshot = await resetJobFinderWorkspace();

      expect(snapshot).toEqual({ snapshotMarker: "test-snapshot" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        "reset trash directory",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("rolls back zero-rename failures, removes the marker, and leaves the next launch with nothing to reset", async () => {
    const moveFailure = busyError();

    mockRename.mockImplementation((_from: string, to: string) => {
      if (String(to) === intentMarkerPath) {
        fileSystemEventLog.push(`rename:${String(_from)}->${String(to)}`);
        return Promise.resolve();
      }
      return Promise.reject(moveFailure);
    });

    let caughtError: unknown;
    try {
      await beginJobFinderWorkspaceResetFileMoves();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
    const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
    expect(resetFileMoveError.restoredAllMovedSources).toBe(true);
    expect(resetFileMoveError.markerRemoved).toBe(true);
    expect(resetFileMoveError.cause).toBe(moveFailure);

    expect(mockRm).toHaveBeenCalledWith(intentMarkerPath, { force: true });

    const rollbackRenames = fileSystemEventLog.filter((event) => {
      if (!event.startsWith("rename:")) {
        return false;
      }
      const [, destination] = event.split("->");
      return (
        destination !== intentMarkerPath &&
        (destination!.endsWith(documentsRelativePath) ||
          destination!.endsWith(browserProfileRelativePath))
      );
    });
    expect(rollbackRenames).toEqual([]);

    mockResetWorkspace.mockRejectedValueOnce(
      new Error("next launch must not reach the workspace"),
    );
    const repository = { reset: vi.fn() };
    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });
    expect(repository.reset).not.toHaveBeenCalled();
  });

  test("rolls back every earlier rename when a later move fails mid-reset across the expanded scope", async () => {
    installOrderedResetMoveMocks({
      failOnMoveIndex: 3,
      moveFailure: busyError(),
    });

    let caughtError: unknown;
    try {
      await beginJobFinderWorkspaceResetFileMoves();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
    const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
    expect(resetFileMoveError.restoredAllMovedSources).toBe(true);
    expect(resetFileMoveError.markerRemoved).toBe(true);
    expect(resetFileMoveError.message).toContain(
      "the next launch will not reset anything",
    );
    expect(mockRm).toHaveBeenCalledWith(intentMarkerPath, { force: true });
    const rollbackRenameDestinations = fileSystemEventLog
      .filter(
        (event) =>
          event.startsWith("rename:") &&
          event.slice(0, event.indexOf("->")).includes(trashPathSegment),
      )
      .map((event) => event.split("->")[1]);
    expect(rollbackRenameDestinations).toEqual([
      workspacePath(applicationDocumentsRelativePath),
      workspacePath(candidateAssetsRelativePath),
      workspacePath(documentsRelativePath),
    ]);
  });

  test("reports cross-device failures through compensation while restoring earlier renames", async () => {
    installOrderedResetMoveMocks({
      failOnMoveIndex: 1,
      moveFailure: exdevError(),
    });

    await expect(beginJobFinderWorkspaceResetFileMoves()).rejects.toThrow(
      /cross-device link not permitted/,
    );

    expect(mockRm).toHaveBeenCalledWith(intentMarkerPath, { force: true });
    expect(
      fileSystemEventLog.filter((event) =>
        event.startsWith("rename:") &&
        event.slice(0, event.indexOf("->")).includes(trashPathSegment) &&
        (event
          .slice(event.indexOf("->"))
          .includes(`${path.sep}documents${path.sep}`) ||
          event
            .slice(event.indexOf("->"))
            .includes(`${path.sep}browser-agent${path.sep}`)),
      ),
    ).toHaveLength(1);
  });

  test("retains the marker for startup recovery when rollback cannot restore every moved file, then forward-recovers on the next start", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    installOrderedResetMoveMocks({
      failOnMoveIndex: 1,
      moveFailure: busyError(),
      failRollback: true,
    });

    try {
      let caughtError: unknown;
      try {
        await beginJobFinderWorkspaceResetFileMoves();
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
      const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
      expect(resetFileMoveError.restoredAllMovedSources).toBe(false);
      expect(resetFileMoveError.markerRemoved).toBe(false);
      expect(resetFileMoveError.unrestoredSourcePathCount).toBe(1);
      expect(resetFileMoveError.message).toContain("retained");
      expect(warnSpy).toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalledWith(intentMarkerPath, {
        force: true,
      });

      const repository = { reset: vi.fn() };
      mockStat.mockResolvedValue({ size: 128, mtimeMs: Date.now() });
      mockReadFile.mockResolvedValue(buildValidMarkerRaw());

      await expect(
        recoverPendingJobFinderWorkspaceReset(repository),
      ).resolves.toEqual({ status: "completed", token: defaultResetToken });

      expect(repository.reset).toHaveBeenCalledTimes(1);
      expect(mockRm).toHaveBeenCalledWith(intentMarkerPath, { force: true });
      expect(mockRm).toHaveBeenCalledWith(
        trashDirectoryPath(defaultResetToken),
        {
          recursive: true,
          force: true,
        },
      );
      expect(getJobFinderStartupResetRecoveryFact().status).toBe("completed");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("beginJobFinderWorkspaceResetFileMoves", () => {
  test("tolerates already-missing source directories while keeping the recorded intent", async () => {
    mockRename.mockImplementation((_from: string, to: string) => {
      if (!String(to).endsWith(".json")) {
        return Promise.reject(enoentError());
      }
      return Promise.resolve();
    });

    const intent = await beginJobFinderWorkspaceResetFileMoves();

    expect(intent.entries.map((entry) => entry.sourcePath)).toEqual(
      allResetSourceRelativePaths,
    );
    expect(
      intent.entries.every((entry) => entry.trashPath.includes(intent.token)),
    ).toBe(true);
  });
});

describe("completeJobFinderWorkspaceReset", () => {
  test("removes the marker first and deletes only the tokenized trash directory", async () => {
    await completeJobFinderWorkspaceReset({
      token: defaultResetToken,
      entries: [],
    });

    expect(mockRm).toHaveBeenNthCalledWith(1, intentMarkerPath, {
      force: true,
    });
    expect(mockRm).toHaveBeenNthCalledWith(
      2,
      trashDirectoryPath(defaultResetToken),
      { recursive: true, force: true },
    );
  });
});

describe("recoverPendingJobFinderWorkspaceReset", () => {
  test("reports idle and touches nothing when no intent marker exists", async () => {
    const repository = { reset: vi.fn() };

    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });

    expect(repository.reset).not.toHaveBeenCalled();
    expect(fileSystemEventLog).toEqual([]);
  });

  test("completes the reset forward idempotently: remaining moves, empty seed reset, marker removal, trash cleanup", async () => {
    mockStat.mockResolvedValue({ size: 256, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    const repository = { reset: vi.fn() };

    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "completed", token: defaultResetToken });

    const renameDestinations = fileSystemEventLog
      .filter((event) => event.startsWith("rename:"))
      .map((event) => event.split("->")[1]);
    expect(renameDestinations).toEqual(
      allResetSourceRelativePaths.map(
        (sourcePath) =>
          workspacePath("trash", `job-finder-reset-${defaultResetToken}`, sourcePath),
      ),
    );
    expect(repository.reset).toHaveBeenCalledTimes(1);
    const markerRemovalIndex = fileSystemEventLog.indexOf(
      `rm:${intentMarkerPath}`,
    );
    const parentFlushAfterMarkerRemovalIndex = fileSystemEventLog.indexOf(
      `fsync:${userDataRoot}`,
      markerRemovalIndex,
    );
    const trashCleanupIndex = fileSystemEventLog.indexOf(
      `rm:${trashDirectoryPath(defaultResetToken)}`,
    );
    expect(parentFlushAfterMarkerRemovalIndex).toBeGreaterThan(
      markerRemovalIndex,
    );
    expect(trashCleanupIndex).toBeGreaterThan(
      parentFlushAfterMarkerRemovalIndex,
    );
  });

  test("clears the job store and the Assistant's store before the marker goes, and keeps it when that fails", async () => {
    const markerRemoved = () =>
      mockRm.mock.calls.some(([target]) => target === intentMarkerPath);
    const order: string[] = [];
    mockResetJobStore.mockImplementationOnce(() => {
      order.push(`store:${markerRemoved()}`);
    });
    mockResetAssistantStore.mockImplementationOnce(() => {
      order.push(`assistant:${markerRemoved()}`);
      return Promise.resolve();
    });
    mockStat.mockResolvedValue({ size: 256, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    await expect(
      recoverPendingJobFinderWorkspaceReset({ reset: vi.fn() }),
    ).resolves.toMatchObject({ status: "completed" });
    // A grant naming job 1 must not outlive a store whose next job is 1.
    expect(order).toEqual(["store:false", "assistant:false"]);
    expect(markerRemoved()).toBe(true);

    mockRm.mockClear();
    mockResetAssistantStore.mockRejectedValueOnce(new Error("locked"));
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    await expect(
      recoverPendingJobFinderWorkspaceReset({ reset: vi.fn() }),
    ).rejects.toThrow("locked");
    expect(markerRemoved()).toBe(false);
  });

  test("quarantines an oversized marker without reading or applying it", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockStat.mockResolvedValue({
      size: maxMarkerBytes + 1,
      mtimeMs: Date.now(),
    });
    const repository = { reset: vi.fn() };

    try {
      const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

      expect(outcome.status).toBe("quarantined");
      if (outcome.status !== "quarantined") {
        throw new Error("unreachable");
      }
      expect(outcome.reason).toBe("oversized");
      expect(outcome.quarantinedFileName).toMatch(
        /^job-finder-reset-intent\.invalid-.+\.json$/,
      );
      expect(outcome).toEqual({
        status: "quarantined",
        reason: "oversized",
        quarantinedFileName: outcome.quarantinedFileName,
      });

      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(repository.reset).not.toHaveBeenCalled();

      const quarantineCall = mockRename.mock.calls.find(
        (call) => String(call[1]) !== intentMarkerPath,
      );
      expect(quarantineCall?.[0]).toBe(intentMarkerPath);
      expectQuarantinedInvalidMarkerPath(String(quarantineCall?.[1]));

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("oversized");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        "no data paths were modified",
      );
      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "marker_quarantined_oversized",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("allows markers at the exact size cap through normal validation", async () => {
    mockStat.mockResolvedValue({ size: maxMarkerBytes, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    const repository = { reset: vi.fn() };

    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "completed", token: defaultResetToken });
    expect(repository.reset).toHaveBeenCalledTimes(1);
  });

  test("quarantines malformed markers, boots startup, and never deletes or moves data paths", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const malformedMarkers = [
      "{not json raw contents",
      buildValidMarkerRaw({ overrides: { version: 2 } }),
      buildValidMarkerRaw({
        overrides: {
          entries: [
            {
              sourcePath: "documents/unmanaged-notes",
              trashPath: `trash/job-finder-reset-${defaultResetToken}/documents/unmanaged-notes`,
            },
          ],
        },
      }),
      buildValidMarkerRaw({
        overrides: {
          entries: [
            {
              sourcePath: "../../etc",
              trashPath: `trash/job-finder-reset-${defaultResetToken}/../../etc`,
            },
          ],
        },
      }),
    ];
    const repository = { reset: vi.fn() };

    try {
      mockStat.mockResolvedValue({ size: 32, mtimeMs: Date.now() });

      for (const rawMarker of malformedMarkers) {
        mockReadFile.mockResolvedValueOnce(rawMarker);

        const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

        expect(outcome).toMatchObject({
          status: "quarantined",
          reason: "malformed",
        });

        const lastRenameCall = (mockRename.mock.calls as unknown[][]).at(-1);
        expectQuarantinedInvalidMarkerPath(String(lastRenameCall?.[1]));
      }

      expect(repository.reset).not.toHaveBeenCalled();

      const dataRenames = fileSystemEventLog.filter(
        (event) =>
          event.startsWith("rename:") &&
          !event.includes("job-finder-reset-intent"),
      );
      expect(dataRenames).toEqual([]);

      const quarantineWarnings = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("Quarantined"));
      expect(quarantineWarnings.length).toBe(malformedMarkers.length);
      for (const warning of quarantineWarnings) {
        expect(warning).not.toContain("{not json raw contents");
      }

      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "marker_quarantined_malformed",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("keeps startup running when the invalid marker cannot be quarantined", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockStat.mockResolvedValue({ size: 16, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce("{ broken");
    mockRename.mockImplementation((from: string, to: string) => {
      if (String(to) !== intentMarkerPath) {
        return Promise.reject(busyError());
      }
      fileSystemEventLog.push(`rename:${String(from)}->${String(to)}`);
      return Promise.resolve();
    });
    const repository = { reset: vi.fn() };

    try {
      await expect(
        recoverPendingJobFinderWorkspaceReset(repository),
      ).resolves.toEqual({
        status: "quarantined",
        reason: "malformed",
        quarantinedFileName: null,
      });

      expect(repository.reset).not.toHaveBeenCalled();
      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "marker_quarantined_malformed",
        quarantinedFileName: null,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("pauses recovery with retained files when an invalid marker coexists with validated reset trash, recording durable evidence", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockStat.mockResolvedValue({
      size: maxMarkerBytes + 1,
      mtimeMs: Date.now(),
    });
    const pendingTrashName = "job-finder-reset-pending001";
    mockReaddir.mockImplementation((target: string) => {
      if (String(target) === workspacePath("trash")) {
        return Promise.resolve([direntFor(pendingTrashName)]);
      }
      if (String(target) === userDataRoot) {
        return Promise.resolve([]);
      }
      return Promise.reject(enoentError());
    });
    const repository = { reset: vi.fn() };

    try {
      const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

      expect(outcome.status).toBe("quarantined");
      if (outcome.status !== "quarantined") {
        throw new Error("unreachable");
      }
      expect(outcome.reason).toBe("with_pending_trash");
      expect(outcome.quarantinedFileName).toMatch(
        /^job-finder-reset-intent\.invalid-.+\.json$/,
      );

      expect(repository.reset).not.toHaveBeenCalled();

      const sidecarWriteCall = mockWriteFile.mock.calls.find((call) =>
        String(call[0]).includes(".pending-trash.json"),
      );
      expect(sidecarWriteCall).toBeTruthy();
      const sidecarPayload = JSON.parse(String(sidecarWriteCall?.[1])) as {
        version: number;
        quarantinedAt: string;
        pendingTrashDirectoryNames: string[];
      };
      expect(sidecarPayload.version).toBe(1);
      expect(typeof sidecarPayload.quarantinedAt).toBe("string");
      expect(Number.isNaN(Date.parse(sidecarPayload.quarantinedAt))).toBe(
        false,
      );
      expect(sidecarPayload.pendingTrashDirectoryNames).toEqual([
        pendingTrashName,
      ]);

      const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(
        warnings.some(
          (message) =>
            message.includes("Quarantined") &&
            message.includes("set-aside reset trash location(s)") &&
            message.includes("nothing will be deleted automatically"),
        ),
      ).toBe(true);
      expect(
        warnings.some((message) =>
          message.includes("no data paths were modified"),
        ),
      ).toBe(false);

      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "marker_quarantined_with_pending_trash",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  function direntFor(name: string) {
    return { name, isDirectory: () => true, isFile: () => false };
  }
});

describe("startup recovery database reset failures", () => {
  test("compensates moved files, removes the marker, and records a degraded fact when the database reset rejects during recovery", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockStat.mockResolvedValue({ size: 256, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValueOnce(buildValidMarkerRaw());
    const repository = {
      reset: vi.fn().mockRejectedValueOnce(new Error("reset boom")),
    };

    try {
      let caughtError: unknown;
      try {
        await recoverPendingJobFinderWorkspaceReset(repository);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
      const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
      expect(resetFileMoveError.message).toContain(
        "all moved files were restored",
      );
      expect(resetFileMoveError.message).toContain(
        "the next launch will not reset anything",
      );
      expect(resetFileMoveError.restoredAllMovedSources).toBe(true);
      expect(resetFileMoveError.markerRemoved).toBe(true);

      expect(mockRm).toHaveBeenCalledWith(intentMarkerPath, { force: true });
      const markerRemovalIndex = fileSystemEventLog.indexOf(
        `rm:${intentMarkerPath}`,
      );
      const parentFlushIndex = fileSystemEventLog.indexOf(
        `fsync:${userDataRoot}`,
        markerRemovalIndex,
      );
      expect(parentFlushIndex).toBeGreaterThan(markerRemovalIndex);

      expect(getJobFinderStartupResetRecoveryFact()).toEqual({
        status: "degraded",
        reason: "reset_recovery_failed",
        quarantinedFileName: null,
      });

      const laterRepository = { reset: vi.fn() };
      mockStat.mockRejectedValue(enoentError());
      await expect(
        recoverPendingJobFinderWorkspaceReset(laterRepository),
      ).resolves.toEqual({ status: "idle" });
      expect(laterRepository.reset).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("retains the marker and reports explicit guidance when compensation cannot restore every moved file", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockStat.mockResolvedValue({ size: 256, mtimeMs: Date.now() });
    mockReadFile.mockResolvedValue(buildValidMarkerRaw());
    mockRename.mockImplementation((from: string, to: string) => {
      const toPath = String(to);
      if (toPath === intentMarkerPath) {
        fileSystemEventLog.push(`rename:${String(from)}->${toPath}`);
        return Promise.resolve();
      }
      if (toPath.includes(trashPathSegment)) {
        fileSystemEventLog.push(`rename:${String(from)}->${toPath}`);
        return Promise.resolve();
      }
      return Promise.reject(busyError("rollback blocked"));
    });
    const repository = {
      reset: vi.fn().mockRejectedValueOnce(new Error("reset boom")),
    };

    try {
      let caughtError: unknown;
      try {
        await recoverPendingJobFinderWorkspaceReset(repository);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
      const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
      expect(resetFileMoveError.restoredAllMovedSources).toBe(false);
      expect(resetFileMoveError.markerRemoved).toBe(false);
      expect(resetFileMoveError.unrestoredSourcePathCount).toBe(
        allResetSourceRelativePaths.length,
      );
      expect(resetFileMoveError.message).toContain(
        "the next launch completes the reset during startup recovery",
      );

      expect(mockRm).not.toHaveBeenCalledWith(intentMarkerPath, {
        force: true,
      });
      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "reset_recovery_failed",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("sweepStaleJobFinderResetArtifacts", () => {
  function dirent(name: string) {
    return { name, isDirectory: () => true, isFile: () => false };
  }

  test("removes only validated stale tokenized trash directories and marker temp files, keeping the active marker token", async () => {
    const staleMoment = Date.now() - 2 * 60 * 60 * 1000;
    const staleToken = "stale-token-0001";
    const activeToken = "active-token-1";

    mockReadFile.mockResolvedValue(buildValidMarkerRaw({ token: activeToken }));
    mockReaddir.mockImplementation((target: string) => {
      if (String(target) === workspacePath("trash")) {
        return Promise.resolve([
          dirent(`job-finder-reset-${staleToken}`),
          dirent(`job-finder-reset-${activeToken}`),
          dirent("job-finder-reset-short"),
          dirent("unrelated-directory"),
        ]);
      }
      if (String(target) === userDataRoot) {
        return Promise.resolve([
          dirent(`job-finder-reset-intent.json.${staleToken}.tmp`),
          dirent("job-finder-reset-intent.json.unrelated.tmp"),
          dirent("unrelated-file.json"),
        ]);
      }
      return Promise.reject(enoentError());
    });
    mockStat.mockImplementation((target: string) => {
      const targetPath = String(target);
      if (targetPath.includes(staleToken)) {
        return Promise.resolve({ mtimeMs: staleMoment, size: 1 });
      }
      return Promise.resolve({ mtimeMs: Date.now(), size: 1 });
    });

    await sweepStaleJobFinderResetArtifacts();

    expect(mockRm).toHaveBeenCalledTimes(2);
    expect(mockRm).toHaveBeenCalledWith(
      workspacePath("trash", `job-finder-reset-${staleToken}`),
      { recursive: true, force: true },
    );
    expect(mockRm).toHaveBeenCalledWith(
      workspacePath(`job-finder-reset-intent.json.${staleToken}.tmp`),
      { recursive: true, force: true },
    );
    expect(mockRm).not.toHaveBeenCalledWith(
      workspacePath("trash", `job-finder-reset-${activeToken}`),
      expect.anything(),
    );
  });

  test("keeps fresh artifacts and warns redacted when a stale artifact cannot be removed", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const freshToken = "fresh-token-01";
    const stuckToken = "stuck-token-001";

    mockReadFile.mockRejectedValue(enoentError());
    mockReaddir.mockImplementation((target: string) => {
      if (String(target) === workspacePath("trash")) {
        return Promise.resolve([
          dirent(`job-finder-reset-${freshToken}`),
          dirent(`job-finder-reset-${stuckToken}`),
        ]);
      }
      return Promise.reject(enoentError());
    });
    mockStat.mockResolvedValue({ mtimeMs: Date.now() - 2 * 60 * 60 * 1000 });
    mockRm.mockImplementation((target: string) => {
      if (String(target).includes(stuckToken)) {
        return Promise.reject(busyError());
      }
      return Promise.resolve();
    });

    try {
      await sweepStaleJobFinderResetArtifacts();

      expect(mockRm).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warningMessage = String(warnSpy.mock.calls[0]?.[0]);
      expect(warningMessage).toContain(`job-finder-reset-${stuckToken}`);
      expect(warningMessage).toContain("left in place");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("never deletes pending trash listed in quarantine evidence, even when stale and the marker is gone", async () => {
    const heldTrashName = "job-finder-reset-held0001";
    const staleTrashName = "job-finder-reset-stale9999";
    const sidecarName =
      "job-finder-reset-intent.invalid-2026-08-23T10-00-00-000Z.json.pending-trash.json";

    mockReadFile.mockImplementation((target: string) => {
      if (String(target) === workspacePath(sidecarName)) {
        return Promise.resolve(
          `${JSON.stringify({
            version: 1,
            quarantinedAt: "2026-08-23T10:00:00.000Z",
            pendingTrashDirectoryNames: [heldTrashName],
          })}\n`,
        );
      }
      return Promise.reject(enoentError());
    });
    mockReaddir.mockImplementation((target: string) => {
      if (String(target) === workspacePath("trash")) {
        return Promise.resolve([dirent(heldTrashName), dirent(staleTrashName)]);
      }
      if (String(target) === userDataRoot) {
        return Promise.resolve([dirent(sidecarName)]);
      }
      return Promise.reject(enoentError());
    });
    const staleMoment = Date.now() - 2 * 60 * 60 * 1000;
    mockStat.mockResolvedValue({ mtimeMs: staleMoment, size: 1 });

    await sweepStaleJobFinderResetArtifacts();

    expect(mockRm).toHaveBeenCalledTimes(1);
    expect(mockRm).toHaveBeenCalledWith(
      workspacePath("trash", staleTrashName),
      { recursive: true, force: true },
    );
    expect(mockRm).not.toHaveBeenCalledWith(
      workspacePath("trash", heldTrashName),
      expect.anything(),
    );
    expect(mockRm).not.toHaveBeenCalledWith(
      workspacePath(sidecarName),
      expect.anything(),
    );
  });

  test("cleans up abandoned quarantine evidence temp files once stale", async () => {
    const abandonedTempName =
      "job-finder-reset-intent.invalid-2026-08-23T10-00-00-000Z.json.pending-trash.json.tmp";

    mockReadFile.mockRejectedValue(enoentError());
    mockReaddir.mockImplementation((target: string) => {
      if (String(target) === workspacePath("trash")) {
        return Promise.reject(enoentError());
      }
      if (String(target) === userDataRoot) {
        return Promise.resolve([dirent(abandonedTempName)]);
      }
      return Promise.reject(enoentError());
    });
    mockStat.mockResolvedValue({
      mtimeMs: Date.now() - 2 * 60 * 60 * 1000,
      size: 1,
    });

    await sweepStaleJobFinderResetArtifacts();

    expect(mockRm).toHaveBeenCalledWith(
      workspacePath(abandonedTempName),
      {
        recursive: true,
        force: true,
      },
    );
  });

  test("times out a browser clear that never finishes before deleting anything", async () => {
    vi.useFakeTimers();
    try {
      mockClearBrowserStorage.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const { resetJobFinderWorkspace } = await import("./reset-workspace");
      const result = resetJobFinderWorkspace();
      const rejection = expect(result).rejects.toThrow(
        "Your workspace was not deleted",
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(mockResetWorkspace).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
