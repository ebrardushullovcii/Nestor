import type { DatabaseSync } from "node:sqlite";
import { type ResumeDraftRevision } from "@nestor/contracts";
import {
  compactResumeDraftStorage,
  restoreResumeDraftStorage,
} from "./resume-draft-storage";

type Patch = { path: string[]; value?: unknown; remove?: true };
type StoredRevision = {
  format: "revision-delta-1";
  baseId: string | null;
  full?: unknown;
  changes?: Patch[];
};
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function diff(before: unknown, after: unknown, path: string[] = []): Patch[] {
  if (Object.is(before, after)) return [];
  if (object(before) && object(after)) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) =>
      !(key in after)
        ? [{ path: [...path, key], remove: true as const }]
        : diff(before[key], after[key], [...path, key]),
    );
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length
  )
    return after.flatMap((value, index) =>
      diff(before[index], value, [...path, String(index)]),
    );
  return [{ path, value: after }];
}
function apply(value: unknown, changes: Patch[]): unknown {
  let result = structuredClone(value);
  for (const patch of changes) {
    if (!patch.path.length) {
      result = patch.value;
      continue;
    }
    let parent = result as ObjectValue;
    for (const key of patch.path.slice(0, -1))
      parent = parent[key] as ObjectValue;
    const key = patch.path.at(-1)!;
    if (patch.remove) delete parent[key];
    else parent[key] = patch.value;
  }
  return result;
}
function pack(database: DatabaseSync, revision: ResumeDraftRevision): unknown {
  const next = revision;
  const sectionsFromDraft =
    !!next.snapshotDraft &&
    JSON.stringify(next.snapshotSections) ===
      JSON.stringify(next.snapshotDraft.sections);
  const identityFromDraft =
    !!next.snapshotDraft &&
    JSON.stringify(next.snapshotIdentity) ===
      JSON.stringify(next.snapshotDraft.identity);
  return {
    ...next,
    snapshotDraft: next.snapshotDraft
      ? compactResumeDraftStorage(database, next.snapshotDraft)
      : null,
    ...(sectionsFromDraft
      ? { snapshotSections: undefined, sectionsFromDraft: true }
      : {}),
    ...(identityFromDraft
      ? { snapshotIdentity: undefined, identityFromDraft: true }
      : {}),
  };
}
function unpack(database: DatabaseSync, value: unknown): ResumeDraftRevision {
  const { sectionsFromDraft, identityFromDraft, ...revision } =
    value as ResumeDraftRevision & {
      sectionsFromDraft?: boolean;
      identityFromDraft?: boolean;
    };
  if (revision.snapshotDraft)
    revision.snapshotDraft = restoreResumeDraftStorage(
      database,
      revision.snapshotDraft,
    );
  if (sectionsFromDraft)
    revision.snapshotSections = revision.snapshotDraft!.sections;
  if (identityFromDraft)
    revision.snapshotIdentity = revision.snapshotDraft!.identity;
  return revision;
}
function readPacked(
  database: DatabaseSync,
  id: string,
  initial?: string,
): unknown {
  const chain: StoredRevision[] = [];
  const seen = new Set<string>();
  let next: string | null = id;
  let full: unknown;
  while (next !== null) {
    if (seen.has(next))
      throw new Error("Resume revision history contains a cycle.");
    seen.add(next);
    const text =
      next === id && initial !== undefined
        ? initial
        : database
            .prepare("SELECT value FROM resume_draft_revisions WHERE id = ?")
            .get(next)?.value;
    if (typeof text !== "string")
      throw new Error("Resume revision history is incomplete.");
    const stored = JSON.parse(text) as StoredRevision;
    if (stored.format !== "revision-delta-1") {
      full = stored;
      break;
    }
    if (stored.baseId === null) {
      full = stored.full;
      break;
    }
    chain.push(stored);
    next = stored.baseId;
  }
  for (const stored of chain.reverse())
    full = apply(full, stored.changes ?? []);
  return full;
}
export function readResumeRevision(
  database: DatabaseSync,
  id: string,
  initial?: string,
): ResumeDraftRevision {
  return unpack(database, readPacked(database, id, initial));
}
export function serializeResumeRevision(
  database: DatabaseSync,
  revision: ResumeDraftRevision,
  migrating = false,
): string {
  const full = pack(database, revision);
  const previous = database
    .prepare(
      "SELECT id FROM resume_draft_revisions WHERE draft_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(revision.draftId, revision.createdAt, revision.createdAt, revision.id);
  if (
    !previous ||
    (!migrating &&
      database
        .prepare("SELECT 1 FROM resume_draft_revisions WHERE id = ?")
        .get(revision.id))
  ) {
    // Replacing an existing base must not change any descendant's snapshot.
    const children = database
      .prepare(
        "SELECT id FROM resume_draft_revisions WHERE json_extract(value, '$.baseId') = ?",
      )
      .all(revision.id);
    for (const child of children) {
      const childFull = readPacked(database, String(child.id));
      database
        .prepare("UPDATE resume_draft_revisions SET value = ? WHERE id = ?")
        .run(
          JSON.stringify({
            format: "revision-delta-1",
            baseId: null,
            full: childFull,
          } satisfies StoredRevision),
          String(child.id),
        );
    }
    return JSON.stringify({
      format: "revision-delta-1",
      baseId: null,
      full,
    } satisfies StoredRevision);
  }
  const baseId = String(previous.id);
  const changes = diff(readPacked(database, baseId), full);
  return JSON.stringify({
    format: "revision-delta-1",
    baseId,
    changes,
  } satisfies StoredRevision);
}

/** Retention rebases the oldest kept snapshot before removing its ancestors. */
export function rebaseRetainedResumeRevisions(
  database: DatabaseSync,
  draftId: string,
  limit: number,
): void {
  const retained = database
    .prepare(
      "SELECT id, value FROM resume_draft_revisions WHERE draft_id = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(draftId, limit);
  const ids = new Set(retained.map((row) => String(row.id)));
  for (const row of retained) {
    const stored = JSON.parse(String(row.value)) as StoredRevision;
    if (
      stored.format === "revision-delta-1" &&
      stored.baseId &&
      !ids.has(stored.baseId)
    ) {
      const full = readPacked(database, String(row.id), String(row.value));
      database
        .prepare("UPDATE resume_draft_revisions SET value = ? WHERE id = ?")
        .run(
          JSON.stringify({
            format: "revision-delta-1",
            baseId: null,
            full,
          } satisfies StoredRevision),
          String(row.id),
        );
    }
  }
}
