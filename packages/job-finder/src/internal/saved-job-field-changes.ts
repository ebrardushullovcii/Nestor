import { isDeepStrictEqual } from "node:util";
import type { SavedJob } from "@nestor/contracts";

/** A copied immutable detail getter still names the exact same SQLite version. */
export function changedSavedJobFields(
  before: SavedJob,
  after: SavedJob,
): Array<keyof SavedJob> {
  if (before === after) return [];
  return (Object.keys(after) as Array<keyof SavedJob>).filter((key) => {
    const previous = Object.getOwnPropertyDescriptor(before, key);
    const next = Object.getOwnPropertyDescriptor(after, key);
    if (previous?.get && previous.get === next?.get) return false;
    return !isDeepStrictEqual(before[key], after[key]);
  });
}
