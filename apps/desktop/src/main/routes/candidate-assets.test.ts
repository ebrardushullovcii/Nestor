import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn().mockResolvedValue("") },
}));

vi.mock("../services/job-finder/workspace-service", () => ({
  getJobFinderWorkspaceService: vi.fn(),
}));
vi.mock("../services/job-finder/create-workspace-service", () => ({
  getJobFinderRepositoryForWorkspaceService: vi.fn(),
}));
vi.mock("../services/job-finder/candidate-asset-library-instance", () => ({
  getCandidateAssetLibrary: vi.fn(),
}));

import { shell } from "electron";
import {
  ResumeSourceDocumentSchema,
  CandidateAssetListResultSchema,
} from "@nestor/contracts";
import { CandidateAssetLibrary } from "../services/job-finder/candidate-asset-library";
import { getCandidateAssetLibrary } from "../services/job-finder/candidate-asset-library-instance";
import { getJobFinderRepositoryForWorkspaceService } from "../services/job-finder/create-workspace-service";
import { getJobFinderWorkspaceService } from "../services/job-finder/workspace-service";
import { createEmptyJobFinderRepositoryState } from "../adapters/job-finder-initial-state";
import { registerCandidateAssetRouteHandlers } from "./candidate-assets";

type RouteHandler = (
  event: IpcMainInvokeEvent,
  payload?: unknown,
) => Promise<unknown>;

describe("candidate asset IPC routes", () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  test("validates import/list/delete/restore payloads and returns renderer-safe metadata", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "candidate-assets-route-"),
    );
    const sourcePath = path.join(temporaryDirectory, "portfolio.pdf");
    await writeFile(sourcePath, "%PDF-1.7\nportfolio\n%%EOF", "utf8");
    const handlers = new Map<string, RouteHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RouteHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    const library = new CandidateAssetLibrary(
      path.join(temporaryDirectory, "library"),
    );
    registerCandidateAssetRouteHandlers(ipcMain, {
      library,
      selectFile: () => Promise.resolve(sourcePath),
    });
    const event = { sender: {} } as IpcMainInvokeEvent;

    const imported = await handlers.get("job-finder:candidate-assets:import")!(
      event,
      {
        kind: "portfolio",
        sensitivity: "sensitive",
        consentScope: "private_storage_only",
        retention: "until_deleted",
      },
    );
    expect(imported).toMatchObject({
      status: "imported",
      asset: { originalName: "portfolio.pdf" },
    });
    expect(imported).not.toHaveProperty("asset.path");

    const listed = (await handlers.get("job-finder:candidate-assets:list")!(
      event,
      {},
    )) as { assets: Array<{ id: string }> };
    expect(listed.assets).toHaveLength(1);

    await handlers.get("job-finder:candidate-assets:delete")!(event, {
      assetId: listed.assets[0]!.id,
    });
    expect(
      await handlers.get("job-finder:candidate-assets:list")!(event, {}),
    ).toEqual({ assets: [] });
    await expect(
      handlers.get("job-finder:candidate-assets:restore")!(event, {
        assetId: listed.assets[0]!.id,
      }),
    ).rejects.toBeTruthy();
    const restored = await handlers.get("job-finder:candidate-assets:restore")!(
      event,
      {
        assetId: listed.assets[0]!.id,
        retention: "90_days",
      },
    );
    expect(restored).toMatchObject({
      asset: {
        id: listed.assets[0]!.id,
        retention: "90_days",
        deletedAt: null,
      },
    });
    await expect(
      handlers.get("job-finder:candidate-assets:import")!(event, {
        kind: "not-a-kind",
      }),
    ).rejects.toBeTruthy();
  });

  test("returns a typed cancellation without receiving a renderer file path", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "candidate-assets-route-"),
    );
    const handlers = new Map<string, RouteHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RouteHandler) =>
        handlers.set(channel, handler),
      ),
    } as unknown as IpcMain;
    registerCandidateAssetRouteHandlers(ipcMain, {
      library: new CandidateAssetLibrary(
        path.join(temporaryDirectory, "library"),
      ),
      selectFile: () => Promise.resolve(null),
    });

    await expect(
      handlers.get("job-finder:candidate-assets:import")!(
        { sender: {} } as IpcMainInvokeEvent,
        { kind: "resume" },
      ),
    ).resolves.toEqual({ status: "cancelled" });
  });

  test("tells waiting applications when an attachable file is added or restored", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "candidate-assets-route-"),
    );
    const sourcePath = path.join(temporaryDirectory, "portfolio.pdf");
    await writeFile(sourcePath, "%PDF-1.7\nportfolio\n%%EOF", "utf8");
    const handlers = new Map<string, RouteHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RouteHandler) =>
        handlers.set(channel, handler),
      ),
    } as unknown as IpcMain;
    const onApplicationFileAvailable = vi.fn(() => Promise.resolve(1));
    registerCandidateAssetRouteHandlers(ipcMain, {
      library: new CandidateAssetLibrary(
        path.join(temporaryDirectory, "library"),
      ),
      selectFile: () => Promise.resolve(sourcePath),
      onApplicationFileAvailable,
    });
    const event = { sender: {} } as IpcMainInvokeEvent;

    // A private-only file is not one the applications may attach.
    await handlers.get("job-finder:candidate-assets:import")!(event, {
      kind: "portfolio",
      consentScope: "private_storage_only",
    });
    expect(onApplicationFileAvailable).not.toHaveBeenCalled();

    const imported = (await handlers.get("job-finder:candidate-assets:import")!(
      event,
      { kind: "portfolio", consentScope: "job_application_attachment" },
    )) as { asset: { id: string } };
    expect(onApplicationFileAvailable).toHaveBeenCalledTimes(1);
    expect(onApplicationFileAvailable).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: imported.asset.id, kind: "portfolio" }),
    );

    await handlers.get("job-finder:candidate-assets:delete")!(event, {
      assetId: imported.asset.id,
    });
    expect(onApplicationFileAvailable).toHaveBeenCalledTimes(1);
    await handlers.get("job-finder:candidate-assets:restore")!(event, {
      assetId: imported.asset.id,
      retention: "until_deleted",
    });
    expect(onApplicationFileAvailable).toHaveBeenCalledTimes(2);
    expect(onApplicationFileAvailable).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: imported.asset.id, deletedAt: null }),
    );
  });
  test("reads original attachment metadata and opens a copy using only the stored profile", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "resume-route-"));
    const sourcePath = path.join(temporaryDirectory, "original.docx");
    await writeFile(sourcePath, "synthetic document bytes");
    const source = ResumeSourceDocumentSchema.parse({
      id: "source_resume",
      fileName: "original.docx",
      storagePath: sourcePath,
      uploadedAt: "2026-10-01T12:00:00.000Z",
    });
    const handlers = new Map<string, RouteHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RouteHandler) =>
        handlers.set(channel, handler),
      ),
    } as unknown as IpcMain;
    const getWorkspaceSnapshot = vi.fn(() => {
      throw new Error("Canonical read is forbidden for the original resume");
    });
    const getWorkspaceProjection = vi.fn();
    const service = { getWorkspaceSnapshot, getWorkspaceProjection };
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue(
      service as unknown as Awaited<
        ReturnType<typeof getJobFinderWorkspaceService>
      >,
    );
    const profile = {
      ...createEmptyJobFinderRepositoryState().profile,
      baseResume: source,
    };
    const getProfile = vi.fn().mockResolvedValue(profile);
    vi.mocked(getJobFinderRepositoryForWorkspaceService).mockReturnValue({
      getProfile,
    } as unknown as NonNullable<
      ReturnType<typeof getJobFinderRepositoryForWorkspaceService>
    >);
    vi.mocked(getCandidateAssetLibrary).mockReturnValue(
      new CandidateAssetLibrary(path.join(temporaryDirectory, "assets")),
    );
    registerCandidateAssetRouteHandlers(ipcMain);
    const event = {} as IpcMainInvokeEvent;
    const result = CandidateAssetListResultSchema.parse(
      await handlers.get("job-finder:candidate-assets:list")!(event, {
        resumeSourceId: source.id,
      }),
    );
    expect(result.originalResumeFile).toEqual({
      id: source.id,
      fileName: source.fileName,
      fileType: "DOCX",
      byteSize: 24,
      importedAt: source.uploadedAt,
    });
    expect(JSON.stringify(result)).not.toContain(sourcePath);
    expect(
      await handlers.get("job-finder:candidate-assets:open")!(event, {
        assetId: source.id,
      }),
    ).toEqual({ outcome: "opened" });
    const viewingPath = vi.mocked(shell).openPath.mock.calls.at(-1)![0];
    expect(viewingPath).not.toBe(sourcePath);
    expect(await readFile(viewingPath, "utf8")).toBe(
      "synthetic document bytes",
    );
    await rm(path.dirname(viewingPath), { recursive: true, force: true });
    expect(
      await handlers.get("job-finder:candidate-assets:open")!(event, {
        assetId: "other_source",
      }),
    ).toEqual({ outcome: "not_found" });
    expect(getJobFinderRepositoryForWorkspaceService).toHaveBeenCalledWith(
      service,
    );
    expect(getProfile).toHaveBeenCalledTimes(3);
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(getWorkspaceProjection).not.toHaveBeenCalled();
  });
});
