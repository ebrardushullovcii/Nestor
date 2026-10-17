import { expect, test } from "vitest";
import { ResumeValidationResultSchema } from "@nestor/contracts";
import { buildResumeCoverageComparison } from "./internal/resume-workspace-helpers";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

test("Resume Studio reads keyword changes again instead of showing a comparison stored by older code", async () => {
  const { workspaceService, repository } = createWorkspaceServiceHarness();
  const { draft } = await workspaceService.getResumeWorkspace("job_ready");
  const profile = await repository.getProfile();
  const current = buildResumeCoverageComparison({ profile, draft });
  // Older code listed the person's own languages as added keywords.
  await repository.upsertResumeValidationResult(
    ResumeValidationResultSchema.parse({
      id: `resume_validation_${draft.id}`,
      draftId: draft.id,
      issues: [],
      draftContentHash: "stored-by-older-code",
      claimAssessments: [],
      coverageComparison: {
        ...current,
        addedKeywords: ["German — C1", "Polish — Native"],
      },
      pageCount: null,
      validatedAt: "2026-10-03T10:00:00.000Z",
    }),
  );

  const workspace = await workspaceService.getResumeWorkspace("job_ready");

  expect(workspace.validation?.coverageComparison?.addedKeywords).toEqual(
    current.addedKeywords,
  );
  expect(workspace.validation?.draftContentHash).toBe("stored-by-older-code");
});
