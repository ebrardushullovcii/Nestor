import {
  CandidateProfileSchema,
  ResumeImportRunSchema,
  ResumeImportVisionArtifactSchema,
  createFreshStartCandidateProfile,
  type ResumeDocumentBundle,
  type ResumeImportRun,
  type ResumeImportProgressEvent,
  type ResumeSourceDocument,
} from "@nestor/contracts";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const {
  mockMkdir,
  mockCopyFile,
  mockReadFile,
  mockExtractResumeDocument,
  mockGenerateResumeVisionImages,
  mockStartJobFinderRuntime,
  mockGetJobFinderDocumentsDirectory,
  mockGetPdfPageCount,
} = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockCopyFile: vi.fn(),
  mockReadFile: vi.fn(() => Promise.resolve(Buffer.from("saved resume bytes"))),
  mockExtractResumeDocument: vi.fn(),
  mockGenerateResumeVisionImages: vi.fn(),
  mockStartJobFinderRuntime: vi.fn(),
  mockGetJobFinderDocumentsDirectory: vi.fn(),
  mockGetPdfPageCount: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    mkdir: mockMkdir,
    copyFile: mockCopyFile,
    readFile: mockReadFile,
  };
});

vi.mock("../../adapters/resume-document", () => ({
  detectResumeDocumentFileKind: (filePath: string) =>
    filePath.endsWith(".pdf") ? "pdf" : "plain_text",
  extractResumeDocument: mockExtractResumeDocument,
  getPdfPageCount: mockGetPdfPageCount,
}));

vi.mock("../../adapters/resume-vision-images", () => ({
  generateResumeVisionImages: mockGenerateResumeVisionImages,
}));

vi.mock("./runtime", () => ({
  startJobFinderRuntime: mockStartJobFinderRuntime,
}));

vi.mock("./paths", () => ({
  getJobFinderDocumentsDirectory: mockGetJobFinderDocumentsDirectory,
}));

function createTestBundle(fullText: string): ResumeDocumentBundle {
  return {
    id: "bundle_test",
    runId: "run_test",
    sourceResumeId: "resume_test",
    sourceFileKind: "pdf",
    primaryParserKind: "pdfjs_text",
    parserKinds: ["pdfjs_text"],
    createdAt: "2026-04-10T00:00:00.000Z",
    warnings: [],
    languageHints: [],
    pages: [
      {
        pageNumber: 1,
        text: fullText,
        charCount: fullText.length,
        parserKinds: ["pdfjs_text"],
        usedOcr: false,
        routeKind: "native_first",
        quality: {
          score: 0.9,
          textDensity: 0.9,
          tokenCount: fullText.split(/\s+/).filter(Boolean).length,
          lineCount: fullText.split(/\r?\n/).filter(Boolean).length,
          blockCount: fullText.split(/\r?\n/).filter(Boolean).length,
          columnLikelihood: 0.08,
          readingOrderConfidence: 0.95,
          nativeTextCoverage: 1,
          ocrConfidence: null,
          imageCoverageRatio: 0,
          invalidUnicodeRatio: 0,
        },
        qualityWarnings: [],
      },
    ],
    blocks: fullText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((text, index) => ({
        id: `page_1_block_${index + 1}`,
        pageNumber: 1,
        readingOrder: index,
        text,
        kind: index === 0 ? "heading" : "paragraph",
        sectionHint: index === 0 ? "identity" : "other",
        bbox: null,
        sourceParserKinds: ["pdfjs_text"],
        sourceConfidence: 0.9,
        parserLineage: ["pdfjs_text"],
        readingOrderConfidence: 0.94,
        lineIds: [`line_${index + 1}`],
        textSpan: null,
      })),
    fullText,
    route: {
      routeKind: "native_first",
      triageReasons: ["test_fixture"],
      preferredExecutors: ["pdfjs_text"],
      usedExecutors: ["pdfjs_text"],
    },
    parserManifest: {
      workerKind: "embedded_node",
      workerVersion: process.versions.node,
      manifestVersion: "019-test-v1",
      runtimeLabel: "vitest",
      availableCapabilities: ["resume_import"],
      executorVersions: { pdfjs_text: process.versions.node },
    },
    quality: {
      score: 0.9,
      textDensity: 0.9,
      tokenCount: fullText.split(/\s+/).filter(Boolean).length,
      lineCount: fullText.split(/\r?\n/).filter(Boolean).length,
      blockCount: fullText.split(/\r?\n/).filter(Boolean).length,
      columnLikelihood: 0.08,
      readingOrderConfidence: 0.95,
      nativeTextCoverage: 1,
      ocrConfidence: null,
      imageCoverageRatio: 0,
      invalidUnicodeRatio: 0,
    },
    qualityWarnings: [],
  };
}

interface ImportedState {
  profile: ReturnType<typeof createFreshStartCandidateProfile>;
  latestResumeImportRun: ResumeImportRun | null;
}

function createSnapshot(baseResume: ResumeSourceDocument): ImportedState {
  return {
    profile: CandidateProfileSchema.parse({
      ...createFreshStartCandidateProfile(),
      baseResume,
    }),
    latestResumeImportRun: null,
  };
}

/**
 * The runtime an import runs on: what the fake import resolves with is what
 * the store holds afterwards; a failed import leaves `saved()`.
 */
function runtimeFor(service: {
  runResumeImport: (input: {
    baseResume: ResumeSourceDocument;
  }) => Promise<ImportedState>;
  saved?: () => Promise<ImportedState>;
}) {
  let state: ImportedState | null = null;
  return {
    profileService: {
      runResumeImport: async (input: { baseResume: ResumeSourceDocument }) => {
        try {
          state = await service.runResumeImport(input);
        } catch (error) {
          state = (await service.saved?.()) ?? null;
          throw error;
        }
      },
    },
    repository: {
      getProfile: () => Promise.resolve(state!.profile),
      getLatestResumeImportRun: () =>
        Promise.resolve(state?.latestResumeImportRun ?? null),
    },
  };
}

async function createTempResumeFile(fileName = "resume.pdf") {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-import-resume-test-"),
  );
  const filePath = path.join(directory, fileName);
  return { directory, filePath };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("importResumeFromSourcePath", () => {
  test("skips local image generation when scripted comparison disables vision", async () => {
    const { importResumeFromSourcePath, isDesktopResumeImportActive } =
      await import("./import-resume");
    const { directory, filePath } = await createTempResumeFile();
    const targetDirectory = path.join(directory, "target");
    const bundle = createTestBundle("Jamie Rivers\nStaff Frontend Engineer");
    const workspaceService = {
      runResumeImport: vi.fn(
        ({ baseResume }: { baseResume: ResumeSourceDocument }) =>
          Promise.resolve(createSnapshot(baseResume)),
      ),
    };
    const progressEvents: ResumeImportProgressEvent[] = [];
    const onProgress = (event: ResumeImportProgressEvent) => {
      expect(isDesktopResumeImportActive()).toBe(true);
      progressEvents.push(event);
    };

    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockGetJobFinderDocumentsDirectory.mockReturnValue(targetDirectory);
    mockStartJobFinderRuntime.mockResolvedValue(runtimeFor(workspaceService));
    mockExtractResumeDocument.mockResolvedValue({
      textContent: bundle.fullText,
      bundle,
      warnings: [],
    });

    try {
      await importResumeFromSourcePath(filePath, {
        useVision: false,
        onProgress,
      });

      expect(isDesktopResumeImportActive()).toBe(false);
      expect(mockGenerateResumeVisionImages).not.toHaveBeenCalled();
      expect(
        workspaceService.runResumeImport.mock.calls[0]?.[0],
      ).not.toHaveProperty("visionArtifact");
      const importInput = workspaceService.runResumeImport.mock.calls[0]?.[0];
      expect(importInput?.baseResume.sha256).toBe(
        "13d86dad73044606649fdd2bdc61f0ba7373885639a4c9589afd0da2ed82bbcd",
      );
      expect(progressEvents.map((event) => event.stage)).toEqual([
        "saving_file",
        "reading_document",
        "building_profile",
        "saving_results",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("routes a native no-text import through the revision-safe workspace boundary", async () => {
    const { importResumeFromSourcePath } = await import("./import-resume");
    const { directory, filePath } = await createTempResumeFile();
    const targetDirectory = path.join(directory, "target");
    const extractedBundle = {
      ...createTestBundle("native image-only resume"),
      pages: [],
      blocks: [],
      fullText: null,
    };
    const workspaceService = {
      runResumeImport: vi.fn(
        ({ baseResume }: { baseResume: ResumeSourceDocument }) =>
          Promise.resolve(createSnapshot(baseResume)),
      ),
    };
    const progressEvents: ResumeImportProgressEvent[] = [];

    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockGetJobFinderDocumentsDirectory.mockReturnValue(targetDirectory);
    mockStartJobFinderRuntime.mockResolvedValue(runtimeFor(workspaceService));
    mockExtractResumeDocument.mockResolvedValue({
      textContent: null,
      bundle: extractedBundle,
      warnings: [],
    });

    try {
      await importResumeFromSourcePath(filePath, {
        useVision: false,
        onProgress: (event) => progressEvents.push(event),
      });

      expect(workspaceService.runResumeImport).toHaveBeenCalledTimes(1);
      const [resumeImportInput] =
        workspaceService.runResumeImport.mock.calls[0] ?? [];
      expect(resumeImportInput?.baseResume).toMatchObject({
        textContent: null,
        extractionStatus: "needs_text",
      });
      // Every stage is announced, including for an unreadable file: skipping
      // one left the previous label frozen on screen for the whole wait.
      expect(progressEvents.map((event) => event.stage)).toEqual([
        "saving_file",
        "reading_document",
        "building_profile",
        "saving_results",
      ]);
      // Determinate progress: the event for a stage counts the stages behind
      // it, so the renderer can render "Step n of 4" rather than a spinner.
      expect(
        progressEvents.map((event) => [event.completed, event.total]),
      ).toEqual([
        [0, 4],
        [1, 4],
        [2, 4],
        [3, 4],
      ]);
      // The long model stage states its own cost from the first second; the
      // old 45s escalation never fired inside a 36s import.
      const buildingProfile = progressEvents.find(
        (event) => event.stage === "building_profile",
      );
      expect(buildingProfile?.expectedSecondsMin).toBe(15);
      expect(buildingProfile?.expectedSecondsMax).toBe(60);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("skips vision artifacts for plain-text resumes", async () => {
    const { importResumeFromSourcePath } = await import("./import-resume");
    const { directory, filePath } = await createTempResumeFile("resume.txt");
    const targetDirectory = path.join(directory, "target");
    const bundle = createTestBundle("Jamie Rivers\nStaff Frontend Engineer");
    const workspaceService = {
      runResumeImport: vi.fn(
        ({ baseResume }: { baseResume: ResumeSourceDocument }) =>
          Promise.resolve(createSnapshot(baseResume)),
      ),
    };

    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockGetJobFinderDocumentsDirectory.mockReturnValue(targetDirectory);
    mockStartJobFinderRuntime.mockResolvedValue(runtimeFor(workspaceService));
    mockExtractResumeDocument.mockResolvedValue({
      textContent: bundle.fullText,
      bundle,
      warnings: [],
    });

    try {
      await importResumeFromSourcePath(filePath);

      expect(mockGenerateResumeVisionImages).not.toHaveBeenCalled();
      expect(
        workspaceService.runResumeImport.mock.calls[0]?.[0],
      ).not.toHaveProperty("visionArtifact");
      const importInput = workspaceService.runResumeImport.mock.calls[0]?.[0];
      expect(importInput?.baseResume.sha256).toBe(
        "13d86dad73044606649fdd2bdc61f0ba7373885639a4c9589afd0da2ed82bbcd",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("generates vision artifacts by default", async () => {
    const { importResumeFromSourcePath } = await import("./import-resume");
    const { directory, filePath } = await createTempResumeFile();
    const targetDirectory = path.join(directory, "target");
    const bundle = createTestBundle("Jamie Rivers\nStaff Frontend Engineer");
    const workspaceService = {
      runResumeImport: vi.fn(
        ({ baseResume }: { baseResume: ResumeSourceDocument }) =>
          Promise.resolve(createSnapshot(baseResume)),
      ),
    };
    const visionArtifact = ResumeImportVisionArtifactSchema.parse({
      id: "vision_artifact_test",
      runId: "run_test",
      sourceResumeId: "resume_test",
      sourceFileKind: "pdf",
      createdAt: "2026-04-10T00:00:00.000Z",
      retained: "temporary",
      pages: [],
      warnings: [],
    });

    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockGetJobFinderDocumentsDirectory.mockReturnValue(targetDirectory);
    mockStartJobFinderRuntime.mockResolvedValue(runtimeFor(workspaceService));
    mockExtractResumeDocument.mockResolvedValue({
      textContent: bundle.fullText,
      bundle,
      warnings: [],
    });
    mockGenerateResumeVisionImages.mockResolvedValue({
      artifact: visionArtifact,
      warnings: [],
    });

    try {
      await importResumeFromSourcePath(filePath);

      expect(mockGenerateResumeVisionImages).toHaveBeenCalledTimes(1);
      expect(workspaceService.runResumeImport).toHaveBeenCalledWith(
        expect.objectContaining({ visionArtifact }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("a damaged PDF", () => {
  test("is refused before it replaces the current resume", async () => {
    const { importResumeFromSourcePath, ResumeImportUnreadableFileError } =
      await import("./import-resume");
    const { directory, filePath } =
      await createTempResumeFile("broken-resume.pdf");
    const workspaceService = {
      runResumeImport: vi.fn(),
    };
    mockMkdir.mockResolvedValue(undefined);
    mockGetJobFinderDocumentsDirectory.mockReturnValue(directory);
    mockStartJobFinderRuntime.mockResolvedValue(runtimeFor(workspaceService));
    mockGetPdfPageCount.mockRejectedValueOnce(
      new Error("Invalid PDF structure"),
    );

    try {
      await expect(importResumeFromSourcePath(filePath)).rejects.toBeInstanceOf(
        ResumeImportUnreadableFileError,
      );
      expect(mockCopyFile).not.toHaveBeenCalled();
      expect(workspaceService.runResumeImport).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("importing a stopped import's file again", () => {
  test("finds the working copy the stopped import saved", async () => {
    const { resolveResumeWorkingCopyPath } = await import("./import-resume");

    expect(
      resolveResumeWorkingCopyPath({
        documentsDirectory: "/data/documents/resumes",
        sourceResumeId: "resume_1758621600000",
        fileName: "resume-import-sample.txt",
      }),
    ).toBe(
      path.join(
        "/data/documents/resumes",
        "1758621600000_resume-import-sample.txt",
      ),
    );
    // A name can never climb out of the documents directory.
    expect(
      resolveResumeWorkingCopyPath({
        documentsDirectory: "/data/documents/resumes",
        sourceResumeId: "resume_1758621600000",
        fileName: "../../secrets.txt",
      }),
    ).toBe(path.join("/data/documents/resumes", "1758621600000_secrets.txt"));
    expect(
      resolveResumeWorkingCopyPath({
        documentsDirectory: "/data/documents/resumes",
        sourceResumeId: "resume_fresh_start",
        fileName: "resume.txt",
      }),
    ).toBeNull();
  });

  test("imports the saved copy under the file's own name, with no picker", async () => {
    const { RESUME_IMPORT_INTERRUPTED_MESSAGE, ResumeImportRunSchema } =
      await import("@nestor/contracts");
    const { retryInterruptedResumeImport } = await import("./import-resume");
    const { directory } = await createTempResumeFile();
    const documentsDirectory = path.join(directory, "documents");
    const actualFs =
      await vi.importActual<typeof FsPromises>("node:fs/promises");
    await actualFs.mkdir(documentsDirectory, { recursive: true });
    await actualFs.writeFile(
      path.join(documentsDirectory, "1758621600000_resume.txt"),
      "Jamie Rivers",
    );
    const bundle = createTestBundle("Jamie Rivers\nStaff Frontend Engineer");
    const workspaceService = {
      runResumeImport: vi.fn(
        ({ baseResume }: { baseResume: ResumeSourceDocument }) =>
          Promise.resolve(createSnapshot(baseResume)),
      ),
    };
    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockGetJobFinderDocumentsDirectory.mockReturnValue(documentsDirectory);
    mockStartJobFinderRuntime.mockResolvedValue(runtimeFor(workspaceService));
    mockExtractResumeDocument.mockResolvedValue({
      textContent: bundle.fullText,
      bundle,
      warnings: [],
    });
    const stoppedRun = ResumeImportRunSchema.parse({
      id: "resume_import_cut_off",
      sourceResumeId: "resume_1758621600000",
      sourceResumeFileName: "resume.txt",
      trigger: "import",
      status: "failed",
      startedAt: "2026-09-23T10:00:00.000Z",
      completedAt: "2026-09-23T10:05:00.000Z",
      errorMessage: RESUME_IMPORT_INTERRUPTED_MESSAGE,
    });

    try {
      await retryInterruptedResumeImport(stoppedRun);
      // R3-041: an AI failure can retry the same saved file without the picker.
      await retryInterruptedResumeImport({
        ...stoppedRun,
        failureKind: "ai_unavailable",
        errorMessage: "The AI connection failed.",
      });

      expect(mockCopyFile).toHaveBeenCalledWith(
        path.join(documentsDirectory, "1758621600000_resume.txt"),
        expect.stringMatching(/\d+_resume\.txt$/),
      );
      const importInput = workspaceService.runResumeImport.mock.calls[0]?.[0];
      expect(importInput?.baseResume.fileName).toBe("resume.txt");

      // A run stopped under an older wording is still recognised by its
      // typed failure kind, not by comparing the sentence it saved.
      workspaceService.runResumeImport.mockClear();
      await retryInterruptedResumeImport({
        ...stoppedRun,
        errorMessage:
          "This import stopped early because the app closed. Import the file again.",
        failureKind: "interrupted",
      });
      expect(workspaceService.runResumeImport).toHaveBeenCalledOnce();
      // A service failure also retries the saved file.
      await expect(
        retryInterruptedResumeImport({
          ...stoppedRun,
          errorMessage: "The resume could not be read.",
          failureKind: "ai_unavailable",
        }),
      ).resolves.toBeTruthy();

      await expect(
        retryInterruptedResumeImport({
          ...stoppedRun,
          failureKind: "invalid_document",
          errorMessage:
            "No resume details were found in this file. Choose another file.",
        }),
      ).rejects.toThrow("There is no failed import to try again.");

      // Nothing to redo, or nothing left on disk: a plain sentence.
      await expect(
        retryInterruptedResumeImport({
          ...stoppedRun,
          status: "applied",
          errorMessage: null,
        }),
      ).rejects.toThrow("There is no failed import to try again.");
      await expect(
        retryInterruptedResumeImport({
          ...stoppedRun,
          sourceResumeId: "resume_1",
        }),
      ).rejects.toThrow("is no longer on this device");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("R3-041 returns the saved failed import so retry is visible immediately", async () => {
  const { importResumeFromSourcePath } = await import("./import-resume");
  const { directory, filePath } = await createTempResumeFile();
  const bundle = createTestBundle("Fatima Noor\nfatima@example.test");
  let failedSnapshot: ReturnType<typeof createSnapshot>;
  mockGetJobFinderDocumentsDirectory.mockReturnValue(
    path.join(directory, "documents"),
  );
  mockExtractResumeDocument.mockResolvedValue({
    textContent: bundle.fullText,
    bundle,
    warnings: [],
  });
  mockMkdir.mockResolvedValue(undefined);
  mockCopyFile.mockResolvedValue(undefined);
  mockStartJobFinderRuntime.mockResolvedValue(
    runtimeFor({
      runResumeImport: vi.fn(
        ({ baseResume }: { baseResume: ResumeSourceDocument }) => {
          failedSnapshot = createSnapshot({
            ...baseResume,
            extractionStatus: "failed",
          });
          failedSnapshot.latestResumeImportRun = ResumeImportRunSchema.parse({
            id: "outage",
            sourceResumeId: baseResume.id,
            sourceResumeFileName: baseResume.fileName,
            trigger: "import",
            status: "failed",
            startedAt: baseResume.uploadedAt,
            errorMessage: "The AI connection failed. Your file is saved.",
          });
          return Promise.reject(new Error("The AI connection failed."));
        },
      ),
      saved: () => Promise.resolve(failedSnapshot),
    }),
  );
  try {
    const result = await importResumeFromSourcePath(filePath, {
      useVision: false,
    });
    expect(result.profile.baseResume.extractionStatus).toBe("failed");
    expect(result.latestResumeImportRun?.errorMessage).toContain(
      "AI connection failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reset stops an import whose document read never finishes, at once", async () => {
  const { importResumeFromSourcePath, stopDesktopResumeImports } =
    await import("./import-resume");
  const { directory, filePath } = await createTempResumeFile();
  const runResumeImport = vi.fn();
  mockMkdir.mockResolvedValue(undefined);
  mockCopyFile.mockResolvedValue(undefined);
  mockGetJobFinderDocumentsDirectory.mockReturnValue(
    path.join(directory, "documents"),
  );
  mockStartJobFinderRuntime.mockResolvedValue({
    profileService: { runResumeImport },
    repository: {},
  });
  mockExtractResumeDocument.mockReturnValue(new Promise(() => undefined));
  try {
    const importing = importResumeFromSourcePath(filePath, {
      useVision: false,
    });
    void importing.catch(() => undefined);
    await vi.waitFor(() =>
      expect(mockExtractResumeDocument).toHaveBeenCalled(),
    );

    await expect(
      Promise.race([
        stopDesktopResumeImports().then(() => "stopped"),
        new Promise((resolve) =>
          setTimeout(() => resolve("still waiting"), 1000),
        ),
      ]),
    ).resolves.toBe("stopped");
    await expect(importing).rejects.toThrow();
    expect(runResumeImport).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
