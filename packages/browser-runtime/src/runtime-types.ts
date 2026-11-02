import type { BrowserAgentPermissions } from "@nestor/contracts";
import type {
  ApplicationPageState,
  ApplicationPageReopenProgress,
  PreparedApplicationForm,
  PreparedFormAttachment,
  AgentDiscoveryProgress,
  ApplicationAttestationKind,
  ApplicationAuthorityEnvelope,
  ApplicationAutomationMode,
  ApplyPageSession,
  ApplyRawPageHands,
  RawApplyPage,
  ApplicationFormActionHandoff,
  ApplicationSalaryDisclosureRule,
  ApplyExecutionResult,
  ApplyRecoveryContext,
  BrowserVisualAnalysisContext,
  BrowserVisualObservationSet,
  BrowserVisualSnapshotRef,
  BrowserVisualSnapshotRequest,
  BrowserSessionState,
  BrowserSourceAccessProbeInput,
  BrowserSourceAccessProbeResult,
  CandidateProfile,
  CandidateAssetKind,
  DiscoveryRunResult,
  JobFinderSettings,
  JobFinderSearchRequest,
  JobPosting,
  JobSearchPreferences,
  JobSearchGoals,
  KnownJobUrlLookup,
  JobSearchCampaignMode,
  AiJobSearchBehavior,
  JobSource,
  ParkedBrowserTabReference,
  ApplicationResumeArtifact,
  ApplicationQuestionKind,
  BrowserAgentRunCheckpoint,
  SourceDebugPhase,
  SavedJob,
} from "@nestor/contracts";
import type { Page } from "playwright";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import type {
  ApplicationFinalActionResult,
  ApplicationFormObservation,
  ExecuteExactlyOneFinalActionInput,
  ObserveApplicationFormOptions,
} from "./application-submission-browser-hands";

export interface PreparedApplicationFormStore {
  get(key: string): Promise<PreparedApplicationForm | null>;
  save(form: PreparedApplicationForm): Promise<void>;
  delete(key: string): Promise<void>;
  loadAttachment(file: PreparedFormAttachment): Promise<Uint8Array>;
}

export interface OpenBrowserSessionOptions {
  /** Automation setup must not steal focus from a user-minimized browser. */
  purpose?: "automation" | "manual";
  /** Open a clean manual page without replacing an existing automation page. */
  reuseExistingPage?: boolean;
  targetUrl?: string | null;
  targetId?: string | null;
  /**
   * The host's id for a tab parked for this request. A host that still has
   * that tab shows it instead of opening the address in a second tab.
   */
  tabId?: string | null;
  /**
   * The page is a step parked for the person (a source sign-in or check).
   * When its tab is gone, the host opens the address again as a parked tab
   * under the same `tabId`, so the request stays bound to it.
   */
  parkedFor?: "sign_in" | "challenge";
}

export interface ExecuteEasyApplyInput {
  job: SavedJob;
  resumeArtifact: ApplicationResumeArtifact;
  profile: CandidateProfile;
  settings: JobFinderSettings;
  instructions?: readonly string[];
}

export type ApplicationExecutionMode = "prepare_only" | "submit_when_ready";

/**
 * Main-process-only attachment resolved from an exact user-approved asset.
 * The byte loader retains filesystem authority in the owning adapter and must
 * revalidate availability plus integrity every time browser-runtime invokes it.
 * Neither the loader nor a file path may cross preload/renderer or persistence.
 */
export interface ApplicationAttachmentArtifact {
  assetId: string;
  /** The kind the person chose in Profile, independently of the form question. */
  assetKind?: CandidateAssetKind;
  /**
   * The exact question that selected this asset. Library-wide application
   * assets are available before a form question exists, so they carry null.
   */
  questionId: string | null;
  prompt: string;
  questionKind: ApplicationQuestionKind;
  fileName: string;
  mime: string;
  sha256: string;
  loadVerifiedBytes: () => Promise<Uint8Array>;
}

export interface ExecuteApplicationFlowInput extends ExecuteEasyApplyInput {
  /** Main-owned exact-site autofill; returns no credentials. */
  prepareBrowserCredentials?: (url: string) => Promise<boolean>;
  readBrowserPermissions?: () =>
    | BrowserAgentPermissions
    | Promise<BrowserAgentPermissions>;
  /** Recorded listing provenance; never inferred from the application host. */
  listingDiscovery?: { label: string; url: string };
  /**
   * Opaque identity for the exact prepared browser page. Later submission
   * hands must present the same key; it carries no permission by itself.
   */
  applicationPageBindingKey?: string;
  /**
   * The caller keeps what this run filled and can bring the form back by
   * refilling it (a Ready or Needs-you form). Its page may then be closed to
   * save memory even when the form cannot be snapshotted here.
   */
  restorableByRefill?: boolean;
  applicationAttachments?: readonly ApplicationAttachmentArtifact[];
  mode: ApplicationExecutionMode;
  /**
   * Where to open the browser for this run, when it is not the job's own
   * link. A run that continues after the person finished a step in the
   * browser starts on the page it stopped on, and reuses that open tab, so
   * what they ticked there is still ticked. Omitted means the job's link.
   */
  startingUrl?: string;
  /**
   * Stable logical execution key for a retry that may be recovered after a
   * process restart. Runtimes may use it to deduplicate safe intermediate
   * work; it never grants submit permission.
   */
  idempotencyKey?: string;
  /**
   * Explicit account-creation authorization. Omitted values are false and
   * the current production flow never creates accounts automatically.
   */
  accountCreationAuthorized?: boolean;
  /**
   * Explicit customer permission for external, site-side persistence during
   * preparation, such as draft creation, autosave requests, or another
   * verified non-final transmission to the employer's server. Selecting a
   * file into a local DOM file input is a local page edit the runtime
   * performs without this flag; only the site's attempt to transmit or
   * persist that selection externally is gated here. This never authorizes
   * DOM form submission or clicking a final apply control; those remain
   * independently blocked. The runtime opens a short window around a grounded
   * field action, accepts bounded fetch/XHR POST/PUT/PATCH traffic and denies
   * final-action, late, long-lived, beacon and navigation traffic. A pinned
   * origin list requires explicit draft/autosave/update semantics and denies
   * cross-origin requests. Omitted values are false. Attachment upload has
   * its own file-bound permission below.
   */
  intermediateMutationsAuthorized?: boolean;
  /** Upload only the exact selected attachment while the form stays fenced. */
  attachmentUploadsAuthorized?: boolean;
  /**
   * Canonical origins covered by the exact authority envelope. This list is
   * checked before field-save and attachment windows. Attachment uploads need
   * a pinned source origin. Field saves use a member of this list (or the current
   * origin when empty) and stay pinned to it. A separate storage origin can
   * receive only the exact selected file. Final-submit origins stay separate.
   */
  intermediateMutationAllowedOrigins?: string[];
  /**
   * Main-owned last-instant authority recheck. The runtime calls it before
   * every field-save window with the currently observed canonical origin;
   * omission or a false/error result keeps external persistence blocked.
   */
  recheckIntermediateMutationAuthority?: (
    observedOrigin: string,
    purpose?: "answers" | "attachment",
  ) => Promise<boolean>;
  /**
   * Explicit final-submit authorization. The production Playwright runtime
   * treats omitted values as false.
   *
   * The production Playwright runtime currently remains prepare-only even when
   * this value is true. Keeping authorization separate from `mode` prevents a
   * `submit_when_ready` request from becoming implicit permission to click a
   * final submit control.
   */
  submitAuthorized?: boolean;
  /**
   * What the person allowed for this exact application. The runtime's own
   * two-value `mode` cannot tell "ask me before sending" from "fill in and
   * stop", and the difference decides whether the form is worked all the way
   * to its send button. Omitted means fill in and stop.
   */
  applyAutomationMode?: ApplicationAutomationMode;
  /**
   * Origins the saved permission covers for this application. Separate from
   * the autosave allowlist: this one bounds where the form may be filled in at
   * all, and an empty list means "only where the application started".
   */
  applyAllowedOrigins?: readonly string[];
  /**
   * Records a newly discovered employer ATS origin after the independent move
   * reviewer has accepted the handoff. Returning null keeps navigation
   * available for preparation but does not widen final-submit authority.
   * True admits only preparation on the reviewed origin, without a send grant.
   */
  authorizeReviewedApplicationOrigin?: (
    origin: string,
  ) => Promise<ApplicationAuthorityEnvelope | true | null>;
  /**
   * Declaration kinds the person approved in advance, from the saved authority
   * document. Anything not on this list pauses for them. Omitted means none.
   */
  preApprovedAttestationKinds?: readonly ApplicationAttestationKind[];
  /**
   * What to do when a form asks what pay they expect. Omitted leaves it to
   * them, which is the safe answer.
   */
  salaryDisclosure?: ApplicationSalaryDisclosureRule;
  /**
   * Optional main-owned, one-use setup before application preparation. The
   * runtime supplies only generic page mechanics; the caller owns the policy
   * that authorizes and recognizes the exact sign-in step. No value from this
   * callback is persisted or exposed to the renderer.
   */
  prepareTaskLocalCredentials?: (input: {
    session: ApplyPageSession;
    signal?: AbortSignal;
  }) => Promise<void>;
  /**
   * Fills in the application form on the page the runtime has opened.
   *
   * The runtime owns the browser: opening the page, watching for service
   * workers, session state. What to put in the form, and whether anything may
   * be sent, is not its decision — the caller supplies it and receives one
   * open page's worth of bounded operations to work through.
   */
  prepareApplicationForm: (input: {
    session: ApplyPageSession;
    /** The live URL of this exact bound page after any authorized setup. */
    currentUrl: string;
    startedAt: string;
    signal?: AbortSignal;
    onProgress?: (
      progress: ApplicationPreparationProgress,
    ) => void | Promise<void>;
  }) => Promise<ApplyExecutionResult>;
  recoveryContext?: ApplyRecoveryContext;
  /**
   * Called once when the browser has no free tab for this application and it
   * waits for one (a tab the person closes, or a sent application's page).
   */
  onWaitingForBrowserTab?: () => void | Promise<void>;
  captureVisualSnapshot?: (
    request: BrowserVisualSnapshotRequest,
  ) => Promise<BrowserVisualSnapshotRef>;
  /**
   * Explicitly opt in to runtime-owned visual diagnostics for safe apply checkpoints.
   * The runtime must not infer this from an ambient AI client because application
   * pages can contain sensitive account, profile, and resume data.
   */
  analyzeVisualSnapshot?: (input: {
    snapshot: BrowserVisualSnapshotRef;
    context: BrowserVisualAnalysisContext;
  }) => Promise<BrowserVisualObservationSet>;
}

export interface ApplicationPreparationProgress {
  step: number;
  note: string;
  progressSteps: number;
  elapsedMs: number;
}

export interface BrowserSessionRuntime {
  readRenderedPage?(
    url: string,
    options?: {
      signal?: AbortSignal | undefined;
      onPage?: AutomationPageListener;
      ready?: (html: string) => boolean;
    },
  ): Promise<{ html: string; finalUrl: string }>;
  getSessionState(source: JobSource): Promise<BrowserSessionState>;
  openSession(
    source: JobSource,
    options?: OpenBrowserSessionOptions,
  ): Promise<BrowserSessionState>;
  closeSession(source: JobSource): Promise<BrowserSessionState>;
  /** Close one parked handoff tab without taking control of other live work. */
  closeParkedTab?(
    source: JobSource,
    tab: ParkedBrowserTabReference,
  ): Promise<void>;
  inspectSourceAccess?(
    source: JobSource,
    input: BrowserSourceAccessProbeInput,
  ): Promise<BrowserSourceAccessProbeResult>;
  runDiscovery(
    source: JobSource,
    searchPreferences: JobSearchPreferences,
  ): Promise<DiscoveryRunResult>;
  executeEasyApply(
    source: JobSource,
    input: ExecuteEasyApplyInput,
  ): Promise<ApplyExecutionResult>;
  executeApplicationFlow(
    source: JobSource,
    input: ExecuteApplicationFlowInput,
    options?: BrowserApplicationExecutionOptions,
  ): Promise<ApplyExecutionResult>;
  /** Hold the exact prepared page and its site while a final action is checked and run. */
  withApplicationPageExecution?<T>(
    source: JobSource,
    pageBindingKey: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Whether the exact page retained for this preparation is still live. */
  hasApplicationPageBinding?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<boolean>;
  getApplicationPageState?(
    source: JobSource,
    key: string,
  ): Promise<ApplicationPageState>;
  reopenApplicationPage?(
    source: JobSource,
    key: string,
    onProgress?: (progress: ApplicationPageReopenProgress) => void,
  ): Promise<ApplicationPageState>;
  /** Discard a ready form only after an exact guarded refill has been verified. */
  hibernateApplicationPageBinding?(
    source: JobSource,
    pageBindingKey: string,
    canDiscard: () => boolean,
  ): Promise<boolean>;
  /** Browser Close ends ephemeral recovery as well as live pages. */
  clearApplicationPageRecovery?(): void;
  /** Native destruction differs from a CDP detach during person handoff. */
  forgetClosedApplicationPage?(
    source: JobSource,
    pageBindingKey: string,
  ): boolean;
  /** Bring the exact retained application page to the person without URL matching. */
  focusApplicationPageBinding?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<boolean>;
  /** Focus only an already-retained post-action page; never restores or navigates. */
  focusRetainedApplicationPage?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<boolean>;
  /** Read the exact retained page for workflow policy, with passwords redacted. */
  readApplicationPageBinding?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<RawApplyPage>;
  /**
   * Reload the exact retained application page once: the person signed in
   * to the same site in another tab, and this page still shows the sign-in
   * it loaded before that. A known application URL can re-enter the flow
   * when a sign-in form stays visible after the session changes. With an
   * explicit application URL, a lost binding is recreated with a guarded GET.
   */
  reloadApplicationPageBinding?(
    source: JobSource,
    pageBindingKey: string,
    applicationUrl?: string,
  ): Promise<void>;
  /** Arm one native POST action on the exact retained page for a person. */
  armApplicationFormAction?(
    source: JobSource,
    input: ApplicationFormActionHandoff,
  ): Promise<void>;
  /** Re-lock a retained handoff when the run resumes or another action opens. */
  closeApplicationFormAction?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<void>;
  /**
   * The person opened a prepared application to finish it themselves: let
   * their own submit and requests through on that exact page. Job Finder is
   * not working on the page then; `closeApplicationFormAction` locks it again
   * whenever a run picks the page back up.
   */
  handApplicationPageToPerson?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<void>;
  /**
   * Reads a prepared application page only while it is handed to the person
   * (after `handApplicationPageToPerson`, before it is locked again). Null
   * otherwise, so Job Finder's own send is never mistaken for the person's.
   */
  readApplicationPageWithPerson?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<RawApplyPage | null>;
  /**
   * Close the exact retained page when its owner has finished with it.
   */
  releaseApplicationPageBinding?(
    source: JobSource,
    pageBindingKey: string,
  ): Promise<void>;
  /** Move a retained page to a replacement attempt without reloading it. */
  transferApplicationPageBinding?(
    source: JobSource,
    previousKey: string,
    nextKey: string,
  ): Promise<boolean>;
  /**
   * Main-process-only application hand. The runtime retains Page ownership
   * and returns a redacted, transient observation with no DOM handle.
   * Catalog/seed runtimes intentionally omit this capability.
   */
  observeApplicationForm?(
    source: JobSource,
    options?: ObserveApplicationFormOptions,
  ): Promise<ApplicationFormObservation>;
  /**
   * Main-process-only reading and writing hands for the application page this
   * source has open. The runtime keeps the page; the caller gets bounded
   * operations on it and no handle. Catalog/seed runtimes omit this.
   */
  applyPageMechanics?(source: JobSource): ApplyRawPageHands;
  /**
   * Installs the prepare-only mutation guard on this source's application
   * page before any field is touched. Catalog/seed runtimes omit this.
   */
  installApplyPrepareOnlyGuard?(
    source: JobSource,
    input: {
      intermediateMutationsAuthorized: boolean;
      allowedOrigins: readonly string[];
    },
  ): Promise<void>;
  /**
   * Main-process-only one-shot final-action hand. It reports submission only
   * when the employer page visibly confirms receipt after the action.
   */
  executeExactlyOneFinalAction?(
    source: JobSource,
    input: ExecuteExactlyOneFinalActionInput,
  ): Promise<ApplicationFinalActionResult>;
  /** Observe the exact prior final action again; never reloads, clicks or re-arms it. */
  recheckApplicationSubmission?(
    source: JobSource,
    input: Pick<
      ExecuteExactlyOneFinalActionInput,
      "expectedObservation" | "expectedControl"
    > & { pageBindingKey: string },
  ): Promise<Extract<
    ApplicationFinalActionResult,
    { outcome: "submitted" }
  > | null>;
  captureVisualSnapshot?(
    source: JobSource,
    request: BrowserVisualSnapshotRequest,
  ): Promise<BrowserVisualSnapshotRef>;
  runAgentDiscovery?(
    source: JobSource,
    options: AgentDiscoveryOptions,
  ): Promise<DiscoveryRunResult>;
}

/**
 * Told about every page a run starts working in, so a host that shares its
 * browser between runs knows which run a tab belongs to (a person stepping
 * into that tab then stops only that run).
 */
export type AutomationPageListener = (page: Page) => void | Promise<void>;

export interface BrowserApplicationExecutionOptions {
  signal?: AbortSignal;
  onAutomationPage?: AutomationPageListener;
}

export interface AgentDiscoveryOptions {
  /** Main-owned exact-site autofill; returns no credentials. */
  prepareBrowserCredentials?: (url: string) => Promise<boolean>;
  browserPermissions?: BrowserAgentPermissions;
  readBrowserPermissions?: () =>
    | BrowserAgentPermissions
    | Promise<BrowserAgentPermissions>;
  /** Browser fallback collects cards; the new engine screens and reads them. */
  inventoryOnly?: boolean;
  lookupKnownUrls?: KnownJobUrlLookup;
  /** Capacity waits happen before page navigation and do not fail a source. */
  onWaitingForBrowserTab?: () => void;
  /** No person-specified result cap; retain every suitable posting found. */
  retainAllFound?: boolean;
  /** Public feed postings available for the model to inspect and select. */
  sourceCatalog?: JobPosting[];
  /** True only for a complete authoritative inventory of this source. */
  sourceCatalogComplete?: boolean;
  userProfile: CandidateProfile;
  searchPreferences: JobSearchGoals;
  /** The person's search focus, expressed as an instruction to the agent. */
  searchMode?: JobSearchCampaignMode;
  /** The person's plain-language goal and run-scoped search choices. */
  searchRequest?: JobFinderSearchRequest;
  /** The saved AI search behavior (Settings): selectivity and remote handling. */
  searchGuidance?: AiJobSearchBehavior;
  targetJobCount: number;
  maxSteps: number;
  runControl?: {
    timeBudgetMs?: number;
    noProgressStepLimit?: number;
  };
  resumeCheckpoint?: BrowserAgentRunCheckpoint;
  onCheckpoint?: (
    checkpoint: BrowserAgentRunCheckpoint,
  ) => Promise<void> | void;
  startingUrls: string[];
  /** Pages parked for unresolved user action; discovery must not reuse or close them. */
  protectedPages?: ParkedBrowserTabReference[];
  /**
   * Open this run in its own tab and leave every other tab alone, so several
   * sources can be searched at the same time. The tab is closed when the run
   * ends unless the run was stopped for the person.
   */
  dedicatedPage?: boolean;
  siteLabel: string;
  navigationHostnames: string[];
  siteInstructions?: string[];
  toolUsageNotes?: string[];
  taskPacket?: {
    phase: SourceDebugPhase;
    phaseGoal: string;
    knownFacts: string[];
    priorPhaseSummary?: string | null;
    avoidStrategyFingerprints: string[];
    successCriteria: string[];
    stopConditions: string[];
    manualPrerequisiteState?: string | null;
    strategyLabel?: string | null;
  };
  /** URL fragments that mark an already-open tab as a usable starting page. */
  relevantUrlSubstrings?: string[];
  skipSessionValidation?: boolean;
  aiClient?: JobFinderAiClient;
  onProgress?: (progress: AgentDiscoveryProgress) => void;
  onAutomationPage?: AutomationPageListener;
  signal?: AbortSignal;
}

export interface CatalogBrowserSessionRuntimeSeed {
  sessions: BrowserSessionState[];
  catalog: JobPosting[];
}

export type StubBrowserSessionRuntimeSeed = CatalogBrowserSessionRuntimeSeed;
