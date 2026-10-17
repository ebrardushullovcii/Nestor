import {
  clearUiResumeBatch,
  syncUiResumeBatch,
  invalidateUiResumeBatch,
} from "../services/assistant/ui-resume-batch";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
}));
vi.mock("../services/job-finder/workspace-service", () => ({
  getJobFinderWorkspaceService: vi.fn(),
}));
vi.mock("../services/assistant/assistant-service", () => ({
  getAssistantHost: vi.fn(),
}));
vi.mock("../services/job-finder/candidate-asset-library-instance", () => ({
  getCandidateAssetLibrary: vi.fn(),
}));

import { CandidateAssetLibrary } from "../services/job-finder/candidate-asset-library";
import { inferAssetKind, registerAssistantRouteHandlers } from "./assistant";
import { getJobFinderWorkspaceService } from "../services/job-finder/workspace-service";

describe("sidebar file attachment classification", () => {
  test.each([
    ["resume-scanned.png", "image"],
    ["CV.JPG", "image"],
    ["cover-letter.jpeg", "image"],
    ["certificate.webp", "image"],
    ["resume.pdf", "resume"],
    ["cover-letter.pdf", "cover_letter"],
    ["transcript.txt", "transcript"],
    ["portfolio.pdf", "portfolio"],
    ["document.docx", "resume"],
  ])("classifies %s as %s", (fileName, expected) => {
    expect(inferAssetKind(fileName)).toBe(expected);
  });

  test("a scan named resume-scanned.png reaches the existing image library path", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-attachment-"),
    );
    try {
      const fileName = "resume-scanned.png";
      const sourcePath = path.join(directory, fileName);
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1kAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(sourcePath, bytes);
      const library = new CandidateAssetLibrary(
        path.join(directory, "library"),
      );
      const result = await library.importFromSourcePath(sourcePath, {
        kind: inferAssetKind(fileName),
        sensitivity: "sensitive",
        consentScope: "job_application_attachment",
        retention: "until_deleted",
      });
      expect(result.status).toBe("imported");
      if (result.status !== "imported")
        throw new Error("Expected imported image");
      expect(result.asset).toMatchObject({
        kind: "image",
        mime: "image/png",
        originalName: fileName,
      });
      const resolved = await library.resolveForApplication(result.asset.id);
      expect(Buffer.from(await resolved.loadVerifiedBytes())).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("saves the batch checkpoint before acknowledging its UI update", async () => {
  const handle = vi.fn<IpcMain["handle"]>();
  const saveResumeBatchCheckpoint = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
    saveResumeBatchCheckpoint,
  } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
  vi.spyOn(BrowserWindow, "fromWebContents").mockReturnValue({
    webContents: { id: 42 },
  } as unknown as BrowserWindow);
  registerAssistantRouteHandlers({ handle } as unknown as IpcMain);
  const callback = handle.mock.calls.find(
    ([channel]) => channel === "job-finder:assistant:sync-resume-batch",
  )![1];
  const batch = {
    id: "batch",
    jobIds: ["unfinished"],
    activeJobIds: ["unfinished"],
    completedJobIds: [],
    done: false,
    stopRequested: false,
  };
  const result: unknown = await callback(
    { sender: { id: 42, on: vi.fn() } } as unknown as IpcMainInvokeEvent,
    batch,
  );
  expect(saveResumeBatchCheckpoint).toHaveBeenCalledWith(batch);
  expect(result).toEqual(batch);
});

test("late UI cleanup after workspace replacement receives Stop without persisting old jobs", async () => {
  clearUiResumeBatch();
  const batch = {
    id: "invalidated-route-queue",
    jobIds: ["old-job"],
    activeJobIds: ["old-job"],
    completedJobIds: [],
    done: false,
    stopRequested: false,
    running: true,
  };
  syncUiResumeBatch(batch);
  invalidateUiResumeBatch();
  const handle = vi.fn<IpcMain["handle"]>();
  const saveResumeBatchCheckpoint = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
    saveResumeBatchCheckpoint,
  } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
  vi.spyOn(BrowserWindow, "fromWebContents").mockReturnValue({
    webContents: { id: 42 },
  } as unknown as BrowserWindow);
  registerAssistantRouteHandlers({ handle } as unknown as IpcMain);
  const callback = handle.mock.calls.find(
    ([channel]) => channel === "job-finder:assistant:sync-resume-batch",
  )![1];
  expect(
    await callback(
      { sender: { id: 42, on: vi.fn() } } as unknown as IpcMainInvokeEvent,
      batch,
    ),
  ).toMatchObject({
    jobIds: ["old-job"],
    activeJobIds: [],
    running: false,
    stopRequested: true,
  });
  expect(saveResumeBatchCheckpoint).not.toHaveBeenCalled();
});

test("a final provider-paused checkpoint notifies the renderer only after it is durable", async () => {
  clearUiResumeBatch();
  const handle = vi.fn<IpcMain["handle"]>();
  let releaseSave!: () => void;
  const saving = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveResumeBatchCheckpoint = vi.fn(() => saving);
  vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
    saveResumeBatchCheckpoint,
  } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
  vi.spyOn(BrowserWindow, "fromWebContents").mockReturnValue({
    webContents: { id: 42 },
  } as unknown as BrowserWindow);
  const sender = {
    id: 42,
    on: vi.fn(),
    send: vi.fn(),
    isDestroyed: () => false,
  };
  registerAssistantRouteHandlers({ handle } as unknown as IpcMain);
  const callback = handle.mock.calls.find(
    ([channel]) => channel === "job-finder:assistant:sync-resume-batch",
  )![1];
  const batch = {
    id: "final-funded-pause",
    jobIds: ["one", "two"],
    activeJobIds: [],
    completedJobIds: [],
    done: false,
    stopRequested: true,
    running: false,
    providerBlock: {
      reason: "funding",
      message: "AI service unavailable: insufficient funds.",
    },
  };
  const result: unknown = callback({ sender } as unknown as IpcMainInvokeEvent, batch);
  await vi.waitFor(() =>
    expect(saveResumeBatchCheckpoint).toHaveBeenCalledOnce(),
  );
  expect(sender.send).not.toHaveBeenCalled();
  releaseSave();
  expect(await result).toEqual(batch);
  expect(sender.send).toHaveBeenCalledExactlyOnceWith(
    "job-finder:workspace-updated",
  );
  clearUiResumeBatch();
});
