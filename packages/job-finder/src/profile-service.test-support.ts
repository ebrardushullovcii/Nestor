import {
  createSavedAnswersStore,
  readSavedApplicationAnswers,
} from "@nestor/db/applications";
import {
  createJobFinderRepository,
  type JobSitesStore,
} from "@nestor/db/job-store";
import type {
  JobFinderAiClient,
  ResumeVisionProvider,
} from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type { JobFinderRepository } from "@nestor/db";

import {
  createTestJobSites,
  createTestJobStore,
} from "./job-sites.test-support";
import {
  createProfileService,
  type ProfileService,
  type ProfileServiceOptions,
} from "./profile-service";
import { createSeed, type TestSeed } from "./test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
} from "./test-runtimes";

export * from "./test-fixtures";
export * from "./test-runtimes";
export * from "./test-findings";

export function parsePhaseFromSiteLabel(siteLabel: string): string {
  return siteLabel.split(":").at(-1)?.trim() ?? siteLabel;
}

/** What a harness was built on, for test read ports. */
export const harnessInputs = new WeakMap<
  object,
  {
    repository: JobFinderRepository;
    documentManager: ReturnType<typeof createDocumentManager>;
    jobSites: JobSitesStore;
  }
>();

/** What profile work changed, read back from the store. */
export async function readProfileView(
  repository: JobFinderRepository,
  extra: {
    resumeImportActive: boolean;
    enabledSiteCount: number;
    availableResumeTemplates: ReturnType<
      ReturnType<typeof createDocumentManager>["listResumeTemplates"]
    >;
  },
) {
  const [
    profile,
    searchPreferences,
    settings,
    profileSetupState,
    activityControl,
    latestResumeImportRun,
    profileRevisions,
  ] = await Promise.all([
    repository.getProfile(),
    repository.getSearchPreferences(),
    repository.getSettings(),
    repository.getProfileSetupState(),
    repository.getActivityControl(),
    repository.getLatestResumeImportRun(),
    repository.listProfileRevisions(),
  ]);
  const [latestResumeImportReviewCandidates, bundles] = latestResumeImportRun
    ? await Promise.all([
        repository.listResumeImportFieldCandidates({
          runId: latestResumeImportRun.id,
          resolutions: ["needs_review", "abstained"],
        }),
        repository.listResumeImportDocumentBundles({
          runId: latestResumeImportRun.id,
        }),
      ])
    : [[], []];
  return {
    profile,
    searchPreferences,
    settings,
    profileSetupState,
    activityControl,
    latestResumeImportRun,
    latestResumeImportReviewCandidates,
    latestResumeImportBundle: bundles[0] ?? null,
    profileRevisions,
    ...extra,
    generatedAt: new Date().toISOString(),
  };
}

/** A job store repository holding the seed's person, goals and settings. */
export async function createSeededRepository(
  seed: Partial<TestSeed> = createSeed(),
  store = createTestJobStore(),
): Promise<JobFinderRepository> {
  const repository = createJobFinderRepository(store);
  const base = createSeed();
  await repository.saveProfileAndSearchPreferences(
    seed.profile ?? base.profile,
    seed.searchPreferences ?? base.searchPreferences,
  );
  await repository.saveSettings(seed.settings ?? base.settings);
  await repository.saveProfileSetupState(
    seed.profileSetupState ?? base.profileSetupState,
  );
  for (const run of seed.resumeImportRuns ?? []) {
    await repository.replaceResumeImportRunArtifacts({
      run,
      documentBundles: (seed.resumeImportDocumentBundles ?? []).filter(
        (bundle) => bundle.runId === run.id,
      ),
      fieldCandidates: (seed.resumeImportFieldCandidates ?? []).filter(
        (candidate) => candidate.runId === run.id,
      ),
    });
  }
  for (const artifact of seed.sourceInstructionArtifacts ?? [])
    await repository.upsertSourceInstructionArtifact(artifact);
  for (const revision of seed.profileRevisions ?? [])
    await repository.upsertProfileRevision(revision);
  for (const message of seed.profileCopilotMessages ?? [])
    await repository.upsertProfileCopilotMessage(message);
  return repository;
}

/**
 * The service with each profile action answering with the profile view it
 * left behind, for tests that check what an action changed.
 */
export function withProfileView(
  service: ProfileService,
  repository: JobFinderRepository,
  options: {
    ready?: Promise<unknown>;
    enabledSiteCount?: () => number;
    availableResumeTemplates?: () => ReturnType<
      ReturnType<typeof createDocumentManager>["listResumeTemplates"]
    >;
  } = {},
) {
  const read = async () => {
    await options.ready;
    await service.refreshProfileSetup();
    return readProfileView(repository, {
      resumeImportActive: service.isResumeImportActive(),
      enabledSiteCount: options.enabledSiteCount?.() ?? 0,
      availableResumeTemplates: options.availableResumeTemplates?.() ?? [],
    });
  };
  /** Runs one action after the seed lands, then reads the profile back. */
  const viewing =
    <K extends keyof ProfileService>(name: K) =>
    async (
      ...args: Parameters<
        Extract<ProfileService[K], (...a: never[]) => unknown>
      >
    ) => {
      await options.ready;
      const run = service[name] as (...a: typeof args) => Promise<unknown>;
      await run(...args);
      return read();
    };
  return {
    ...service,
    read,
    runResumeImport: viewing("runResumeImport"),
    analyzeProfileFromResume: viewing("analyzeProfileFromResume"),
    saveProfile: viewing("saveProfile"),
    saveProfileAndSearchPreferences: viewing("saveProfileAndSearchPreferences"),
    saveSearchPreferences: viewing("saveSearchPreferences"),
    saveProfileSetupState: viewing("saveProfileSetupState"),
    applyProfileSetupReviewAction: viewing("applyProfileSetupReviewAction"),
    applyResumeTimelineRepairAction: viewing("applyResumeTimelineRepairAction"),
    saveSettings: viewing("saveSettings"),
    updateApplicationDefaults: viewing("updateApplicationDefaults"),
    updateAiBehavior: viewing("updateAiBehavior"),
    updateWorkspaceBehavior: viewing("updateWorkspaceBehavior"),
    updateAppearanceTheme: viewing("updateAppearanceTheme"),
    undoProfileRevision: viewing("undoProfileRevision"),
    applyProfileCopilotPatchGroup: viewing("applyProfileCopilotPatchGroup"),
    rejectProfileCopilotPatchGroup: viewing("rejectProfileCopilotPatchGroup"),
  };
}

/**
 * Profile work over an in-memory job store seeded with a synthetic person.
 * Each action answers with the profile view it left behind.
 */
export function createProfileServiceHarness(
  options: {
    seed?: ReturnType<typeof createSeed>;
    jobSites?: JobSitesStore;
    browserRuntime?: BrowserSessionRuntime;
    aiClient?: JobFinderAiClient;
    visionProvider?: ResumeVisionProvider;
    documentManager?: ReturnType<typeof createDocumentManager>;
    onResumeEvidenceFinished?: () => void;
    sourceAccess?: ProfileServiceOptions["sourceAccess"];
  } = {},
) {
  const seed = options.seed ?? createSeed();
  const store = createTestJobStore();
  const repository = createJobFinderRepository(store);
  const seeded = createSeededRepository(seed, store);
  const jobSites = options.jobSites ?? createTestJobSites(seed.jobSites, store);
  const browserRuntime = options.browserRuntime ?? createBrowserRuntime();
  const aiClient = options.aiClient ?? createAiClient();
  const documentManager = options.documentManager ?? createDocumentManager();
  const service = createProfileService({
    repository,
    readSavedAnswers: () => readSavedApplicationAnswers(store),
    jobSites,
    browserRuntime,
    aiClient,
    ...(options.visionProvider
      ? { visionProvider: options.visionProvider }
      : {}),
    documentManager,
    ...(options.onResumeEvidenceFinished
      ? { onResumeEvidenceFinished: options.onResumeEvidenceFinished }
      : {}),
    ...(options.sourceAccess ? { sourceAccess: options.sourceAccess } : {}),
  });
  const profileWork = withProfileView(service, repository, {
    ready: seeded,
    enabledSiteCount: () => jobSites.counts().enabled,
    availableResumeTemplates: () => documentManager.listResumeTemplates(),
  });
  const { read } = profileWork;
  // The service itself, as the assistant calls it, with the same read.
  const assistantService = Object.assign(service, { read });
  harnessInputs.set(profileWork, { repository, documentManager, jobSites });
  harnessInputs.set(assistantService, {
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
    store,
    repository,
    jobSites,
    browserRuntime,
    aiClient,
    documentManager,
    profileWork,
    service: assistantService,
    seeded,
  };
}
