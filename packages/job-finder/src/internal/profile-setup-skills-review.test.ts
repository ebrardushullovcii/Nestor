import { describe, expect, test } from "vitest";
import {
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import { buildProfileSetupReviewItems } from "./profile-setup-review-items";
import { shouldIncludeCandidateInSetupReview } from "./profile-setup-review-mapping";

const createdAt = "2026-09-30T02:34:54.000Z";
const extractedSkills = ["TypeScript", "React", "Accessibility", "AWS"];

function scannedSkillsCandidate() {
  return ResumeImportFieldCandidateSchema.parse({
    id: "scan_skills_candidate",
    runId: "scan_skills_run",
    target: { section: "skill", key: "skills", recordId: null },
    label: "Skills",
    sourceKind: "vision_omni",
    value: extractedSkills,
    valuePreview: extractedSkills.join(", "),
    evidenceText: "TypeScript React Accessibility AWS",
    confidence: 0.94,
    confidenceBreakdown: {
      overall: 0.56032,
      parserQuality: 0.2836,
      evidenceQuality: 0.42,
      agreementScore: 0.34,
      normalizationRisk: 0.2,
      conflictRisk: 0.18,
      fieldSensitivity: "medium",
      recommendation: "needs_review",
    },
    resolution: "needs_review",
    visualEvidence: [
      {
        branch: "vision",
        sourceFileKind: "pdf",
        pageNumber: 1,
        regionHint: "Left column SKILLS section",
        confidence: 0.94,
        uncertaintyNotes: [],
      },
    ],
    createdAt,
  });
}

describe("scanned skills import review", () => {
  test("keeps the canonical skills candidate linked to the existing profile destination", () => {
    const seed = createSeed();
    const imported = scannedSkillsCandidate();
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: { ...seed.profile, skills: [] },
      candidates: [imported],
      searchPreferences: seed.searchPreferences,
    });

    expect(shouldIncludeCandidateInSetupReview(imported)).toBe(true);
    expect(
      items.find((item) => item.sourceCandidateId === imported.id),
    ).toMatchObject({
      step: "essentials",
      target: { domain: "identity", key: "skills", recordId: null },
      status: "pending",
      proposedValue: "TypeScript, React, Accessibility, AWS",
      sourceSnippet: "TypeScript React Accessibility AWS",
      sourceRunId: imported.runId,
    });
    expect(
      shouldIncludeCandidateInSetupReview({
        ...imported,
        target: { ...imported.target, key: "unrecognizedSkills" },
      }),
    ).toBe(false);
  });

  test.each(["confirm", "dismiss", "clear_value"] as const)(
    "%s resolves the actual candidate without inventing skills",
    async (action) => {
      const seed = createSeed();
      const imported = scannedSkillsCandidate();
      const run = ResumeImportRunSchema.parse({
        id: imported.runId,
        sourceResumeId: seed.profile.baseResume.id,
        sourceResumeFileName: "resume-scanned.pdf",
        trigger: "refresh",
        status: "review_ready",
        startedAt: createdAt,
        completedAt: createdAt,
        primaryParserKind: "plain_text",
        parserKinds: ["plain_text"],
        analysisProviderKind: "openai_compatible_vision",
        analysisProviderLabel: "Configured vision",
        candidateCounts: {
          total: 1,
          autoApplied: 0,
          needsReview: 1,
          rejected: 0,
          abstained: 0,
        },
      });
      const { workspaceService } = createWorkspaceServiceHarness({
        seed: {
          ...seed,
          profile: { ...seed.profile, skills: [] },
          resumeImportRuns: [run],
          resumeImportFieldCandidates: [imported],
        },
      });
      const before = await workspaceService.getWorkspaceSnapshot();
      const review = before.profileSetupState.reviewItems.find(
        (item) => item.sourceCandidateId === imported.id,
      );
      expect(review).toBeDefined();
      if (!review) throw new Error("Skills suggestion was omitted from review");

      await workspaceService.applyProfileSetupReviewAction(review.id, action);
      const after = await workspaceService.getWorkspaceSnapshot();
      const state = await workspaceService.getResumeImportState();

      expect(after.profile.skills).toEqual(
        action === "confirm" ? extractedSkills : [],
      );
      expect(
        state.resumeImportFieldCandidates.find(
          (item) => item.id === imported.id,
        ),
      ).toMatchObject({
        resolution: action === "confirm" ? "auto_applied" : "rejected",
        resolutionReason:
          action === "confirm"
            ? "review_confirmed"
            : action === "dismiss"
              ? "review_dismissed"
              : "review_edited",
      });
      expect(after.profile.spokenLanguages).toEqual(
        seed.profile.spokenLanguages,
      );
    },
  );
});
