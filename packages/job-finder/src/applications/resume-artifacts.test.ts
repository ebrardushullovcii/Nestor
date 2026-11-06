import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import { seedResumeDraft } from "../internal/resume-workspace-structure";
import {
  renderApplicationResume,
  renderReadyJobResume,
} from "./resume-artifacts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ApplicationResumeArtifact,
  StoredResume,
} from "@nestor/contracts";
import type { JobFinderDocumentManager } from "../internal/workspace-service-contracts";

function fixture(fileName = "original.txt") {
  const seed = createSeed();
  seed.profile.baseResume.textContent =
    "Jamie Synthetic\nEmail: jamie@example.test\n\nBuilt React tools.\nKept every original line.";
  const artifact = {
    id: "approved",
    source: "original_upload",
    fileName,
    filePath: `/synthetic/${fileName}`,
    sha256: "a".repeat(64),
    approvedAt: "2026-11-06T00:00:00.000Z",
  } as ApplicationResumeArtifact;
  const renderResumeArtifact = vi.fn(
    (
      input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
    ) => {
      expect(input.renderDocument.sections.length).toBeGreaterThan(0);
      return Promise.resolve({
        format: "pdf" as const,
        fileName: "jamie-resume.pdf",
        storagePath: "/synthetic/rendered.pdf",
        sha256: "b".repeat(64),
      });
    },
  );
  const renderResumeDocxArtifact = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      fileName: "jamie-resume.docx",
      storagePath: "/synthetic/rendered.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: "c".repeat(64),
    }),
  );
  return {
    input: {
      artifact,
      resume: { draft: null } as StoredResume,
      profile: seed.profile,
      settings: { ...seed.settings, resumeFormat: "html" as const },
      job: { id: "job", title: "Engineer", company: "Synthetic" } as Parameters<
        typeof renderApplicationResume
      >[0]["job"],
      documentManager: {
        renderResumeArtifact,
        renderResumeDocxArtifact,
      } as unknown as JobFinderDocumentManager,
    },
    renderResumeArtifact,
    renderResumeDocxArtifact,
  };
}

describe("approved resume application formats", () => {
  test("renders Original TXT as PDF and DOCX from the same complete text without a writer", async () => {
    const f = fixture();
    const result = await renderApplicationResume(f.input);
    expect(result.artifact).toMatchObject({
      fileName: "jamie-resume.pdf",
      sha256: "b".repeat(64),
      approvedAt: f.input.artifact.approvedAt,
    });
    expect(f.renderResumeArtifact.mock.calls[0]![0].settings.resumeFormat).toBe(
      "pdf",
    );
    const pdfDocument = f.renderResumeArtifact.mock.calls[0]![0].renderDocument;
    expect(pdfDocument.sections[0]?.text).toBe(
      f.input.profile.baseResume.textContent,
    );
    expect(f.renderResumeDocxArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ renderDocument: pdfDocument }),
    );
    expect(result.docx).toMatchObject({ fileName: "jamie-resume.docx" });
  });

  test("keeps an already approved PDF's exact file and digest", async () => {
    const f = fixture("approved.pdf");
    expect((await renderApplicationResume(f.input)).artifact).toEqual({
      ...f.input.artifact,
      textContent: f.input.profile.baseResume.textContent,
    });
    expect(f.renderResumeArtifact).not.toHaveBeenCalled();
  });

  test("fails before attaching when no approved text can be converted", async () => {
    const f = fixture();
    f.input.profile.baseResume.textContent = null;
    await expect(renderApplicationResume(f.input)).rejects.toThrow(
      "no readable content",
    );
    expect(f.renderResumeArtifact).not.toHaveBeenCalled();
  });

  test("refuses an HTML result even if the renderer returned a path", async () => {
    const f = fixture();
    f.renderResumeArtifact.mockResolvedValueOnce({
      format: "html",
      fileName: "wrong.html",
      storagePath: "/synthetic/wrong.html",
      sha256: "b".repeat(64),
    } as never);
    await expect(renderApplicationResume(f.input)).rejects.toThrow(
      "could not be rendered as PDF",
    );
  });
});

test("a continuation reuses the verified PDF and regenerates it if the approved content or file changes", async () => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-resume-copy-"));
  try {
    const storagePath = path.join(directory, "resume.pdf");
    const bytes = Buffer.from("%PDF-1.4 synthetic approved copy");
    await writeFile(storagePath, bytes);
    f.renderResumeArtifact.mockResolvedValue({
      format: "pdf",
      fileName: "resume.pdf",
      storagePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const first = await renderApplicationResume(f.input);
    const second = await renderApplicationResume({
      ...f.input,
      existingArtifact: first.artifact,
    });
    expect(second.artifact).toEqual(first.artifact);
    expect(f.renderResumeArtifact).toHaveBeenCalledTimes(1);
    await writeFile(storagePath, "corrupt synthetic copy");
    await renderApplicationResume({
      ...f.input,
      existingArtifact: first.artifact,
    });
    expect(f.renderResumeArtifact).toHaveBeenCalledTimes(2);
    await writeFile(storagePath, bytes);
    f.input.profile.baseResume.textContent += "\nAnother approved line.";
    const changed = await renderApplicationResume({
      ...f.input,
      existingArtifact: first.artifact,
    });
    expect(changed.artifact.id).not.toBe(first.artifact.id);
    expect(f.renderResumeArtifact).toHaveBeenCalledTimes(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a ready resume nobody approved is rendered once, recorded as unapproved, and reused while its words match", async () => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-ready-resume-"));
  try {
    const storagePath = path.join(directory, "resume.pdf");
    const bytes = Buffer.from("%PDF-1.4 synthetic ready resume");
    await writeFile(storagePath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    f.renderResumeArtifact.mockResolvedValue({
      format: "pdf",
      fileName: "resume.pdf",
      storagePath,
      sha256,
    });
    const seed = createSeed();
    const resume = {
      jobId: 7,
      level: "aggressive",
      state: "ready",
      approvedAt: null,
      draft: seedResumeDraft({
        profile: f.input.profile,
        job: seed.savedJobs[0]!,
        templateId: "classic_ats",
      }),
      pdfPath: null,
    } as unknown as StoredResume;
    const input = {
      resume,
      profile: f.input.profile,
      job: f.input.job,
      settings: f.input.settings,
      documentManager: f.input.documentManager,
    };
    const first = await renderReadyJobResume(input);
    expect(first.textContent).toContain(input.profile.fullName);
    expect(first).toMatchObject({
      jobId: "7",
      source: "tailored_export",
      filePath: storagePath,
      sha256,
      approvedAt: null,
      level: "aggressive",
      exportArtifactId: `job_resume_draft:7:${sha256}`,
    });
    expect(f.renderResumeArtifact.mock.calls[0]![0].settings.resumeFormat).toBe(
      "pdf",
    );
    expect(
      await renderReadyJobResume({ ...input, existingArtifact: first }),
    ).toEqual(first);
    expect(f.renderResumeArtifact).toHaveBeenCalledTimes(1);
    await expect(
      renderReadyJobResume({
        ...input,
        resume: { ...resume, state: "writing" },
      }),
    ).rejects.toThrow("still being written");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
