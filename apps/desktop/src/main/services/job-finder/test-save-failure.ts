import {
  JobFinderTestSaveSurfaceSchema,
  type JobFinderTestSaveSurface,
} from "@nestor/contracts";
import { isDesktopTestApiEnabled } from "./test-api";

/**
 * Exactly which IPC save channels each protected renderer save surface owns.
 * The map is the contract: arming a surface fails the next save that surface
 * can start and nothing else, so a "settings" arm can never be mistaken for a
 * profile failure while a walkthrough proves the Settings staged-draft rule.
 *
 * `job-finder:save-profile-setup-state` belongs to both `profile` and
 * `answers` because guided setup reports the extras step under `answers` and
 * every other step under `profile`; a one-shot hook that fires on the next
 * setup save of whichever surface was armed is exactly the intent.
 */
const JOB_FINDER_TEST_SAVE_SURFACE_CHANNELS = {
  profile: [
    "job-finder:save-profile",
    "job-finder:save-search-preferences",
    "job-finder:save-profile-setup-state",
    "job-finder:apply-profile-copilot-patch-group",
  ],
  answers: [
    "job-finder:save-workspace-inputs",
    "job-finder:save-profile-setup-state",
  ],
  settings: [
    "job-finder:save-settings",
    "job-finder:update-application-defaults",
    "job-finder:update-workspace-behavior",
    "job-finder:update-ai-behavior",
    "job-finder:update-appearance-theme",
    "job-finder:update-tracker-crm",
  ],
  resume: [
    "job-finder:save-resume-draft",
    "job-finder:restore-resume-draft-revision",
    "job-finder:undo-resume-assistant-edit",
    "job-finder:apply-resume-patch",
  ],
} as const satisfies Record<JobFinderTestSaveSurface, readonly string[]>;

export type JobFinderSaveChannel =
  (typeof JOB_FINDER_TEST_SAVE_SURFACE_CHANNELS)[JobFinderTestSaveSurface][number];

export const jobFinderSaveChannels: readonly JobFinderSaveChannel[] = [
  ...new Set(Object.values(JOB_FINDER_TEST_SAVE_SURFACE_CHANNELS).flat()),
] as readonly JobFinderSaveChannel[];

/**
 * At most one surface can be armed at a time and the arm is consumed by the
 * first matching save, so an armed failure can never leak into a later save
 * or a later session.
 */
let armedSurface: JobFinderTestSaveSurface | null = null;

export function getArmedJobFinderTestSaveFailureSurface(): JobFinderTestSaveSurface | null {
  return armedSurface;
}

export function clearArmedJobFinderTestSaveFailure(): void {
  armedSurface = null;
}

/**
 * Arms exactly the next save on `surface` to reject. Refuses outright when the
 * desktop test API is disabled, so a production build has no way to reach this
 * state even if the module is somehow loaded.
 */
export function armJobFinderTestSaveFailure(
  surface: unknown,
  env: NodeJS.ProcessEnv = process.env,
): JobFinderTestSaveSurface {
  if (!isDesktopTestApiEnabled(env)) {
    throw new Error(
      "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
    );
  }

  armedSurface = JobFinderTestSaveSurfaceSchema.parse(surface);
  return armedSurface;
}

function formatSyntheticSaveFailureMessage(
  surface: JobFinderTestSaveSurface,
): string {
  return `Job Finder could not write the ${surface} change to the workspace database. The workspace file is temporarily unavailable. (Synthetic desktop test-API failure.)`;
}

/**
 * Consumes an armed failure for `channel`. Throws once — and only once — when
 * the armed surface owns that channel; every other call, and every call in a
 * build without the test API, returns without touching the save.
 */
export function consumeArmedJobFinderTestSaveFailure(
  channel: JobFinderSaveChannel,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (armedSurface === null) {
    return;
  }

  if (!isDesktopTestApiEnabled(env)) {
    // Defensive: an arm can only be created while the test API is enabled, so
    // an arm observed without it is stale state and is dropped, never applied.
    armedSurface = null;
    return;
  }

  const surface = armedSurface;
  const ownedChannels: readonly string[] =
    JOB_FINDER_TEST_SAVE_SURFACE_CHANNELS[surface];

  if (!ownedChannels.includes(channel)) {
    return;
  }

  armedSurface = null;
  throw new Error(formatSyntheticSaveFailureMessage(surface));
}
