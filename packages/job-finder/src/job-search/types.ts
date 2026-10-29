import type { BrowserAgentPermissions } from "@nestor/contracts";
import type {
  CandidateProfile,
  JobDiscoveryTarget,
  JobSearchPreferences,
  JobSearchRecord,
  JobSearchSettingsInput,
  JobSearchStatus,
  SourceInstructionArtifact,
  SavedOptionFallback,
} from "@nestor/contracts";
import type { JobStore } from "@nestor/db/job-store";

import type { JobSearchEngine } from "./engine";

export interface JobSearchContext {
  browserPermissions?: BrowserAgentPermissions;
  readBrowserPermissions?: () =>
    | BrowserAgentPermissions
    | Promise<BrowserAgentPermissions>;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  sources: readonly JobDiscoveryTarget[];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
  remoteCountsAsAnyLocation?: boolean;
  countryOptionFallbacks?: readonly SavedOptionFallback[];
}

export interface JobSearchRunnerDeps {
  store: JobStore;
  engine: JobSearchEngine;
  readContext(): Promise<JobSearchContext>;
  /** Cheap live policy read so a setting changed mid-search cannot publish an old judgment. */
  readRemoteCountsAsAnyLocation?(): boolean;
  /** Separate HTTP/browser queues, with per-host limits; fit batches run alongside collection. */
  concurrency?: {
    sources?: number;
    perHost?: number;
    browser?: number;
    fit?: number;
  };
  /** Sites read in the browser at once, read at each search: the Speed setting. */
  browserPages?: () => number;
  /** Fit requests in flight at once, read at each pass: the Speed setting. */
  fitRequests?: () => number;
  /**
   * The person started this work (Search, Retry, Keep reading). Work the
   * person stopped by closing the browser may use it again.
   */
  onExplicitStart?: () => void;
}

export interface JobSearchRunner {
  /** Resolves after recording the start, without waiting for sources or fit. */
  start(settings: JobSearchSettingsInput): Promise<JobSearchRecord>;
  /** Also cancels a standalone scoreUnscored call. Saved jobs stay saved. */
  stop(): void;
  /** Rechecks only this site; joins the running search, or starts a single-site search. */
  retrySource(id: number): Promise<JobSearchRecord>;
  /** Reads the rest of one site, or of every site the last search left partial. */
  keepReading(id?: number): Promise<JobSearchRecord>;
  status(): JobSearchStatus;
  /** Coalesced to at most four notifications per second. */
  onStatus(listener: (status: JobSearchStatus) => void): () => void;
  /** Retries unscored found/shortlisted jobs, without re-scoring existing fits. */
  scoreUnscored(): Promise<number>;
  prioritizeFit(ids: readonly number[]): void;
}
