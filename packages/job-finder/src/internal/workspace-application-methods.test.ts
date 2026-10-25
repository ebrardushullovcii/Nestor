import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepositorySeed,
} from "@nestor/db";
import { describe, expect, test, vi } from "vitest";
import {
  CandidateAssetSchema,
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  ApplicationQuestionRecordSchema,
  ApplicationAnswerRecordSchema,
} from "@nestor/contracts";
import * as preparation from "./agent-application-preparation";

import { createJobFinderWorkspaceService } from "../workspace-service";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "../workspace-service.test-runtimes";
import type { ResumeExportFileVerifier } from "./workspace-service-context";
import type { CandidateAssetResolver } from "./workspace-service-contracts";

type ExecuteFlow = BrowserSessionRuntime["executeApplicationFlow"];

const RETIRED_USER_DATA_ROOT = "/retired-user-data/documents/resumes/generated";
const CURRENT_USER_DATA_ROOT = "/current-user-data/documents/resumes/generated";

const STALE_EXPORT_PATH = `${RETIRED_USER_DATA_ROOT}/job-ready-resume.pdf`;
const RECOVERED_EXPORT_PATH = `${CURRENT_USER_DATA_ROOT}/job-ready-resume.pdf`;
const STALE_ORIGINAL_RESUME_PATH = `${RETIRED_USER_DATA_ROOT}/alex-vanguard.pdf`;
const RECOVERED_ORIGINAL_RESUME_PATH = `${CURRENT_USER_DATA_ROOT}/alex-vanguard.pdf`;

const EXPORT_SHA256 = "b".repeat(64);
const ORIGINAL_RESUME_SHA256 = "a".repeat(64);

/**
 * Stands in for the desktop local verifier: it recovers a path that was
 * recorded under a retired user-data directory by looking for the same file
 * name under the current one, and reports which candidate it actually read.
 */
function createRecoveringExportFileVerifier(disk: ReadonlyMap<string, string>) {
  const resolveOnDiskPath = (filePath: string): string | null => {
    const trimmedPath = filePath.trim();
    if (disk.has(trimmedPath)) {
      return trimmedPath;
    }

    if (!trimmedPath.startsWith(`${RETIRED_USER_DATA_ROOT}/`)) {
      return null;
    }

    const recoveredPath = `${CURRENT_USER_DATA_ROOT}/${trimmedPath.split("/").at(-1)}`;
    return disk.has(recoveredPath) ? recoveredPath : null;
  };

  const verifier: ResumeExportFileVerifier = {
    exists(filePath) {
      return Promise.resolve(resolveOnDiskPath(filePath) !== null);
    },
    sha256(filePath) {
      const resolvedPath = resolveOnDiskPath(filePath);
      if (!resolvedPath) {
        throw new Error(`Resume export file is missing on disk: ${filePath}`);
      }

      return Promise.resolve(disk.get(resolvedPath)!);
    },
    resolvePath(filePath) {
      return Promise.resolve(resolveOnDiskPath(filePath));
    },
  };

  return verifier;
}

/**
 * Mirrors the production runtime, which re-checks the artifact path it is
 * handed with its own `access()` and reports `missing_resume` when that exact
 * path is unreadable. Reusing the catalog runtime's own missing-resume result
 * keeps the shape identical to the real blocked outcome.
 */
function createDiskAwareBrowserRuntime(reachablePaths: ReadonlySet<string>) {
  const baseRuntime = createBrowserRuntime();
  if (!baseRuntime.executeApplicationFlow) {
    throw new Error("Expected catalog browser runtime to support apply flows.");
  }

  const runFlow = baseRuntime.executeApplicationFlow.bind(baseRuntime);
  const executeApplicationFlow = vi.fn<ExecuteFlow>(
    async (source, input, options) => {
      const artifactPath = input.resumeArtifact.filePath.trim();
      if (reachablePaths.has(artifactPath)) {
        return runFlow(source, input, options);
      }

      return runFlow(
        source,
        {
          ...input,
          resumeArtifact: { ...input.resumeArtifact, filePath: "" },
        },
        options,
      );
    },
  );

  return {
    browserRuntime: { ...baseRuntime, executeApplicationFlow },
    executeApplicationFlow,
  };
}

function stageApprovedTailoredExport(
  seed: JobFinderRepositorySeed,
  filePath: string,
  sha256: string,
): void {
  seed.tailoredAssets = seed.tailoredAssets.map((asset) =>
    asset.jobId === "job_ready" ? { ...asset, storagePath: filePath } : asset,
  );
  seed.resumeDrafts = [
    {
      id: "resume_draft_job_ready",
      jobId: "job_ready",
      status: "approved",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "deterministic",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: "2026-03-20T10:04:00.000Z",
      approvedExportId: "resume_export_job_ready",
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:04:00.000Z",
    },
  ];
  seed.resumeExportArtifacts = [
    {
      id: "resume_export_job_ready",
      draftId: "resume_draft_job_ready",
      jobId: "job_ready",
      format: "pdf",
      filePath,
      sha256,
      pageCount: 2,
      templateId: "classic_ats",
      exportedAt: "2026-03-20T10:04:00.000Z",
      isApproved: true,
    },
  ];
}

function createService(input: {
  seed: JobFinderRepositorySeed;
  exportFileVerifier: ResumeExportFileVerifier;
  browserRuntime: BrowserSessionRuntime;
  candidateAssetResolver?: CandidateAssetResolver;
}) {
  const repository = createInMemoryJobFinderRepository(input.seed);
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime: input.browserRuntime,
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: input.exportFileVerifier,
    ...(input.candidateAssetResolver
      ? { candidateAssetResolver: input.candidateAssetResolver }
      : {}),
    researchAdapter: createResearchAdapter(),
  });
}

describe("apply prerequisites resolve the resume path the verifier actually read", () => {
  test("keeps the durable run and result start times after preparation completes", async () => {
    const seed = createSeed();
    stageApprovedTailoredExport(seed, RECOVERED_EXPORT_PATH, EXPORT_SHA256);
    const { browserRuntime } = createDiskAwareBrowserRuntime(
      new Set([RECOVERED_EXPORT_PATH]),
    );
    const runFlow = browserRuntime.executeApplicationFlow;
    if (!runFlow) throw new Error("Expected application flow support.");
    const repository = createInMemoryJobFinderRepository(seed);
    const runWrites = vi.spyOn(repository, "upsertApplyRun");
    const resultWrites = vi.spyOn(repository, "upsertApplyJobResult");
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: {
        ...browserRuntime,
        executeApplicationFlow: async (source, input, options) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return runFlow(source, input, options);
        },
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: createRecoveringExportFileVerifier(
        new Map([[RECOVERED_EXPORT_PATH, EXPORT_SHA256]]),
      ),
      researchAdapter: createResearchAdapter(),
    });

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const run = snapshot.applyRuns.at(-1);
    const result = snapshot.applyJobResults.find(
      (candidate) => candidate.runId === run?.id,
    );
    const firstRunWrite = runWrites.mock.calls.find(
      ([candidate]) => candidate.id === run?.id,
    )?.[0];
    const firstResultWrite = resultWrites.mock.calls.find(
      ([candidate]) => candidate.id === result?.id,
    )?.[0];

    expect(run?.createdAt).toBe(firstRunWrite?.createdAt);
    expect(result?.startedAt).toBe(firstResultWrite?.startedAt);
    expect(Date.parse(run?.createdAt ?? "")).toBeLessThan(
      Date.parse(run?.updatedAt ?? ""),
    );
  });

  test("uses a ready tailored draft in prepare-only execution without requiring a separate approval", async () => {
    const seed = createSeed();
    const draftPath = `${CURRENT_USER_DATA_ROOT}/job-ready-draft.pdf`;
    seed.tailoredAssets = seed.tailoredAssets.map((asset) =>
      asset.jobId === "job_ready"
        ? { ...asset, status: "ready", storagePath: draftPath }
        : asset,
    );
    seed.resumeDrafts = [
      {
        id: "resume_draft_job_ready",
        jobId: "job_ready",
        status: "needs_review",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: null,
        approvedExportId: null,
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [];
    const disk = new Map([[draftPath, EXPORT_SHA256]]);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set(disk.keys()));
    const workspaceService = createService({
      seed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime,
    });

    await workspaceService.startApplyCopilotRun("job_ready");

    expect(executeApplicationFlow.mock.calls[0]?.[1]).toMatchObject({
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
      resumeArtifact: {
        source: "tailored_export",
        sourceDocumentId: "resume_draft_job_ready",
        exportArtifactId: null,
        filePath: draftPath,
        sha256: EXPORT_SHA256,
      },
    });
  });

  test("requires an approved tailored resume for a sending mode before opening the browser", async () => {
    const draftPath = `${CURRENT_USER_DATA_ROOT}/job-ready-draft.pdf`;
    const unapprovedSeed = createSeed();
    unapprovedSeed.settings = {
      ...unapprovedSeed.settings,
      applicationAutomationMode: "autonomous_submit",
    };
    unapprovedSeed.tailoredAssets = unapprovedSeed.tailoredAssets.map((asset) =>
      asset.jobId === "job_ready"
        ? { ...asset, status: "ready", storagePath: draftPath }
        : asset,
    );
    unapprovedSeed.resumeDrafts = [
      {
        id: "resume_draft_job_ready",
        jobId: "job_ready",
        status: "needs_review",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: null,
        approvedExportId: null,
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    unapprovedSeed.resumeExportArtifacts = [];
    const disk = new Map([[draftPath, EXPORT_SHA256]]);
    const unapprovedRuntime = createDiskAwareBrowserRuntime(
      new Set(disk.keys()),
    );
    const unapprovedService = createService({
      seed: unapprovedSeed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime: unapprovedRuntime.browserRuntime,
    });

    await expect(
      unapprovedService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow("Approve the tailored resume");
    expect(unapprovedRuntime.executeApplicationFlow).not.toHaveBeenCalled();

    const approvedSeed = createSeed();
    approvedSeed.settings = {
      ...approvedSeed.settings,
      applicationAutomationMode: "autonomous_submit",
    };
    stageApprovedTailoredExport(approvedSeed, draftPath, EXPORT_SHA256);
    const approvedRuntime = createDiskAwareBrowserRuntime(new Set(disk.keys()));
    const approvedService = createService({
      seed: approvedSeed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime: approvedRuntime.browserRuntime,
    });

    await approvedService.startApplyCopilotRun("job_ready");
    expect(approvedRuntime.executeApplicationFlow).toHaveBeenCalledTimes(1);
  });

  test("offers allowed supporting Documents to an initial application run", async () => {
    const seed = createSeed();
    const draftPath = `${CURRENT_USER_DATA_ROOT}/job-ready-draft.pdf`;
    stageApprovedTailoredExport(seed, draftPath, EXPORT_SHA256);
    const asset = CandidateAssetSchema.parse({
      id: "asset-portfolio",
      kind: "portfolio",
      originalName: "portfolio.txt",
      mime: "text/plain",
      byteSize: 9,
      sha256: "c".repeat(64),
      createdAt: "2026-03-20T09:00:00.000Z",
      sensitivity: "sensitive",
      consentScope: "job_application_attachment",
      retention: "until_deleted",
    });
    const loadVerifiedBytes = vi.fn(() =>
      Promise.resolve(new TextEncoder().encode("portfolio")),
    );
    const disk = new Map([[draftPath, EXPORT_SHA256]]);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set(disk.keys()));
    const listAssets = vi.fn(() => Promise.resolve({ assets: [asset] }));
    const workspaceService = createService({
      seed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime,
      candidateAssetResolver: {
        list: listAssets,
        resolveForApplication: () =>
          Promise.resolve({ asset, loadVerifiedBytes }),
      },
    });

    await workspaceService.startApplyCopilotRun("job_ready");

    expect(listAssets).toHaveBeenCalledWith({ includeDeleted: false });
    expect(executeApplicationFlow.mock.calls[0]?.[1].applicationAttachments).toEqual([
      {
        assetId: asset.id,
        assetKind: "portfolio",
        questionId: null,
        prompt: "Portfolio from the person's files",
        questionKind: "portfolio",
        fileName: asset.originalName,
        mime: asset.mime,
        sha256: asset.sha256,
        loadVerifiedBytes,
      },
    ]);
  });

  test("hands the recovered tailored export path to the runtime instead of the stale recorded one", async () => {
    const seed = createSeed();
    stageApprovedTailoredExport(seed, STALE_EXPORT_PATH, EXPORT_SHA256);
    const disk = new Map([[RECOVERED_EXPORT_PATH, EXPORT_SHA256]]);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set(disk.keys()));
    const workspaceService = createService({
      seed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime,
    });

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");

    // The visible defect first: the readiness gate passes, then the runtime
    // re-checks the recorded path, reports missing_resume, and the stale
    // blocker sync offers the same failing retry again.
    const jobResult = snapshot.applyJobResults.find(
      (result) => result.jobId === "job_ready",
    );
    expect(jobResult?.blockerReason).not.toBe("resume_missing");
    expect(snapshot.applicationRecords[0]?.latestBlocker?.code).not.toBe(
      "missing_resume",
    );
    expect(snapshot.applicationRecords[0]?.nextActionLabel).not.toBe(
      "Retry preparation when you are ready.",
    );

    const executionInput = executeApplicationFlow.mock.calls[0]?.[1];
    expect(executionInput?.resumeArtifact).toMatchObject({
      jobId: "job_ready",
      source: "tailored_export",
      exportArtifactId: "resume_export_job_ready",
      fileName: "job-ready-resume.pdf",
      filePath: RECOVERED_EXPORT_PATH,
    });
    expect(executionInput?.resumeArtifact.sha256).toBe(EXPORT_SHA256);
    expect(executionInput).toMatchObject({
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
    });
  });

  test("hands the recovered original CV path to the runtime instead of the stale recorded one", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    seed.profile = {
      ...seed.profile,
      baseResume: {
        ...seed.profile.baseResume,
        storagePath: STALE_ORIGINAL_RESUME_PATH,
        sha256: ORIGINAL_RESUME_SHA256,
      },
    };
    const disk = new Map([
      [RECOVERED_ORIGINAL_RESUME_PATH, ORIGINAL_RESUME_SHA256],
    ]);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set(disk.keys()));
    const workspaceService = createService({
      seed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime,
    });

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");

    const jobResult = snapshot.applyJobResults.find(
      (result) => result.jobId === "job_ready",
    );
    expect(jobResult?.blockerReason).not.toBe("resume_missing");
    expect(snapshot.applicationRecords[0]?.latestBlocker?.code).not.toBe(
      "missing_resume",
    );

    const executionInput = executeApplicationFlow.mock.calls[0]?.[1];
    expect(executionInput?.resumeArtifact).toMatchObject({
      jobId: "job_ready",
      source: "original_upload",
      sourceDocumentId: "resume_1",
      exportArtifactId: null,
      fileName: "alex-vanguard.pdf",
      filePath: RECOVERED_ORIGINAL_RESUME_PATH,
    });
  });

  test("keeps the recorded path when the verifier cannot resolve one", async () => {
    const seed = createSeed();
    stageApprovedTailoredExport(seed, RECOVERED_EXPORT_PATH, EXPORT_SHA256);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set([RECOVERED_EXPORT_PATH]));
    const workspaceService = createService({
      seed,
      // A verifier without resolvePath, exactly like every existing caller.
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      browserRuntime,
    });

    await workspaceService.startApplyCopilotRun("job_ready");

    expect(
      executeApplicationFlow.mock.calls[0]?.[1]?.resumeArtifact.filePath,
    ).toBe(RECOVERED_EXPORT_PATH);
  });

  test("still fails closed when the recovered tailored export no longer matches its saved digest", async () => {
    const seed = createSeed();
    stageApprovedTailoredExport(seed, STALE_EXPORT_PATH, EXPORT_SHA256);
    const disk = new Map([[RECOVERED_EXPORT_PATH, "c".repeat(64)]]);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set(disk.keys()));
    const workspaceService = createService({
      seed,
      exportFileVerifier: createRecoveringExportFileVerifier(disk),
      browserRuntime,
    });

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/changed after it was saved/);
    expect(executeApplicationFlow).not.toHaveBeenCalled();
  });

  test("still blocks when no candidate for the recorded export exists on disk", async () => {
    const seed = createSeed();
    stageApprovedTailoredExport(seed, STALE_EXPORT_PATH, EXPORT_SHA256);
    const { browserRuntime, executeApplicationFlow } =
      createDiskAwareBrowserRuntime(new Set<string>());
    const workspaceService = createService({
      seed,
      exportFileVerifier: createRecoveringExportFileVerifier(new Map()),
      browserRuntime,
    });

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");

    expect(executeApplicationFlow).not.toHaveBeenCalled();
    expect(
      snapshot.applyJobResults.find((result) => result.jobId === "job_ready"),
    ).toMatchObject({ state: "blocked", blockerReason: "resume_missing" });
  });
});

test.each(
  (["direct", "approved", "queue"] as const).flatMap((path) =>
    [false, true].map((multistep) => ({ path, multistep })),
  ),
)(
  "$path preparation keeps answer sources in the persisted card (multistep: $multistep)",
  async ({ path, multistep }) => {
    const seed = createSeed();
    stageApprovedTailoredExport(seed, RECOVERED_EXPORT_PATH, EXPORT_SHA256);
    const ready = ApplyExecutionResultSchema.parse({
      state: "ready",
      summary: "Prepared",
      detail: "Nothing sent",
      submittedAt: null,
      outcome: null,
      nextActionLabel: "Review",
    });
    const labels = [
      "Full name",
      "Email",
      "Phone",
      "Portfolio URL",
      path === "queue" ? "Work areas" : "Why this role?",
    ];
    const sources = [
      "your name",
      "your email address",
      "your phone number",
      "your portfolio",
      "your answer to this question",
    ];
    const ids = [
      "profile.name",
      "profile.email",
      "profile.phone",
      "profile.portfolio",
      "answerLibrary.application_answer",
    ];
    const values = [
      "Alex Example",
      "alex@example.test",
      "+44123456789",
      "https://example.test/portfolio",
      path === "queue" ? "Finance; Reporting" : "I build dependable platforms.",
    ];
    if (multistep) {
      labels.push("Declaration");
      sources.push("your Settings (on by default)");
      ids.push("settings.declaration");
      values.push("Yes");
    }
    let preparations = 0;
    const preparer = vi
      .spyOn(preparation, "createApplyFormPreparer")
      .mockImplementation((input) => {
        preparations += 1;
        const indices = labels
          .map((_, index) => index)
          .filter((index) =>
            multistep
              ? preparations === 1 ||
                (preparations === 4 ? index < 2 : index === 5)
              : preparations !== 4 || index < 4,
          );
        const fieldKey = (index: number) =>
          `https://example.test/apply|${multistep ? `Screen ${index + 1}` : "Application"}|c${index + preparations * 10}|${labels[index]}`;
        const card = ApplicationReviewCardSchema.parse({
          siteLabel: "Example",
          pageUrl: "https://example.test/apply",
          preparedAt: new Date().toISOString(),
          ...(multistep ? { observedFieldKeys: indices.map(fieldKey) } : {}),
          answers: indices.map((index) => ({
            question: labels[index],
            fieldKey: fieldKey(index),
            answer:
              preparations === 4 && index === 1
                ? "changed@example.test"
                : values[index],
            source:
              preparations === 1 && index !== 4
                ? sources[index]
                : "the filled application form",
            ...(index === 4 && preparations === 1
              ? {}
              : {
                  sourceId:
                    preparations === 1 ? ids[index] : `observed.c${index}`,
                }),
            written: false,
          })),
        });
        input.onPrepared?.({
          reviewCard: card,
          handoff: { status: "not_ready", reason: "Nothing sent" },
          result: {
            outcome: "prepared",
            reason: "Prepared",
            steps: 1,
            finalUrl: card.pageUrl,
            filled: [],
            attachments: [],
            pauses: [],
            notes: [],
            timeline: [],
            modelTurns: 1,
            readyToSend: null,
          },
        });
        return () => Promise.resolve(ready);
      });
    const base = createBrowserRuntime();
    const repository = createInMemoryJobFinderRepository(seed);
    const service = createJobFinderWorkspaceService({
      repository,
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      researchAdapter: createResearchAdapter(),
      exportFileVerifier: createRecoveringExportFileVerifier(
        new Map([[RECOVERED_EXPORT_PATH, EXPORT_SHA256]]),
      ),
      browserRuntime: {
        ...base,
        executeApplicationFlow: () => Promise.resolve(ready),
      },
    });
    try {
      let applicationRecordId: string | null = null;
      for (let run = 0; run < 4; run += 1) {
        const snapshot: Awaited<
          ReturnType<typeof service.startApplyCopilotRun>
        > =
          path === "direct"
            ? await service.startApplyCopilotRun(
                "job_ready",
                undefined,
                applicationRecordId,
              )
            : path === "approved"
              ? await service.approveApply("job_ready", applicationRecordId)
              : await (async () => {
                  const staged = await service.startAutoApplyRun(
                    "job_ready",
                    applicationRecordId,
                  );
                  const pending = staged.applyRuns.find(
                    (entry) => entry.state === "awaiting_submit_approval",
                  );
                  if (!pending) throw new Error("Expected staged run");
                  return service.approveApplyRun(pending.id);
                })();
        const newest: (typeof snapshot.applyJobResults)[number] | undefined = [
          ...snapshot.applyJobResults,
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        applicationRecordId = newest?.applicationRecordId ?? null;
        expect(applicationRecordId).not.toBeNull();
        const card = newest?.reviewCard;
        expect(card?.answers).toHaveLength(
          multistep ? (run === 3 ? 2 : 6) : run === 3 ? 4 : 5,
        );
        expect(card?.answers.map((answer) => answer.source)).toEqual(
          run === 3
            ? [
                sources[0],
                "the filled application form",
                ...(multistep ? [] : sources.slice(2, 4)),
              ]
            : run === 0
              ? [
                  ...sources.slice(0, 4),
                  "the filled application form",
                  ...sources.slice(5),
                ]
              : sources,
        );
        if (run > 0 && run !== 3)
          expect(card?.answers[4]?.sourceId).toBe(
            "applicationAnswer.approved_answer",
          );
        if (run === 0 && newest && applicationRecordId) {
          const at = new Date().toISOString();
          await repository.upsertApplicationQuestionRecord(
            ApplicationQuestionRecordSchema.parse({
              id: "approved_question",
              runId: newest.runId,
              jobId: "job_ready",
              applicationRecordId,
              resultId: newest.id,
              prompt: labels[4],
              answerControlType: path === "queue" ? "multi_choice" : "text",
              detectedAt: at,
              selectedAnswerId: "approved_answer",
            }),
          );
          await repository.upsertApplicationAnswerRecord(
            ApplicationAnswerRecordSchema.parse({
              id: "approved_answer",
              runId: newest.runId,
              jobId: "job_ready",
              applicationRecordId,
              resultId: newest.id,
              questionId: "approved_question",
              text:
                path === "queue"
                  ? JSON.stringify(["Reporting", "Finance"])
                  : values[4],
              sourceKind: "user",
              status: "suggested",
              createdAt: at,
            }),
          );
        }
      }
    } finally {
      preparer.mockRestore();
    }
  },
);
