import type { ResumeDraft, ResumeDraftRevision } from "@nestor/contracts";

type Json = unknown;

// Fields a save stamps without the person changing content. Comparing them
// would make every later save look like an edit to the same line.
const VOLATILE_KEYS = new Set(["updatedAt"]);

// Draft-level fields that describe the draft's lifecycle, not its content.
// Undo keeps the current values and the caller sets review state.
const LIFECYCLE_KEYS = new Set([
  "id",
  "jobId",
  "status",
  "approvedAt",
  "approvedExportId",
  "staleReason",
  "createdAt",
  "updatedAt",
]);

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripVolatile(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (isPlainObject(value)) {
    const result: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      if (!VOLATILE_KEYS.has(key)) {
        result[key] = stripVolatile(value[key]);
      }
    }
    return result;
  }
  return value;
}

function sameContent(left: Json, right: Json): boolean {
  return (
    JSON.stringify(stripVolatile(left)) === JSON.stringify(stripVolatile(right))
  );
}

function isIdentifiedArray(value: Json): value is Array<{ id: string }> {
  return (
    Array.isArray(value) &&
    value.every((item) => isPlainObject(item) && typeof item.id === "string")
  );
}

function idsOf(items: ReadonlyArray<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

function mergeIdentifiedArrays(
  before: Array<{ id: string }>,
  after: Array<{ id: string }>,
  current: Array<{ id: string }>,
): Array<{ id: string }> {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const result: Array<{ id: string }> = [];

  for (const item of current) {
    const beforeItem = beforeById.get(item.id);
    const afterItem = afterById.get(item.id);
    if (!beforeItem && afterItem) {
      // Added by the AI edit. Drop it unless the person has changed it since,
      // which makes it theirs.
      if (sameContent(afterItem, item)) {
        continue;
      }
      result.push(item);
      continue;
    }
    if (beforeItem && afterItem) {
      result.push(
        mergeRevertingAssistantEdit(beforeItem, afterItem, item) as {
          id: string;
        },
      );
      continue;
    }
    // Present before the AI edit but not after it and still present now, or
    // added after the AI edit: either way it is the person's line.
    result.push(item);
  }

  // Lines the AI edit removed come back where they were, unless the person
  // has since added the same id back themselves.
  const currentIds = new Set(result.map((item) => item.id));
  before.forEach((item, index) => {
    if (afterById.has(item.id) || currentIds.has(item.id)) {
      return;
    }
    const previousId = before
      .slice(0, index)
      .reverse()
      .find((candidate) => currentIds.has(candidate.id))?.id;
    const insertAt = previousId
      ? result.findIndex((candidate) => candidate.id === previousId) + 1
      : 0;
    result.splice(insertAt, 0, item);
    currentIds.add(item.id);
  });

  // The AI edit reordered this list and the person has not reordered it
  // since: put the original order back.
  const afterOrder = idsOf(after);
  const currentOrder = idsOf(current);
  if (
    JSON.stringify(idsOf(before)) !== JSON.stringify(afterOrder) &&
    JSON.stringify(afterOrder) === JSON.stringify(currentOrder)
  ) {
    const beforeIndex = new Map(idsOf(before).map((id, index) => [id, index]));
    const originalIndex = new Map(
      idsOf(result).map((id, index) => [id, index]),
    );
    result.sort((left, right) => {
      const leftIndex = beforeIndex.get(left.id);
      const rightIndex = beforeIndex.get(right.id);
      if (leftIndex !== undefined && rightIndex !== undefined) {
        return leftIndex - rightIndex;
      }
      return (
        (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0)
      );
    });
  }

  return result;
}

/**
 * Three-way revert of one AI edit. `before` and `after` are the draft on
 * either side of the AI edit, `current` is the draft now. Every part the AI
 * edit changed goes back to `before` unless the person has changed that part
 * since, in which case the person's later wording wins. Parts the AI edit did
 * not touch keep their current value.
 */
export function mergeRevertingAssistantEdit(
  before: Json,
  after: Json,
  current: Json,
): Json {
  if (sameContent(before, after)) {
    return current;
  }
  if (sameContent(after, current)) {
    return before;
  }
  if (
    isIdentifiedArray(before) &&
    isIdentifiedArray(after) &&
    isIdentifiedArray(current)
  ) {
    return mergeIdentifiedArrays(before, after, current);
  }
  if (isPlainObject(before) && isPlainObject(after) && isPlainObject(current)) {
    const result: Record<string, Json> = { ...current };
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (VOLATILE_KEYS.has(key)) {
        continue;
      }
      result[key] = mergeRevertingAssistantEdit(
        before[key],
        after[key],
        current[key],
      );
    }
    return result;
  }
  // Both sides changed the same value: the person's later edit wins.
  return current;
}

/**
 * The draft as it stood right after `revision` was applied: the next
 * revision's pre-change snapshot, or the current draft when no later revision
 * exists.
 */
export function findDraftAfterRevision(input: {
  revision: ResumeDraftRevision;
  revisions: readonly ResumeDraftRevision[];
  currentDraft: ResumeDraft;
}): ResumeDraft | null {
  const later = input.revisions
    .filter(
      (candidate) =>
        candidate.id !== input.revision.id &&
        candidate.createdAt > input.revision.createdAt,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (later.length === 0) {
    return input.currentDraft;
  }
  return later[0]?.snapshotDraft ?? null;
}

export function buildDraftWithoutAssistantEdit(input: {
  before: ResumeDraft;
  after: ResumeDraft;
  current: ResumeDraft;
}): ResumeDraft {
  const merged = mergeRevertingAssistantEdit(
    input.before,
    input.after,
    input.current,
  ) as Record<string, Json>;
  const result: Record<string, Json> = { ...merged };
  for (const key of LIFECYCLE_KEYS) {
    result[key] = (input.current as unknown as Record<string, Json>)[key];
  }
  return result as unknown as ResumeDraft;
}
