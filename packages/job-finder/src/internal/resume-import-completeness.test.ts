import { describe, expect, it } from "vitest";
import {
  createFreshStartCandidateProfile,
  JobSearchPreferencesSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
} from "@nestor/contracts";
import { reconcileCandidates } from "./resume-import-reconciliation";
import { completeResumeImport } from "./resume-import-completeness";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./resume-import-apply";
const now = "2026-10-27T12:00:00.000Z";
const role = ResumeImportFieldCandidateSchema.parse({
  id: "role",
  runId: "import",
  target: { section: "experience", key: "record", recordId: "role" },
  label: "Work experience",
  sourceKind: "model_experience",
  value: {
    title: "Product Designer",
    companyName: "Signal Systems",
    summary: "Designed accessible tools.",
  },
  confidence: 0.95,
  resolution: "auto_applied",
  createdAt: now,
  evidenceText:
    "Product Designer at Signal Systems. Designed accessible tools.",
  sourceBlockIds: ["b1"],
});
function input() {
  return {
    profile: createFreshStartCandidateProfile(),
    preferences: JobSearchPreferencesSchema.parse({
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    }),
    bundle: ResumeDocumentBundleSchema.parse({
      id: "bundle",
      runId: "import",
      sourceResumeId: "resume",
      sourceFileKind: "plain_text",
      primaryParserKind: "plain_text",
      createdAt: now,
      fullText: role.evidenceText,
    }),
    candidates: [role],
  };
}
describe("resume import completeness", () => {
  it("offers editable headline, summary and roles from cited work history without applying them", () => {
    const source = input();
    const result = completeResumeImport(source);
    const suggestions = result.candidates.filter(
      (candidate) =>
        candidate.resolutionReason === "grounded_completeness_suggestion",
    );
    expect(
      suggestions.map((candidate) => [candidate.target.key, candidate.value]),
    ).toEqual([
      ["headline", "Product Designer"],
      ["summary", "Designed accessible tools."],
      ["targetRoles", ["Product Designer"]],
    ]);
    expect(
      reconcileCandidates(
        source.profile,
        source.preferences,
        suggestions,
        source.bundle,
        { readByModel: true },
      ).every((candidate) => candidate.resolution === "needs_review"),
    ).toBe(true);
    expect(
      suggestions.every(
        (candidate) =>
          candidate.resolution === "needs_review" &&
          candidate.evidenceText === role.evidenceText,
      ),
    ).toBe(true);
    const merged = applyResolvedResumeImportCandidatesToWorkspace({
      profile: source.profile,
      searchPreferences: source.preferences,
      candidates: result.candidates,
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "test",
      analysisWarnings: result.warnings,
    });
    expect(merged.profile.headline).toBe(source.profile.headline);
    expect(merged.profile.summary).toBe(source.profile.summary);
    expect(merged.searchPreferences.targetRoles).toEqual([]);
    expect(
      completeResumeImport({ ...source, candidates: result.candidates })
        .candidates,
    ).toHaveLength(result.candidates.length);
  });
  it("names the required missing headline when no grounded suggestion is possible", () => {
    const result = completeResumeImport({ ...input(), candidates: [] });
    expect(result.candidates).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Headline is required");
  });
  it("never repeats an unevidenced model title or replaces existing fields", () => {
    const source = input();
    expect(
      completeResumeImport({
        ...source,
        bundle: { ...source.bundle, fullText: "Contact only" },
      }).candidates,
    ).toEqual([role]);
    const result = completeResumeImport({
      ...source,
      profile: {
        ...source.profile,
        headline: "Saved",
        summary: "Saved",
        targetRoles: ["Researcher"],
      },
    });
    expect(result.candidates).toEqual([role]);
  });
});
