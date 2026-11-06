import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import {
  renderApplicationResume,
  applicationResumeSourceStillApproved,
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
      approved: { draft: null } as StoredResume,
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
    expect((await renderApplicationResume(f.input)).artifact).toEqual(
      f.input.artifact,
    );
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

test("a converted resume keeps its approval only while the original source bytes and identity still match", async () => {
  const f = fixture();
  const directory = await mkdtemp(
    path.join(tmpdir(), "nestor-approved-source-"),
  );
  try {
    const sourcePath = path.join(directory, "original.txt");
    const text = f.input.profile.baseResume.textContent!;
    await writeFile(sourcePath, text);
    f.input.profile.baseResume.storagePath = sourcePath;
    f.input.profile.baseResume.sha256 = createHash("sha256")
      .update(text)
      .digest("hex");
    f.input.approved.approvedAt = f.input.artifact.approvedAt;
    f.input.approved.pdfPath = null;
    f.input.artifact.source = "original_upload";
    f.input.artifact.sourceDocumentId = f.input.profile.baseResume.id;
    const { artifact } = await renderApplicationResume(f.input);
    expect(
      await applicationResumeSourceStillApproved(
        artifact,
        f.input.approved,
        f.input.profile,
      ),
    ).toBe(true);
    await writeFile(sourcePath, "Changed synthetic source");
    await expect(
      applicationResumeSourceStillApproved(
        artifact,
        f.input.approved,
        f.input.profile,
      ),
    ).rejects.toThrow("Original resume changed");
    f.input.profile.baseResume.id = "different-import";
    expect(
      await applicationResumeSourceStillApproved(
        artifact,
        f.input.approved,
        f.input.profile,
      ),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
