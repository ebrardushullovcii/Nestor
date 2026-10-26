import {
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileCopilotPatchGroupSchema,
  type AssistantChangeEntry,
  type AssistantChangeTarget,
  type CandidateProfile,
  type JobFinderSettings,
  type JobSearchPreferences,
  type ProfileCopilotPatchOperation,
  type ResumeApplicationMode,
} from "@nestor/contracts";

import { diffValues, undoChangeEntries } from "../assistant/change-diff";
import { commitProfileCopilotStateWithStaleRetry } from "./profile-commit-stale-conflict";
import { createUniqueId } from "./shared";
import type { ProfileContext } from "./profile-context";
import {
  buildProfileRevision,
  nextProfileRevisionSequence,
  type AppliedProfilePatchGroup,
} from "./workspace-profile-copilot-methods";

/**
 * The shared assistant-edit operation (ADR 0037).
 *
 * Profile, search preferences and settings are changed with
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

export function createWorkspaceAssistantEditMethods(input: {
  ctx: ProfileContext;
  applyAssistantProfilePatchGroup: (
    patchGroup: ReturnType<typeof ProfileCopilotPatchGroupSchema.parse>,
    attribution: { messageId: string | null; reason: string },
  ) => Promise<AppliedProfilePatchGroup>;
  commitResumeApplicationMode: (mode: ResumeApplicationMode) => Promise<void>;
  saveSettings: (settings: JobFinderSettings) => Promise<unknown>;
}) {
  const { ctx } = input;

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
    const approvedBefore = ctx.approvedResumeJobIds?.() ?? [];
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
    // The job store sends a resume back for review in the same write that
    // changes a fact it was built on.
    const approvedAfter = new Set(ctx.approvedResumeJobIds?.() ?? []);
    const invalidatedApprovedResumeJobIds = approvedBefore.filter(
      (jobId) => !approvedAfter.has(jobId),
    );
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

  return {
    applyAssistantProfileOperations,
    undoAssistantProfileChange,
    undoAssistantSettingsChange,
  };
}

export type WorkspaceAssistantEditMethods = ReturnType<
  typeof createWorkspaceAssistantEditMethods
>;
