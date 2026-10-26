import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import type { ResumeVisionProvider } from "@nestor/ai-providers";
import { describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "../index";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "../workspace-service.test-runtimes";
import {
  createStageCandidate,
  createTestBundle,
} from "../workspace-service.resume-analysis.shared";
import { RESUME_IMPORT_VISION_SUPERSEDED_MESSAGE } from "./resume-import-workflow";
import { interruptedTextImportMessage } from "./resume-import-recovery";

const RESUME_ID = "resume_vision_race";
const VISION_HEADLINE = "Staff Platform Engineer";

function createFreshStartSeed() {
  const baseSeed = createSeed();
  return {
    ...baseSeed,
    profile: {
      ...baseSeed.profile,
      id: "candidate_fresh_start",
      firstName: "New",
      lastName: "Candidate",
      fullName: "New Candidate",
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "Set your preferred location",
      experiences: [],
      education: [],
    },
  };
}

function createTextStageAiClient() {
  return {
    ...createAiClient(),
    extractResumeImportStage(
      input: Parameters<
        NonNullable<
          ReturnType<typeof createAiClient>["extractResumeImportStage"]
        >
      >[0],
    ) {
      if (input.stage !== "identity_summary") {
        return Promise.resolve({
          stage: input.stage,
          analysisProviderKind: "deterministic" as const,
          analysisProviderLabel: "Test AI",
          candidates: [],
          notes: [],
        });
      }

      return Promise.resolve({
        stage: input.stage,
        analysisProviderKind: "deterministic" as const,
        analysisProviderLabel: "Test AI",
        candidates: [
          createStageCandidate({
            target: { section: "contact", key: "email", recordId: null },
            label: "Email",
            value: "jamie@example.com",
            sourceBlockIds: ["page_1_block_2"],
            confidence: 0.9,
            recommendation: "auto_apply",
            overall: 0.86,
          }),
        ],
        notes: [],
      });
    },
  };
}

function createSlowVisionProvider(): ResumeVisionProvider {
  return {
    getStatus() {
      return {
        kind: "openai_compatible_vision",
        role: "vision",
        ready: true,
        label: "Slow successful vision",
        model: "FelidaeAI-Omni-3.6",
        baseUrl: "https://example.com/v1",
        modelContextWindowTokens: 139000,
        reservedHeadroomTokens: 30000,
        requestTimeoutMs: 1000,
        detail: "test",
      };
    },
    async extractResumeVision() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        analysisProviderKind: "openai_compatible_vision" as const,
        analysisProviderLabel: "Slow successful vision",
        candidates: [
          {
            ...createStageCandidate({
              target: { section: "identity", key: "headline", recordId: null },
              label: "Headline",
              value: VISION_HEADLINE,
              sourceBlockIds: [],
              confidence: 0.84,
              recommendation: "needs_review",
              overall: 0.78,
            }),
            visualEvidence: [
              {
                branch: "vision" as const,
                sourceFileKind: "pdf" as const,
                pageNumber: 1,
                regionHint: "top headline",
                confidence: 0.84,
                uncertaintyNotes: [],
              },
            ],
          },
        ],
        notes: [],
        warnings: [],
        primaryErrorMessage: null,
      };
    },
  };
}

function createService(repository: JobFinderRepository) {
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createTextStageAiClient(),
    visionProvider: createSlowVisionProvider(),
    documentManager: createDocumentManager(),
    exportFileVerifier: { exists: () => Promise.resolve(true) },
    researchAdapter: createResearchAdapter(),
  });
}

function runImport(
  workspaceService: ReturnType<typeof createService>,
  seed: ReturnType<typeof createFreshStartSeed>,
) {
  const text = "Jamie Rivers\njamie@example.com";
  return workspaceService.runResumeImport({
    baseResume: {
      ...seed.profile.baseResume,
      id: RESUME_ID,
      fileName: "resume.pdf",
      textContent: text,
    },
    documentBundle: createTestBundle({ fullText: text }),
    visionArtifact: {
      id: "vision_artifact_race_test",
      runId: "seed_run",
      sourceResumeId: RESUME_ID,
      sourceFileKind: "pdf",
      createdAt: "2026-04-10T10:00:00.000Z",
      retained: "temporary",
      pages: [
        {
          id: "vision_page_race",
          sourceResumeId: RESUME_ID,
          sourceFileKind: "pdf",
          pageNumber: 1,
          renderKind: "pdf_page_image",
          mimeType: "image/png",
          width: 1200,
          height: 1600,
          byteLength: 4,
          sha256: "abc123",
          dataUrl: "data:image/png;base64,AAAA",
          storagePath: null,
          retained: "temporary",
          generatedAt: "2026-04-10T10:00:00.000Z",
          warnings: [],
        },
      ],
      warnings: [],
    },
  });
}

describe("resume import foreground revision race", () => {
  test("attaches the imported resume file when the foreground finalization loses the race", async () => {
    const seed = createFreshStartSeed();
    const base = createInMemoryJobFinderRepository(seed);
    const importedText = "Jamie Rivers\njamie@example.com";
    let interveningEdits = 0;
    const repository: JobFinderRepository = {
      ...base,
      finalizeResumeImportRun: async (input) => {
        // An ordinary profile write (setup save, copilot apply) lands between
        // the revision this import captured and its finalization.
        await base.saveProfile({
          ...(await base.getProfile()),
          summary: `Saved the setup form while the import was running: ${++interveningEdits}.`,
        });
        return base.finalizeResumeImportRun(input);
      },
    };
    const workspaceService = createService(repository);

    await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: RESUME_ID,
        fileName: "jamie-resume.pdf",
        textContent: importedText,
      },
      documentBundle: createTestBundle({ fullText: importedText }),
    });

    const profile = await base.getProfile();
    const run = await base.getLatestResumeImportRun();
    const candidates = run
      ? await base.listResumeImportFieldCandidates({ runId: run.id })
      : [];

    // The write that won the race is still intact.
    expect(profile.summary).toBe(
      `Saved the setup form while the import was running: ${interveningEdits}.`,
    );
    // The imported details are held for the user, not applied automatically.
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((candidate) => candidate.resolution !== "auto_applied"),
    ).toBe(true);
    // The copied resume file is attached rather than orphaned, so the run,
    // its bundle, and its review items all describe the resume the profile
    // actually points at.
    expect(profile.baseResume.id).toBe(RESUME_ID);
    expect(profile.baseResume.textContent).toBe(importedText);
    expect(run?.sourceResumeId).toBe(profile.baseResume.id);
    const reachableBundles = await base.listResumeImportDocumentBundles({
      sourceResumeId: profile.baseResume.id,
    });
    expect(reachableBundles.length).toBeGreaterThan(0);
  });

  test("keeps the newest imported resume when an older import finalizes late", async () => {
    const seed = createFreshStartSeed();
    const base = createInMemoryJobFinderRepository(seed);
    // Both files carry the same header identity, so the identity guard cannot
    // be what keeps the older file out of the profile — only run ownership can.
    const sharedHeader = "Jamie Rivers\njamie@example.com";
    const firstText = `${sharedHeader}\nFirst pick`;
    const secondText = `${sharedHeader}\nSecond pick`;
    let releaseFirstFinalization!: () => void;
    let firstFinalizerEntered!: () => void;
    const firstFinalizerReady = new Promise<void>((resolve) => {
      firstFinalizerEntered = resolve;
    });
    const firstFinalizationGate = new Promise<void>((resolve) => {
      releaseFirstFinalization = resolve;
    });
    let finalizeCalls = 0;
    const repository: JobFinderRepository = {
      ...base,
      finalizeResumeImportRun: async (input) => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) {
          firstFinalizerEntered();
          await firstFinalizationGate;
        }
        return base.finalizeResumeImportRun(input);
      },
    };
    const workspaceService = createService(repository);

    const firstImport = workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_race_first",
        fileName: "first.pdf",
        textContent: firstText,
      },
      documentBundle: createTestBundle({ fullText: firstText }),
    });
    await firstFinalizerReady;

    // The user picked another file while the first import was still finishing.
    await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_race_second",
        fileName: "second.pdf",
        textContent: secondText,
      },
      documentBundle: createTestBundle({ fullText: secondText }),
    });

    releaseFirstFinalization();
    await firstImport;

    const profile = await base.getProfile();

    // The later pick owns the profile; the earlier run stays superseded rather
    // than replacing it on its way out.
    expect(profile.baseResume.id).toBe("resume_race_second");
    expect(profile.baseResume.fileName).toBe("second.pdf");
    expect(profile.baseResume.textContent).toBe(secondText);
  });

  test("does not rewrite the profile when the finalization applies normally", async () => {
    const seed = createFreshStartSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const workspaceService = createService(repository);
    const importedText = "Jamie Rivers\njamie@example.com";

    await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: RESUME_ID,
        fileName: "jamie-resume.pdf",
        textContent: importedText,
      },
      documentBundle: createTestBundle({ fullText: importedText }),
    });

    const profile = await repository.getProfile();
    const run = await repository.getLatestResumeImportRun();

    expect(profile.baseResume.id).toBe(RESUME_ID);
    expect(run?.status).not.toBe("failed");
    expect(run?.warnings.join("\n")).not.toMatch(/waiting for your review/i);
  });
});

describe("resume import multi-stage revision race", () => {
  test("applies deferred visual-scan refinements after an ordinary profile write advanced the revision", async () => {
    const seed = createFreshStartSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const workspaceService = createService(repository);

    const snapshot = await runImport(workspaceService, seed);
    const textStageStatus = snapshot.latestResumeImportRun?.status;
    expect(["applied", "review_ready"]).toContain(textStageStatus);
    expect(snapshot.latestResumeImportRun?.modelRoles?.vision.status).toBe(
      "running",
    );

    // An ordinary write between the text stage and the deferred visual scan
    // (setup save, review confirmation, copilot apply) advances the profile
    // revision the text stage finalized against.
    const edited = await repository.commitProfileUpdate((current) => ({
      ...current,
      summary: "Edited while the visual scan was still running.",
    }));
    expect(edited.status).toBe("applied");

    await vi.waitFor(
      async () => {
        const run = await repository.getLatestResumeImportRun();
        expect(run?.modelRoles?.vision.status).toBe("completed");
      },
      { timeout: 1000, interval: 10 },
    );

    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });
    const profile = await repository.getProfile();

    expect(run?.status).not.toBe("failed");
    expect(run?.errorMessage).toBeNull();
    expect(run?.warnings).not.toContain(
      RESUME_IMPORT_VISION_SUPERSEDED_MESSAGE,
    );
    expect(run?.warnings.join("\n")).not.toMatch(/superseded/i);
    expect(
      candidates.some((candidate) => candidate.sourceKind === "vision_omni"),
    ).toBe(true);
    expect(profile.headline).toBe(VISION_HEADLINE);
    expect(profile.summary).toBe(
      "Edited while the visual scan was still running.",
    );
    expect(profile.baseResume.extractionStatus).toBe("ready");
  });

  test("keeps the applied text import and its candidates when the visual scan loses the revision race twice", async () => {
    const seed = createFreshStartSeed();
    const base = createInMemoryJobFinderRepository(seed);
    let finalizeCalls = 0;
    const repository: JobFinderRepository = {
      ...base,
      finalizeResumeImportRun: async (input) => {
        finalizeCalls += 1;
        if (finalizeCalls > 1) {
          // Every visual-scan finalization races a fresh manual edit.
          await base.saveProfile({
            ...(await base.getProfile()),
            summary: `Manual edit ${finalizeCalls}`,
          });
        }
        return base.finalizeResumeImportRun(input);
      },
    };
    const workspaceService = createService(repository);

    const snapshot = await runImport(workspaceService, seed);
    const textStageStatus = snapshot.latestResumeImportRun?.status;
    expect(["applied", "review_ready"]).toContain(textStageStatus);
    const textStageCandidateCount =
      snapshot.latestResumeImportRun?.candidateCounts.total ?? 0;
    expect(textStageCandidateCount).toBeGreaterThan(0);

    await vi.waitFor(
      async () => {
        const run = await base.getLatestResumeImportRun();
        expect(run?.modelRoles?.vision.status).toBe("skipped");
      },
      { timeout: 1000, interval: 10 },
    );

    const run = await base.getLatestResumeImportRun();
    const candidates = await base.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });
    const profile = await base.getProfile();

    expect(finalizeCalls).toBe(3);
    expect(run?.status).toBe(textStageStatus);
    expect(run?.candidateCounts.total).toBe(textStageCandidateCount);
    expect(run?.errorMessage).toBeNull();
    expect(run?.warnings).toContain(RESUME_IMPORT_VISION_SUPERSEDED_MESSAGE);
    expect(run?.modelRoles?.vision.warning).toBe(
      RESUME_IMPORT_VISION_SUPERSEDED_MESSAGE,
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.some((candidate) => candidate.sourceKind === "vision_omni"),
    ).toBe(false);
    expect(profile.headline).not.toBe(VISION_HEADLINE);
    expect(profile.summary).toBe("Manual edit 3");
    expect(profile.baseResume.extractionStatus).toBe("ready");
  });
});

describe("resume import while the deferred visual scan runs", () => {
  test("a snapshot read during the visual scan keeps the applied text import", async () => {
    const seed = createFreshStartSeed();
    const base = createInMemoryJobFinderRepository(seed);
    const seenDuringVisionStage: string[] = [];
    let workspaceService: ReturnType<typeof createService> | null = null;
    let textStageFinalized = false;
    const repository: JobFinderRepository = {
      ...base,
      finalizeResumeImportRun: async (input) => {
        textStageFinalized = true;
        return base.finalizeResumeImportRun(input);
      },
      replaceResumeImportRunArtifacts: async (input) => {
        await base.replaceResumeImportRunArtifacts(input);
        if (textStageFinalized && workspaceService) {
          // Any setup save or refresh while the visual scan reconciles goes
          // through a snapshot read.
          const snapshot = await workspaceService.getWorkspaceSnapshot();
          expect(snapshot.resumeImportActive).toBe(true);
          seenDuringVisionStage.push(
            `${snapshot.latestResumeImportRun?.status}:${snapshot.latestResumeImportRun?.errorMessage ?? ""}`,
          );
        }
      },
    };
    workspaceService = createService(repository);

    const snapshot = await runImport(workspaceService, seed);
    const textStageStatus = snapshot.latestResumeImportRun?.status;
    expect(["applied", "review_ready"]).toContain(textStageStatus);

    await vi.waitFor(
      async () => {
        const run = await base.getLatestResumeImportRun();
        expect(run?.modelRoles?.vision.status).toBe("completed");
      },
      { timeout: 1000, interval: 10 },
    );

    expect(seenDuringVisionStage.length).toBeGreaterThan(0);
    for (const seen of seenDuringVisionStage) {
      expect(seen).not.toMatch(/^failed/);
      expect(seen).not.toContain(interruptedTextImportMessage);
    }
    const run = await base.getLatestResumeImportRun();
    expect(run?.status).not.toBe("failed");
    expect(run?.errorMessage).toBeNull();
    await vi.waitFor(async () =>
      expect(
        (await workspaceService.getWorkspaceSnapshot()).resumeImportActive,
      ).toBe(false),
    );
  });

  test("a visual scan that fails midway leaves the text import applied, not stopped", async () => {
    const seed = createFreshStartSeed();
    const base = createInMemoryJobFinderRepository(seed);
    let textStageFinalized = false;
    let failedOnce = false;
    const repository: JobFinderRepository = {
      ...base,
      finalizeResumeImportRun: async (input) => {
        textStageFinalized = true;
        return base.finalizeResumeImportRun(input);
      },
      replaceResumeImportRunArtifacts: async (input) => {
        if (
          textStageFinalized &&
          !failedOnce &&
          input.run.modelRoles?.adjudication.status !== "not_started" &&
          input.run.modelRoles?.vision.status !== "running"
        ) {
          failedOnce = true;
          throw new Error("Disk full while saving the visual scan.");
        }
        await base.replaceResumeImportRunArtifacts(input);
      },
    };
    const workspaceService = createService(repository);

    const snapshot = await runImport(workspaceService, seed);
    const textStageStatus = snapshot.latestResumeImportRun?.status;
    expect(["applied", "review_ready"]).toContain(textStageStatus);

    await vi.waitFor(
      async () => {
        const run = await base.getLatestResumeImportRun();
        expect(run?.modelRoles?.vision.status).toBe("failed");
      },
      { timeout: 1000, interval: 10 },
    );
    expect(failedOnce).toBe(true);

    const after = await workspaceService.getWorkspaceSnapshot();
    expect(after.latestResumeImportRun?.status).toBe(textStageStatus);
    expect(after.latestResumeImportRun?.errorMessage).toBeNull();
    expect(after.latestResumeImportRun?.warnings).not.toContain(
      interruptedTextImportMessage,
    );
  });
});
