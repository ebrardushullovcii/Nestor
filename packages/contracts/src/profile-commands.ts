import { z } from "zod";
import type { AppCommandDefinition } from "./app-commands";
import { CandidateWorkEligibilitySchema } from "./profile";
import {
  ProfileRecordQuerySchema,
  ProfileRecordSchema,
  RemoveProfileRecordInputSchema,
  PatchProfileInputSchema,
  type ProfileOverview,
  type ProfileRecord,
  type ProfileRecordPage,
} from "./profile-store";
import {
  PatchGoalsInputSchema,
  PatchSettingsInputSchema,
} from "./preferences-store";
import type { JobSearchPreferences } from "./discovery";
import { ResumeApproachSchema, type JobFinderSettings } from "./workspace";

export const CommitProfileEditsInputSchema = z
  .object({
    profile: PatchProfileInputSchema.optional(),
    goals: PatchGoalsInputSchema.optional(),
    upsert: z.array(ProfileRecordSchema).max(500).default([]),
    remove: z.array(RemoveProfileRecordInputSchema).max(500).default([]),
    expectedRecords: z
      .array(
        RemoveProfileRecordInputSchema.extend({
          value: ProfileRecordSchema.nullable(),
        }),
      )
      .max(500)
      .default([]),
    expectedWorkPermissions:
      CandidateWorkEligibilitySchema.shape.limitedWorkPermissions,
    draftId: z.string().min(1).max(100).optional(),
    requireCurrentDraft: z.boolean().optional(),
    resumeIdentityChoice: z.enum(["profile_name", "resume_name"]).optional(),
    workPermissions:
      CandidateWorkEligibilitySchema.shape.limitedWorkPermissions,
  })
  .strict();
export type CommitProfileEditsInput = z.input<
  typeof CommitProfileEditsInputSchema
>;
export type ProfileEditBatch = z.output<typeof CommitProfileEditsInputSchema>;
export interface ProfileEditResult {
  profile: ProfileOverview;
  goals: JobSearchPreferences;
}
export const UpsertProfileRecordInputSchema = ProfileRecordSchema.and(
  z.object({ expected: ProfileRecordSchema.nullable().optional() }),
);
export const ProfileEditsDraftSchema = z
  .object({
    id: z.string().min(1).max(100),
    edits: CommitProfileEditsInputSchema,
  })
  .strict();
export type ProfileEditsDraft = z.output<typeof ProfileEditsDraftSchema>;
export const PROFILE_COMMANDS = {
  get_profile_draft: {
    effect: "read",
    description:
      "Reads recoverable unsaved Profile edits, including changes kept during an import conflict.",
    input: z.object({}).strict(),
  },
  put_profile_draft: {
    effect: "local_write",
    description:
      "Keeps only unsaved Profile changes for recovery without applying them to the person's facts.",
    input: ProfileEditsDraftSchema,
  },
  clear_profile_draft: {
    effect: "local_write",
    description:
      "Discards only the specified recovered Profile edit, preserving newer typing.",
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
  },
  commit_profile_edits: {
    effect: "local_write",
    description:
      "Commits only edited fields and records in one transaction. Conflicts or invalid goal ranges leave every change unapplied.",
    input: CommitProfileEditsInputSchema,
  },
  set_resume_approach: {
    effect: "local_write",
    description:
      "Saves the person's Original, Light, Tailored or Aggressive resume level atomically with the corresponding writing mode.",
    input: z.object({ approach: ResumeApproachSchema }).strict(),
  },
  get_profile: {
    effect: "read",
    description:
      "Profile fields, skills and record counts, without importing history or resume text into the screen. Work history and other records are paged with list_profile_records.",
    input: z.object({}).strict(),
  },
  patch_profile: {
    effect: "local_write",
    description:
      "Changes only supplied Profile fields or text lists. Read get_profile before planning an edit; Assistant writes compare those read values and reject concurrent changes. Work eligibility and application identity belong here; reusable application answers belong in Needs you.",
    input: PatchProfileInputSchema,
  },
  list_profile_records: {
    effect: "read",
    description:
      "One page of work history, education, certifications, projects, languages, links or proof, with a text filter and stable cursor.",
    input: ProfileRecordQuerySchema,
  },
  get_profile_record: {
    effect: "read",
    description: "One Profile record by collection and id.",
    input: RemoveProfileRecordInputSchema,
  },
  upsert_profile_record: {
    effect: "local_write",
    description:
      "Saves one work-history or background record, preserving every other row. Read get_profile_record for its id before planning the edit, including a new id; Assistant writes reject changes since that read.",
    input: UpsertProfileRecordInputSchema,
  },
  remove_profile_record: {
    effect: "local_write",
    description: "Removes only the named Profile record.",
    input: RemoveProfileRecordInputSchema,
  },
  set_work_permissions: {
    effect: "local_write",
    description:
      "Saves the person's limited work permissions and explicit sponsorship conditions. Does not infer work authorization.",
    input: z
      .object({
        rows: CandidateWorkEligibilitySchema.shape.limitedWorkPermissions.unwrap(),
      })
      .strict(),
  },
  get_profile_goals: {
    effect: "read",
    description:
      "The person's saved role, location, work mode, hours, compensation and resume level preferences. Job sites are read separately.",
    input: z.object({}).strict(),
  },
  patch_profile_goals: {
    effect: "local_write",
    description:
      "Changes only supplied goal fields or lists. Read get_profile_goals before planning an edit; Assistant writes reject changes since that read. Does not save Profile, Settings or job sites.",
    input: PatchGoalsInputSchema,
  },
  get_settings: {
    effect: "read",
    description:
      "The person's saved appearance, AI, writing, browser and Apply settings.",
    input: z.object({}).strict(),
  },
  patch_settings: {
    effect: "local_write",
    description:
      "Changes only supplied Settings fields or declaration choices. Does not overwrite untouched settings or Profile.",
    input: PatchSettingsInputSchema,
  },
} as const satisfies Record<string, AppCommandDefinition>;
export type ProfileCommandName = keyof typeof PROFILE_COMMANDS;
export interface ProfileCommandOutputs {
  get_profile_draft: ProfileEditsDraft | null;
  put_profile_draft: { saved: true };
  clear_profile_draft: { removed: boolean };
  commit_profile_edits: ProfileEditResult;
  set_resume_approach: {
    settings: JobFinderSettings;
    goals: JobSearchPreferences;
  };
  get_profile: ProfileOverview;
  patch_profile: ProfileOverview;
  list_profile_records: ProfileRecordPage;
  get_profile_record: ProfileRecord | null;
  upsert_profile_record: ProfileRecord;
  remove_profile_record: { removed: boolean };
  set_work_permissions: ProfileOverview;
  get_profile_goals: JobSearchPreferences;
  patch_profile_goals: JobSearchPreferences;
  get_settings: JobFinderSettings;
  patch_settings: JobFinderSettings;
}
