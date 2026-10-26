export {
  createProfileService,
  type ProfileService,
  type ProfileServiceOptions,
} from "./profile-service";
export * from "./job-search";
export {
  recordApplicationAuthoritySuccessor,
  resolveApplicationAuthoritySuccessorId,
  withApplicationAuthorityGate,
} from "./internal/application-authority-gate";
export * from "./resume-import-benchmark";
export type {
  CandidateAssetResolver,
  JobFinderDocumentManager,
  RenderedResumeArtifact,
  ResolvedApplicationCandidateAsset,
  ResumeResearchAdapter,
  ResumeResearchAdapterInput,
} from "./internal/workspace-service-contracts";
export type {
  ResumeRenderDocument,
  ResumeRenderSection,
  ResumeRenderSectionEntry,
} from "./internal/resume-workspace-structure";
export {
  createDefaultListingHtmlFetcher,
  type ListingHtmlFetcher,
  type ListingHtmlFetchResult,
} from "./internal/listing-detail-enrichment";
export { describeApplicationPreparationProgress } from "./internal/application-preparation-progress";

// The app assistant (ADR 0037, 0038, 0039).
export * from "./assistant";

export { savedResumeDigestMatches } from "./internal/resume-file-integrity";
export { readJobFromBrowserPage } from "./browser-page-job";
