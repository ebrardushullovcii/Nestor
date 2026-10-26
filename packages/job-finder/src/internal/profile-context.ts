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
  JobDiscoveryTarget,
  JobSource,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import type { JobFinderDocumentManager } from "./workspace-service-contracts";

export interface MutableRef<T> {
  current: T;
}

/**
 * What profile work runs on: resume import, guided setup, the assistant's
 * profile edits and site checks.
 */
export interface ProfileContext {
  jobSites?: JobSitesStore;
  aiClient: JobFinderAiClient;
  visionProvider?: ResumeVisionProvider;
  browserRuntime: BrowserSessionRuntime;
  documentManager: JobFinderDocumentManager;
  repository: JobFinderRepository;
  readSavedAnswers?: () => readonly CandidateReusableAnswer[];
  hasRunJobSearch?: () => boolean;
  /** Jobs whose resume is approved, to tell which ones a change sent back. */
  approvedResumeJobIds?: () => string[];
  activeSourceDebugExecutionIdRef: MutableRef<string | null>;
  activeSourceDebugAbortControllerRef: MutableRef<AbortController | null>;
  activeSourceDebugPromiseRef: MutableRef<Promise<unknown> | null>;
  activeResumeVisionRunIds: Set<string>;
  activeResumeEvidenceRunIds: Set<string>;
  onResumeEvidenceFinished?: () => void;
  saveJobSiteMetadata: (
    targetId: string,
    updater: (target: JobDiscoveryTarget) => JobDiscoveryTarget,
  ) => Promise<JobDiscoveryTarget>;
  persistSourceDebugRun: (run: SourceDebugRunRecord) => Promise<void>;
  openRunBrowserSession: (
    source: JobSource,
    options?: OpenBrowserSessionOptions,
  ) => Promise<void>;
  closeRunBrowserSession: (source: JobSource) => Promise<void>;
}
