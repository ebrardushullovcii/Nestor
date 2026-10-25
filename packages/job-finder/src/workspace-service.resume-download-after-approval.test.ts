import { describe, expect, test } from "vitest";
import { createDocumentManager } from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

function createPathHonoringDocumentManager() {
  const base = createDocumentManager();
  let renders = 0;
  return {
    ...base,
    async renderResumeArtifact(
      input: Parameters<typeof base.renderResumeArtifact>[0],
    ) {
      renders += 1;
      const rendered = await base.renderResumeArtifact(input);
      // Like the real document manager: a download writes to the chosen
      // path; an approval export writes a fresh file in app storage.
      return {
        ...rendered,
        storagePath: input.targetPath ?? `/tmp/app-storage/render-${renders}.pdf`,
      };
    },
  };
}

describe("Download PDF after approval", () => {
  test("keeps the job's resume pointed at the approved file, so Shortlisted still offers Apply", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      documentManager: createPathHonoringDocumentManager(),
    });
    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const approvalExport = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;
    await workspaceService.approveResume("job_ready", approvalExport.id);

    const afterDownload = await workspaceService.exportResumePdf(
      "job_ready",
      "/tmp/my-copy/resume.pdf",
    );

    const asset = afterDownload.tailoredAssets.find(
      (candidate) => candidate.jobId === "job_ready",
    )!;
    const review = afterDownload.reviewQueue.find(
      (item) => item.jobId === "job_ready",
    )!.resumeReview;
    expect(review.status).toBe("approved");
    expect("approvedFilePath" in review ? review.approvedFilePath : null).toBe(
      asset.storagePath,
    );
    expect(
      afterDownload.resumeExportArtifacts.some(
        (artifact) => artifact.filePath === "/tmp/my-copy/resume.pdf",
      ),
    ).toBe(true);

    // A download with no chosen folder renders a new copy in app storage;
    // the job still points at the approved file.
    const afterStorageCopy = await workspaceService.exportResumePdf("job_ready");
    const storageAsset = afterStorageCopy.tailoredAssets.find(
      (candidate) => candidate.jobId === "job_ready",
    )!;
    expect(storageAsset.storagePath).toBe(asset.storagePath);
  });
});
