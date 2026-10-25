import type {
  AgentDebugFindings,
  DiscoveryAccessBlockerReason,
  BrowserAgentRunCheckpoint,
  JobPosting,
  JobFinderSearchRequest,
  JobSearchCampaignMode,
  AiJobSearchBehavior,
  JobSearchGoals,
  KnownJobUrlLookup,
  CandidateProfile,
  AgentDiscoveryProgress,
  JobSource,
  SharedAgentCompactionSnapshot,
  SourceDebugPhase,
  SourceDebugPhaseCompletionMode,
  SourceDebugPhaseEvidence,
  Tool,
  ToolCall,
} from "@nestor/contracts";

// Re-export shared types from contracts
export type { Tool, ToolCall };

// Narrow interface for search preferences used by the agent
export type AgentSearchPreferences = JobSearchGoals;

export interface AgentNavigationPolicy {
  allowedHostnames: string[];
  allowSubdomains?: boolean;
}

export interface AgentPromptContext {
  siteLabel: string;
  /** Whether this run should favor only strong fits or find a broad pool. */
  searchMode?: JobSearchCampaignMode;
  searchRequest?: JobFinderSearchRequest;
  /** The saved AI search behavior: how picky, and how remote counts. */
  searchGuidance?: AiJobSearchBehavior;
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
}

export interface AgentConfig {
  lookupKnownUrls?: KnownJobUrlLookup;
  /** No person-specified result cap; retain every suitable posting found. */
  retainAllFound?: boolean;
  /** Public feed postings available for the model to inspect and select. */
  sourceCatalog?: JobPosting[];
  /** True only for a complete authoritative inventory of this source. */
  sourceCatalogComplete?: boolean;
  source: JobSource;
  maxSteps: number;
  /** Legacy-compatible emergency ceiling. Normal completion is progress based. */
  runControl?: {
    timeBudgetMs?: number;
    noProgressStepLimit?: number;
  };
  targetJobCount: number;
  userProfile: CandidateProfile;
  searchPreferences: AgentSearchPreferences;
  startingUrls: string[];
  navigationPolicy: AgentNavigationPolicy;
  promptContext: AgentPromptContext;
  resumeCheckpoint?: BrowserAgentRunCheckpoint;
  onCheckpoint?: (
    checkpoint: BrowserAgentRunCheckpoint,
  ) => Promise<void> | void;
}

export interface AgentResult {
  pagesCovered?: number;
  coveredPageUrls?: string[];
  deferredListingPageUrls?: string[];
  duplicateListingPageUrls?: string[];
  duplicateListings?: number;
  unreadableListings?: Array<{
    title: string;
    url: string;
    category: "unreadable";
    reason: string;
  }>;
  jobs: JobPosting[];
  steps: number;
  incomplete?: boolean;
  warning?: string;
  error?: string;
  transcriptMessageCount: number;
  reviewTranscript?: string[];
  compactionState?: SharedAgentCompactionSnapshot | null;
  compactionUsedFallbackTrigger?: boolean;
  phaseCompletionMode?: SourceDebugPhaseCompletionMode | null;
  phaseCompletionReason?: string | null;
  phaseEvidence?: SourceDebugPhaseEvidence | null;
  debugFindings?: AgentDebugFindings | null;
  accessBlockerReason?: DiscoveryAccessBlockerReason;
  parkedPageUrl?: string;
}

// Re-export AgentDiscoveryProgress from contracts for consistency
export type AgentProgress = AgentDiscoveryProgress;

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type OnProgressCallback = (progress: AgentProgress) => void;
