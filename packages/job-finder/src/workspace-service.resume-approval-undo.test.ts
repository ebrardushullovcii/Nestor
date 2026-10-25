import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

describe("undoing a resume approval", () => {
  it("puts the draft back as it was, not as out of date", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const before = (await workspaceService.getResumeWorkspace("job_ready"))
      .draft;
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    )!;
    await workspaceService.approveResume("job_ready", artifact.id);

    const restoreStatus = before.status === "draft" ? "draft" : "needs_review";
    await workspaceService.clearResumeApproval("job_ready", { restoreStatus });

    const after = await workspaceService.getResumeWorkspace("job_ready");
    expect(after.draft).toMatchObject({
      status: restoreStatus,
      staleReason: null,
      approvedAt: null,
      approvedExportId: null,
    });
    expect(after.exports.some((entry) => entry.isApproved)).toBe(false);
  });

  it("keeps a plain clear asking for a fresh review", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    )!;
    await workspaceService.approveResume("job_ready", artifact.id);
    await workspaceService.clearResumeApproval("job_ready");

    const after = await workspaceService.getResumeWorkspace("job_ready");
    expect(after.draft.status).toBe("stale");
    expect(after.draft.staleReason).toBeTruthy();
  });
});
