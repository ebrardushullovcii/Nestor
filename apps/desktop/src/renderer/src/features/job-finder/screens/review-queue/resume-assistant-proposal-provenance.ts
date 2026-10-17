import {
  getResumeEntryBulletTargetId,
  getResumeEntryFieldTargetId,
  getResumeSectionBulletTargetId,
  getResumeSectionTextTargetId,
} from "@nestor/contracts";
import type {
  ResumeClaimAssessment,
  ResumeClaimAssessmentStatus,
  ResumeClaimField,
  ResumeDraft,
  ResumeDraftBullet,
  ResumeDraftEntry,
  ResumeDraftPatch,
  ResumeDraftSection,
  ResumeDraftSourceRef,
} from "@nestor/contracts";

/**
 * Shown in every grounding disclosure so users never assume proposed wording
 * was already verified: saved validation only ever describes saved text.
 */
export const PROPOSED_WORDING_CHECK_NOTE =
  "New wording is checked after you accept and save.";

const MISSING_TARGET_LABEL = "Original target is no longer in the draft";
const SAVED_TEXT_NOT_CHECKED_LABEL = "Current saved text: Not checked yet.";

const wordingPatchOperations = new Set<ResumeDraftPatch["operation"]>([
  "replace_section_text",
  "replace_entry_summary",
  "insert_bullet",
  "update_bullet",
  "remove_bullet",
  "replace_section_bullets",
]);

const claimStatusLabels: Record<ResumeClaimAssessmentStatus, string> = {
  exact: "Exact evidence",
  paraphrase: "Paraphrased evidence",
  review: "Needs your review",
  confirm_needed: "Needs confirmation",
  unsupported: "Unsupported claim",
};

export type ProposalProvenanceTone =
  | "attention"
  | "neutral"
  | "positive"
  | "warning";

const claimStatusTones: Record<
  ResumeClaimAssessmentStatus,
  ProposalProvenanceTone
> = {
  exact: "positive",
  paraphrase: "neutral",
  review: "warning",
  confirm_needed: "warning",
  unsupported: "attention",
};

export type ResolvedProposalPatchTarget = {
  bullet: ResumeDraftBullet | null;
  bulletNumber: number | null;
  entry: ResumeDraftEntry | null;
  section: ResumeDraftSection | null;
};

export type ProposalSavedTextCheck = {
  label: string;
  tone: ProposalProvenanceTone;
};

export type ProposalProvenance = {
  savedTextCheck: ProposalSavedTextCheck | null;
  sourceRefs: readonly ResumeDraftSourceRef[];
  targetFound: boolean;
  targetLabel: string;
};

/**
 * Draft-locator shape shared by saved claim assessments and proposal patches so
 * both resolve through one target lookup.
 */
export type ResumeClaimLocator = Pick<
  ResumeClaimAssessment,
  "sectionId" | "entryId" | "bulletId"
>;

/**
 * Resolves the draft node a claim locator or patch points at. Missing links
 * degrade to `null` instead of throwing so historical rows keep rendering
 * after the draft moved on.
 */
export function findResumeClaimLocatorTarget(
  draft: ResumeDraft,
  locator: ResumeClaimLocator,
): ResolvedProposalPatchTarget {
  const section =
    draft.sections.find((candidate) => candidate.id === locator.sectionId) ??
    null;
  const entry =
    section?.entries.find((candidate) => candidate.id === locator.entryId) ??
    null;
  const bullets = entry?.bullets ?? section?.bullets ?? [];
  const bulletIndex = bullets.findIndex(
    (candidate) => candidate.id === locator.bulletId,
  );

  return {
    bullet: bulletIndex === -1 ? null : (bullets[bulletIndex] ?? null),
    bulletNumber: bulletIndex === -1 ? null : bulletIndex + 1,
    entry,
    section,
  };
}

export function findProposalPatchTarget(
  draft: ResumeDraft,
  patch: ResumeDraftPatch,
): ResolvedProposalPatchTarget {
  return findResumeClaimLocatorTarget(draft, {
    bulletId: patch.targetBulletId ?? null,
    entryId: patch.targetEntryId ?? null,
    sectionId: patch.targetSectionId,
  });
}

/**
 * The exact editor field a proposed change lands on, so "Edit this wording
 * myself" can open that field instead of leaving the user to find it. Returns
 * `null` for structural operations (ordering, include/lock) that have no single
 * text field to edit.
 */
export function getProposalPatchEditorTargetId(
  patch: ResumeDraftPatch,
): string | null {
  switch (patch.operation) {
    case "replace_section_text":
      return getResumeSectionTextTargetId(patch.targetSectionId);
    case "replace_entry_summary":
      return patch.targetEntryId
        ? getResumeEntryFieldTargetId(
            patch.targetSectionId,
            patch.targetEntryId,
            "summary",
          )
        : null;
    case "insert_bullet":
    case "update_bullet":
    case "remove_bullet":
      if (!patch.targetBulletId) {
        return null;
      }

      return patch.targetEntryId
        ? getResumeEntryBulletTargetId(
            patch.targetSectionId,
            patch.targetEntryId,
            patch.targetBulletId,
          )
        : getResumeSectionBulletTargetId(
            patch.targetSectionId,
            patch.targetBulletId,
          );
    default:
      return null;
  }
}

function humanizeFallbackLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatEntryLabel(entry: ResumeDraftEntry): string {
  return (
    entry.title ?? entry.subtitle ?? humanizeFallbackLabel(entry.entryType)
  );
}

export function formatProposalTargetLabel(input: {
  patch: ResumeDraftPatch;
  target: ResolvedProposalPatchTarget;
}): string {
  if (!input.target.section) {
    return MISSING_TARGET_LABEL;
  }

  const parts = [input.target.section.label];

  if (input.target.entry) {
    parts.push(formatEntryLabel(input.target.entry));
  }

  if (input.patch.operation === "insert_bullet") {
    parts.push("New bullet");
  } else if (input.target.bulletNumber !== null) {
    parts.push(`Bullet ${input.target.bulletNumber}`);
  }

  return parts.join(" · ");
}

/**
 * Human label for a saved claim locator ("Experience · Senior systems designer ·
 * Bullet 1"), presented with the same section/entry/bullet wording as proposal
 * provenance so both surfaces describe a location identically.
 */
export function formatResumeClaimLocatorLabel(input: {
  draft: ResumeDraft;
  locator: ResumeClaimLocator;
}): string {
  const target = findResumeClaimLocatorTarget(input.draft, input.locator);

  if (!target.section) {
    return MISSING_TARGET_LABEL;
  }

  const parts = [target.section.label];

  if (target.entry) {
    parts.push(formatEntryLabel(target.entry));
  }

  if (target.bulletNumber !== null) {
    parts.push(`Bullet ${target.bulletNumber}`);
  }

  return parts.join(" · ");
}

function resolveNearestSourceRefs(
  target: ResolvedProposalPatchTarget,
): readonly ResumeDraftSourceRef[] {
  // Fall through empty ref lists too: a bullet without its own linked evidence
  // should still surface the evidence linked to its entry or section.
  if (target.bullet?.sourceRefs.length) {
    return target.bullet.sourceRefs;
  }

  if (target.entry?.sourceRefs.length) {
    return target.entry.sourceRefs;
  }

  return target.section?.sourceRefs ?? [];
}

function resolveExpectedClaimField(
  patch: ResumeDraftPatch,
  target: ResolvedProposalPatchTarget,
): ResumeClaimField | null {
  switch (patch.operation) {
    case "replace_section_text":
      return "section_text";
    case "replace_entry_summary":
      return "entry_summary";
    case "update_bullet":
    case "remove_bullet":
      return target.entry ? "entry_bullet" : "section_bullet";
    default:
      return null;
  }
}

function resolveCurrentSavedClaimText(
  patch: ResumeDraftPatch,
  target: ResolvedProposalPatchTarget,
): string | null {
  switch (patch.operation) {
    case "replace_section_text":
      return target.section?.text ?? null;
    case "replace_entry_summary":
      return target.entry?.summary ?? null;
    case "update_bullet":
    case "remove_bullet":
      return target.bullet?.text ?? null;
    default:
      return null;
  }
}

/**
 * Finds the saved assessment that still describes the current text at this
 * exact locator. Saved validation describes the text that existed when it ran:
 * if the locator or the text drifted, there is nothing honest to show.
 */
export function findCurrentClaimAssessment(input: {
  claimAssessments: readonly ResumeClaimAssessment[];
  patch: ResumeDraftPatch;
  target: ResolvedProposalPatchTarget;
}): ResumeClaimAssessment | null {
  const field = resolveExpectedClaimField(input.patch, input.target);

  if (!field) {
    return null;
  }

  const currentSavedText = resolveCurrentSavedClaimText(
    input.patch,
    input.target,
  );

  if (currentSavedText === null) {
    return null;
  }

  const matches = input.claimAssessments.filter(
    (assessment) =>
      assessment.field === field &&
      assessment.sectionId === input.patch.targetSectionId &&
      (assessment.entryId ?? null) === (input.patch.targetEntryId ?? null) &&
      (assessment.bulletId ?? null) === (input.patch.targetBulletId ?? null) &&
      assessment.claimText === currentSavedText,
  );

  if (matches.length === 0) {
    return null;
  }

  return matches.reduce((latest, candidate) =>
    candidate.assessedAt > latest.assessedAt ? candidate : latest,
  );
}

/**
 * Pure display model for proposal-card provenance: where the edit lands, the
 * nearest linked source refs, and whether saved validation still matches the
 * current saved text. Never claims anything about proposed wording.
 */
export function resolveProposalProvenance(input: {
  claimAssessments?: readonly ResumeClaimAssessment[] | null;
  draft: ResumeDraft;
  patch: ResumeDraftPatch;
}): ProposalProvenance {
  const target = findProposalPatchTarget(input.draft, input.patch);
  const touchesProposedWording = wordingPatchOperations.has(
    input.patch.operation,
  );
  const assessment = touchesProposedWording
    ? findCurrentClaimAssessment({
        claimAssessments: input.claimAssessments ?? [],
        patch: input.patch,
        target,
      })
    : null;

  return {
    savedTextCheck: !touchesProposedWording
      ? null
      : assessment
        ? {
            label: `Current saved text: ${claimStatusLabels[assessment.status]}.`,
            tone: claimStatusTones[assessment.status],
          }
        : { label: SAVED_TEXT_NOT_CHECKED_LABEL, tone: "neutral" },
    sourceRefs: resolveNearestSourceRefs(target),
    targetFound: target.section !== null,
    targetLabel: formatProposalTargetLabel({ patch: input.patch, target }),
  };
}
