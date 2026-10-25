import type {
  JobSelectionInput,
  ApplyRawPageHands,
  AssistantResumeBatchState,
  CandidateAsset,
  JobFinderJobDetail,
  JobFinderSearchRequest,
} from "@nestor/contracts";
import type { AssistantToolDefinition } from "./tool-kit";

/**
 * What the assistant needs from the host that is not a workspace-service
 * call: the same orchestration the screens use (a search with its activity
 * feed, an apply batch with its authority, a send), files, and the browser.
 * The desktop main process implements these with the exact functions its
 * IPC routes call, so the assistant and the buttons take one path.
 */
export interface AssistantHostPorts {
  /** Store commands registered by the host, shared with the screens. */
  commands?: readonly AssistantToolDefinition[];
  readJobDetail?(
    jobId: string,
    planId: string | null,
  ): Promise<JobFinderJobDetail>;
  /** Only registered desktop actions; never raw IPC or arbitrary file access. */
  executeAction?(actionId: string, input: unknown): Promise<unknown>;
  /** Includes reading the file before the domain import run is stored. */
  isResumeImportActive?(): boolean;
  /** The UI-owned queue uses this same stop flag before dispatching a draft. */
  readResumeBatch?(): AssistantResumeBatchState | null;
  stopResumeBatch?(): AssistantResumeBatchState | null;
  /** Starts a search as Find jobs does and returns once the run exists. */
  startSearch(input: {
    searchRequest: JobFinderSearchRequest;
    targetId: string | null;
  }): Promise<{ runId: string | null; message: string }>;
  cancelSearch(runId: string): Promise<void>;
  /** Freeze the approved selection behind a sidebar instruction, without model pagination. */
  resolveApprovedJobs?(selection: JobSelectionInput): Promise<number[]>;
  /** Runs a source check (the same as Check this source). */
  checkSource(
    targetId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listDocuments(): Promise<readonly CandidateAsset[]>;
  /** Plain text of one document, bounded; null when it has none. */
  readDocumentText(documentId: string): Promise<string | null>;
  /** The file's bytes for an upload into a page; the model never sees a path. */
  loadDocumentFile(documentId: string): Promise<{
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }>;
  /** Imports a document into the profile as a resume. */
  importResumeDocument(
    documentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Writes the tracker export where the person chooses; returns the path or null. */
  /** The browser, when the host has one. */
  browser?: AssistantBrowserPort;
  /** Makes app navigation visible while preserving every browser tab. */
  prepareAppNavigation?(): Promise<void>;
  /** Tells mounted screens to refresh after the assistant changed something. */
  publishWorkspaceUpdate(): void;
}

/**
 * The tab the person lent the assistant (ADR 0038). A lease covers exactly
 * that tab and the tabs the task opens from it; the person's click or key in
 * it, closing it, Stop, or the end of the task revokes it.
 */
export interface AssistantBrowserLease {
  leaseId: string;
  /** True for a tab the person lent, rather than one this task opened. */
  borrowed?: boolean;
  /** Rechecks whether the current page retains a saved application. */
  isApplicationBound(): Promise<boolean>;
  /** Exact retained result this turn may edit; navigation and send stay closed. */
  applicationResultId?: string;
  tabId: string;
  /** Aborted when the lease is revoked. */
  revoked: AbortSignal;
  /** Mechanics on the lease's current page (it moves into a popup it adopts). */
  hands: ApplyRawPageHands;
  currentUrl(): string;
  /** Tabs the task opened from the lent tab, with their order for adoption. */
  childTabIds(): string[];
  /** A still of the page, for image-capable routes. */
  screenshot?(): Promise<{ dataUrl: string } | null>;
  release(reason: string): Promise<void>;
}

export interface AssistantBrowserPort {
  /** Shows the focused tab without lending it or taking it over. */
  show?(): Promise<void>;
  /** The tab on screen now, if the browser is open. */
  visibleTab(): { tabId: string; url: string; title: string | null } | null;
  lease(input: {
    tabId: string | null;
    applicationResultId?: string;
    onApplicationChange?: (recordId: string, field: string) => Promise<void>;
    conversationId: string;
    turnId: string;
    signal?: AbortSignal;
    /** When no tab is lent, the task may open its own at this address. */
    openUrl?: string | null;
  }): Promise<AssistantBrowserLease>;
}
