import { describe, expect, test } from "vitest";
import type { TailoredAsset } from "@nestor/contracts";
import { buildTailoredAssetBridge } from "./internal/resume-workspace-helpers";
import { seedResumeDraft } from "./internal/resume-workspace-structure";
import { createSeed } from "./workspace-service.test-support";

/**
 * Every save, patch, and export rebuilds the tailored asset through the
 * bridge. Dropping the structured generation reason there made the studio's
 * disclosure degrade from the specific, debuggable verifier sentence to a
 * generic fallback line the moment the user touched the draft — exactly when
 * more had happened, not less.
 */
describe("buildTailoredAssetBridge generation provenance", () => {
  function buildExistingAsset(): TailoredAsset {
    return {
      id: "resume_job_1",
      jobId: "job_1",
      kind: "resume",
      status: "ready",
      label: "Tailored Resume",
      version: "v1",
      templateName: "Chronology Classic",
      compatibilityScore: 80,
      progressPercent: 100,
      updatedAt: "2026-09-03T10:00:00.000Z",
      storagePath: "/tmp/resume.pdf",
      contentText: "Resume text",
      previewSections: [],
      generationMethod: "deterministic",
      generationReason: "provider_output_unverified",
      generationDetail:
        "AI proposed 1 rewrite, but none could be verified against your saved evidence",
      notes: ["Used the built-in deterministic resume tailorer."],
      failureMessage: null,
      failedAt: null,
    } as TailoredAsset;
  }

  test("carries the exact reason and detail through a deterministic rebuild", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const draft = seedResumeDraft({
      job,
      profile: seed.profile,
      templateId: seed.settings.resumeTemplateId,
    });

    const asset = buildTailoredAssetBridge({
      draft: { ...draft, generationMethod: "deterministic" },
      existingAsset: buildExistingAsset(),
      job,
      profile: seed.profile,
    });

    expect(asset.generationReason).toBe("provider_output_unverified");
    expect(asset.generationDetail).toBe(
      "AI proposed 1 rewrite, but none could be verified against your saved evidence",
    );
  });

  test("clears the first-draft reason once the draft itself is AI written", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const draft = seedResumeDraft({
      job,
      profile: seed.profile,
      templateId: seed.settings.resumeTemplateId,
    });

    const asset = buildTailoredAssetBridge({
      draft: { ...draft, generationMethod: "ai" },
      existingAsset: buildExistingAsset(),
      job,
      profile: seed.profile,
    });

    expect(asset.generationMethod).toBe("ai_assisted");
    expect(asset.generationReason).toBeNull();
    expect(asset.generationDetail).toBeNull();
  });

  test("records no reason when the first draft never had one", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const draft = seedResumeDraft({
      job,
      profile: seed.profile,
      templateId: seed.settings.resumeTemplateId,
    });

    const asset = buildTailoredAssetBridge({
      draft: { ...draft, generationMethod: "deterministic" },
      job,
      profile: seed.profile,
    });

    expect(asset.generationReason).toBeNull();
    expect(asset.generationDetail).toBeNull();
  });
});
