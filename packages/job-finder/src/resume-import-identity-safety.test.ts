import {
  CandidateProfileSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
} from "@nestor/contracts";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import { describe, expect, test } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import { buildResumeDraftIdentity } from "./internal/resume-workspace-structure";
import {
  describeResumeIdentityOwnershipChoice,
  findResumeImportIdentityConflicts,
  resolveResumeIdentity,
  extractIdentityNameFromLine,
  useResumeSourceNameForProfile,
} from "./internal/resume-identity";
import { reconcileCandidates } from "./internal/resume-import-reconciliation";
import { createSeed } from "./workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";
import {
  createStageCandidate,
  createTestBundle,
} from "./workspace-service.resume-analysis.shared";

function createService(repository: JobFinderRepository) {
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: { exists: () => Promise.resolve(true) },
    researchAdapter: createResearchAdapter(),
  });
}

function createCaseyProfile() {
  const seed = createSeed();
  return CandidateProfileSchema.parse({
    ...seed.profile,
    firstName: "Casey",
    lastName: "Rowan",
    middleName: null,
    fullName: "Casey Rowan",
    preferredDisplayName: "Casey Rowan",
    currentLocation: "Casey City",
    email: "casey@example.com",
    applicationIdentity: {
      ...seed.profile.applicationIdentity,
      preferredEmail: "casey@example.com",
    },
    baseResume: {
      ...seed.profile.baseResume,
      id: "resume_casey",
      fileName: "casey-resume.txt",
      textContent: "Casey Rowan\nCasey City\ncasey@example.com",
    },
    skills: ["Casey Skill"],
  });
}

function createIdentityCandidate(input: {
  id: string;
  key: string;
  value: string;
}) {
  return ResumeImportFieldCandidateSchema.parse({
    ...createStageCandidate({
      target: { section: "identity", key: input.key, recordId: null },
      label: input.key,
      value: input.value,
      sourceBlockIds: ["page_1_block_1"],
      confidence: 0.95,
      recommendation: "auto_apply",
      overall: 0.95,
    }),
    id: input.id,
    runId: "run_identity_safety",
    sourceKind: "parser_literal",
    createdAt: "2026-08-31T10:00:00.000Z",
    resolution: "needs_review",
    resolutionReason: null,
    resolvedAt: null,
  });
}

describe("resume import identity and revision safety", () => {
  test("keeps a manual profile edit when a delayed import finalizer becomes stale", async () => {
    const seed = createSeed();
    const caseyProfile = createCaseyProfile();
    const base = createInMemoryJobFinderRepository({
      ...seed,
      profile: caseyProfile,
    });
    let releaseFinalization!: () => void;
    let finalizerEntered!: () => void;
    const finalizerReady = new Promise<void>((resolve) => {
      finalizerEntered = resolve;
    });
    const finalizationGate = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    const repository: JobFinderRepository = {
      ...base,
      finalizeResumeImportRun: async (input) => {
        finalizerEntered();
        await finalizationGate;
        return base.finalizeResumeImportRun(input);
      },
    };
    const workspaceService = createService(repository);
    const importedText =
      "Taylor Quinn\nTaylor City\ntaylor@example.com\nP01 Imported Skill";

    const pendingImport = workspaceService.runResumeImport({
      baseResume: {
        ...caseyProfile.baseResume,
        id: "resume_p01_first_job",
        fileName: "first-job.txt",
        textContent: importedText,
      },
      documentBundle: createTestBundle({ fullText: importedText }),
    });
    await finalizerReady;

    await base.saveProfile({
      ...caseyProfile,
      currentLocation: "Casey Manual Location",
      skills: ["Casey Manual Skill"],
    });
    releaseFinalization();

    const snapshot = await pendingImport;
    const profile = await base.getProfile();
    const run = await base.getLatestResumeImportRun();
    const candidates = run
      ? await base.listResumeImportFieldCandidates({ runId: run.id })
      : [];

    expect(profile.fullName).toBe("Casey Rowan");
    expect(profile.currentLocation).toBe("Casey Manual Location");
    expect(profile.skills).toEqual(["Casey Manual Skill"]);
    // A losing import may attach its copied file so the run is not orphaned,
    // but never when the imported header describes a different person than
    // the profile that won the race: writing Taylor's resume text under
    // Casey's visible identity makes `resolveResumeIdentity` report a
    // mismatch, which hard-blocks resume generation, preview, export and
    // approval with no way out. The imported details stay in review instead.
    expect(profile.baseResume.id).toBe("resume_casey");
    expect(resolveResumeIdentity(profile).mismatchReasons).toEqual([]);
    // Losing the revision race is not an extraction failure: the current
    // profile is kept and the imported details are held for review instead
    // of being discarded or reported as a failed import.
    expect(run?.status).toBe("review_ready");
    expect(run?.errorMessage).toBeNull();
    expect(run?.warnings.join("\n")).toMatch(/waiting for your review/i);
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((candidate) => candidate.resolution !== "auto_applied"),
    ).toBe(true);
    expect(run?.candidateCounts.autoApplied).toBe(0);
    expect(run?.candidateCounts.needsReview).toBeGreaterThan(0);
    expect(snapshot.profile.fullName).toBe("Casey Rowan");
    expect(snapshot.latestResumeImportRun?.status).toBe("review_ready");
  });

  test("does not re-save stale input profile from a failed import handler", async () => {
    const seed = createSeed();
    const caseyProfile = createCaseyProfile();
    const base = createInMemoryJobFinderRepository({
      ...seed,
      profile: caseyProfile,
    });
    let raced = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileUpdate: async (updateProfile, options) => {
        if (!raced && options?.expectedRevision !== undefined) {
          raced = true;
          await base.saveProfile({
            ...(await base.getProfile()),
            currentLocation: "Casey Failed-Handler Edit",
            skills: ["Casey Failed-Handler Skill"],
          });
        }
        return base.commitProfileUpdate(updateProfile, options);
      },
    };
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage: () =>
          Promise.reject(new Error("text extraction failed")),
      },
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    await expect(
      workspaceService.runResumeImport({
        baseResume: {
          ...caseyProfile.baseResume,
          id: "resume_failed_handler_input",
          fileName: "failed-handler.txt",
          textContent: "Taylor Quinn\ntaylor@example.com",
        },
        documentBundle: createTestBundle({
          fullText: "Taylor Quinn\ntaylor@example.com",
        }),
      }),
    ).rejects.toThrow("The AI connection failed");

    const profile = await base.getProfile();
    expect(raced).toBe(true);
    expect(profile.fullName).toBe("Casey Rowan");
    expect(profile.currentLocation).toBe("Casey Failed-Handler Edit");
    expect(profile.skills).toEqual(["Casey Failed-Handler Skill"]);
    expect(profile.baseResume.id).toBe("resume_casey");
  });

  test("keeps a late manual edit when a native no-text import becomes stale", async () => {
    const seed = createSeed();
    const caseyProfile = createCaseyProfile();
    const base = createInMemoryJobFinderRepository({
      ...seed,
      profile: caseyProfile,
    });
    let releaseCommit!: () => void;
    let commitEntered!: () => void;
    const commitReady = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const repository: JobFinderRepository = {
      ...base,
      commitProfileUpdate: async (updateProfile, options) => {
        commitEntered();
        await commitGate;
        return base.commitProfileUpdate(updateProfile, options);
      },
    };
    const workspaceService = createService(repository);
    const emptyBundle = ResumeDocumentBundleSchema.parse({
      ...createTestBundle({ fullText: "native image-only resume" }),
      fullText: null,
      pages: [],
      blocks: [],
    });

    const pendingImport = workspaceService.runResumeImport({
      baseResume: {
        ...caseyProfile.baseResume,
        id: "resume_casey_native_no_text",
        fileName: "casey-native.pdf",
        textContent: null,
        textUpdatedAt: null,
        extractionStatus: "needs_text",
      },
      documentBundle: emptyBundle,
    });
    await commitReady;

    await base.saveProfile({
      ...caseyProfile,
      currentLocation: "Casey Late Manual Location",
      skills: ["Casey Late Manual Skill"],
    });
    releaseCommit();

    const snapshot = await pendingImport;
    const profile = await base.getProfile();

    expect(profile.currentLocation).toBe("Casey Late Manual Location");
    expect(profile.skills).toEqual(["Casey Late Manual Skill"]);
    expect(profile.baseResume.id).toBe("resume_casey");
    expect(snapshot.profile.currentLocation).toBe("Casey Late Manual Location");
  });

  test("does not overwrite a late manual edit while refreshing a textless resume", async () => {
    const seed = createSeed();
    const caseyProfile = CandidateProfileSchema.parse({
      ...createCaseyProfile(),
      baseResume: {
        ...createCaseyProfile().baseResume,
        textContent: null,
        textUpdatedAt: null,
        extractionStatus: "needs_text",
      },
    });
    const base = createInMemoryJobFinderRepository({
      ...seed,
      profile: caseyProfile,
    });
    let raced = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileUpdate: async (updateProfile, options) => {
        if (!raced) {
          raced = true;
          await base.saveProfile({
            ...(await base.getProfile()),
            currentLocation: "Casey Refresh Manual Location",
          });
        }
        return base.commitProfileUpdate(updateProfile, options);
      },
    };
    const workspaceService = createService(repository);

    await expect(workspaceService.analyzeProfileFromResume()).rejects.toThrow(
      /resume text is required/i,
    );

    const profile = await base.getProfile();
    expect(raced).toBe(true);
    expect(profile.currentLocation).toBe("Casey Refresh Manual Location");
    expect(profile.baseResume.extractionStatus).toBe("needs_text");
  });

  test("marks contradictory import identity candidates for review instead of auto-applying them", () => {
    const profile = createCaseyProfile();
    const seed = createSeed();
    const candidate = createIdentityCandidate({
      id: "candidate_taylor_name",
      key: "fullName",
      value: "Taylor Quinn",
    });

    const conflicts = findResumeImportIdentityConflicts(profile, [candidate]);
    const reconciled = reconcileCandidates(profile, seed.searchPreferences, [
      candidate,
    ]);

    expect(conflicts.get(candidate.id)).toMatch(/conflicts/i);
    expect(reconciled[0]?.resolution).toBe("needs_review");
    expect(reconciled[0]?.resolutionReason).toMatch(
      /identity_mismatch_requires_review/,
    );
  });

  test("reads the name from a flattened two-column header and never from a sentence tail", () => {
    // pdf text extraction merges a two-column header into one line and wraps
    // the summary so its last words land on their own line. The identity
    // check used to reject the first and accept "at scale." as the name.
    expect(extractIdentityNameFromLine("Owen Mercer Tampa, FL")).toBe(
      "Owen Mercer",
    );
    expect(extractIdentityNameFromLine("Owen Mercer | Tampa, FL")).toBe(
      "Owen Mercer",
    );
    expect(extractIdentityNameFromLine("at scale.")).toBeNull();
    expect(extractIdentityNameFromLine("and reliability")).toBeNull();
    expect(extractIdentityNameFromLine("PROFESSIONAL SUMMARY")).toBeNull();
    expect(extractIdentityNameFromLine("Online Resume Sample")).toBeNull();
    expect(extractIdentityNameFromLine("Curriculum Vitae")).toBeNull();
    expect(extractIdentityNameFromLine("Mary-Jane O’Neil")).toBe(
      "Mary-Jane O’Neil",
    );

    const caseyProfile = createCaseyProfile();
    const profileWithMergedHeader = CandidateProfileSchema.parse({
      ...caseyProfile,
      baseResume: {
        ...caseyProfile.baseResume,
        id: "resume_casey_merged_header",
        fileName: "casey-resume.pdf",
        textContent: [
          "Casey Rowan Tampa, FL",
          "+1 555 000 0000",
          "casey@example.com",
          "PROFESSIONAL SUMMARY",
          "Experienced engineer improving development practices for security and reliability",
          "at scale.",
        ].join("\n"),
      },
    });

    expect(
      resolveResumeIdentity(profileWithMergedHeader).mismatchReasons,
    ).toEqual([]);
  });

  test("blocks an established profile when its base resume identifies another person", () => {
    const caseyProfile = createCaseyProfile();
    const profileWithTaylorResume = CandidateProfileSchema.parse({
      ...caseyProfile,
      baseResume: {
        ...caseyProfile.baseResume,
        id: "resume_taylor_source",
        fileName: "taylor-resume.txt",
        textContent: "Taylor Quinn\nTaylor City\ntaylor@example.com",
      },
    });

    const resolution = resolveResumeIdentity(profileWithTaylorResume);

    expect(resolution.identity).toMatchObject({
      fullName: "Casey Rowan",
      email: "casey@example.com",
    });
    expect(resolution.mismatchReasons.join(" ")).toMatch(/Taylor Quinn/);
    expect(resolution.mismatchReasons.join(" ")).toMatch(/taylor@example.com/);
  });

  test("clears the block only when the person says the document is theirs", () => {
    // A genuine two-identities-in-one-document case used to be a dead end:
    // no draft, no export, no way forward. The way forward is the person's
    // own word, recorded against the exact values they were shown.
    const caseyProfile = createCaseyProfile();
    const profileWithTaylorResume = CandidateProfileSchema.parse({
      ...caseyProfile,
      baseResume: {
        ...caseyProfile.baseResume,
        id: "resume_taylor_source",
        fileName: "taylor-resume.txt",
        textContent: "Taylor Quinn\nTaylor City\ntaylor@example.com",
      },
    });

    const choice = describeResumeIdentityOwnershipChoice(
      profileWithTaylorResume,
    );
    expect(choice.sourceFullName).toBe("Taylor Quinn");
    expect(choice.profileFullName).toBe("Casey Rowan");

    const acknowledged = CandidateProfileSchema.parse({
      ...profileWithTaylorResume,
      resumeIdentityOwnership: choice.acknowledgement,
    });
    expect(resolveResumeIdentity(acknowledged).mismatchReasons).toEqual([]);
    // The profile name is what gets used; nothing was rewritten silently.
    expect(resolveResumeIdentity(acknowledged).identity).toMatchObject({
      fullName: "Casey Rowan",
      email: "casey@example.com",
    });

    // A different document naming a third person raises the block again: the
    // acknowledgement was about one document, not a blanket permission.
    const anotherDocument = CandidateProfileSchema.parse({
      ...acknowledged,
      baseResume: {
        ...acknowledged.baseResume,
        id: "resume_jordan_source",
        textContent: "Jordan Blake\nJordan City\njordan@example.com",
      },
    });
    expect(
      resolveResumeIdentity(anotherDocument).mismatchReasons.join(" "),
    ).toMatch(/Jordan Blake/);
  });

  test("can explicitly keep the imported resume name as the profile identity", () => {
    const caseyProfile = createCaseyProfile();
    const profileWithTaylorResume = CandidateProfileSchema.parse({
      ...caseyProfile,
      baseResume: {
        ...caseyProfile.baseResume,
        textContent: "Taylor Morgan Quinn\ntaylor@example.com",
      },
    });

    const updated = useResumeSourceNameForProfile(profileWithTaylorResume);

    expect(updated).toMatchObject({
      firstName: "Taylor",
      middleName: "Morgan",
      lastName: "Quinn",
      fullName: "Taylor Morgan Quinn",
      preferredDisplayName: null,
    });
    expect(resolveResumeIdentity(updated).mismatchReasons).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/Taylor Morgan Quinn/)]),
    );
  });

  test("allows a fresh placeholder profile to import a replacement identity", async () => {
    const seed = createSeed();
    const placeholderProfile = CandidateProfileSchema.parse({
      ...seed.profile,
      id: "candidate_fresh_start",
      firstName: "New",
      lastName: "Candidate",
      middleName: null,
      fullName: "New Candidate",
      preferredDisplayName: null,
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "Set your preferred location",
      yearsExperience: 0,
      email: null,
      phone: null,
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredEmail: null,
        preferredPhone: null,
      },
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_fresh_start",
        fileName: "No resume imported yet",
        textContent: null,
        textUpdatedAt: null,
        extractionStatus: "needs_text",
        lastAnalyzedAt: null,
      },
      experiences: [],
      education: [],
    });
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      profile: placeholderProfile,
    });
    const workspaceService = createService(repository);
    const text = "Taylor Quinn\nTaylor City\ntaylor@example.com";

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...placeholderProfile.baseResume,
        id: "resume_taylor_import",
        fileName: "taylor-resume.txt",
        textContent: text,
      },
      documentBundle: createTestBundle({ fullText: text }),
    });

    expect(snapshot.profile.fullName).toBe("Taylor Quinn");
    expect(snapshot.profile.email).toBe("taylor@example.com");
    expect(resolveResumeIdentity(snapshot.profile).mismatchReasons).toEqual([]);
  });

  test("does not treat a role title as the source resume name", () => {
    const caseyProfile = createCaseyProfile();
    const profileWithTitle = CandidateProfileSchema.parse({
      ...caseyProfile,
      baseResume: {
        ...caseyProfile.baseResume,
        textContent:
          "Senior Frontend Engineer\nCasey Rowan\nCasey City\ncasey@example.com",
      },
    });

    expect(resolveResumeIdentity(profileWithTitle).mismatchReasons).toEqual([]);
  });

  test("recognizes a source name with common diacritics", () => {
    const caseyProfile = createCaseyProfile();
    const profileWithDiacriticSource = CandidateProfileSchema.parse({
      ...caseyProfile,
      baseResume: {
        ...caseyProfile.baseResume,
        textContent: "Élodie Brûlé\nParis, France\nelodie@example.com",
      },
    });

    expect(
      resolveResumeIdentity(profileWithDiacriticSource).mismatchReasons.join(
        " ",
      ),
    ).toMatch(/Élodie Brûlé/);
  });

  test("allows an aligned identity through import and draft identity resolution", async () => {
    const seed = createSeed();
    const alignedProfile = CandidateProfileSchema.parse({
      ...seed.profile,
      firstName: "Jamie",
      lastName: "Rivers",
      fullName: "Jamie Rivers",
      preferredDisplayName: null,
      email: "jamie@example.com",
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredEmail: "jamie@example.com",
      },
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_jamie_aligned",
        fileName: "jamie.txt",
        textContent: "Jamie Rivers\nBerlin, Germany\njamie@example.com",
      },
    });
    const base = createInMemoryJobFinderRepository({
      ...seed,
      profile: alignedProfile,
    });
    const workspaceService = createService(base);
    const text = "Jamie Rivers\nBerlin, Germany\njamie@example.com";

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...alignedProfile.baseResume,
        textContent: text,
      },
      documentBundle: createTestBundle({ fullText: text }),
    });

    expect(resolveResumeIdentity(snapshot.profile).mismatchReasons).toEqual([]);
    expect(buildResumeDraftIdentity(snapshot.profile)).toMatchObject({
      fullName: "Jamie Rivers",
      email: "jamie@example.com",
    });
    expect(["applied", "review_ready"]).toContain(
      snapshot.latestResumeImportRun?.status,
    );
  });
});
