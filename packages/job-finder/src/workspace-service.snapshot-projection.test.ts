import { mkdtemp, rm } from "node:fs/promises";
import { StatementSync } from "node:sqlite";
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
    seed.searchPreferences.discovery.targets.forEach((target) => {
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
    runState: "running",
    activeRun: run,
    recentRuns: [run],
    pendingDiscoveryJobs: [
      pending,
      {
        ...seed.savedJobs[0]!,
        title: "Duplicate pending row must yield to saved row",
      },
    ],
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
      test("a second snapshot does not read discovery storage", async () => {
        const { repo, close } = await fixture(storage, true);
        try {
          const workspace = service(repo);
          await vi.waitFor(async () =>
            expect((await repo.getDiscoveryState()).activeRun).toBeNull(),
          );
          await workspace.getWorkspaceBootstrap();
          await workspace.getWorkspaceProjection();
          const reads: string[] = [];
          const all = Reflect.get(StatementSync.prototype, "all");
          const spy = vi
            .spyOn(StatementSync.prototype, "all")
            .mockImplementation(function (
              this: StatementSync,
              ...args: Parameters<StatementSync["all"]>
            ) {
              if (
                /\bFROM\s+(?:discovery_runs|discovery_ledger|discovery_run_targets|discovery_run_activity|discovery_ledger_observations)\b/i.test(
                  this.sourceSQL,
                )
              )
                reads.push(this.sourceSQL);
              return all.apply(this, args);
            });
          try {
            await workspace.getWorkspaceProjection();
            expect(reads).toEqual([]);
          } finally {
            spy.mockRestore();
          }
        } finally {
          await close();
        }
      });
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

    test("changed rows and activity converge while display progress never rewrites plans", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const workspace = service(repo);
        await workspace.getWorkspaceProjection();
        // Settle adoption before measuring ordinary display reads.
        await workspace.getWorkspaceProjection();
        const save = vi.spyOn(repo, "saveCampaignState");
        const [job] = await repo.listSavedJobs();
        if (!job) throw new Error("Expected a saved job");
        const original = await workspace.getWorkspaceProjection();
        await repo.commitSavedJobDelta({
          updateJobIds: [job.id],
          update: (current) => ({
            ...current,
            status: "archived",
            discoveryFeedback: {
              version: 1,
              revision: 1,
              reasons: [],
              recordedAt: "2026-10-23T00:00:00.000Z",
              priorStatus: current.status,
              employerExclusion: null,
            },
          }),
        });
        const hidden = await workspace.getWorkspaceProjection();
        expect(hidden.discoveryJobs.some((row) => row.id === job.id)).toBe(
          false,
        );
        expect(
          hidden.dismissedDiscoveryJobs.some((row) => row.id === job.id),
        ).toBe(true);
        const unchanged = await workspace.getWorkspaceProjection();
        expect(unchanged.campaigns).toEqual(hidden.campaigns);
        expect(save).not.toHaveBeenCalled();
        await repo.commitSavedJobDelta({
          updateJobIds: [job.id],
          update: (current) => ({
            ...current,
            status: job.status,
            discoveryFeedback: job.discoveryFeedback,
          }),
        });
        const restored = await workspace.getWorkspaceProjection();
        expect(restored.discoveryJobs.map((row) => row.id)).toEqual(
          original.discoveryJobs.map((row) => row.id),
        );
        expect(restored.dismissedDiscoveryJobs.map((row) => row.id)).toEqual(
          original.dismissedDiscoveryJobs.map((row) => row.id),
        );
        const canonical = await workspace.getWorkspaceSnapshot();
        expect(structuredClone(restored.discoveryJobs)).toEqual(
          structuredClone(canonical.discoveryJobs),
        );
        expect(structuredClone(restored.companyJobs)).toEqual(
          structuredClone(canonical.companyJobs),
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
    test("recovery retains the newest transaction-current checkpoints; only display/bootstrap omit them", async () => {
      const { repo, run, close } = await fixture(storage);
      try {
        let intercept = true;
        const recoveryRead = vi.spyOn(repo, "readDiscoveryBootstrapProjection");
        const displayRead = vi.spyOn(repo, "readDiscoveryDisplayProjection");
        const wrapped: JobFinderRepository = {
          ...repo,
          commitDiscoveryStateUpdate: async (update) => {
            if (intercept) {
              intercept = false;
              await repo.commitDiscoveryStateUpdate((current) => ({
                ...current,
                activeRun: current.activeRun
                  ? {
                      ...current.activeRun,
                      targetExecutions: current.activeRun.targetExecutions.map(
                        (execution) => ({
                          ...execution,
                          agentCheckpoint: execution.agentCheckpoint
                            ? { ...execution.agentCheckpoint, revision: 8 }
                            : null,
                        }),
                      ),
                    }
                  : null,
              }));
            }
            return repo.commitDiscoveryStateUpdate(update);
          },
        };
        const workspace = service(wrapped);
        const activeBootstrap = await workspace.getWorkspaceBootstrap();
        expect(
          activeBootstrap.activeDiscoveryRun?.targetExecutions[0]
            ?.agentCheckpoint,
        ).toBeNull();
        expect(activeBootstrap.recentDiscoveryRuns).toEqual([]);
        recoveryRead.mockClear();
        displayRead.mockClear();
        const display = await workspace.getWorkspaceProjection();
        expect(recoveryRead).toHaveBeenCalledOnce();
        expect(displayRead).toHaveBeenCalledOnce();
        const recovered = display.recentDiscoveryRuns.find(
          (item) => item.id === run.id,
        );
        expect(recovered).toMatchObject({
          state: "failed",
          runPhase: "interrupted",
        });
        expect(recovered?.targetExecutions[0]).toMatchObject({
          targetId: "target_checkpoint",
          state: "failed",
          agentCheckpoint: null,
        });
        const canonical = await workspace.getWorkspaceSnapshot();
        expect(
          canonical.recentDiscoveryRuns.find((item) => item.id === run.id)
            ?.targetExecutions[0]?.agentCheckpoint,
        ).toMatchObject({
          revision: 8,
          collectedJobs: [{ description: "Durable checkpoint body" }],
        });
        const bootstrap = await workspace.getWorkspaceBootstrap();
        expect(bootstrap.recentDiscoveryRuns).toEqual([]);
        expect(
          (await repo.exportState()).discovery.recentRuns[0]
            ?.targetExecutions[0]?.agentCheckpoint?.revision,
        ).toBe(8);
      } finally {
        await close();
      }
    });

    test("pending listings and saved-row precedence match canonical snapshots; unchanged display refreshes avoid canonical discovery reads", async () => {
      const { repo, pending, close } = await fixture(storage);
      try {
        const workspace = service(repo);
        const readIntelligence = vi.spyOn(repo, "getIntelligenceState");
        const bootstrap = await workspace.getWorkspaceBootstrap();
        expect(bootstrap.hydration.phase).toBe("bootstrap");
        expect(readIntelligence).not.toHaveBeenCalled();
        readIntelligence.mockRestore();
        await vi.waitFor(async () =>
          expect((await repo.getDiscoveryState()).activeRun).toBeNull(),
        );
        const canonical = await workspace.getWorkspaceSnapshot();
        const readCanonical = vi.spyOn(repo, "getDiscoveryState");
        const first = await workspace.getWorkspaceProjection();
        const second = await workspace.getWorkspaceProjection();
        expect(readCanonical).not.toHaveBeenCalled();
        expect(structuredClone(first.discoveryJobs)).toEqual(
          structuredClone(canonical.discoveryJobs),
        );
        expect(structuredClone(second.discoveryJobs)).toEqual(
          structuredClone(first.discoveryJobs),
        );
        expect(
          first.discoveryJobs.filter((job) => job.id === pending.id),
        ).toHaveLength(1);
        expect(
          first.discoveryJobs.some(
            (job) =>
              job.title === "Duplicate pending row must yield to saved row",
          ),
        ).toBe(false);
        expect(
          canonical.recentDiscoveryRuns[0]?.targetExecutions[0]
            ?.agentCheckpoint,
        ).not.toBeNull();
        expect(
          first.recentDiscoveryRuns[0]?.targetExecutions[0]?.agentCheckpoint,
        ).toBeNull();
        canonical.recentDiscoveryRuns[0]!.targetExecutions[0]!.agentCheckpoint!.collectedJobs[0]!.description =
          "Caller mutation";
        expect(
          (await repo.getDiscoveryState()).recentRuns[0]?.targetExecutions[0]
            ?.agentCheckpoint?.collectedJobs[0]?.description,
        ).toBe("Durable checkpoint body");
        readCanonical.mockRestore();
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
