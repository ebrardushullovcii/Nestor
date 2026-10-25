import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resume vision image generation", () => {
  test("rejects oversized sidecar image payloads instead of truncating JSON", async () => {
    const { appendBoundedSidecarOutputForTest } =
      await import("./resume-document-sidecar");

    expect(() =>
      appendBoundedSidecarOutputForTest("12345", "67890", 9),
    ).toThrow("Python resume parser sidecar output exceeded 9 bytes.");
  });

  test("normalizes sidecar artifacts and temporary retention metadata", async () => {
    const sidecarModule = await import("./resume-document-sidecar");
    const sidecarSpy = vi
      .spyOn(sidecarModule, "runResumeVisionImageSidecar")
      .mockResolvedValue({
        ok: true,
        artifact: {
          id: "sidecar_artifact",
          runId: "sidecar_run",
          sourceResumeId: "sidecar_resume",
          sourceFileKind: "pdf",
          createdAt: "2026-04-10T10:00:00.000Z",
          retained: "debug_retained",
          pages: [
            {
              id: "vision_page_1",
              sourceResumeId: "sidecar_resume",
              sourceFileKind: "pdf",
              pageNumber: 1,
              renderKind: "pdf_page_image",
              mimeType: "image/png",
              width: 1200,
              height: 1600,
              byteLength: 4,
              sha256: "abc123",
              dataUrl: "data:image/png;base64,AAAA",
              storagePath: "debug/page-1.png",
              retained: "debug_retained",
              generatedAt: "2026-04-10T10:00:00.000Z",
              warnings: [],
            },
          ],
          warnings: ["rendered"],
        },
        warnings: ["rendered"],
        errorMessage: null,
      });
    const { generateResumeVisionImages } =
      await import("./resume-vision-images");

    const result = await generateResumeVisionImages({
      filePath: "resume.pdf",
      runId: "run_1",
      sourceResumeId: "resume_1",
      artifactId: "vision_artifact_1",
      env: {},
    });

    expect(sidecarSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fileKind: "pdf",
        retention: "temporary",
        timeoutMs: 600_000,
      }),
    );
    expect(result.artifact).toMatchObject({
      id: "vision_artifact_1",
      runId: "run_1",
      sourceResumeId: "resume_1",
      sourceFileKind: "pdf",
      retained: "temporary",
    });
    expect(result.artifact.pages[0]).toMatchObject({
      sourceResumeId: "resume_1",
      sourceFileKind: "pdf",
      retained: "temporary",
      storagePath: null,
    });
  });

  test("honors debug retention and timeout environment settings", async () => {
    const sidecarModule = await import("./resume-document-sidecar");
    const sidecarSpy = vi
      .spyOn(sidecarModule, "runResumeVisionImageSidecar")
      .mockResolvedValue({
        ok: true,
        artifact: {
          id: "vision_artifact_2",
          runId: "run_2",
          sourceResumeId: "resume_2",
          sourceFileKind: "markdown",
          createdAt: "2026-04-10T10:00:00.000Z",
          retained: "debug_retained",
          pages: [
            {
              id: "vision_page_1",
              sourceResumeId: "resume_2",
              sourceFileKind: "markdown",
              pageNumber: 1,
              renderKind: "markdown_rendered_preview",
              mimeType: "image/png",
              width: 1200,
              height: 1600,
              byteLength: 4,
              sha256: "abc123",
              dataUrl: "data:image/png;base64,AAAA",
              storagePath: "debug/page-1.png",
              retained: "debug_retained",
              generatedAt: "2026-04-10T10:00:00.000Z",
              warnings: [],
            },
          ],
          warnings: [],
        },
        warnings: [],
        errorMessage: null,
      });
    const { generateResumeVisionImages } =
      await import("./resume-vision-images");

    const result = await generateResumeVisionImages({
      filePath: "resume.md",
      runId: "run_2",
      sourceResumeId: "resume_2",
      env: {
        NESTOR_RESUME_VISION_RETAIN_ARTIFACTS: "debug",
        NESTOR_RESUME_VISION_IMAGE_TIMEOUT_MS: "12000",
      },
    });

    expect(sidecarSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fileKind: "markdown",
        retention: "debug_retained",
        timeoutMs: 12_000,
      }),
    );
    expect(result.artifact.retained).toBe("debug_retained");
    expect(result.artifact.pages[0]?.dataUrl).toBeNull();
    expect(result.artifact.pages[0]?.storagePath).toBe("debug/page-1.png");
  });
});
