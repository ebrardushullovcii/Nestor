import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DiscoveryRunRecordSchema,
  ResumeDraftSchema,
  ResumeValidationResultSchema,
  ProfileCopilotMessageSchema,
  ProfileReviewItemSchema,
  SavedJobSchema,
} from "@nestor/contracts";
import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import { describe, expect, test, vi } from "vitest";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

function service(repository: JobFinderRepository) {
  const workspace = createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
  });
  if (!workspace.getWorkspaceProjection)
    throw new Error("Display projection is unavailable.");
  return {
    ...workspace,
    getWorkspaceProjection: workspace.getWorkspaceProjection.bind(workspace),
  };
}

async function fixture(storage: "memory" | "file", noRuntimeRefresh = false) {
  const seed = createSeed();
  if (noRuntimeRefresh)
    seed.jobSites.forEach((target) => {
      target.enabled = false;
    });
  const pending = SavedJobSchema.parse({
    ...seed.savedJobs[0],
    id: "pending_unique",
    status: "discovered",
    sourceJobId: "pending_unique",
    canonicalUrl: "https://example.com/jobs/pending_unique",
    title: "Pending role",
  });
  const run = DiscoveryRunRecordSchema.parse({
    id: "interrupted_with_checkpoint",
    state: "running",
    scope: "run_all",
    startedAt: "2026-10-13T10:00:00.000Z",
    targetIds: ["target_checkpoint"],
    targetExecutions: [
      {
        targetId: "target_checkpoint",
        adapterKind: "auto",
        state: "running",
        agentCheckpoint: {
          revision: 7,
          savedAt: "2026-10-13T10:00:01.000Z",
          stepCount: 3,
          currentUrl: "https://example.com/jobs",
          lastStableUrl: "https://example.com/jobs",
          collectedJobs: [
            { ...pending, description: "Durable checkpoint body" },
          ],
          visitedUrls: ["https://example.com/jobs"],
          phaseEvidence: {},
        },
      },
    ],
    summary: { targetsPlanned: 1, outcome: "running" },
  });
  seed.discovery = {
    ...seed.discovery,
  };
  const temp =
    storage === "file"
      ? await mkdtemp(path.join(os.tmpdir(), "nestor-snapshot-projection-"))
      : null;
  const repo = temp
    ? await createFileJobFinderRepository({
        filePath: path.join(temp, "workspace.sqlite"),
        seed,
      })
    : createInMemoryJobFinderRepository(seed);
  return {
    repo,
    run,
    pending,
    close: async () => {
      await repo.close();
      if (temp) await rm(temp, { recursive: true, force: true });
    },
  };
}

for (const storage of ["memory", "file"] as const) {
  describe(`${storage} snapshot display projection`, () => {
    if (storage === "file")
      test("company membership edits preserve discovery rows and match canonical company lists", async () => {
        const { repo, close } = await fixture(storage);
        try {
          const workspace = service(repo);
          await workspace.getWorkspaceProjection();
          const before = await workspace.getWorkspaceProjection();
          const intelligence = await repo.getIntelligenceState();
          const jobs = await repo.listSavedJobs();
          const chosen = jobs[0]!;
          const { CompanyEntitySchema } = await import("@nestor/contracts");
          await repo.saveIntelligenceState({
            ...intelligence,
            companies: [
              CompanyEntitySchema.parse({
                id: "synthetic_membership",
                canonicalName: "Synthetic employer",
                jobIds: [chosen.id],
                createdAt: "2026-10-23T00:00:00.000Z",
                updatedAt: "2026-10-23T00:00:00.000Z",
              }),
            ],
          });
          const after = await workspace.getWorkspaceProjection();
          const canonical = await workspace.getWorkspaceSnapshot();
          expect(after.companyJobs.map((job) => job.id)).toEqual([chosen.id]);
          // Compare the public IPC shape while lazy getters still have an open
          // repository. Internal preparation symbols may differ between reads.
          expect(structuredClone(after.companyJobs)).toEqual(
            structuredClone(canonical.companyJobs),
          );
          expect(structuredClone(after.discoveryJobs)).toEqual(
            structuredClone(before.discoveryJobs),
          );
          if (storage === "file")
            for (const row of after.discoveryJobs)
              expect(row).toBe(
                before.discoveryJobs.find((job) => job.id === row.id),
              );
        } finally {
          await close();
        }
      });
    test("profile review and copilot mutation callbacks return display metadata while public canonical reads stay owned", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const workspace = service(repo);
        await workspace.getWorkspaceProjection();
        const at = "2026-10-13T10:00:00.000Z";
        const setup = await repo.getProfileSetupState();
        await repo.saveProfileSetupState({
          ...setup,
          reviewItems: [
            ProfileReviewItemSchema.parse({
              id: "synthetic_review",
              step: "essentials",
              target: { domain: "identity", key: "headline" },
              label: "Review headline",
              reason: "Synthetic review",
              severity: "recommended",
              status: "pending",
              createdAt: at,
            }),
          ],
        });
        await repo.upsertProfileCopilotMessage(
          ProfileCopilotMessageSchema.parse({
            id: "synthetic_copilot",
            role: "assistant",
            content: "Synthetic proposal",
            createdAt: at,
            patchGroups: [
              {
                id: "synthetic_patch",
                summary: "Synthetic headline proposal",
                createdAt: at,
                operations: [
                  {
                    operation: "replace_identity_fields",
                    value: { headline: "Proposed synthetic headline" },
                  },
                ],
              },
            ],
          }),
        );
        const historyReads = vi.spyOn(repo, "listTailoredAssets");
        const reviewed = await workspace.applyProfileSetupReviewAction(
          "synthetic_review",
          "dismiss",
        );
        expect(
          reviewed.profileSetupState.reviewItems.find(
            (item) => item.id === "synthetic_review",
          )?.status,
        ).toBe("dismissed");
        const rejected =
          await workspace.rejectProfileCopilotPatchGroup("synthetic_patch");
        expect(
          rejected.profileCopilotMessages.find(
            (message) => message.id === "synthetic_copilot",
          )?.patchGroups[0]?.applyMode,
        ).toBe("rejected");
        expect(rejected.profile.headline).not.toBe(
          "Proposed synthetic headline",
        );
        expect(historyReads).not.toHaveBeenCalled();
        historyReads.mockRestore();
        const canonical = await workspace.getWorkspaceSnapshot();
        const originalLabel = canonical.tailoredAssets[0]!.label;
        canonical.tailoredAssets[0]!.label = "Caller-only edit";
        expect((await repo.listTailoredAssets())[0]?.label).toBe(originalLabel);
      } finally {
        await close();
      }
    });

    test("review shows only the latest validation's blockers and does not load validation history", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const jobId = createSeed().savedJobs[0]!.id;
        const draft = ResumeDraftSchema.parse({
          id: "review_draft",
          jobId,
          status: "needs_review",
          templateId: "classic_ats",
          sections: [],
          createdAt: "2026-10-13T09:00:00.000Z",
          updatedAt: "2026-10-13T10:00:00.000Z",
        });
        await repo.upsertResumeDraft(draft);
        const validation = (
          id: string,
          draftId: string,
          validatedAt: string,
          count: number,
        ) =>
          ResumeValidationResultSchema.parse({
            id,
            draftId,
            validatedAt,
            issues: [],
            // Unbacked generated lines: the only kind that waits on the person.
            claimAssessments: Array.from({ length: count }, (_, index) => ({
              id: `${id}_claim_${index}`,
              field: "section_bullet",
              sectionId: "section_experience",
              entryId: null,
              bulletId: `${id}_bullet_${index}`,
              claimText: "Synthetic line needs a decision.",
              claimOrigin: "ai_generated",
              contentHash: `fnv1a32:${index.toString(16).padStart(8, "0")}`,
              status: "unsupported",
              evidenceRefs: [],
              verifier: "model_fact_check_v1",
              assessedAt: validatedAt,
            })),
          });
        await repo.upsertResumeValidationResult(
          validation("old_review", draft.id, "2026-10-13T09:00:00.000Z", 4),
        );
        await repo.upsertResumeValidationResult(
          validation("latest_review", draft.id, "2026-10-13T10:00:00.000Z", 2),
        );
        await repo.upsertResumeValidationResult(
          validation(
            "unrelated_review",
            "other_draft",
            "2026-10-13T11:00:00.000Z",
            8,
          ),
        );
        const history = vi.spyOn(repo, "listResumeValidationResults");
        const latest = vi.spyOn(repo, "listLatestResumeValidationResults");
        const view = await service(repo).getWorkspaceProjection();
        expect(
          view.reviewQueue.find((item) => item.jobId === jobId)
            ?.resumeLinesToDecide,
        ).toBe(2);
        expect(history).not.toHaveBeenCalled();
        expect(latest).not.toHaveBeenCalled();
        history.mockRestore();
        latest.mockRestore();
      } finally {
        await close();
      }
    });
  });
}
