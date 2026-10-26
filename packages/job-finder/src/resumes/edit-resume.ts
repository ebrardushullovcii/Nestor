import type { EditResumeInput, ResumeDraft } from "@nestor/contracts";
import { ResumeDraftIdentitySchema } from "@nestor/contracts";

function mergeDefined<T extends object>(
  base: T,
  fields: { [K in keyof T]?: T[K] | undefined } | undefined,
): T {
  const next = { ...base };
  for (const key of Object.keys(fields ?? {}) as Array<keyof T>) {
    const value = fields?.[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function editRows<T extends { id: string }, E extends { id: string }>(
  rows: readonly T[],
  edits: readonly E[] | undefined,
  apply: (row: T, edit: E) => T,
): T[] {
  if (!edits) return [...rows];
  for (const edit of edits)
    if (!rows.some((row) => row.id === edit.id))
      throw new Error(
        `Resume item ${edit.id} no longer exists. Read the saved resume again.`,
      );
  return rows.map((row) =>
    edits.filter((edit) => edit.id === row.id).reduce(apply, row),
  );
}

/** Narrow edits never ask the model to reproduce the rest of a resume. */
export function editResumeDraft(
  draft: ResumeDraft,
  input: EditResumeInput,
): ResumeDraft {
  return {
    ...mergeDefined(draft, input.layout),
    ...(input.identity
      ? {
          identity: ResumeDraftIdentitySchema.parse({
            ...draft.identity,
            ...input.identity,
          }),
        }
      : {}),
    sections: editRows(draft.sections, input.sections, (section, edit) => ({
      ...mergeDefined(section, edit.fields),
      bullets: editRows(section.bullets, edit.bullets, (bullet, patch) => ({
        ...mergeDefined(bullet, patch.fields),
      })),
      entries: editRows(section.entries, edit.entries, (entry, patch) => ({
        ...mergeDefined(entry, patch.fields),
        bullets: editRows(entry.bullets, patch.bullets, (bullet, change) => ({
          ...mergeDefined(bullet, change.fields),
        })),
      })),
    })),
  };
}

export function dropsResumeContent(
  before: ResumeDraft | null,
  after: ResumeDraft,
): boolean {
  if (!before) return false;
  if (before.identity && !after.identity) return true;
  return before.sections.some((section) => {
    const next = after.sections.find((row) => row.id === section.id);
    return (
      !next ||
      section.bullets.some((b) => !next.bullets.some((n) => n.id === b.id)) ||
      section.entries.some((entry) => {
        const nextEntry = next.entries.find((row) => row.id === entry.id);
        return (
          !nextEntry ||
          entry.bullets.some(
            (b) => !nextEntry.bullets.some((n) => n.id === b.id),
          )
        );
      })
    );
  });
}
