import {
  SPEED_LEVELS,
  speedLevelOf,
  type SpeedLevelLimits,
} from "@nestor/contracts";
import { createPreferencesStore, type JobStore } from "@nestor/db/job-store";
import { getJobStore } from "../job-store";

const preferences = new WeakMap<
  JobStore,
  ReturnType<typeof createPreferencesStore>
>();

/**
 * The Speed setting's limits, read from the job store whenever work is about
 * to start, so a change in Settings applies to the next page or application.
 * Standard when the store cannot be read.
 */
export function currentSpeedLimits(): SpeedLevelLimits {
  try {
    const store = getJobStore();
    let settings = preferences.get(store);
    if (!settings) {
      settings = createPreferencesStore(store);
      preferences.set(store, settings);
    }
    return SPEED_LEVELS[speedLevelOf(settings.settings.read())];
  } catch {
    return SPEED_LEVELS.standard;
  }
}
