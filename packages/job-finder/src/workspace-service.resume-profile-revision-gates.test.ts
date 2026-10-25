import { describe, expect, test } from "vitest";

import { buildResumeDraftStateHash } from "./internal/resume-workspace-helpers";
import {
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function editProfile(
  repository: ReturnType<typeof createWorkspaceServiceHarness>["repository"],
): Promise<void> {
  const profile = await repository.getProfile();
  await repository.saveProfile({
    ...profile,
    headline: `${profile.headline} (edited concurrently)`,
  });
}

describe("resume profile revision gates", () => {
  test("fails generation after a resume-relevant profile change during rendering and records a retryable failure", async () => {
    const baseDocumentManager = createDocumentManager();
    const renderStarted = deferred<void>();
    const renderRelease = deferred<void>();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumeArtifact(
        input: Parameters<typeof baseDocumentManager.renderResumeArtifact>[0],
      ) {
        renderStarted.resolve();
        await renderRelease.promise;
        return baseDocumentManager.renderResumeArtifact(input);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      documentManager,
    });
    const assetBefore = (await repository.listTailoredAssets()).find(
      (asset) => asset.jobId === "job_ready",
    );

    const generation = workspaceService.generateResume("job_ready");
    await renderStarted.promise;
    await editProfile(repository);
    renderRelease.resolve();

    await expect(generation).rejects.toThrow(/profile changed/i);

    const draftAfter = await repository.getResumeDraftByJobId("job_ready");
    const assetAfter = (await repository.listTailoredAssets()).find(
      (asset) => asset.jobId === "job_ready",
    );
    expect(draftAfter).toBeNull();
    expect(assetAfter?.id).toBe(assetBefore?.id);
    expect(assetAfter?.status).toBe("failed");
    expect(assetAfter?.failureMessage).toMatch(
      /Your profile changed while this resume was being written.*Try again/,
    );
  });

  test("finishes generation when only search preferences or sources change during rendering", async () => {
    const baseDocumentManager = createDocumentManager();
    const renderStarted = deferred<void>();
    const renderRelease = deferred<void>();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumeArtifact(
        input: Parameters<typeof baseDocumentManager.renderResumeArtifact>[0],
      ) {
        renderStarted.resolve();
        await renderRelease.promise;
        return baseDocumentManager.renderResumeArtifact(input);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      documentManager,
    });
    const revisionBefore = (await repository.getProfileWithRevision())
      .revision;

    const generation = workspaceService.generateResume("job_ready");
    await renderStarted.promise;
    const preferences = await repository.getSearchPreferences();
    await repository.saveSearchPreferences({
      ...preferences,
      tailoringMode:
        preferences.tailoringMode === "aggressive" ? "balanced" : "aggressive",
    });
    expect((await repository.getProfileWithRevision()).revision).not.toBe(
      revisionBefore,
    );
    renderRelease.resolve();

    await expect(generation).resolves.toBeDefined();
    const assetAfter = (await repository.listTailoredAssets()).find(
      (asset) => asset.jobId === "job_ready",
    );
    expect(assetAfter?.status).toBe("ready");
    expect(assetAfter?.failureMessage ?? null).toBeNull();
    expect(await repository.getResumeDraftByJobId("job_ready")).not.toBeNull();
  });

  test("rejects a preview after the profile changes during rendering", async () => {
    const baseDocumentManager = createDocumentManager();
    const renderStarted = deferred<void>();
    const renderRelease = deferred<void>();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumePreview(
        input: Parameters<typeof baseDocumentManager.renderResumePreview>[0],
      ) {
        renderStarted.resolve();
        await renderRelease.promise;
        return baseDocumentManager.renderResumePreview(input);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      documentManager,
    });
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const draftBefore = await repository.getResumeDraftByJobId("job_ready");

    const preview = workspaceService.previewResumeDraft(workspace.draft);
    await renderStarted.promise;
    await editProfile(repository);
    renderRelease.resolve();

    await expect(preview).rejects.toThrow(/profile changed/i);

    const draftAfter = await repository.getResumeDraftByJobId("job_ready");
    expect(draftAfter).not.toBeNull();
    expect(buildResumeDraftStateHash(draftAfter!)).toBe(
      buildResumeDraftStateHash(draftBefore!),
    );
  });

  test("rejects export after the profile changes during rendering without persisting an export artifact", async () => {
    const baseDocumentManager = createDocumentManager();
    const renderStarted = deferred<void>();
    const renderRelease = deferred<void>();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumeArtifact(
        input: Parameters<typeof baseDocumentManager.renderResumeArtifact>[0],
      ) {
        renderStarted.resolve();
        await renderRelease.promise;
        return baseDocumentManager.renderResumeArtifact(input);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      documentManager,
    });
    await workspaceService.getResumeWorkspace("job_ready");
    const draftBefore = await repository.getResumeDraftByJobId("job_ready");

    const exportOperation = workspaceService.exportResumePdf("job_ready");
    await renderStarted.promise;
    await editProfile(repository);
    renderRelease.resolve();

    await expect(exportOperation).rejects.toThrow(/profile changed/i);

    expect(
      (await repository.listResumeExportArtifacts({ jobId: "job_ready" }))
        .length,
    ).toBe(0);
    const draftAfter = await repository.getResumeDraftByJobId("job_ready");
    expect(buildResumeDraftStateHash(draftAfter!)).toBe(
      buildResumeDraftStateHash(draftBefore!),
    );
  });

  test("rejects approval after the profile changes during export integrity verification", async () => {
    const sha256 = "b".repeat(64);
    const baseDocumentManager = createDocumentManager();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumeArtifact(
        input: Parameters<typeof baseDocumentManager.renderResumeArtifact>[0],
      ) {
        const artifact = await baseDocumentManager.renderResumeArtifact(input);
        return { ...artifact, sha256 };
      },
    };
    const verificationStarted = deferred<void>();
    const verificationRelease = deferred<void>();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      documentManager,
      exportFileVerifier: {
        exists: () => Promise.resolve(true),
        sha256: async () => {
          verificationStarted.resolve();
          await verificationRelease.promise;
          return sha256;
        },
      },
    });
    await workspaceService.getResumeWorkspace("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    if (!exportArtifact) {
      throw new Error("Expected a resume export artifact.");
    }
    const draftBefore = await repository.getResumeDraftByJobId("job_ready");

    const approval = workspaceService.approveResume(
      "job_ready",
      exportArtifact.id,
    );
    await verificationStarted.promise;
    await editProfile(repository);
    verificationRelease.resolve();

    await expect(approval).rejects.toThrow(/profile changed/i);

    const draftAfter = await repository.getResumeDraftByJobId("job_ready");
    expect(buildResumeDraftStateHash(draftAfter!)).toBe(
      buildResumeDraftStateHash(draftBefore!),
    );
    expect(draftAfter?.status).not.toBe("approved");
    const persistedExport = (
      await repository.listResumeExportArtifacts({ jobId: "job_ready" })
    ).find((artifact) => artifact.id === exportArtifact.id);
    expect(persistedExport?.isApproved).toBe(false);
    expect(persistedExport?.sha256).toBe(sha256);
  });

  test("blocks tailored Apply Copilot before execution when the profile changes after prerequisite reads", async () => {
    const seed = createSeed();
    const baseDocumentManager = createDocumentManager();
    const baseRuntime = createBrowserRuntime();
    let executeCallCount = 0;
    const browserRuntime = {
      ...baseRuntime,
      async executeApplicationFlow(
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
        options?: Parameters<typeof baseRuntime.executeApplicationFlow>[2],
      ) {
        executeCallCount += 1;
        return baseRuntime.executeApplicationFlow(source, input, options);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      documentManager: baseDocumentManager,
    });
    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    if (!exportArtifact) {
      throw new Error("Expected a resume export artifact.");
    }
    await workspaceService.approveResume("job_ready", exportArtifact.id);

    const baseGetProfileWithRevision =
      repository.getProfileWithRevision.bind(repository);
    let profileReads = 0;
    const prerequisiteGateRead = deferred<void>();
    const prerequisiteGateRelease = deferred<void>();
    repository.getProfileWithRevision = async () => {
      profileReads += 1;
      if (profileReads === 3) {
        prerequisiteGateRead.resolve();
        await prerequisiteGateRelease.promise;
      }
      return baseGetProfileWithRevision();
    };

    const start = workspaceService.startApplyCopilotRun("job_ready");
    await prerequisiteGateRead.promise;
    await editProfile(repository);
    prerequisiteGateRelease.resolve();

    await expect(start).rejects.toThrow(/profile changed/i);
    expect(executeCallCount).toBe(0);
    expect(await repository.listApplyRuns()).toHaveLength(0);
    expect(await repository.listApplyJobResults()).toHaveLength(0);
  });
});
