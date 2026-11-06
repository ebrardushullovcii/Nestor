import type { JobFinderRepository } from "@nestor/db";
import {
  createApplicationService,
  type ApplicationService,
  type ApplicationServiceDeps,
} from "@nestor/job-finder/applications";

import { getJobStore } from "./job-store";
import { registerServiceStopper } from "./service-stoppers";
import { getApplicationStore } from "./job-finder/application-store";

import { getSendGuards } from "./send-guards";
import { getCandidateAssetLibrary } from "./job-finder/candidate-asset-library-instance";
import { loadEmbeddedBrowser } from "./browser/load-embedded-browser";

let service: ApplicationService | null = null;
let ready: Promise<ApplicationService> | null = null;
let resolveReady: ((service: ApplicationService) => void) | null = null;

export async function startApplicationService(
  deps: Pick<
    ApplicationServiceDeps,
    | "browser"
    | "aiClient"
    | "documentManager"
    | "isHoldingCurrent"
    | "concurrency"
  > & {
    repository: JobFinderRepository;
  },
): Promise<ApplicationService> {
  service?.stop();
  const { repository } = deps;
  const applications = getApplicationStore();
  // One guards object: every send and permission change queues on it.
  const guards = getSendGuards();

  const instructionMode: NonNullable<
    ApplicationServiceDeps["instructionMode"]
  > = async (input) => {
    const { assistantApplicationMode } =
      await import("./assistant/assistant-service");
    return assistantApplicationMode(input);
  };

  // ADR 0079: the model's send call goes directly to the durable ledger.
  // Legacy authorities and grants remain readable; their profile preflight,
  // mode refusal and retry loop no longer stand in front of application work.
  const authorizeSending: ApplicationServiceDeps["authorizeSending"] = () =>
    Promise.resolve(null);

  service = createApplicationService({
    ...deps,
    jobs: getJobStore(),
    applications,
    authorityRepository: guards,
    candidateAssets: getCandidateAssetLibrary(),
    readInputs: async () => {
      const [profile, settings, searchPreferences, sourceInstructionArtifacts] =
        await Promise.all([
          repository.getProfile(),
          repository.getSettings(),
          repository.getSearchPreferences(),
          repository.listSourceInstructionArtifacts(),
        ]);
      return {
        profile,
        settings,
        searchPreferences,
        sourceInstructionArtifacts,
      };
    },
    isPaused: async () => (await repository.getActivityControl()).paused,
    authorizeSending,
    instructionMode,
    onPersonSent: ({ pageKey, ...sent }) => {
      void loadEmbeddedBrowser()
        .then((browser) => browser.noteSent(pageKey, sent))
        .catch(() => undefined);
    },
  });
  await service.start();
  registerServiceStopper(stopApplicationService);
  resolveReady?.(service);
  resolveReady = null;
  ready = Promise.resolve(service);
  return service;
}

export function getApplicationService(): Promise<ApplicationService> {
  ready ??= new Promise((resolve) => {
    resolveReady = resolve;
  });
  return ready;
}

export function stopApplicationService(): void {
  service?.stop();
  service = null;
  ready = null;
}
