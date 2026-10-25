import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

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
import { inferAssetKind } from "./assistant";

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

