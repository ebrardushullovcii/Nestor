import type {
  ResumeDraft,
  ResumeDraftPatch,
  ResumeDraftRevision,
  ResumeValidationIssue,
} from "@nestor/contracts";

/**
 * The text a blocked claim replaced, plus the exact user patch that puts it
 * back. Blockers can then offer a one-click undo of the wording that failed the
 * export gate instead of only offering "edit it yourself".
 */
export type ResumeValidationRestoreCandidate = {
  previousText: string;
  currentText: string;
  patch: ResumeDraftPatch;
};

type ResumeValidationTextLocation =
  | { kind: "section_text"; sectionId: string }
  | { kind: "entry_summary"; sectionId: string; entryId: string }
  | {
      kind: "section_bullet";
      sectionId: string;
      bulletId: string;
    }
  | {
      kind: "entry_bullet";
      sectionId: string;
      entryId: string;
      bulletId: string;
    };

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveLocation(
  issue: Pick<ResumeValidationIssue, "sectionId" | "entryId" | "bulletId">,
): ResumeValidationTextLocation | null {
  if (!issue.sectionId) {
    return null;
  }

  if (issue.bulletId && issue.entryId) {
    return {
      kind: "entry_bullet",
      sectionId: issue.sectionId,
      entryId: issue.entryId,
      bulletId: issue.bulletId,
    };
  }

  if (issue.bulletId) {
    return {
      kind: "section_bullet",
      sectionId: issue.sectionId,
      bulletId: issue.bulletId,
    };
  }

  if (issue.entryId) {
    return {
      kind: "entry_summary",
      sectionId: issue.sectionId,
      entryId: issue.entryId,
    };
  }

  return { kind: "section_text", sectionId: issue.sectionId };
}

function readTextAt(
  draft: ResumeDraft,
  location: ResumeValidationTextLocation,
): string | null {
  const section =
    draft.sections.find((candidate) => candidate.id === location.sectionId) ??
    null;

  if (!section) {
    return null;
  }

  if (location.kind === "section_text") {
    return section.text ?? null;
  }

  if (location.kind === "section_bullet") {
    return (
      section.bullets.find((bullet) => bullet.id === location.bulletId)?.text ??
      null
    );
  }

  const entry =
    section.entries.find((candidate) => candidate.id === location.entryId) ??
    null;

  if (!entry) {
    return null;
  }

  if (location.kind === "entry_summary") {
    return entry.summary ?? null;
  }

  return (
    entry.bullets.find((bullet) => bullet.id === location.bulletId)?.text ??
    null
  );
}

function buildRestorePatch(input: {
  draftId: string;
  location: ResumeValidationTextLocation;
  previousText: string;
}): ResumeDraftPatch {
  const base = {
    id: `restore_previous_text_${input.location.sectionId}_${input.location.kind}`,
    draftId: input.draftId,
    targetSectionId: input.location.sectionId,
    targetEntryId: null as string | null,
    anchorEntryId: null,
    targetBulletId: null as string | null,
    anchorBulletId: null,
    position: null,
    newText: input.previousText,
    newIncluded: null,
    newLocked: null,
    newBullets: null,
    appliedAt: new Date().toISOString(),
    origin: "user" as const,
    conflictReason: null,
  };

  switch (input.location.kind) {
    case "section_text":
      return { ...base, operation: "replace_section_text" };
    case "entry_summary":
      return {
        ...base,
        operation: "replace_entry_summary",
        targetEntryId: input.location.entryId,
      };
    case "section_bullet":
      return {
        ...base,
        operation: "update_bullet",
        targetBulletId: input.location.bulletId,
      };
    case "entry_bullet":
      return {
        ...base,
        operation: "update_bullet",
        targetEntryId: input.location.entryId,
        targetBulletId: input.location.bulletId,
      };
  }
}

/**
 * Finds the most recent saved text at the blocked claim's exact locator that is
 * not the flagged wording. Revisions are read newest-first, so the candidate is
 * whatever the flagged sentence replaced. Returns `null` when the locator, the
 * flagged sentence, or a differing earlier snapshot is unavailable — the
 * blocker then keeps only its edit and ask-AI actions.
 */
export function findResumeValidationRestoreCandidate(input: {
  draft: ResumeDraft;
  issue: ResumeValidationIssue;
  revisions: readonly ResumeDraftRevision[];
}): ResumeValidationRestoreCandidate | null {
  const location = resolveLocation(input.issue);

  if (!location) {
    return null;
  }

  const currentText = readTextAt(input.draft, location);

  if (!currentText?.trim()) {
    return null;
  }

  const flaggedText = input.issue.flaggedText ?? null;

  if (flaggedText && normalize(flaggedText) !== normalize(currentText)) {
    // The saved text moved on since validation ran; restoring would rewrite
    // something the user has not seen flagged.
    return null;
  }

  const orderedRevisions = [...input.revisions].sort((left, right) =>
    left.createdAt < right.createdAt
      ? 1
      : left.createdAt > right.createdAt
        ? -1
        : 0,
  );

  for (const revision of orderedRevisions) {
    const snapshot = revision.snapshotDraft;

    if (!snapshot) {
      continue;
    }

    const previousText = readTextAt(snapshot, location);

    if (!previousText?.trim()) {
      continue;
    }

    if (normalize(previousText) === normalize(currentText)) {
      continue;
    }

    return {
      previousText,
      currentText,
      patch: buildRestorePatch({
        draftId: input.draft.id,
        location,
        previousText,
      }),
    };
  }

  return null;
}
