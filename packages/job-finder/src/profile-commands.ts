import { CandidateProfileSchema } from "@nestor/contracts";
import {
  describeResumeIdentityOwnershipChoice,
  useResumeSourceNameForProfile,
} from "./internal/resume-identity";
import type {
  PROFILE_COMMANDS,
  ProfileCommandOutputs,
  ProfileCommandName,
} from "@nestor/contracts";
import {
  createProfileStore,
  createPreferencesStore,
  type JobStore,
} from "@nestor/db/job-store";
import type { z } from "zod";
export type ProfileCommandHandlers = {
  [K in ProfileCommandName]: (
    input: z.output<(typeof PROFILE_COMMANDS)[K]["input"]>,
  ) => ProfileCommandOutputs[K];
};
/** The UI and Assistant share typed commands, independent of the workspace snapshot. */
export function createProfileCommandHandlers(
  store: JobStore,
): ProfileCommandHandlers {
  const profile = createProfileStore(store),
    preferences = createPreferencesStore(store);
  return {
    commit_profile_edits: (input) =>
      store.transaction(() => {
        if (input.profile) profile.patch(input.profile);
        if (input.goals) preferences.goals.patch(input.goals);
        for (const row of input.upsert) profile.records.upsert(row);
        for (const row of input.remove)
          profile.records.remove(row.collection, row.id);
        if (input.workPermissions)
          profile.setWorkPermissions(input.workPermissions);
        if (input.resumeIdentityChoice) {
          const current = CandidateProfileSchema.parse(profile.read());
          if (input.resumeIdentityChoice === "profile_name")
            profile.setResumeSource(
              current.baseResume,
              describeResumeIdentityOwnershipChoice(current).acknowledgement,
            );
          else {
            const next = useResumeSourceNameForProfile(current);
            profile.patch({
              fields: {
                firstName: next.firstName,
                middleName: next.middleName,
                lastName: next.lastName,
                fullName: next.fullName,
                preferredDisplayName: next.preferredDisplayName,
              },
            });
            profile.setResumeSource(current.baseResume, null);
          }
        }
        return { profile: profile.overview(), goals: preferences.goals.read() };
      }),
    set_resume_approach: ({ approach }) =>
      store.transaction(() => {
        if (approach === "original_resume")
          preferences.settings.patch({
            fields: { resumeApplicationMode: "original_resume" },
          });
        else {
          preferences.settings.patch({
            fields: { resumeApplicationMode: "tailored_per_job" },
          });
          preferences.goals.patch({ fields: { tailoringMode: approach } });
        }
        return {
          settings: preferences.settings.read(),
          goals: preferences.goals.read(),
        };
      }),
    get_profile: () => profile.overview(),
    patch_profile: (input) => profile.patch(input),
    list_profile_records: (input) => profile.records.list(input),
    get_profile_record: ({ collection, id }) =>
      profile.records.get(collection, id),
    upsert_profile_record: (input) => profile.records.upsert(input),
    remove_profile_record: ({ collection, id }) => ({
      removed: profile.records.remove(collection, id),
    }),
    set_work_permissions: ({ rows }) => {
      profile.setWorkPermissions(rows);
      return profile.overview();
    },
    get_profile_goals: () => preferences.goals.read(),
    patch_profile_goals: (input) => {
      preferences.goals.patch(input);
      return preferences.goals.read();
    },
    get_settings: () => preferences.settings.read(),
    patch_settings: (input) => {
      preferences.settings.patch(input);
      return preferences.settings.read();
    },
  };
}
