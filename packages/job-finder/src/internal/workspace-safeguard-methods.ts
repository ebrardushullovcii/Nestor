import { sendPairKey } from "./same-company-sends";
import { randomUUID } from "node:crypto";

import {
  JobFinderIntelligenceStateSchema,
  SafeguardMutationInputSchema,
  SafeguardsOverviewSchema,
  type JobFinderWorkspaceSnapshot,
  type SafeguardMutationInput,
  type SafeguardsOverview,
  type SavedJob,
} from "@nestor/contracts";

import {
  applyCompanyApplicationEvidence,
  deriveActiveSafeguardBlockers,
  deriveScopeBlockers,
  dismissContradictoryAnswerDetection,
  dismissSafeguardEntry,
  prepareBatchSampleReview,
  recordAbnormalFailureEvidence,
  recordContradictoryAnswerDetection,
  recordListingSignal,
  recordSimultaneousApplicationConflict,
  resolveContradictoryAnswerDetection,
  resolveSimultaneousApplicationConflict,
  restoreSafeguardEntry,
  updateBatchSampleReview,
  type SafeguardBlocker,
} from "./safeguard-operations";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { reconcileAutomaticBatchSampleReviews } from "./automatic-batch-review-recovery";

/**
 * Typed high-volume quality and reputation safeguards integration.
 *
 * Every mutation is a plain local tracking fact validated by the strict
 * `SafeguardMutationInputSchema` (which structurally forbids credentials,
 * login, CAPTCHA, MFA, legal consent, account creation, upload, redirect, and
 * final-submit authority). Ids and timestamps are minted/stamped by this
 * service, evidence is validated by the pure safeguard operations, and every
 * mutation persists through the intelligence state so it survives restarts.
 */
export function createWorkspaceSafeguardMethods(input: {
  ctx: WorkspaceServiceContext;
  getWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
}) {
  const { ctx, getWorkspaceSnapshot } = input;

  async function mutateSafeguards(
    rawInput: SafeguardMutationInput,
  ): Promise<JobFinderWorkspaceSnapshot> {
    const mutation = SafeguardMutationInputSchema.parse(rawInput);

    await ctx.withIntelligenceTransition(async () => {
      const state = await ctx.repository.getIntelligenceState();
      const now = new Date().toISOString();
      let nextSafeguards = state.safeguards;

      switch (mutation.type) {
        case "decide_same_company_send_pair": {
          const group = nextSafeguards.simultaneousApplicationConflicts.find(
            (entry) => entry.id === mutation.conflictId,
          );
          if (
            !group?.jobIds ||
            !mutation.jobIds.every((id) => group.jobIds!.includes(id))
          )
            throw new Error(
              "This pair is no longer in the company group. Review Safeguards again.",
            );
          const key = sendPairKey(mutation.jobIds);
          const pairs = (group.allowedPairs ?? []).filter(
            (pair) => sendPairKey(pair.jobIds) !== key,
          );
          pairs.push({
            jobIds: mutation.jobIds,
            decidedAt: now,
            revokedAt: mutation.allow ? null : now,
          });
          nextSafeguards = {
            ...nextSafeguards,
            simultaneousApplicationConflicts:
              nextSafeguards.simultaneousApplicationConflicts.map((entry) =>
                entry.id === group.id
                  ? { ...entry, allowedPairs: pairs }
                  : entry,
              ),
            updatedAt: now,
          };
          break;
        }
        case "apply_company_application_evidence": {
          const result = applyCompanyApplicationEvidence({
            safeguards: nextSafeguards,
            evidence: mutation.evidence,
            now,
            createCapId: () => `safeguard_cap_${randomUUID()}`,
            config: mutation.config,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "record_simultaneous_application_conflict": {
          const result = recordSimultaneousApplicationConflict({
            safeguards: nextSafeguards,
            conflict: {
              conflictId: mutation.conflictId,
              applicationRecordId: mutation.applicationRecordId,
              conflictingApplicationRecordId:
                mutation.conflictingApplicationRecordId,
              explanation: mutation.explanation,
              recoveryGuidance: mutation.recoveryGuidance,
            },
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "resolve_simultaneous_application_conflict": {
          const result = resolveSimultaneousApplicationConflict({
            safeguards: nextSafeguards,
            conflictId: mutation.conflictId,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "record_listing_signal": {
          const result = recordListingSignal({
            safeguards: nextSafeguards,
            signal: {
              id: mutation.signalId,
              jobId: mutation.jobId,
              signal: mutation.signal,
              detail: mutation.detail,
              detectedAt: mutation.detectedAt,
              confidence: mutation.confidence,
              provenance: mutation.provenance,
              explanation: mutation.explanation,
              recoveryGuidance: mutation.recoveryGuidance,
            },
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "record_abnormal_failure_evidence": {
          const result = recordAbnormalFailureEvidence({
            safeguards: nextSafeguards,
            pauseId: mutation.pauseId,
            windowStartedAt: mutation.windowStartedAt,
            evidence: mutation.evidence,
            now,
            config: mutation.config,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "prepare_batch_sample_review": {
          const result = prepareBatchSampleReview({
            safeguards: nextSafeguards,
            reviewId: mutation.reviewId,
            batchId: mutation.batchId,
            prepared: mutation.prepared,
            requiredSampleRatio: mutation.requiredSampleRatio,
            explanation: mutation.explanation,
            recoveryGuidance: mutation.recoveryGuidance,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "update_batch_sample_review": {
          const result = updateBatchSampleReview({
            safeguards: nextSafeguards,
            reviewId: mutation.reviewId,
            reviewedCount: mutation.reviewedCount,
            reviewCompleted: mutation.reviewCompleted,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "record_contradictory_answer_detection": {
          const result = recordContradictoryAnswerDetection({
            safeguards: nextSafeguards,
            detection: {
              detectionId: mutation.detectionId,
              questionA: mutation.questionA,
              questionB: mutation.questionB,
              answerA: mutation.answerA,
              answerB: mutation.answerB,
              contradictionScore: mutation.contradictionScore,
              detectedAt: mutation.detectedAt,
              explanation: mutation.explanation,
              recoveryGuidance: mutation.recoveryGuidance,
            },
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "resolve_contradictory_answer_detection": {
          const result = resolveContradictoryAnswerDetection({
            safeguards: nextSafeguards,
            detectionId: mutation.detectionId,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "dismiss_contradictory_answer_detection": {
          const result = dismissContradictoryAnswerDetection({
            safeguards: nextSafeguards,
            detectionId: mutation.detectionId,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "dismiss_safeguard_entry": {
          const result = dismissSafeguardEntry({
            safeguards: nextSafeguards,
            dismissalId: `safeguard_dismissal_${randomUUID()}`,
            kind: mutation.kind,
            referenceId: mutation.referenceId,
            reason: mutation.reason,
            note: mutation.note,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        case "restore_safeguard_entry": {
          const result = restoreSafeguardEntry({
            safeguards: nextSafeguards,
            dismissalId: mutation.dismissalId,
            now,
          });
          if (!result.ok) throw new Error(result.failure.message);
          nextSafeguards = result.safeguards;
          break;
        }
        default: {
          const unreachable: never = mutation;
          throw new Error(
            `Unsupported safeguard mutation: ${JSON.stringify(unreachable)}`,
          );
        }
      }

      await ctx.repository.saveIntelligenceState(
        JobFinderIntelligenceStateSchema.parse({
          ...state,
          safeguards: nextSafeguards,
          updatedAt: now,
        }),
      );
    });

    return getWorkspaceSnapshot();
  }

  async function getSafeguardsOverview(): Promise<SafeguardsOverview> {
    await reconcileAutomaticBatchSampleReviews(ctx);
    const state = await ctx.repository.getIntelligenceState();
    const safeguards = state.safeguards;
    const blockers = deriveActiveSafeguardBlockers({ safeguards });
    const highestPriorityBlocker = blockers[0] ?? null;

    return SafeguardsOverviewSchema.parse({
      generatedAt: new Date().toISOString(),
      highestPriorityBlocker,
      blockers,
      counts: {
        caps: safeguards.companyApplicationCaps.length,
        activeCaps: safeguards.companyApplicationCaps.filter(
          (cap) => cap.limitReached,
        ).length,
        conflicts: safeguards.simultaneousApplicationConflicts.length,
        activeConflicts: safeguards.simultaneousApplicationConflicts.filter(
          (conflict) => conflict.status === "detected",
        ).length,
        signals: safeguards.listingSignals.length,
        activeSignals: new Set(
          safeguards.listingSignals.map((signal) => signal.jobId),
        ).size,
        pauses: safeguards.abnormalFailurePauses.length,
        activePauses: safeguards.abnormalFailurePauses.filter(
          (pause) => pause.paused,
        ).length,
        reviews: safeguards.preparedBatchSampleReviews.length,
        pendingReviews: safeguards.preparedBatchSampleReviews.filter(
          (review) => !review.reviewCompleted,
        ).length,
        contradictions: safeguards.contradictoryAnswerDetections.length,
        activeContradictions: safeguards.contradictoryAnswerDetections.filter(
          (detection) => detection.status === "detected",
        ).length,
        dismissals: safeguards.safeguardDismissals.length,
      },
    });
  }

  /**
   * Evaluates the safe-gate blockers that apply to preparing applications for
   * the given jobs. Company caps resolve through the persisted company
   * entities (the job's owning company), conflicts through the persisted
   * application records, and listing signals directly per job. Only
   * apply-scoped safeguards count: the daily cap, an apply failure pause, a
   * listing problem, a pending sample review, and a pause the person set
   * themselves. A search plan that paused its own discovery runs does not
   * stop an application. Contradictory answers stay advisory. This never
   * grants any submission authority: it only reports what the caller must
   * clear before preparing.
   */
  async function evaluateApplicationPreparationBlockers(
    jobIds: readonly string[],
    scopedSavedJobs?: readonly SavedJob[],
  ): Promise<SafeguardBlocker[]> {
    await reconcileAutomaticBatchSampleReviews(ctx);
    const [state, savedJobs, applicationRecords] = await Promise.all([
      ctx.repository.getIntelligenceState(),
      scopedSavedJobs
        ? Promise.resolve(scopedSavedJobs)
        : ctx.repository.listSavedJobs(),
      ctx.repository.listApplicationRecords(),
    ]);

    const jobSet = new Set(jobIds);
    const companyIdSet = new Set<string>();
    for (const job of savedJobs) {
      if (!jobSet.has(job.id)) continue;
      const owningCompany = state.companies.find(
        (company) =>
          company.jobIds.includes(job.id) ||
          company.canonicalName === job.company ||
          company.aliases.some((alias) => alias.alias === job.company),
      );
      if (owningCompany) companyIdSet.add(owningCompany.id);
    }

    const recordJobIds = new Map<string, string>();
    for (const record of applicationRecords) {
      recordJobIds.set(record.id, record.jobId);
    }

    return deriveScopeBlockers({
      safeguards: state.safeguards,
      jobIds,
      companyIds: [...companyIdSet],
      applicationRecordJobIds: recordJobIds,
      // Preparing an application is gated by what stands in the way of
      // applying. A search plan that paused itself after failed searches has
      // nothing to do with this application and never blocks it.
      operation: "apply",
    });
  }

  /**
   * Reviews of prepared applications gate later application preparation,
   * not read-only discovery. Discovery still reconciles them for the UI.
   */
  async function evaluateGlobalDiscoveryBlockers(): Promise<
    SafeguardBlocker[]
  > {
    await reconcileAutomaticBatchSampleReviews(ctx);
    const state = await ctx.repository.getIntelligenceState();

    return deriveScopeBlockers({
      safeguards: state.safeguards,
      jobIds: [],
      companyIds: [],
      applicationRecordJobIds: new Map(),
      operation: "discovery",
    }).filter((blocker) => blocker.kind === "batch_sample_review_pending");
  }

  function requireNoBlockers(blockers: readonly SafeguardBlocker[]): void {
    const blocker = blockers.find((entry) => entry.severity === "blocker");
    if (!blocker) return;

    // The exact reason and recovery action come from the persisted entry; the
    // thrown message surfaces both and points at the Safeguards screen.
    // The person reads the reason and the thing to do next. The internal
    // reference travels on the blocker itself (`code`), for logs and for a
    // renderer that wants it behind a details control.
    throw new Error(
      `${blocker.explanation} ${blocker.recoveryGuidance} ` +
        `Open Safeguards to resolve, dismiss, or retry before continuing.`,
    );
  }

  return {
    mutateSafeguards,
    getSafeguardsOverview,
    evaluateApplicationPreparationBlockers,
    evaluateGlobalDiscoveryBlockers,
    requireNoBlockers,
  };
}
