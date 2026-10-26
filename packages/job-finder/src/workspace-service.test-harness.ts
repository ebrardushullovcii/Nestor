import type { JobDiscoveryTarget } from "@nestor/contracts";
import {
  createSavedAnswersStore,
  readSavedApplicationAnswers,
} from "@nestor/db/applications";
import {
  createTestJobSites,
  createTestJobStore,
} from "./job-sites.test-support";
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
    jobSites: JobSitesStore;
  }
>();

export function createWorkspaceServiceHarness(
  options: {
    seed?: JobFinderRepositorySeed & { jobSites?: JobDiscoveryTarget[] };
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
  const seed = options.seed ?? createSeed();
  const store = createTestJobStore();
  const repository = createInMemoryJobFinderRepository(seed, { store });
  const jobSites =
    options.jobSites ?? createTestJobSites(seed.jobSites ?? [], store);
  const browserRuntime = options.browserRuntime ?? createBrowserRuntime();
  const aiClient = options.aiClient ?? createAiClient();
  const documentManager = options.documentManager ?? createDocumentManager();
  const exportFileVerifier = options.exportFileVerifier ?? {
    exists: () => Promise.resolve(true),
  };
  const researchAdapter = options.researchAdapter ?? createResearchAdapter();
  const workspaceService = createJobFinderWorkspaceService({
    repository,
    savedAnswers: createSavedAnswersStore(store),
    readSavedAnswers: () => readSavedApplicationAnswers(store),
    jobSites,
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

  workspaceHarnessInputs.set(workspaceService, {
    repository,
    documentManager,
    jobSites,
  });
  return {
    readSavedAnswerRows: () =>
      createSavedAnswersStore(store)
        .list()
        .rows.map(
          (row) =>
            createSavedAnswersStore(store).get({
              key: row.key,
              scope: row.scope,
            })!,
        ),
    savedAnswers: createSavedAnswersStore(store),
    repository,
    jobSites,
    browserRuntime,
    aiClient,
    documentManager,
    exportFileVerifier,
    researchAdapter,
    workspaceService,
  };
}
