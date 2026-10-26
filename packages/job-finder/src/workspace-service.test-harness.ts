import type { JobSitesStore } from "@nestor/db/job-store";
import type {
  JobFinderAiClient,
  ResumeVisionProvider,
} from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepositorySeed,
} from "@nestor/db";
import {
  createJobFinderWorkspaceService,
  type ListingHtmlFetcher,
} from "./index";
import { createSeed } from "./workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";

export const workspaceHarnessInputs = new WeakMap<
  object,
  {
    repository: ReturnType<typeof createInMemoryJobFinderRepository>;
    documentManager: ReturnType<typeof createDocumentManager>;
  }
>();

export function createWorkspaceServiceHarness(
  options: {
    seed?: JobFinderRepositorySeed;
    jobSites?: JobSitesStore;
    browserRuntime?: BrowserSessionRuntime;
    aiClient?: JobFinderAiClient;
    visionProvider?: ResumeVisionProvider;
    documentManager?: ReturnType<typeof createDocumentManager>;
    exportFileVerifier?: {
      exists(filePath: string): Promise<boolean>;
      sha256?(filePath: string): Promise<string>;
    };
    researchAdapter?: ReturnType<typeof createResearchAdapter>;
    fetchListingHtml?: ListingHtmlFetcher;
    onResumeEvidenceFinished?: () => void;
    onListingAssessmentFinished?: () => void;
    onSavedJobsRescored?: () => void;
  } = {},
) {
  const repository = createInMemoryJobFinderRepository(
    options.seed ?? createSeed(),
  );
  const browserRuntime = options.browserRuntime ?? createBrowserRuntime();
  const aiClient = options.aiClient ?? createAiClient();
  const documentManager = options.documentManager ?? createDocumentManager();
  const exportFileVerifier = options.exportFileVerifier ?? {
    exists: () => Promise.resolve(true),
  };
  const researchAdapter = options.researchAdapter ?? createResearchAdapter();
  const workspaceService = createJobFinderWorkspaceService({
    repository,
    ...(options.jobSites ? { jobSites: options.jobSites } : {}),
    ...(options.onResumeEvidenceFinished
      ? { onResumeEvidenceFinished: options.onResumeEvidenceFinished }
      : {}),
    browserRuntime,
    aiClient,
    ...(options.visionProvider
      ? { visionProvider: options.visionProvider }
      : {}),
    documentManager,
    exportFileVerifier,
    researchAdapter,
    ...(options.onListingAssessmentFinished
      ? { onListingAssessmentFinished: options.onListingAssessmentFinished }
      : {}),
    ...(options.onSavedJobsRescored
      ? { onSavedJobsRescored: options.onSavedJobsRescored }
      : {}),
    ...(options.fetchListingHtml
      ? { fetchListingHtml: options.fetchListingHtml }
      : {}),
  });

  workspaceHarnessInputs.set(workspaceService, { repository, documentManager });
  return {
    repository,
    browserRuntime,
    aiClient,
    documentManager,
    exportFileVerifier,
    researchAdapter,
    workspaceService,
  };
}
