export * from "./workspace-service";
export * from "./job-search";
export {
  recordApplicationAuthoritySuccessor,
  resolveApplicationAuthoritySuccessorId,
  withApplicationAuthorityGate,
} from "./internal/application-authority-gate";
export * from "./product-action-tools";
export * from "./resume-import-benchmark";
export * from "./user-action-domain";
export * from "./internal/performance-budget-evaluation";
export * from "./internal/performance-evidence";
export * from "./internal/match-assessment-change-audit";
export * from "./internal/application-crm";
export * from "./internal/workspace-crm-methods";
export {
  areEquivalentEducationRecords,
  areEquivalentExperienceRecords,
  scoreEducationRecordCompleteness,
  scoreExperienceRecordCompleteness,
} from "./internal/resume-record-identity";

export {
  applyResumeTimelineRepairAction,
  deriveResumeTimelineRepairProposals,
  persistResumeTimelineRepairAction,
} from "./internal/resume-timeline-repair";

export {
  abnormalFailurePauseScope,
  applyCompanyApplicationEvidence,
  blockerAppliesTo,
  deriveActiveSafeguardBlockers,
  deriveBatchSampleIds,
  deriveHighestPriorityBlocker,
  deriveLatestListingSignal,
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
} from "./internal/safeguard-operations";
export {
  createDefaultListingHtmlFetcher,
  type ListingHtmlFetcher,
  type ListingHtmlFetchResult,
} from "./internal/listing-detail-enrichment";

export {
  inspectApplicationAccessPage,
  type ApplicationAccessPageState,
} from "./internal/application-access-page";
export { DiscoveryRunAlreadyActiveError } from "./internal/workspace-discovery-methods";
export { describeApplicationPreparationProgress } from "./internal/application-preparation-progress";

// One rule for what a tailored document is called, so the Electron layer's
// exported file name cannot disagree with the name the screens print.
export {
  resolveTailoredAssetLabel,
  TAILORED_RESUME_ASSET_LABEL,
  UNTAILORABLE_RESUME_ASSET_LABEL,
} from "./internal/resume-workspace-helpers";

// How an application the person stepped into is recorded, so the desktop
// host can carry exactly those on when the browser is handed back.
export { PERSON_TOOK_OVER_SUMMARY } from "./internal/workspace-application-user-action";

// The app assistant (ADR 0037, 0038, 0039).
export * from "./assistant";

export { savedResumeDigestMatches } from "./internal/resume-file-integrity";
export { resolveApprovedResumeExportForApply } from "./internal/matching-review-queue";

export { ApplicationLetterGroundingError } from "./internal/application-letter-provider";
