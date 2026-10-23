import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResumeHtmlRenderInput } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { createLocalJobFinderDocumentManager } from "./job-finder-document-manager";
import { createApplyQueueDemoState } from "./job-finder-demo-state";

vi.mock("electron", () => ({ BrowserWindow: vi.fn() }));

test("simultaneous resumes for one employer keep separate files and contents", async () => {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "resume-concurrent-"),
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(1790400000000);
  try {
    const seed = createApplyQueueDemoState();
    const manager = createLocalJobFinderDocumentManager({ outputDirectory });
    const render = (headline: string) =>
      manager.renderResumeArtifact({
        job: seed.savedJobs[0]!,
        profile: seed.profile,
        templateId: "classic_ats",
        settings: { ...seed.settings, resumeFormat: "html" },
        renderDocument: {
          fullName: seed.profile.fullName ?? "Alex Vanguard",
          headline,
          location: "Remote",
          contactItems: [],
          sections: [],
        },
      });
    const [first, second] = await Promise.all([
      render("Platform specialist"),
      render("Research specialist"),
    ]);
    if (!first.storagePath || !second.storagePath)
      throw new Error("Both resumes must have files");
    expect(first.storagePath).not.toBe(second.storagePath);
    expect(first.sha256).not.toBe(second.sha256);
    expect(await readFile(first.storagePath, "utf8")).toContain(
      "Platform specialist",
    );
    expect(await readFile(second.storagePath, "utf8")).toContain(
      "Research specialist",
    );
  } finally {
    clock.mockRestore();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("artifact HTML workers receive only render data, without PDF callbacks or candidate records", async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "resume-worker-"));
  try {
    const seed = createApplyQueueDemoState();
    const renderResumeHtml = vi.fn((input: ResumeHtmlRenderInput) => {
      // Worker.postMessage rejects callbacks; exercise its cloning boundary.
      expect(Object.keys(structuredClone(input)).sort()).toEqual([
        "renderDocument",
        "settings",
        "templateId",
      ]);
      return Promise.resolve({ previewHtml: "preview", exportHtml: "export" });
    });
    const manager = createLocalJobFinderDocumentManager({
      outputDirectory,
      renderResumeHtml,
    });
    const artifact = await manager.renderResumeArtifact({
      job: seed.savedJobs[0]!,
      profile: seed.profile,
      templateId: "classic_ats",
      settings: { ...seed.settings, resumeFormat: "html" },
      renderDocument: {
        fullName: "Alex Vanguard",
        headline: null,
        location: null,
        contactItems: [],
        sections: [],
      },
      onQueueWait: vi.fn(),
      signal: new AbortController().signal,
    });
    expect(renderResumeHtml).toHaveBeenCalledOnce();
    expect(await readFile(artifact.storagePath!, "utf8")).toBe("export");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
