import { describe, expect, test, vi } from "vitest";
import {
  buildResumeDraftContentHash,
  buildResumeRenderDocument,
} from "./internal/resume-workspace-helpers";
import {
  createDocumentManager,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("resume pdf export binding", () => {
  function hashedDocumentManager() {
    const manager = createDocumentManager();
    return {
      ...manager,
      async renderResumeArtifact(
        input: Parameters<typeof manager.renderResumeArtifact>[0],
      ) {
        return {
          ...(await manager.renderResumeArtifact(input)),
          sha256: "a".repeat(64),
        };
      },
    };
  }
  test("bulk approval reuses the exact current PDF and runs the normal approval write", async () => {
    const { repository, workspaceService, documentManager } =
      createWorkspaceServiceHarness({
        documentManager: hashedDocumentManager(),
        exportFileVerifier: {
          exists: () => Promise.resolve(true),
          sha256: () => Promise.resolve("a".repeat(64)),
        },
      });
    await workspaceService.getResumeWorkspace("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (a) => a.jobId === "job_ready",
    )!;
    const render = vi.spyOn(documentManager, "renderResumeArtifact");
    const approve = vi.spyOn(repository, "approveResumeExport");
    await workspaceService.approveCurrentResume("job_ready");
    await workspaceService.approveCurrentResume("job_ready");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    const [approval] = approve.mock.calls[0]!;
    expect(approval.exportArtifact).toEqual({ ...artifact, isApproved: true });
    expect(approval.draft).toMatchObject({
      status: "approved",
      approvedExportId: artifact.id,
    });
    expect(
      await repository.listResumeExportArtifacts({ jobId: "job_ready" }),
    ).toHaveLength(1);
  });

  test("bulk approval rebuilds a missing export and refuses changed PDF bytes", async () => {
    let exists = true;
    let digest = "a".repeat(64);
    const { workspaceService, documentManager } = createWorkspaceServiceHarness(
      {
        documentManager: hashedDocumentManager(),
        exportFileVerifier: {
          exists: () => Promise.resolve(exists),
          sha256: () => Promise.resolve(digest),
        },
      },
    );
    await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.exportResumePdf("job_ready");
    const render = vi.spyOn(documentManager, "renderResumeArtifact");
    digest = "b".repeat(64);
    await expect(
      workspaceService.approveCurrentResume("job_ready"),
    ).rejects.toThrow(/(hash|changed|match)/i);
    expect(render).not.toHaveBeenCalled();
    digest = "a".repeat(64);
    exists = false;
    render.mockImplementation(() => {
      exists = true;
      return Promise.resolve({
        fileName: "rebuilt.pdf",
        storagePath: "/tmp/rebuilt.pdf",
        sha256: digest,
        format: "pdf" as const,
        intermediateFileName: "rebuilt.html",
        intermediateStoragePath: "/tmp/rebuilt.html",
        pageCount: 1,
        warnings: [],
      });
    });
    await workspaceService.approveCurrentResume("job_ready");
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft.status,
    ).toBe("approved");
  });

  test("exports and approves the exact sanitized draft whose claims were validated", async () => {
    const baseDocumentManager = createDocumentManager();
    let capturedRenderDocument:
      | Parameters<
          typeof baseDocumentManager.renderResumeArtifact
        >[0]["renderDocument"]
      | null = null;
    const documentManager = {
      ...baseDocumentManager,
      renderResumeArtifact(
        input: Parameters<typeof baseDocumentManager.renderResumeArtifact>[0],
      ) {
        capturedRenderDocument = input.renderDocument;
        return baseDocumentManager.renderResumeArtifact(input);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      documentManager,
    });

    await workspaceService.getResumeWorkspace("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    const persistedDraft = await repository.getResumeDraftByJobId("job_ready");
    const [validation] = await repository.listResumeValidationResults(
      persistedDraft!.id,
    );
    const profile = await repository.getProfile();

    expect(exportArtifact).toBeTruthy();
    expect(validation?.draftContentHash).toBe(
      buildResumeDraftContentHash(persistedDraft!),
    );
    expect(capturedRenderDocument).toEqual(
      buildResumeRenderDocument(profile, persistedDraft!),
    );

    await repository.saveResumeDraftWithValidation({
      draft: persistedDraft!,
      validation: {
        ...validation!,
        id: "resume_validation_warning_only",
        issues: [
          {
            id: "issue_warning_only",
            severity: "warning",
            category: "thin_output",
            sectionId: null,
            entryId: null,
            bulletId: null,
            message: "Review the concise summary before applying.",
          },
        ],
      },
    });

    await workspaceService.approveResume("job_ready", exportArtifact!.id);
    const approved = await workspaceService.getResumeWorkspace("job_ready");

    expect(approved.draft.status).toBe("approved");
    expect(approved.draft.approvedExportId).toBe(exportArtifact!.id);
  });

  test("rejects approval when current validation contains an error", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.getResumeWorkspace("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    const draft = await repository.getResumeDraftByJobId("job_ready");
    const [validation] = await repository.listResumeValidationResults(
      draft!.id,
    );

    await repository.saveResumeDraftWithValidation({
      draft: draft!,
      validation: {
        ...validation!,
        id: "resume_validation_blocking_error",
        issues: [
          {
            id: "issue_blocking_error",
            severity: "error",
            category: "invented_metric",
            sectionId: null,
            entryId: null,
            bulletId: null,
            message: "A metric is not grounded in candidate evidence.",
          },
        ],
      },
    });

    await expect(
      workspaceService.approveResume("job_ready", exportArtifact!.id),
    ).rejects.toThrow(/blocking validation errors/i);
  });
});
