import {
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileCopilotPatchGroupSchema,
  ResumeDraftSchema,
  type AssistantChangeEntry,
  type AssistantChangeTarget,
  type CandidateProfile,
  type JobFinderSettings,
  type JobSearchPreferences,
  type ProfileCopilotPatchOperation,
  type ResumeApplicationMode,
  type ResumeDraft,
} from "@nestor/contracts";

import { diffValues, undoChangeEntries } from "../assistant/change-diff";
import { commitProfileCopilotStateWithStaleRetry } from "./profile-commit-stale-conflict";
import {
  createMonotonicTimestamp,
  preserveWorkHistoryReviewGuidance,
} from "./resume-draft-commit-support";
import {
  buildResumeDraftRevision,
  buildResumeDraftStateHash,
  buildTailoredAssetBridge,
  validateResumeDraft,
} from "./resume-workspace-helpers";
import { hasResumeAffectingProfileChange } from "./resume-workspace-staleness";
import { createUniqueId } from "./shared";
import {
  ensureResumeDraft,
  sanitizeAndCheckResumeDraft,
} from "./workspace-application-resume-support";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import {
  buildProfileRevision,
  nextProfileRevisionSequence,
  type AppliedProfilePatchGroup,
} from "./workspace-profile-copilot-methods";

/**
 * The shared assistant-edit operation (ADR 0037).
 *
 * Profile, search preferences, settings and resume drafts are changed with
 * an expected starting state, the typed changes, validation and history
 * attribution, and committed atomically. Each commit returns the exact values
 * it touched so the assistant can keep an undo receipt; undo applies the
 * inverse only where the value is still what the change produced.
 */

export interface AssistantEditChange {
  target: AssistantChangeTarget;
  targetId: string | null;
  entries: AssistantChangeEntry[];
}

export interface AssistantEditResult {
  changes: AssistantEditChange[];
}

export interface AssistantProfileEditResult extends AssistantEditResult {
  invalidatedApprovedResumeJobIds: string[];
}

export interface AssistantUndoResult {
  undoneLabels: string[];
  conflictLabels: string[];
}

export class AssistantEditConflictError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "stale_revision"
      | "original_resume"
      | "no_change"
      | "not_kept",
  ) {
    super(message);
    this.name = "AssistantEditConflictError";
  }
}

const RESUME_IGNORED_KEYS = ["updatedAt", "lastGeneratedContentHash"] as const;

/** Every visible text in a draft, keyed by where it sits. */
function resumeTextsByPlace(draft: ResumeDraft): Map<string, string> {
  const texts = new Map<string, string>();
  const put = (key: string, value: string | null | undefined) => {
    const text = value?.replace(/\s+/gu, " ").trim();
    if (text) texts.set(key, text);
  };
  for (const section of draft.sections) {
    put(`section:${section.id}`, section.text);
    for (const bullet of section.bullets)
      put(`bullet:${bullet.id}`, bullet.text);
    for (const entry of section.entries) {
      put(`entry:${entry.id}`, entry.summary);
      for (const bullet of entry.bullets)
        put(`bullet:${bullet.id}`, bullet.text);
    }
  }
  return texts;
}

/**
 * Texts the assistant wrote that the resume checker replaced or removed
 * while saving (for example a summary line with no saved evidence, which
 * falls back to the profile summary). Reporting such an edit as saved would
 * be false, so the caller refuses it instead.
 */
export function findResumeTextsNotKept(input: {
  before: ResumeDraft;
  requested: ResumeDraft;
  saved: ResumeDraft;
}): string[] {
  const before = resumeTextsByPlace(input.before);
  const requested = resumeTextsByPlace(input.requested);
  const saved = resumeTextsByPlace(input.saved);
  const dropped: string[] = [];
  for (const [place, text] of requested) {
    if (before.get(place) === text) continue;
    if (saved.get(place) !== text) dropped.push(text);
  }
  return dropped;
}

const PROFILE_LABELS: Record<string, string> = {
  headline: "Headline",
  summary: "Summary",
  fullSummary: "Summary",
  targetRoles: "Target roles",
  locations: "Locations",
  skills: "Skills",
  experiences: "Work history",
  education: "Education",
  certifications: "Certifications",
  projects: "Projects",
  links: "Links",
  spokenLanguages: "Languages",
  yearsExperience: "Years of experience",
  currentLocation: "Current location",
  workModes: "Work modes",
  excludedLocations: "Excluded locations",
  tailoringMode: "Resume level",
  compensation: "Pay",
  workEligibility: "Work eligibility",
  proofBank: "Proof points",
};

function labelFromPath(
  path: readonly string[],
  value: { before: unknown; after: unknown },
): string | null {
  const keys = path.filter((segment) => !segment.startsWith("#"));
  const top = keys[0];
  if (!top) return null;
  const base = PROFILE_LABELS[top] ?? null;
  const record = [value.before, value.after].find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  const recordName =
    record &&
    [
      record.title,
      record.companyName,
      record.schoolName,
      record.name,
      record.label,
    ].find(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
  const field = keys.length > 1 ? keys.at(-1) : null;
  const humanField = field
    ? field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
    : null;
  if (base && recordName) return `${base}: ${recordName}`;
  if (base && humanField && humanField !== top.toLowerCase()) {
    return `${base} (${humanField})`;
  }
  return base;
}

type ResumeProjection = Pick<
  ResumeDraft,
  "templateId" | "targetPageCount" | "identity" | "sections"
>;

function projectResume(draft: ResumeDraft): ResumeProjection {
  return {
    templateId: draft.templateId,
    targetPageCount: draft.targetPageCount,
    identity: draft.identity,
    sections: draft.sections,
  };
}

export function createWorkspaceAssistantEditMethods(input: {
  ctx: WorkspaceServiceContext;
  applyAssistantProfilePatchGroup: (
    patchGroup: ReturnType<typeof ProfileCopilotPatchGroupSchema.parse>,
    attribution: { messageId: string | null; reason: string },
  ) => Promise<AppliedProfilePatchGroup>;
  commitResumeApplicationMode: (mode: ResumeApplicationMode) => Promise<void>;
  saveSettings: (settings: JobFinderSettings) => Promise<unknown>;
}) {
  const { ctx } = input;

  function withDraftTransition<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return ctx.withResumeDraftTransition
      ? ctx.withResumeDraftTransition(jobId, operation)
      : operation();
  }

  async function applyAssistantProfileOperations(request: {
    operations: readonly ProfileCopilotPatchOperation[];
    summary: string;
    messageId: string | null;
  }): Promise<AssistantProfileEditResult> {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: createUniqueId("assistant_patch_group"),
      summary: request.summary,
      applyMode: "applied",
      operations: request.operations,
      createdAt: new Date().toISOString(),
    });
    const approvedDraftsBefore = (
      await ctx.repository.listResumeDrafts()
    ).filter((draft) => draft.status === "approved");
    const applied = await input.applyAssistantProfilePatchGroup(patchGroup, {
      messageId: request.messageId,
      reason: `Assistant change: ${request.summary}`,
    });
    const changes: AssistantEditChange[] = [];
    const profileEntries = diffValues(
      applied.profileBefore,
      applied.profileAfter,
      { labelFor: labelFromPath },
    );
    if (profileEntries.length > 0) {
      changes.push({
        target: "profile",
        targetId: null,
        entries: profileEntries,
      });
    }
    const preferenceEntries = diffValues(
      applied.searchPreferencesBefore,
      applied.searchPreferencesAfter,
      { labelFor: labelFromPath },
    );
    if (preferenceEntries.length > 0) {
      changes.push({
        target: "search_preferences",
        targetId: null,
        entries: preferenceEntries,
      });
    }
    if (
      applied.resumeApplicationMode &&
      applied.resumeApplicationMode.before !==
        applied.resumeApplicationMode.after
    ) {
      changes.push({
        target: "settings",
        targetId: null,
        entries: [
          {
            path: ["resumeApplicationMode"],
            kind: "set",
            ...(applied.resumeApplicationMode.before === null
              ? {}
              : { before: applied.resumeApplicationMode.before }),
            after: applied.resumeApplicationMode.after,
            index: null,
            label: "Resume level",
          },
        ],
      });
    }
    let invalidatedApprovedResumeJobIds: string[] = [];
    if (
      approvedDraftsBefore.length > 0 &&
      hasResumeAffectingProfileChange(
        applied.profileBefore,
        applied.profileAfter,
      )
    ) {
      const draftsAfter = new Map(
        (await ctx.repository.listResumeDrafts()).map((draft) => [
          draft.id,
          draft,
        ]),
      );
      invalidatedApprovedResumeJobIds = approvedDraftsBefore.flatMap((draft) =>
        draftsAfter.get(draft.id)?.status === "stale" ? [draft.jobId] : [],
      );
    }
    return { changes, invalidatedApprovedResumeJobIds };
  }

  /**
   * Undoes exactly one assistant change to the profile and preferences,
   * keeping every later edit. Returns the labels undone and those that
   * changed again since.
   */
  async function undoAssistantProfileChange(request: {
    profileEntries: readonly AssistantChangeEntry[];
    searchPreferencesEntries: readonly AssistantChangeEntry[];
    reason: string;
  }): Promise<AssistantUndoResult> {
    let result: AssistantUndoResult = { undoneLabels: [], conflictLabels: [] };
    let profileBefore: CandidateProfile | null = null;
    let profileAfter: CandidateProfile | null = null;
    await commitProfileCopilotStateWithStaleRetry(ctx.repository, async () => {
      const [captured, searchPreferences, profileSetupState, revisions] =
        await Promise.all([
          ctx.repository.getProfileWithRevision(),
          ctx.repository.getSearchPreferences(),
          ctx.repository.getProfileSetupState(),
          ctx.repository.listProfileRevisions(),
        ]);
      const profileUndo = undoChangeEntries(
        captured.profile,
        request.profileEntries,
      );
      const preferencesUndo = undoChangeEntries(
        searchPreferences,
        request.searchPreferencesEntries,
      );
      const nextProfile = CandidateProfileSchema.parse(profileUndo.next);
      const nextPreferences: JobSearchPreferences =
        JobSearchPreferencesSchema.parse(preferencesUndo.next);
      profileBefore = captured.profile;
      profileAfter = nextProfile;
      result = {
        undoneLabels: [...profileUndo.undone, ...preferencesUndo.undone].map(
          (entry) => entry.label ?? entry.path.join("."),
        ),
        conflictLabels: [
          ...profileUndo.conflicts,
          ...preferencesUndo.conflicts,
        ].map((entry) => entry.label ?? entry.path.join(".")),
      };
      return {
        profile: nextProfile,
        searchPreferences: nextPreferences,
        profileSetupState,
        revisions: [
          buildProfileRevision({
            trigger: "undo",
            profile: captured.profile,
            searchPreferences,
            profileSetupState,
            profileAfter: nextProfile,
            searchPreferencesAfter: nextPreferences,
            sequence: nextProfileRevisionSequence(revisions),
            reason: request.reason,
          }),
        ],
        expectedProfileRevision: captured.revision,
      };
    });
    if (
      profileBefore &&
      profileAfter &&
      hasResumeAffectingProfileChange(profileBefore, profileAfter)
    ) {
      await ctx.staleApprovedResumeDrafts(
        "Profile details changed after approval and the resume needs a fresh review.",
      );
    }
    return result;
  }

  /** Undoes one assistant change to Settings; later edits are kept. */
  async function undoAssistantSettingsChange(request: {
    entries: readonly AssistantChangeEntry[];
  }): Promise<AssistantUndoResult> {
    const current = JobFinderSettingsSchema.parse(
      await ctx.repository.getSettings(),
    );
    const modeEntries = request.entries.filter(
      (entry) =>
        entry.path.length === 1 && entry.path[0] === "resumeApplicationMode",
    );
    const otherEntries = request.entries.filter(
      (entry) => !modeEntries.includes(entry),
    );
    const undo = undoChangeEntries(current, otherEntries);
    const modeUndo = undoChangeEntries(current, modeEntries);
    if (undo.undone.length > 0) {
      await input.saveSettings(JobFinderSettingsSchema.parse(undo.next));
    }
    if (modeUndo.undone.length > 0) {
      const restored = modeUndo.next.resumeApplicationMode;
      await input.commitResumeApplicationMode(restored ?? "tailored_per_job");
    }
    return {
      undoneLabels: [...undo.undone, ...modeUndo.undone].map(
        (entry) => entry.label ?? entry.path.join("."),
      ),
      conflictLabels: [...undo.conflicts, ...modeUndo.conflicts].map(
        (entry) => entry.label ?? entry.path.join("."),
      ),
    };
  }

  async function commitResumeDraft(request: {
    jobId: string;
    before: ResumeDraft;
    next: ResumeDraft;
    actor: "assistant" | "restore";
    mutationKind: "assistant_patch" | "restore";
    reason: string;
  }): Promise<ResumeDraft | null> {
    const state = await ensureResumeDraft(ctx, request.jobId);
    const sanitized = await sanitizeAndCheckResumeDraft(ctx, {
      draft: request.next,
      job: state.job,
      profile: state.profile,
    });
    if (request.actor === "assistant") {
      const notKept = findResumeTextsNotKept({
        before: request.before,
        requested: request.next,
        saved: sanitized,
      });
      if (notKept.length > 0) {
        throw new AssistantEditConflictError(
          `Nothing was saved: the resume checker would not keep ${notKept
            .slice(0, 3)
            .map((text) => `"${text.slice(0, 160)}"`)
            .join(
              ", ",
            )} (resume text drops first-person wording like "I" or "my", filler phrases, and claims the saved profile does not back). Reword it in the resume's neutral voice from the profile's facts, or add the fact to the profile first.`,
          "not_kept",
        );
      }
    }
    if (
      buildResumeDraftStateHash(sanitized) ===
      buildResumeDraftStateHash(request.before)
    ) {
      return null;
    }
    const validation = validateResumeDraft({
      draft: sanitized,
      job: state.job,
      profile: state.profile,
      validatedAt: sanitized.updatedAt,
    });
    const previousValidation =
      (
        await ctx.repository.listResumeValidationResults(request.before.id)
      )[0] ?? null;
    const revisions = await ctx.repository.listResumeDraftRevisions(
      request.before.id,
    );
    await ctx.repository.applyResumePatchWithRevision({
      expectedDraftUpdatedAt: request.before.updatedAt,
      draft: sanitized,
      revision: buildResumeDraftRevision({
        draft: request.before,
        resultingDraft: sanitized,
        createdAt: sanitized.updatedAt,
        parentRevisionId: revisions[0]?.id ?? null,
        actor: request.actor,
        mutationKind: request.mutationKind,
        reason: request.reason,
      }),
      validation: preserveWorkHistoryReviewGuidance({
        validation,
        previousValidation,
        draft: sanitized,
      }),
      tailoredAsset: buildTailoredAssetBridge({
        draft: sanitized,
        job: state.job,
        profile: state.profile,
        existingAsset: state.tailoredAsset,
        clearStoragePath: true,
        templates: state.templates,
      }),
    });
    return sanitized;
  }

  async function undoAssistantResumeChange(request: {
    jobId: string;
    entries: readonly AssistantChangeEntry[];
    reason: string;
  }): Promise<AssistantUndoResult> {
    return withDraftTransition(request.jobId, async () => {
      const state = await ensureResumeDraft(ctx, request.jobId);
      const undo = undoChangeEntries(
        projectResume(state.draft),
        request.entries,
        {
          ignoreKeys: RESUME_IGNORED_KEYS,
        },
      );
      const result: AssistantUndoResult = {
        undoneLabels: undo.undone.map(
          (entry) => entry.label ?? entry.path.join("."),
        ),
        conflictLabels: undo.conflicts.map(
          (entry) => entry.label ?? entry.path.join("."),
        ),
      };
      if (undo.undone.length === 0) return result;
      const updatedAt = createMonotonicTimestamp(state.draft.updatedAt);
      await commitResumeDraft({
        jobId: request.jobId,
        before: state.draft,
        next: ResumeDraftSchema.parse({
          ...state.draft,
          ...undo.next,
          status: "needs_review",
          approvedAt: null,
          approvedExportId: null,
          staleReason:
            "An assistant change was undone and the resume needs a fresh review.",
          updatedAt,
        }),
        actor: "restore",
        mutationKind: "restore",
        reason: request.reason,
      });
      return result;
    });
  }

  return {
    applyAssistantProfileOperations,
    undoAssistantProfileChange,
    undoAssistantSettingsChange,
    undoAssistantResumeChange,
  };
}

export type WorkspaceAssistantEditMethods = ReturnType<
  typeof createWorkspaceAssistantEditMethods
>;
