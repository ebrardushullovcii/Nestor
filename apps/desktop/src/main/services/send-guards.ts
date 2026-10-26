import { createSendGuards, type SendGuards } from "@nestor/db/job-store";

import { getJobStore } from "./job-store";

const guards = new WeakMap<ReturnType<typeof getJobStore>, SendGuards>();

/**
 * The send guards over the open job store. Always the same object for one
 * store: sends and permission changes queue on it, one at a time.
 */
export function getSendGuards(): SendGuards {
  const store = getJobStore();
  let current = guards.get(store);
  if (!current) {
    current = createSendGuards(store);
    guards.set(store, current);
  }
  return current;
}
