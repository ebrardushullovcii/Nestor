import type { DatabaseSync } from "node:sqlite";
import path from "node:path";

const listeners = new Map<string, Set<() => void>>();
const databasePaths = new WeakMap<DatabaseSync, string>();
const key = (file: string) =>
  process.platform === "win32"
    ? path.resolve(file).toLowerCase()
    : path.resolve(file);

/** Visible workspace writers run in main; a commit schedules one reader push. */
export function subscribeWorkspaceCommits(
  file: string,
  listener: () => void,
): () => void {
  const id = key(file);
  let subscribers = listeners.get(id);
  if (!subscribers) listeners.set(id, (subscribers = new Set()));
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(id);
  };
}
export function notifyWorkspaceCommit(database: DatabaseSync): void {
  let file = databasePaths.get(database);
  if (!file) {
    const row = database
      .prepare("PRAGMA database_list")
      .all()
      .find((item) => item.name === "main");
    if (!row?.file) return;
    file = key(String(row.file));
    databasePaths.set(database, file);
  }
  for (const listener of listeners.get(file) ?? []) {
    try {
      listener();
    } catch {
      /* A UI notification cannot undo a committed write. */
    }
  }
}
