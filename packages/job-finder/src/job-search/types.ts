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
}

export interface JobSearchRunnerDeps {
  store: JobStore;
  engine: JobSearchEngine;
  readContext(): Promise<JobSearchContext>;
  /** Defaults: four HTTP inventories and six fit batches. Browser reads are capped by the engine. */
  concurrency?: { sources?: number; fit?: number };
}

export interface JobSearchRunner {
  /** Resolves after recording the start, without waiting for sources or fit. */
  start(settings: JobSearchSettingsInput): Promise<JobSearchRecord>;
  /** Also cancels a standalone scoreUnscored call. Saved jobs stay saved. */
  stop(): void;
  status(): JobSearchStatus;
  /** Coalesced to at most four notifications per second. */
  onStatus(listener: (status: JobSearchStatus) => void): () => void;
  /** Retries unscored found/shortlisted jobs, without re-scoring existing fits. */
  scoreUnscored(): Promise<number>;
}
