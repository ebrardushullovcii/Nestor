import type { JobFinderRepository } from "@nestor/db";
import {
  createResumeService,
  type ResumeService,
  type ResumeServiceDeps,
} from "@nestor/job-finder/resumes";

import { getJobStore } from "./job-store";
import { registerServiceStopper } from "./service-stoppers";

let service: ResumeService | null = null;
let ready: Promise<ResumeService> | null = null;
let resolveReady: ((service: ResumeService) => void) | null = null;

/**
 * Starts writing resumes for shortlisted jobs. Called once the workspace
 * service has its AI client and document renderer; a restart of that service
 * restarts this with the new ones.
 */
export function startResumeService(
  deps: Omit<ResumeServiceDeps, "store" | "readInputs"> & {
    repository: JobFinderRepository;
  },
): ResumeService {
  service?.stop();
  const { repository, ...rest } = deps;
  service = createResumeService({
    ...rest,
    store: getJobStore(),
    readInputs: async () => {
      const [profile, searchPreferences, settings] = await Promise.all([
        repository.getProfile(),
        repository.getSearchPreferences(),
        repository.getSettings(),
      ]);
      return { profile, searchPreferences, settings };
    },
  });
  service.start();
  registerServiceStopper(stopResumeService);
  resolveReady?.(service);
  resolveReady = null;
  ready = Promise.resolve(service);
  return service;
}

/** The running resume service, waiting for startup when it has not begun. */
export function getResumeService(): Promise<ResumeService> {
  ready ??= new Promise((resolve) => {
    resolveReady = resolve;
  });
  return ready;
}

export function stopResumeService(): void {
  service?.stop();
  service = null;
  ready = null;
}
