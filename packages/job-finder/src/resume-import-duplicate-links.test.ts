import { describe, expect, test } from "vitest";

import {
  ResumeImportFieldCandidateSchema,
  createFreshStartCandidateProfile,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import {
  DUPLICATE_LINK_REASON,
  reconcileCandidates,
} from "./internal/resume-import-reconciliation";
import { createSeed } from "./workspace-service.test-fixtures";
import { createStageCandidate } from "./workspace-service.resume-analysis.shared";

const runId = "resume_import_run_duplicate_links";

function contactCandidate(
  key: string,
  value: string,
): ResumeImportFieldCandidate {
  return ResumeImportFieldCandidateSchema.parse({
    runId,
    ...createStageCandidate({
      target: { section: "contact", key, recordId: null },
      label: key,
      value,
      sourceBlockIds: [`page_1_block_${key}`],
      confidence: 0.95,
      overall: 0.8,
      recommendation: "needs_review",
    }),
    id: `candidate_${key}`,
    sourceKind: "model_identity_summary",
    resolution: "needs_review",
    createdAt: "2026-09-23T18:00:00.000Z",
    resolvedAt: null,
  });
}

describe("resume import duplicate links", () => {
  test("rejects a portfolio URL that only repeats the GitHub URL from the same run", () => {
    const seed = createSeed();
    const profile = createFreshStartCandidateProfile();
    const resolved = reconcileCandidates(profile, seed.searchPreferences, [
      contactCandidate("githubUrl", "https://github.com/morgan-lee"),
      contactCandidate("portfolioUrl", "https://github.com/morgan-lee/"),
    ]);
    const portfolio = resolved.find((c) => c.target.key === "portfolioUrl");
    const github = resolved.find((c) => c.target.key === "githubUrl");
    expect(portfolio?.resolution).toBe("rejected");
    expect(portfolio?.resolutionReason).toBe(DUPLICATE_LINK_REASON);
    expect(github?.resolution).not.toBe("rejected");
  });

  test("rejects a personal website that repeats the saved LinkedIn URL, keeps a distinct one", () => {
    const seed = createSeed();
    const profile = {
      ...createFreshStartCandidateProfile(),
      linkedinUrl: "https://www.linkedin.com/in/morgan-lee",
    };
    const resolved = reconcileCandidates(profile, seed.searchPreferences, [
      contactCandidate("personalWebsiteUrl", "linkedin.com/in/morgan-lee"),
      contactCandidate("portfolioUrl", "https://morganlee.dev"),
    ]);
    expect(
      resolved.find((c) => c.target.key === "personalWebsiteUrl")?.resolution,
    ).toBe("rejected");
    expect(
      resolved.find((c) => c.target.key === "portfolioUrl")?.resolution,
    ).not.toBe("rejected");
  });
});
