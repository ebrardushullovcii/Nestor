import type { CandidateReusableAnswer } from "@nestor/contracts";
import type { JobSitesStore } from "@nestor/db/job-store";
import type {
  JobFinderAiClient,
  ResumeVisionProvider,
} from "@nestor/ai-providers";
import type {
  BrowserSessionRuntime,
  OpenBrowserSessionOptions,
} from "@nestor/browser-runtime";
import type {
  ApplyJobResult,
  ResumeDraftProcessor,
  JobFinderDiscoveryState,
  JobFinderWorkspaceSnapshot,
  JobSearchPreferences,
  JobDiscoveryTarget,
  JobSource,
  ParkedBrowserTabReference,
  SavedJob,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import type { createListingActivityIdentityIndex } from "./listing-activity-identity-index";
import type {
  CandidateAssetResolver,
  JobFinderDocumentManager,
  ResumeResearchAdapter,
} from "./workspace-service-contracts";
import type { ListingHtmlFetcher } from "./listing-detail-enrichment";

/** Secret-bearing data that exists only on one command's call stack. */
export interface TaskLocalApplicationCredentials {
  /** Opaque command identity; never an account identifier. */
  reference: string;
  identifier: string;
  password: string;
}

export interface ResumeExportFileVerifier {
  exists(filePath: string): Promise<boolean>;
  sha256?(filePath: string): Promise<string>;
  /**
   * The on-disk path `exists`/`sha256` actually resolved to, or null when no
   * candidate exists. A verifier that can recover a path recorded under a
   * since-moved user-data directory must expose it here: the application
   * resume artifact carries the path onward to the browser runtime, which
   * re-checks it with its own `access()` and reports `missing_resume` when the
   * recorded path no longer exists.
   */
  resolvePath?(filePath: string): Promise<string | null>;
}

export interface MutableRef<T> {
  current: T;
}

export interface ApplicationPreparationCapacityToken {
  localDate: string;
  remainingJobs: number;
  /**
   * The jobs this reservation covers. The day's counter needs them by id so a
   * job whose application record already exists is not charged again while its
   * own reservation is still held.
   */
  jobIds: readonly string[];
}

export interface WorkspaceServiceContext {
  jobSites?: JobSitesStore;
  aiClient: JobFinderAiClient;
  visionProvider?: ResumeVisionProvider;
  browserRuntime: BrowserSessionRuntime;
  documentManager: JobFinderDocumentManager;
  resumeDraftProcessor?: ResumeDraftProcessor;
  candidateAssetResolver?: CandidateAssetResolver;
  exportFileVerifier?: ResumeExportFileVerifier;
  researchAdapter?: ResumeResearchAdapter;
  repository: JobFinderRepository;
  readSavedAnswers?: () => readonly CandidateReusableAnswer[];
  backgroundWorkReady?: PromiseLike<void>;
  listingAssessmentJobIds?: Set<string>;
  listingActivityIdentityIndex?: ReturnType<
    typeof createListingActivityIdentityIndex
  >;
  listingAssessmentGenerationRef?: MutableRef<number>;
  listingAssessmentAbortControllerRef?: MutableRef<AbortController>;
  withListingAssessmentSlot?: <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  isWorkspaceClosing?: () => boolean;
  onListingAssessmentFinished?: () => void;
  onShortlistResumeChanged?: () => void;
  onSavedJobsRescored?: () => void;
  hasRunJobSearch?: () => boolean;
  activeSourceDebugExecutionIdRef: MutableRef<string | null>;
  activeSourceDebugAbortControllerRef: MutableRef<AbortController | null>;
  activeSourceDebugPromiseRef: MutableRef<Promise<unknown> | null>;
  applyRunTransitionTails: Map<string, Promise<void>>;
  markApplicationPreparationStarted(
    input: { resultId: string; runId: string; jobId: string },
    token?: ApplicationPreparationCapacityToken,
  ): Promise<ApplyJobResult>;
  withApplicationCrmTransition<T>(operation: () => Promise<T>): Promise<T>;
  withIntelligenceTransition<T>(operation: () => Promise<T>): Promise<T>;
  withCampaignTransition<T>(operation: () => Promise<T>): Promise<T>;
  activeResumeVisionRunIds: Set<string>;
  activeResumeEvidenceRunIds: Set<string>;
  onResumeEvidenceFinished?: () => void;
  getWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Reads the current projection without launching user-action recovery.
   * Nested workflows use this when they are themselves part of recovery, so
   * they cannot await the recovery promise that is waiting for them.
   */
  readWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
  /**
   * The display projection (borrowed, frozen rows), also without recovery.
   * A finished search answers with this: a canonical read re-parsed every
   * saved job (about 14 s of the main process with 12,000 jobs) for a
   * snapshot its callers then discard or convert for display.
   */
  readWorkspaceProjection?: () => Promise<JobFinderWorkspaceSnapshot>;
  getActiveCampaignId: () => Promise<string | null>;
  runSourceDebugWorkflow: (
    targetId: string,
    signal?: AbortSignal,
    options?: {
      clearExistingInstructions?: boolean;
      reviewInstructionId?: string | null;
    },
  ) => Promise<JobFinderWorkspaceSnapshot>;
  persistDiscoveryState: (
    updater: (current: JobFinderDiscoveryState) => JobFinderDiscoveryState,
  ) => Promise<JobFinderDiscoveryState>;
  /**
   * `knownSessions` are the sessions the caller just read; when the browser
   * reports nothing new against them, nothing is written.
   */
  refreshDiscoverySessions: (
    searchPreferences: JobSearchPreferences,
    knownSessions?: JobFinderDiscoveryState["sessions"],
  ) => Promise<JobFinderDiscoveryState["sessions"]>;
  saveJobSiteMetadata: (
    targetId: string,
    updater: (target: JobDiscoveryTarget) => JobDiscoveryTarget,
  ) => Promise<JobDiscoveryTarget>;
  persistSourceDebugRun: (run: SourceDebugRunRecord) => Promise<void>;
  persistBrowserSessionState: (
    session: Awaited<ReturnType<BrowserSessionRuntime["openSession"]>>,
  ) => Promise<void>;
  staleApprovedResumeDrafts: (
    staleReason: string,
    jobIds?: readonly string[],
    profileInputs?: Parameters<
      NonNullable<JobFinderRepository["staleResumeDrafts"]>
    >[0]["profileInputs"],
  ) => Promise<void>;
  openRunBrowserSession: (
    source: JobSource,
    options?: OpenBrowserSessionOptions,
  ) => Promise<void>;
  closeRunBrowserSession: (source: JobSource) => Promise<void>;
  closeParkedBrowserTab: (
    source: JobSource,
    tab: ParkedBrowserTabReference,
  ) => Promise<void>;
  hasActiveBrowserWorkflow: () => boolean;
  /**
   * A deliberate start by the person (Search now, Run now, Apply): clears a
   * pause, tells the host so its browser stops refusing work, and lets the
   * host lift a pause the person caused in the browser itself.
   */
  resumeActivityForExplicitStart: () => Promise<void>;
  /**
   * Plain-HTTP page reader for listing bodies (see
   * `listing-detail-enrichment.ts`). Optional so tests inject a fake and the
   * desktop supplies the default fetcher.
   */
  fetchListingHtml?: ListingHtmlFetcher;
  updateJob: (
    jobId: string,
    updater: (job: SavedJob) => SavedJob,
  ) => Promise<void>;
  /**
   * The per-job queue every resume draft mutation waits on; set by the
   * application methods so assistant edits share it.
   */
  withResumeDraftTransition?: <T>(
    jobId: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export type DiscoveryContinuationResult =
  | { status: "continued" }
  | { status: "origin_removed"; message: string };
