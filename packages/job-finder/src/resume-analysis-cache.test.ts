import { describe, expect, test, vi } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";

import {
  buildResumeAnalysisCacheIdentity,
  resumeAnalysisCacheIdentitiesMatch,
} from "./internal/resume-analysis-cache";
import { createTestBundle } from "./workspace-service.resume-analysis.shared";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const SOURCE_SHA = "a".repeat(64);

function createCacheInput() {
  const seed = createSeed();
  const profile = CandidateProfileSchema.parse({
    ...seed.profile,
    baseResume: {
      ...seed.profile.baseResume,
      id: "resume_cache_source",
      sha256: SOURCE_SHA,
    },
  });
  const bundle = createTestBundle({
    fullText: profile.baseResume.textContent ?? "Alex Vanguard",
  });

  return { seed, profile, bundle };
}

describe("resume analysis cache", () => {
  test("reuses unchanged compatible analysis without calling providers again", async () => {
    const { seed, profile, bundle } = createCacheInput();
    const aiClient = createAiClient();
    const extractionSpy = vi.spyOn(aiClient, "extractResumeImportStage");
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: { ...seed, profile },
      aiClient,
    });

    const first = await workspaceService.runResumeImport({
      baseResume: profile.baseResume,
      documentBundle: bundle,
    });
    const callsAfterFirstRun = extractionSpy.mock.calls.length;
    expect(callsAfterFirstRun).toBeGreaterThan(0);
    expect(first.latestResumeImportRun?.analysisCacheHit).toBe(false);

    // The first import filled the profile and the targeting fields; restore
    // both so the second run's context matches the first.
    await repository.saveProfile(profile);
    await repository.saveSearchPreferences(seed.searchPreferences);
    const second = await workspaceService.runResumeImport({
      baseResume: profile.baseResume,
      documentBundle: bundle,
    });

    expect(extractionSpy).toHaveBeenCalledTimes(callsAfterFirstRun);
    expect(second.latestResumeImportRun).toMatchObject({
      analysisCacheHit: true,
      analysisCacheSourceRunId: first.latestResumeImportRun?.id,
      analysisCacheIdentity: { sourceSha256: SOURCE_SHA },
    });

    expect(second.latestResumeImportRun?.timing?.textBranchMs).toBe(0);
  });

  test("does not reuse analysis after source bytes or parser version changes", async () => {
    const { seed, profile, bundle } = createCacheInput();
    const aiClient = createAiClient();
    const extractionSpy = vi.spyOn(aiClient, "extractResumeImportStage");
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: { ...seed, profile },
      aiClient,
    });

    await workspaceService.runResumeImport({
      baseResume: profile.baseResume,
      documentBundle: bundle,
    });
    const callsPerRun = extractionSpy.mock.calls.length;

    const changedBytesProfile = CandidateProfileSchema.parse({
      ...profile,
      baseResume: { ...profile.baseResume, sha256: "b".repeat(64) },
    });
    await repository.saveProfile(changedBytesProfile);
    const changedBytes = await workspaceService.runResumeImport({
      baseResume: changedBytesProfile.baseResume,
      documentBundle: bundle,
    });
    expect(extractionSpy).toHaveBeenCalledTimes(callsPerRun * 2);
    expect(changedBytes.latestResumeImportRun?.analysisCacheHit).toBe(false);

    await repository.saveProfile(profile);
    const changedParserBundle = {
      ...bundle,
      parserManifest: bundle.parserManifest
        ? { ...bundle.parserManifest, manifestVersion: "019-test-v2" }
        : undefined,
    };
    const changedParser = await workspaceService.runResumeImport({
      baseResume: profile.baseResume,
      documentBundle: changedParserBundle,
    });
    expect(extractionSpy).toHaveBeenCalledTimes(callsPerRun * 3);
    expect(changedParser.latestResumeImportRun?.analysisCacheHit).toBe(false);
  });

  test("treats every prompt, schema, policy, provider, and context version as compatibility-critical", () => {
    const { seed, profile, bundle } = createCacheInput();
    const status = createAiClient().getStatus();
    const baseline = buildResumeAnalysisCacheIdentity({
      profile,
      searchPreferences: seed.searchPreferences,
      documentBundle: bundle,
      textProviderStatus: status,
      visionProviderStatus: null,
    });
    expect(baseline).not.toBeNull();

    const incompatible = [
      { promptVersion: "resume-analysis-prompts-v1" },
      { schemaVersion: "resume-analysis-schema-v2" },
      { policyVersion: "resume-analysis-policy-v1" },
      {
        textProviderStatus: {
          ...status,
          model: "different-model",
        },
      },
      {
        searchPreferences: {
          ...seed.searchPreferences,
          targetRoles: ["Different role"],
        },
      },
    ];

    for (const override of incompatible) {
      const candidate = buildResumeAnalysisCacheIdentity({
        profile,
        searchPreferences: seed.searchPreferences,
        documentBundle: bundle,
        textProviderStatus: status,
        visionProviderStatus: null,
        ...override,
      });
      expect(resumeAnalysisCacheIdentitiesMatch(baseline, candidate)).toBe(
        false,
      );
    }
  });

  test("disables caching when no verified source-byte digest is available", () => {
    const { seed, profile, bundle } = createCacheInput();
    const withoutDigest = CandidateProfileSchema.parse({
      ...profile,
      baseResume: { ...profile.baseResume, sha256: null },
    });

    expect(
      buildResumeAnalysisCacheIdentity({
        profile: withoutDigest,
        searchPreferences: seed.searchPreferences,
        documentBundle: bundle,
        textProviderStatus: createAiClient().getStatus(),
        visionProviderStatus: null,
      }),
    ).toBeNull();
  });
  test("never reuses partial provider analysis and refresh always recomputes", async () => {
    const { seed, profile, bundle } = createCacheInput();
    const aiClient = createAiClient();
    const baseExtract = aiClient.extractResumeImportStage.bind(aiClient);
    let firstFailurePending = true;
    const extractionSpy = vi
      .spyOn(aiClient, "extractResumeImportStage")
      .mockImplementation((input) => {
        if (firstFailurePending && input.stage === "identity_summary") {
          firstFailurePending = false;
          return Promise.reject(new Error("transient provider failure"));
        }
        return baseExtract(input);
      });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: { ...seed, profile },
      aiClient,
    });

    await workspaceService.runResumeImport({
      baseResume: profile.baseResume,
      documentBundle: bundle,
    });
    const callsAfterPartialRun = extractionSpy.mock.calls.length;
    expect(callsAfterPartialRun).toBeGreaterThan(0);

    await repository.saveProfile(profile);
    const retry = await workspaceService.runResumeImport({
      baseResume: profile.baseResume,
      documentBundle: bundle,
    });
    expect(extractionSpy.mock.calls.length).toBeGreaterThan(
      callsAfterPartialRun,
    );
    expect(retry.latestResumeImportRun?.analysisCacheHit).toBe(false);

    const callsAfterRetry = extractionSpy.mock.calls.length;
    await repository.saveProfile(profile);
    const refresh = await workspaceService.analyzeProfileFromResume();
    expect(extractionSpy.mock.calls.length).toBeGreaterThan(callsAfterRetry);
    expect(refresh.latestResumeImportRun?.trigger).toBe("refresh");
    expect(refresh.latestResumeImportRun?.analysisCacheIdentity).toBeNull();
    expect(refresh.latestResumeImportRun?.analysisCacheHit).toBe(false);
  });
});
