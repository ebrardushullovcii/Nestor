import { randomUUID } from "node:crypto";

import {
  JobFinderIntelligenceStateSchema,
  RecommendResumeStrategyInputSchema,
  RecordOutcomeInputSchema,
  RapidReviewDecisionLogSchema,
  RapidReviewMutationInputSchema,
  ResumeStrategyRecommendationSchema,
  ReviewCompanyMergeInputSchema,
  SaveResumeStrategyInputSchema,
  SelectResumeStrategyInputSchema,
  SetCampaignResumeStrategyDefaultInputSchema,
  SetCompanyPreferenceInputSchema,
  SetOutcomeSuggestionEnabledInputSchema,
  CompanyIntelligenceMutationInputSchema,
  normalizeCompanyName,
  type CompanyIntelligenceMutationInput,
  type JobFinderWorkspaceSnapshot,
  type RapidReviewDecision,
  type RapidReviewDecisionLog,
  type RapidReviewMutationInput,
  type RecommendResumeStrategyInput,
  type RecordOutcomeInput,
  type ResumeStrategyRecommendation,
  type ReviewCompanyMergeInput,
  type SaveResumeStrategyInput,
  type SelectResumeStrategyInput,
  type SetCampaignResumeStrategyDefaultInput,
  type SetCompanyPreferenceInput,
  type SetOutcomeSuggestionEnabledInput,
} from "@nordri/contracts";

import {
  appendRapidReviewDecisions,
  deriveCurrentRapidReviewDecision,
  undoLatestActiveRapidReviewDecision,
} from "./rapid-review-operations";
import {
  appendOutcomeEvent,
  disableOutcomeSuggestion,
  deriveOutcomeAnalytics,
  resetOutcomeSuggestion,
} from "./outcome-analytics";
import {
  applyCompanyIntelligenceMutation,
  nextCompanyIntelligenceUpdatedAt,
  reconcileCompanies,
  reviewCompanyMerge,
  setCompanyPreference,
} from "./company-intelligence-operations";
import {
  createResumeStrategy,
  disableResumeStrategy,
  selectResumeStrategy,
  updateResumeStrategy,
} from "./resume-strategy-operations";
import {
  recommendResumeStrategyForJob,
  resolveCampaignDefaultResumeStrategyId,
} from "./resume-strategy-application";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { ensureCampaignState } from "./campaign-dashboard";
import {
  appendExactEmployerExclusion,
  removeExactEmployerExclusion,
  resolveEmployerExclusionPreview,
} from "./employer-exclusion";

type RapidReviewCallbacks = {
  shortlist(jobId: string): Promise<unknown>;
  reject(jobId: string): Promise<unknown>;
  restore(jobId: string): Promise<unknown>;
};

function getLog(
  logs: readonly RapidReviewDecisionLog[],
  campaignId: string,
): RapidReviewDecisionLog {
  return (
    logs.find((log) => log.campaignId === campaignId) ??
    RapidReviewDecisionLogSchema.parse({ campaignId })
  );
}

function replaceLog(
  logs: readonly RapidReviewDecisionLog[],
  next: RapidReviewDecisionLog,
): RapidReviewDecisionLog[] {
  return logs.some((log) => log.campaignId === next.campaignId)
    ? logs.map((log) => (log.campaignId === next.campaignId ? next : log))
    : [...logs, next];
}

async function applyDecision(
  callbacks: RapidReviewCallbacks,
  decision: RapidReviewDecision | null,
  jobId: string,
): Promise<void> {
  if (decision?.kind === "shortlist") {
    await callbacks.shortlist(jobId);
  } else if (decision?.kind === "reject") {
    await callbacks.reject(jobId);
  } else if (decision === null) {
    await callbacks.restore(jobId);
  }
}

export function createWorkspaceIntelligenceMethods(input: {
  ctx: WorkspaceServiceContext;
  getWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
  callbacks: RapidReviewCallbacks;
}) {
  async function refreshCompanyState(): Promise<void> {
    await input.ctx.withIntelligenceTransition(async () => {
      const [state, savedJobs, applicationRecords] = await Promise.all([
        input.ctx.repository.getIntelligenceState(),
        input.ctx.repository.readSavedJobsProjection(),
        input.ctx.repository.listApplicationRecords(),
      ]);
      const now = new Date().toISOString();
      const reconciled = reconcileCompanies({
        companies: state.companies,
        jobs: savedJobs,
        applicationRecords,
        now,
        createCompanyId: () => `company_${randomUUID()}`,
      });
      if (!reconciled.ok) throw new Error(reconciled.failure.message);
      await input.ctx.repository.saveIntelligenceState(
        JobFinderIntelligenceStateSchema.parse({
          ...state,
          companies: reconciled.companies,
          updatedAt: nextCompanyIntelligenceUpdatedAt(now, state.updatedAt),
        }),
      );
    });
  }

  return {
    refreshCompanyIntelligenceState: refreshCompanyState,
    async refreshCompanyIntelligence(): Promise<JobFinderWorkspaceSnapshot> {
      await refreshCompanyState();
      return input.getWorkspaceSnapshot();
    },

    async setCompanyPreference(
      rawInput: SetCompanyPreferenceInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = SetCompanyPreferenceInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        await input.ctx.withCampaignTransition(async () => {
          await ensureCampaignState({
            repository: input.ctx.repository,
            searchPreferences:
              await input.ctx.repository.getSearchPreferences(),
          });
          await input.ctx.repository.commitCampaignPreferencesUpdate(
            (current) => {
              const state = current.intelligenceState;
              const now = new Date().toISOString();
              const result = setCompanyPreference({
                companies: state.companies,
                input: command,
                now,
              });
              if (!result.ok) throw new Error(result.failure.message);
              const previous = state.companies.find(
                (company) => company.id === command.companyId,
              )!;
              const names = [
                result.company.canonicalName,
                ...result.company.aliases
                  .filter(
                    (alias) =>
                      alias.identityAuthority === "user_approved_merge",
                  )
                  .map((alias) => alias.alias),
              ];
              if (command.preference === "exclude") {
                const whitelist = [
                  ...current.searchPreferences.companyWhitelist,
                  ...current.campaignState!.campaigns.flatMap(
                    (campaign) => campaign.searchPreferences.companyWhitelist,
                  ),
                ];
                for (const name of names) {
                  const preview = resolveEmployerExclusionPreview({
                    job: {
                      id: command.companyId,
                      company: name,
                      employerDomain: null,
                    },
                    searchPreferences: {
                      ...current.searchPreferences,
                      companyWhitelist: whitelist,
                    },
                    companies: state.companies,
                  });
                  if (preview.status !== "available")
                    throw new Error(
                      `Employer exclusion is unavailable: ${preview.reason}.`,
                    );
                }
              }
              const updateBlacklist = (blacklist: string[]) =>
                names.reduce(
                  (values, name) =>
                    command.preference === "exclude"
                      ? appendExactEmployerExclusion(
                          values,
                          name,
                          normalizeCompanyName(name),
                        ).values
                      : previous.preference === "exclude"
                        ? removeExactEmployerExclusion(
                            values,
                            normalizeCompanyName(name),
                          )
                        : values,
                  blacklist,
                );
              return {
                result: null,
                campaignState: {
                  ...current.campaignState!,
                  campaigns: current.campaignState!.campaigns.map(
                    (campaign) => ({
                      ...campaign,
                      searchPreferences: {
                        ...campaign.searchPreferences,
                        companyBlacklist: updateBlacklist(
                          campaign.searchPreferences.companyBlacklist,
                        ),
                      },
                    }),
                  ),
                },
                searchPreferences: {
                  ...current.searchPreferences,
                  companyBlacklist: updateBlacklist(
                    current.searchPreferences.companyBlacklist,
                  ),
                },
                intelligenceState: JobFinderIntelligenceStateSchema.parse({
                  ...state,
                  companies: result.companies,
                  updatedAt: nextCompanyIntelligenceUpdatedAt(
                    now,
                    state.updatedAt,
                  ),
                }),
              };
            },
          );
        });
      });
      return input.getWorkspaceSnapshot();
    },

    async reviewCompanyMerge(
      rawInput: ReviewCompanyMergeInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = ReviewCompanyMergeInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const state = await input.ctx.repository.getIntelligenceState();
        const now = new Date().toISOString();
        const result = reviewCompanyMerge({
          companies: state.companies,
          input: command,
          now,
        });
        if (!result.ok) throw new Error(result.failure.message);
        await input.ctx.repository.saveIntelligenceState(
          JobFinderIntelligenceStateSchema.parse({
            ...state,
            companies: result.companies,
            updatedAt: nextCompanyIntelligenceUpdatedAt(now, state.updatedAt),
          }),
        );
      });
      return input.getWorkspaceSnapshot();
    },

    async mutateCompanyIntelligence(
      rawInput: CompanyIntelligenceMutationInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = CompanyIntelligenceMutationInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const evidence =
          command.mutation.type === "upsert_salary_offer_evidence"
            ? command.mutation.evidence
            : null;
        await input.ctx.repository.commitCompanyIntelligenceUpdate(
          {
            companyId: command.companyId,
            expectedCompanyUpdatedAt: command.expectedUpdatedAt,
            jobId: evidence?.jobId ?? null,
            applicationRecordId: evidence?.applicationRecordId ?? null,
          },
          ({ intelligenceState, savedJob, applicationRecord }) => {
            const now = new Date().toISOString();
            const result = applyCompanyIntelligenceMutation({
              companies: intelligenceState.companies,
              jobs: savedJob ? [savedJob] : [],
              applicationRecords: applicationRecord ? [applicationRecord] : [],
              input: command,
              now,
            });
            if (!result.ok) throw new Error(result.failure.message);
            return JobFinderIntelligenceStateSchema.parse({
              ...intelligenceState,
              companies: result.companies,
              updatedAt: nextCompanyIntelligenceUpdatedAt(
                now,
                intelligenceState.updatedAt,
              ),
            });
          },
        );
      });
      return input.getWorkspaceSnapshot();
    },

    async setOutcomeSuggestionEnabled(
      rawInput: SetOutcomeSuggestionEnabledInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = SetOutcomeSuggestionEnabledInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const state = await input.ctx.repository.getIntelligenceState();
        const now = new Date().toISOString();
        const operationInput = {
          state,
          dimension: command.dimension,
          key: command.key,
          now,
        };
        // enable/reset lift any prior user disable and request a fresh
        // re-derivation; a plain disable records an explicit opt-out.
        const controlled =
          command.enabled || command.reset
            ? resetOutcomeSuggestion(operationInput)
            : disableOutcomeSuggestion(operationInput);
        if (controlled === state) {
          // Safe no-op: analytics absent or the bucket does not exist.
          await input.ctx.repository.saveIntelligenceState(state);
          return;
        }
        // Re-derive immediately so the control takes effect: a pending reset
        // is consumed and the suggestion re-evaluated against the outcome
        // events, while a user disable is preserved by the derivation.
        await input.ctx.repository.saveIntelligenceState(
          JobFinderIntelligenceStateSchema.parse({
            ...controlled,
            outcomeAnalytics: deriveOutcomeAnalytics({
              events: controlled.outcomeEvents,
              generatedAt: now,
              previousOverview: controlled.outcomeAnalytics,
            }),
          }),
        );
      });
      return input.getWorkspaceSnapshot();
    },

    async saveResumeStrategy(
      rawInput: SaveResumeStrategyInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = SaveResumeStrategyInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const state = await input.ctx.repository.getIntelligenceState();
        const now = new Date().toISOString();
        const result = command.id
          ? updateResumeStrategy({
              state,
              strategyId: command.id,
              strategy: command,
              now,
            })
          : createResumeStrategy({
              state,
              strategyId: `resume_strategy_${randomUUID()}`,
              strategy: command,
              now,
            });
        if (!result.ok) throw new Error(result.failure.message);
        await input.ctx.repository.saveIntelligenceState(result.state);
      });
      return input.getWorkspaceSnapshot();
    },

    async disableResumeStrategy(
      strategyId: string,
    ): Promise<JobFinderWorkspaceSnapshot> {
      await input.ctx.withIntelligenceTransition(async () => {
        const result = disableResumeStrategy({
          state: await input.ctx.repository.getIntelligenceState(),
          strategyId,
          now: new Date().toISOString(),
        });
        if (!result.ok) throw new Error(result.failure.message);
        await input.ctx.repository.saveIntelligenceState(result.state);
      });
      return input.getWorkspaceSnapshot();
    },

    async selectResumeStrategy(
      rawInput: SelectResumeStrategyInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = SelectResumeStrategyInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const [state, campaignState] = await Promise.all([
          input.ctx.repository.getIntelligenceState(),
          input.ctx.repository.getCampaignState(),
        ]);
        const campaign = campaignState?.campaigns.find(
          (candidate) => candidate.id === command.campaignId,
        );
        if (!campaign?.jobIds.includes(command.jobId)) {
          throw new Error("That job is not available in this search plan.");
        }
        const result = selectResumeStrategy({
          state,
          selectionId: `resume_strategy_selection_${randomUUID()}`,
          input: command,
          now: new Date().toISOString(),
        });
        if (!result.ok) throw new Error(result.failure.message);
        await input.ctx.repository.saveIntelligenceState(result.state);
      });
      return input.getWorkspaceSnapshot();
    },

    async recommendResumeStrategy(
      rawInput: RecommendResumeStrategyInput,
    ): Promise<ResumeStrategyRecommendation> {
      const command = RecommendResumeStrategyInputSchema.parse(rawInput);
      const [state, campaignState, savedJobs] = await Promise.all([
        input.ctx.repository.getIntelligenceState(),
        input.ctx.repository.getCampaignState(),
        input.ctx.repository.listSavedJobs(),
      ]);
      const job = savedJobs.find((candidate) => candidate.id === command.jobId);
      if (!job) {
        throw new Error("That job is no longer available.");
      }

      const scopedCampaignId = command.campaignId ?? null;
      if (scopedCampaignId !== null) {
        const scopedCampaign = campaignState?.campaigns.find(
          (candidate) => candidate.id === scopedCampaignId,
        );
        if (!scopedCampaign?.jobIds.includes(job.id)) {
          throw new Error(
            "That job is not available in the requested campaign.",
          );
        }
      }

      const campaignId =
        scopedCampaignId ??
        campaignState?.campaigns.find((candidate) =>
          candidate.jobIds.includes(job.id),
        )?.id ??
        campaignState?.activeCampaignId ??
        null;
      const campaignDefaultResumeStrategyId =
        resolveCampaignDefaultResumeStrategyId(campaignState, job.id);
      const { roleFamily, recommendation } = recommendResumeStrategyForJob({
        state,
        job,
        campaignDefaultResumeStrategyId,
      });
      const recommendedStrategy = recommendation.strategyId
        ? (state.resumeStrategies.find(
            (candidate) => candidate.id === recommendation.strategyId,
          ) ?? null)
        : null;

      return ResumeStrategyRecommendationSchema.parse({
        jobId: job.id,
        campaignId,
        roleFamily,
        strategyId: recommendation.strategyId,
        strategyName: recommendedStrategy?.name ?? null,
        source: recommendation.source,
        reason: recommendation.reason,
      });
    },

    async setCampaignResumeStrategyDefault(
      rawInput: SetCampaignResumeStrategyDefaultInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command =
        SetCampaignResumeStrategyDefaultInputSchema.parse(rawInput);
      await input.ctx.withCampaignTransition(async () => {
        const [campaignState, intelligenceState] = await Promise.all([
          input.ctx.repository.getCampaignState(),
          input.ctx.repository.getIntelligenceState(),
        ]);
        if (!campaignState) {
          throw new Error("No job search campaign is available.");
        }
        const campaign = campaignState.campaigns.find(
          (candidate) => candidate.id === command.campaignId,
        );
        if (!campaign) {
          throw new Error("That campaign is no longer available.");
        }
        if (command.strategyId !== null) {
          const strategy = intelligenceState.resumeStrategies.find(
            (candidate) => candidate.id === command.strategyId,
          );
          if (!strategy) {
            throw new Error("That resume strategy no longer exists.");
          }
          if (!strategy.enabled) {
            throw new Error(
              "A disabled resume strategy cannot be a campaign default.",
            );
          }
        }
        const nextCampaigns = campaignState.campaigns.map((candidate) =>
          candidate.id === command.campaignId
            ? {
                ...candidate,
                applicationPolicy: {
                  ...candidate.applicationPolicy,
                  defaultResumeStrategyId: command.strategyId,
                },
              }
            : candidate,
        );
        await input.ctx.repository.saveCampaignState({
          ...campaignState,
          campaigns: nextCampaigns,
        });
      });
      return input.getWorkspaceSnapshot();
    },

    async recordOutcome(
      rawInput: RecordOutcomeInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = RecordOutcomeInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const [campaignState, currentState, savedJobs, applicationRecords] =
          await Promise.all([
            input.ctx.repository.getCampaignState(),
            input.ctx.repository.getIntelligenceState(),
            input.ctx.repository.listSavedJobs(),
            input.ctx.repository.listApplicationRecords(),
          ]);
        const job = savedJobs.find(
          (candidate) => candidate.id === command.jobId,
        );
        if (!job) throw new Error("That job is no longer available.");
        const campaignsForJob = (campaignState?.campaigns ?? []).filter(
          (candidate) => candidate.jobIds.includes(job.id),
        );
        if (campaignsForJob.length === 0) {
          throw new Error("That job is not linked to a search campaign.");
        }
        const campaign = command.campaignId
          ? campaignsForJob.find(
              (candidate) => candidate.id === command.campaignId,
            )
          : campaignsForJob.length === 1
            ? campaignsForJob[0]
            : undefined;
        if (!campaign) {
          throw new Error(
            command.campaignId
              ? "That campaign does not contain the selected job."
              : "This job belongs to multiple campaigns; select the campaign before recording an outcome.",
          );
        }
        const applicationsForJob = applicationRecords.filter(
          (candidate) => candidate.jobId === job.id,
        );
        const applicationRecord = command.applicationRecordId
          ? applicationRecords.find(
              (candidate) => candidate.id === command.applicationRecordId,
            )
          : applicationsForJob.length <= 1
            ? applicationsForJob[0]
            : undefined;
        if (
          command.applicationRecordId &&
          (!applicationRecord || applicationRecord.jobId !== job.id)
        ) {
          throw new Error(
            "That application record does not belong to the selected job.",
          );
        }
        if (!command.applicationRecordId && applicationsForJob.length > 1) {
          throw new Error(
            "This job has multiple application records; select the application before recording an outcome.",
          );
        }
        if (
          command.resumeStrategyId &&
          !currentState.resumeStrategies.some(
            (strategy) =>
              strategy.id === command.resumeStrategyId && strategy.enabled,
          )
        ) {
          throw new Error("That resume strategy is no longer available.");
        }
        const now = new Date().toISOString();
        const withEvent = appendOutcomeEvent({
          state: currentState,
          callerId: `outcome_${randomUUID()}`,
          applicationRecordId: applicationRecord?.id ?? null,
          jobId: job.id,
          outcome: command.outcome,
          campaignId: campaign.id,
          source: job.source,
          // The recorded source is one enum value for every job, so grouping
          // outcomes by it gave a single bucket. The job's own discovery
          // lineage names the saved source it actually came from.
          sourceTargetId: job.provenance[0]?.targetId ?? null,
          company: job.company,
          jobTitle: job.title,
          resumeStrategyId: command.resumeStrategyId,
          occurredAt: now,
          note: command.note,
          now,
        });
        await input.ctx.repository.saveIntelligenceState(
          JobFinderIntelligenceStateSchema.parse({
            ...withEvent,
            outcomeAnalytics: deriveOutcomeAnalytics({
              events: withEvent.outcomeEvents,
              generatedAt: now,
              previousOverview: currentState.outcomeAnalytics,
            }),
          }),
        );
      });
      return input.getWorkspaceSnapshot();
    },

    async mutateRapidReview(
      rawInput: RapidReviewMutationInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const mutation = RapidReviewMutationInputSchema.parse(rawInput);
      await input.ctx.withIntelligenceTransition(async () => {
        const [campaignState, currentState, savedJobIds] = await Promise.all([
          input.ctx.repository.getCampaignState(),
          input.ctx.repository.getIntelligenceState(),
          input.ctx.repository.listSavedJobIds(),
        ]);
        const campaign = campaignState?.campaigns.find(
          (candidate) => candidate.id === mutation.campaignId,
        );
        if (!campaign) {
          throw new Error("That job search campaign is no longer available.");
        }

        const currentLog = getLog(
          currentState.rapidReviewLogs,
          mutation.campaignId,
        );
        const now = new Date().toISOString();

        if (mutation.type === "decide") {
          const uniqueJobIds = [...new Set(mutation.jobIds)];
          const knownJobIds = new Set(savedJobIds);
          for (const jobId of uniqueJobIds) {
            if (!campaign.jobIds.includes(jobId) || !knownJobIds.has(jobId)) {
              throw new Error(
                `Job '${jobId}' is not available in this search plan. Refresh Rapid review and try again.`,
              );
            }
            const current = deriveCurrentRapidReviewDecision({
              log: currentLog,
              jobId,
            });
            const expected = mutation.expectedRevisions[jobId] ?? null;
            if ((current?.revision ?? null) !== expected) {
              throw new Error(
                `Job '${jobId}' changed since this review opened. Refresh before deciding.`,
              );
            }
          }

          const appended = appendRapidReviewDecisions({
            log: currentLog,
            decisions: uniqueJobIds.map((jobId) => {
              const current = deriveCurrentRapidReviewDecision({
                log: currentLog,
                jobId,
              });
              return {
                decisionId: `rapid_review_${randomUUID()}`,
                decision: {
                  campaignId: mutation.campaignId,
                  jobId,
                  kind: mutation.decision,
                  revision: (current?.revision ?? -1) + 1,
                  reason: mutation.reason,
                  createdAt: now,
                },
              };
            }),
          });
          if (!appended.ok) throw new Error(appended.failure.message);

          for (const entry of appended.entries) {
            await applyDecision(input.callbacks, entry, entry.jobId);
          }
          await input.ctx.repository.saveIntelligenceState(
            JobFinderIntelligenceStateSchema.parse({
              ...currentState,
              rapidReviewLogs: replaceLog(
                currentState.rapidReviewLogs,
                appended.log,
              ),
              updatedAt: now,
            }),
          );
          return;
        }

        const undone = undoLatestActiveRapidReviewDecision({
          log: currentLog,
          jobId: mutation.jobId,
          expectedRevision: mutation.expectedRevision,
          undo: {
            undoneAt: now,
            reason: mutation.reason,
            restoringDecisionId: null,
          },
        });
        if (!undone.ok) throw new Error(undone.failure.message);
        const restored = deriveCurrentRapidReviewDecision({
          log: undone.log,
          jobId: mutation.jobId,
        });
        await applyDecision(input.callbacks, restored, mutation.jobId);
        await input.ctx.repository.saveIntelligenceState(
          JobFinderIntelligenceStateSchema.parse({
            ...currentState,
            rapidReviewLogs: replaceLog(
              currentState.rapidReviewLogs,
              undone.log,
            ),
            updatedAt: now,
          }),
        );
      });
      return input.getWorkspaceSnapshot();
    },
  };
}
