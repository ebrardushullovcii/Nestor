import type {
  CandidateProfile,
  JobDiscoveryTarget,
  JobSearchPreferences,
  JobSearchRecord,
  JobSearchSettingsInput,
  JobSearchStatus,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import type { JobStore } from "@nestor/db/job-store";

import type { JobSearchEngine } from "./engine";

export interface JobSearchContext {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  sources: readonly JobDiscoveryTarget[];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
  remoteCountsAsAnyLocation?: boolean;
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
}

export interface JobSearchRunner {
  /** Resolves after recording the start, without waiting for sources or fit. */
  start(settings: JobSearchSettingsInput): Promise<JobSearchRecord>;
  /** Also cancels a standalone scoreUnscored call. Saved jobs stay saved. */
  stop(): void;
  /** Rechecks only this site; joins the running search, or starts a single-site search. */
  retrySource(id: number): Promise<JobSearchRecord>;
  status(): JobSearchStatus;
  /** Coalesced to at most four notifications per second. */
  onStatus(listener: (status: JobSearchStatus) => void): () => void;
  /** Retries unscored found/shortlisted jobs, without re-scoring existing fits. */
  scoreUnscored(): Promise<number>;
}
