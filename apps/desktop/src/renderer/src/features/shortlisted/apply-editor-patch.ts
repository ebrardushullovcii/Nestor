import type {
  ResumeDraft,
  ResumeDraftBullet,
  ResumeDraftPatch,
  ResumeDraftSection,
} from "@nestor/contracts";

type Bulleted = { bullets: ResumeDraftBullet[] };

function move<T extends { id: string }>(
  items: readonly T[],
  id: string,
  anchorId: string | null,
  position: "before" | "after" | null,
): T[] {
  const moving = items.find((item) => item.id === id);
  if (!moving) return [...items];
  const rest = items.filter((item) => item.id !== id);
  if (!anchorId) return [...rest, moving];
  const anchor = rest.findIndex((item) => item.id === anchorId);
  if (anchor < 0) return [...items];
  rest.splice(position === "before" ? anchor : anchor + 1, 0, moving);
  return rest;
}

function patchBullets<T extends Bulleted>(
  owner: T,
  patch: ResumeDraftPatch,
): T {
  const id = patch.targetBulletId;
  if (!id) return owner;
  switch (patch.operation) {
    case "toggle_include":
      return {
        ...owner,
        bullets: owner.bullets.map((bullet) =>
          bullet.id === id
            ? { ...bullet, included: patch.newIncluded ?? !bullet.included }
            : bullet,
        ),
      };
    case "set_lock":
      return {
        ...owner,
        bullets: owner.bullets.map((bullet) =>
          bullet.id === id
            ? { ...bullet, locked: patch.newLocked ?? !bullet.locked }
            : bullet,
        ),
      };
    case "move_bullet":
      return {
        ...owner,
        bullets: move(owner.bullets, id, patch.anchorBulletId, patch.position),
      };
    default:
      return owner;
  }
}

function patchSection(
  section: ResumeDraftSection,
  patch: ResumeDraftPatch,
): ResumeDraftSection {
  if (patch.targetBulletId) {
    return patch.targetEntryId
      ? {
          ...section,
          entries: section.entries.map((entry) =>
            entry.id === patch.targetEntryId
              ? patchBullets(entry, patch)
              : entry,
          ),
        }
      : patchBullets(section, patch);
  }
  const entryId = patch.targetEntryId;
  switch (patch.operation) {
    case "toggle_include": {
      if (!entryId) {
        return { ...section, included: patch.newIncluded ?? !section.included };
      }
      const entry = section.entries.find((item) => item.id === entryId);
      const included = patch.newIncluded ?? !entry?.included;
      return {
        ...section,
        // Showing a role shows its section too.
        included: included ? true : section.included,
        entries: section.entries.map((item) =>
          item.id === entryId ? { ...item, included } : item,
        ),
      };
    }
    case "set_lock":
      return entryId
        ? {
            ...section,
            entries: section.entries.map((item) =>
              item.id === entryId
                ? { ...item, locked: patch.newLocked ?? !item.locked }
                : item,
            ),
          }
        : { ...section, locked: patch.newLocked ?? !section.locked };
    case "move_entry":
      return entryId
        ? {
            ...section,
            entryOrderMode: "manual",
            entries: move(
              section.entries,
              entryId,
              patch.anchorEntryId,
              patch.position,
            ),
          }
        : section;
    case "reset_entry_order":
      // Saving puts chronology-ordered entries back in date order.
      return { ...section, entryOrderMode: "chronology" };
    default:
      return section;
  }
}

/** The editor's Hide, Lock and move buttons, applied to the draft in place. */
export function applyEditorPatch(
  draft: ResumeDraft,
  patch: ResumeDraftPatch,
): ResumeDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.id === patch.targetSectionId
        ? patchSection(section, patch)
        : section,
    ),
  };
}
