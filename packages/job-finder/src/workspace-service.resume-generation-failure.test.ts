import { describe, expect, test } from "vitest";
import type { JobFinderAiClient } from "@nordri/ai-providers";
import { createInMemoryJobFinderRepository } from "@nordri/db";

import { createJobFinderWorkspaceService } from "./index";
import { buildResumeRenderDocument } from "./internal/resume-workspace-structure";
import { createSeed } from "./workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

const GENERATION_ERROR =
  "Provider request failed with api_key=sk-abc123XYZdef456 and status 502\nat provider gateway\nretry later";

function createFailingGenerationAiClient(): JobFinderAiClient {
  const baseAiClient = createAiClient();

  return {
    ...baseAiClient,
    createResumeDraft() {
      return Promise.reject(new Error(GENERATION_ERROR));
    },
  } satisfies JobFinderAiClient;
}

describe("tailored resume generation failure durability", () => {
  test("records a sanitized failed asset without losing the original error", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: createFailingGenerationAiClient(),
    });

    await expect(workspaceService.generateResume("job_ready")).rejects.toThrow(
      /Provider request failed/,
    );

    const failedAsset = (await repository.listTailoredAssets()).find(
      (asset) => asset.jobId === "job_ready",
    );
    expect(failedAsset).toMatchObject({
      id: "asset_ready",
      version: "v2",
      status: "failed",
      storagePath: "/tmp/job-ready-resume.pdf",
    });
    expect(failedAsset?.failureMessage).toContain("Provider request failed");
    expect(failedAsset?.failureMessage).not.toContain("sk-abc123XYZdef456");
    expect(failedAsset?.failureMessage).not.toContain("\n");
    expect(failedAsset?.failedAt).toBeTruthy();

    const queueItem = (
      await workspaceService.getWorkspaceSnapshot()
    ).reviewQueue.find((item) => item.jobId === "job_ready");
    expect(queueItem?.assetStatus).toBe("failed");
  });

  test("a failed regenerate leaves the job's existing resume as it was (ADR 0041)", async () => {
    let failing = false;
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        createResumeDraft(input) {
          return failing
            ? Promise.reject(new Error(GENERATION_ERROR))
            : baseAiClient.createResumeDraft(input);
        },
      },
    });
    await workspaceService.generateResume("job_ready");
    const before = {
      asset: (await repository.listTailoredAssets()).find(
        (asset) => asset.jobId === "job_ready",
      ),
      draft: await repository.getResumeDraftByJobId("job_ready"),
    };

    failing = true;
    await expect(workspaceService.generateResume("job_ready")).rejects.toThrow(
      /Provider request failed/,
    );

    expect(
      (await repository.listTailoredAssets()).find(
        (asset) => asset.jobId === "job_ready",
      ),
    ).toMatchObject({
      ...before.asset,
      failureMessage: expect.stringContaining(
        "Your previous resume was kept.",
      ) as unknown,
      failedAt: expect.any(String) as unknown,
    });
    expect(await repository.getResumeDraftByJobId("job_ready")).toEqual(
      before.draft,
    );
  });

  test("does not record a failed asset when a newer edit superseded the generation", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const baseAiClient = createAiClient();
    let supersedeDuringGeneration = false;
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: {
        ...baseAiClient,
        async createResumeDraft(input) {
          if (supersedeDuringGeneration) {
            // Simulate a newer edit from another writer winning between the
            // generation snapshot and its persist attempt.
            const currentDraft =
              await repository.getResumeDraftByJobId("job_ready");
            if (currentDraft) {
              await repository.upsertResumeDraft({
                ...currentDraft,
                identity: {
                  ...currentDraft.identity!,
                  headline: "Newer edit wins.",
                },
                updatedAt: new Date(
                  Date.parse(currentDraft.updatedAt) + 60_000,
                ).toISOString(),
              });
            }
            throw new Error(GENERATION_ERROR);
          }
          return baseAiClient.createResumeDraft(input);
        },
      },
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    await workspaceService.generateResume("job_ready");
    supersedeDuringGeneration = true;

    // The stale generation still reports its provider error truthfully...
    await expect(workspaceService.generateResume("job_ready")).rejects.toThrow(
      /Provider request failed/,
    );

    // ...but the newer canonical edit survives untouched and no false failed
    // asset was persisted over it.
    const survivingDraft = await repository.getResumeDraftByJobId("job_ready");
    expect(survivingDraft?.identity?.headline).toBe("Newer edit wins.");
    const asset = (await repository.listTailoredAssets()).find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(asset).toMatchObject({
      id: "asset_ready",
      status: "ready",
      failureMessage: null,
      failedAt: null,
    });
    const queueItem = (
      await workspaceService.getWorkspaceSnapshot()
    ).reviewQueue.find((item) => item.jobId === "job_ready");
    expect(queueItem?.assetStatus).not.toBe("failed");
  });

  test("failed state survives a service reload and a successful retry clears it", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const failingService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createFailingGenerationAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    await expect(failingService.generateResume("job_ready")).rejects.toThrow(
      /Provider request failed/,
    );

    // Restart truth: a fresh service over the same repository still reports
    // the failure instead of falling back to not_started.
    const reloadedService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });
    const reloadedQueueItem = (
      await reloadedService.getWorkspaceSnapshot()
    ).reviewQueue.find((item) => item.jobId === "job_ready");
    expect(reloadedQueueItem?.assetStatus).toBe("failed");

    await reloadedService.generateResume("job_ready");

    const retriedAsset = (await repository.listTailoredAssets()).find(
      (asset) => asset.jobId === "job_ready",
    );
    expect(retriedAsset).toMatchObject({
      id: "asset_ready",
      version: "v3",
      status: "ready",
      progressPercent: 100,
      failureMessage: null,
      failedAt: null,
    });
    const retryQueueItem = (
      await reloadedService.getWorkspaceSnapshot()
    ).reviewQueue.find((item) => item.jobId === "job_ready");
    expect(retryQueueItem?.assetStatus).toBe("ready");
  });

  test("keeps propagating the generation error when recording the failure fails", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    let failFailureUpserts = false;
    const flakyRepository = {
      ...repository,
      upsertTailoredAsset(
        asset: Parameters<typeof repository.upsertTailoredAsset>[0],
      ) {
        if (failFailureUpserts) {
          return Promise.reject(new Error("disk full"));
        }
        return repository.upsertTailoredAsset(asset);
      },
    };
    const workspaceService = createJobFinderWorkspaceService({
      repository: flakyRepository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createFailingGenerationAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    failFailureUpserts = true;

    await expect(workspaceService.generateResume("job_ready")).rejects.toThrow(
      /Provider request failed/,
    );
    const rejection = await workspaceService.generateResume("job_ready").then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/Provider request failed/);
    expect((rejection as Error).message).not.toMatch(/disk full/);
  });

  test("keeps successful generations free of failure detail", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");

    const asset = (await repository.listTailoredAssets()).find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(asset).toMatchObject({
      id: "asset_ready",
      version: "v3",
      status: "ready",
      failureMessage: null,
      failedAt: null,
    });
  });
});

test("generation sees only confirmed profile records and renders no import draft role", async () => {
  const seed = createSeed();
  seed.profile.experiences.push({
    ...seed.profile.experiences[0]!,
    id: "import_draft",
    title: "/",
    isDraft: true,
  });
  const base = createAiClient();
  const harness = createWorkspaceServiceHarness({
    seed,
    aiClient: {
      ...base,
      async createResumeDraft(input) {
        expect(input.profile.experiences.some((role) => role.isDraft)).toBe(
          false,
        );
        return base.createResumeDraft(input);
      },
    },
  });
  await harness.workspaceService.generateResume("job_ready");
  const workspace =
    await harness.workspaceService.getResumeWorkspace("job_ready");
  expect(
    workspace?.draft.sections
      .flatMap((section) => section.entries)
      .some((entry) => entry.profileRecordId === "import_draft"),
  ).toBe(false);
});

test("a saved hidden role stays out of preview and rendering after reload and can be restored", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const workspace = await workspaceService.getResumeWorkspace("job_ready");
  const section = workspace.draft.sections.find(
    (item) => item.kind === "experience",
  )!;
  const role = section.entries.find((entry) => entry.included)!;
  const hidden = {
    ...workspace.draft,
    sections: workspace.draft.sections.map((item) =>
      item.id === section.id
        ? {
            ...item,
            entries: item.entries.map((entry) =>
              entry.id === role.id
                ? { ...entry, included: false, origin: "user_edited" as const }
                : entry,
            ),
          }
        : item,
    ),
  };
  await workspaceService.saveResumeDraft(hidden);
  const reloaded = await workspaceService.getResumeWorkspace("job_ready");
  expect(
    reloaded.draft.sections
      .find((item) => item.id === section.id)
      ?.entries.find((entry) => entry.id === role.id)?.included,
  ).toBe(false);
  const text = buildResumeRenderDocument(createSeed().profile, reloaded.draft)
    .sections.flatMap((item) => item.entries)
    .map((entry) => entry.title);
  expect(text).not.toContain(role.title);
  await workspaceService.saveResumeDraft({
    ...reloaded.draft,
    sections: reloaded.draft.sections.map((item) =>
      item.id === section.id
        ? {
            ...item,
            entries: item.entries.map((entry) =>
              entry.id === role.id ? { ...entry, included: true } : entry,
            ),
          }
        : item,
    ),
  });
  expect(
    (await workspaceService.getResumeWorkspace("job_ready")).draft.sections
      .find((item) => item.id === section.id)
      ?.entries.find((entry) => entry.id === role.id)?.included,
  ).toBe(true);
});

test("removing a job during writing keeps it removed and discards the finished draft", async () => {
  const base = createAiClient();
  let release!: () => void;
  let writing!: () => void;
  const started = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    aiClient: {
      ...base,
      async createResumeDraft(input) {
        writing();
        await waiting;
        return base.createResumeDraft(input);
      },
    },
  });
  const pending = workspaceService.generateResume("job_ready");
  await started;
  await workspaceService.removeJobFromReview("job_ready");
  release();
  await pending;
  expect(
    (await repository.listSavedJobs()).find((job) => job.id === "job_ready")
      ?.status,
  ).toBe("shortlisted");
  expect(await repository.getResumeDraftByJobId("job_ready")).toBeNull();
  expect(
    (await workspaceService.getWorkspaceSnapshot()).reviewQueue.some(
      (item) => item.jobId === "job_ready",
    ),
  ).toBe(false);
});
