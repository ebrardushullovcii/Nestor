import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: (contents: { id: number }) => ({ webContents: contents }),
  },
  dialog: {},
}));
vi.mock("../services/job-finder/runtime", () => ({
  getProfileService: vi.fn(),
}));
const acknowledgeNavigation = vi.hoisted(() => vi.fn());
vi.mock("../services/assistant/assistant-service", () => ({
  getAssistantHost: () => Promise.resolve({ acknowledgeNavigation }),
}));
vi.mock("../services/job-finder/candidate-asset-library-instance", () => ({
  getCandidateAssetLibrary: vi.fn(),
}));

import { CandidateAssetLibrary } from "../services/job-finder/candidate-asset-library";
import { inferAssetKind, registerAssistantRouteHandlers } from "./assistant";

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

// The preload passes this through, so main is where it is checked.
test("checks a displayed navigation acknowledgment before the assistant sees it", async () => {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  >();
  registerAssistantRouteHandlers({
    handle: (name: string, handler: never) => handlers.set(name, handler),
  } as unknown as IpcMain);
  const acknowledge = handlers.get(
    "job-finder:assistant:acknowledge-navigation",
  )!;
  const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
  const ack = {
    conversationId: "conversation",
    navigationRequestId: "request",
    displayedRoute: "x".repeat(4000),
    section: "tracker",
    overlay: "none",
    status: "displayed",
    reason: null,
  };
  await acknowledge(event, ack);
  expect(acknowledgeNavigation).toHaveBeenCalledWith(ack);
  await expect(
    acknowledge(event, { ...ack, displayedRoute: "x".repeat(4001) }),
  ).rejects.toThrow();
  expect(acknowledgeNavigation).toHaveBeenCalledTimes(1);
});
