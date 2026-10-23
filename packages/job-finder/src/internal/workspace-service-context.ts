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
  FitJudgmentProgress,
  JobFinderWorkspaceSnapshot,
  JobSearchPreferences,
  JobDiscoveryTarget,
  JobSource,
  ParkedBrowserTabReference,
  SavedJob,
  SourceDebugRunRecord,
  UserActionRequest,
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
  aiClient: JobFinderAiClient;
  visionProvider?: ResumeVisionProvider;
  browserRuntime: BrowserSessionRuntime;
  documentManager: JobFinderDocumentManager;
  resumeDraftProcessor?: ResumeDraftProcessor;
  candidateAssetResolver?: CandidateAssetResolver;
  exportFileVerifier?: ResumeExportFileVerifier;
  researchAdapter?: ResumeResearchAdapter;
  repository: JobFinderRepository;
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
  fitJudgmentProgressRef?: MutableRef<FitJudgmentProgress | null>;
  onListingAssessmentFinished?: () => void;
  onSavedJobsRescored?: () => void;
  activeDiscoveryAbortControllerRef: MutableRef<AbortController | null>;
  /**
   * The run id the in-flight discovery pipeline belongs to. A stop request
   * arrives while the run record may not be persisted yet, so matching on the
   * stored state alone let the request be acknowledged without ever reaching
   * the pipeline — the search kept working and the toolbar kept saying
   * "Stopping".
   */
  activeDiscoveryRunIdRef: MutableRef<string | null>;
  activeDiscoveryPromiseRef: MutableRef<Promise<unknown> | null>;
  activeSourceDebugExecutionIdRef: MutableRef<string | null>;
  activeSourceDebugAbortControllerRef: MutableRef<AbortController | null>;
  activeSourceDebugPromiseRef: MutableRef<Promise<unknown> | null>;
  activeApplyRunAbortControllers: Map<string, AbortController>;
  activeApplyRunPromises: Map<string, Promise<void>>;
  applyRunTransitionTails: Map<string, Promise<void>>;
  markApplicationPreparationStarted(
    input: { resultId: string; runId: string; jobId: string },
    token?: ApplicationPreparationCapacityToken,
  ): Promise<ApplyJobResult>;
  requireApplicationSafeguardClearance?(
    jobIds: readonly string[],
    savedJobs?: readonly SavedJob[],
  ): Promise<void>;
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
  resumeApplicationUserAction: (
    request: UserActionRequest,
    taskLocalCredentials?: TaskLocalApplicationCredentials,
  ) => Promise<void>;
  /**
   * Reads one source again after the person cleared whatever stopped it (a
   * sign-in page, a human-verification check, a full-page message). The search
   * that hit the wall ended at that source, so clearing it has to continue the
   * search rather than leave the person to start a whole new one.
   */
  continueDiscoveryForSource: (
    targetId: string,
    discoveryRunId: string,
  ) => Promise<DiscoveryContinuationResult>;
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
  saveDiscoveryTargetUpdate: (
    targetId: string,
    updater: (target: JobDiscoveryTarget) => JobDiscoveryTarget,
  ) => Promise<JobSearchPreferences>;
  persistSourceDebugRun: (run: SourceDebugRunRecord) => Promise<void>;
  persistBrowserSessionState: (
    session: Awaited<ReturnType<BrowserSessionRuntime["openSession"]>>,
  ) => Promise<void>;
  staleApprovedResumeDrafts: (
    staleReason: string,
    jobIds?: readonly string[],
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
