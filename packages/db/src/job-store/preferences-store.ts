import { applySettingsResumeEffects } from "./profile-effects";
import {
  GoalFieldsSchema,
  GoalListsSchema,
  PatchGoalsInputSchema,
  GoalValuesSchema,
  SettingsFieldsSchema,
  SettingsListsSchema,
  PatchSettingsInputSchema,
  SettingsValuesSchema,
  JobSearchPreferencesSchema,
  JobFinderSettingsSchema,
  AiBehaviorPreferenceSchema,
  CoverLetterPreferenceSchema,
  ApplicationCrmSettingsSchema,
  ApplicationCrmStageDefinitionSchema,
  type JobSearchPreferences,
  type JobFinderSettings,
  type PatchGoalsInput,
  type PatchSettingsInput,
  type GoalValues,
  type SettingsValues,
  type ApplicationCrmStageDefinition,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";
import {
  createScalarValues,
  scalarSchema,
  flatten,
  flattenLists,
  inflate,
  createProfileItems,
  type ScalarTable,
} from "./profile-values";

const goalFields = Object.keys(GoalFieldsSchema.shape),
  settingFields = Object.keys(SettingsFieldsSchema.shape);
const GOALS_TABLE: ScalarTable = {
  name: "profile_goals",
  fields: goalFields,
  booleans: [],
  numbers: [
    "minimumSalaryUsd",
    "targetSalaryUsd",
    "compensation.minimum",
    "compensation.maximum",
    "weeklyHours.minimum",
    "weeklyHours.maximum",
  ],
  optional: goalFields.filter((key) => {
    const s =
      GoalFieldsSchema.shape[key as keyof typeof GoalFieldsSchema.shape];
    return s.isOptional() && !s.isNullable();
  }),
};
const SETTINGS_TABLE: ScalarTable = {
  name: "profile_settings",
  fields: settingFields,
  booleans: [
    "collapseSideMenuWithAssistant",
    "writeResumesOnShortlist",
    "humanReviewRequired",
    "allowAutoSubmitOverride",
    "keepSessionAlive",
    "discoveryOnly",
    "aiBehavior.jobSearch.remoteCountsAsAnyLocation",
    "applicationCrm.noResponseAutomation.enabled",
  ],
  numbers: ["applicationCrm.noResponseAutomation.afterDays"],
  optional: settingFields.filter((key) => {
    const s =
      SettingsFieldsSchema.shape[
        key as keyof typeof SettingsFieldsSchema.shape
      ];
    return s.isOptional() && !s.isNullable();
  }),
};
export const PREFERENCES_SCHEMA = [
  scalarSchema(GOALS_TABLE),
  scalarSchema(SETTINGS_TABLE),
  `
 CREATE TABLE IF NOT EXISTS profile_tracker_stages(id TEXT PRIMARY KEY,label TEXT NOT NULL,base_stage TEXT NOT NULL,color TEXT NOT NULL,position INTEGER NOT NULL,is_terminal INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS profile_tracker_stages_position ON profile_tracker_stages(position,id);
 `,
].join("\n");
const defaultGoals = () =>
  JobSearchPreferencesSchema.parse({
    workModes: [],
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
  });
const defaultSettings = () =>
  JobFinderSettingsSchema.parse({
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
    fontPreset: "inter_requisite",
    appearanceTheme: "system",
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    keepSessionAlive: false,
    discoveryOnly: false,
    applicationAutomationMode: "confirm_before_submit",
    salaryDisclosure: "pause_for_user",
    resumeApplicationMode: "tailored_per_job",
    collapseSideMenuWithAssistant: true,
    writeResumesOnShortlist: true,
    aiBehavior: AiBehaviorPreferenceSchema.parse({}),
    coverLetter: CoverLetterPreferenceSchema.parse({}),
    applicationCrm: ApplicationCrmSettingsSchema.parse({}),
  });
export function createPreferencesStore(store: JobStore) {
  const items = createProfileItems(store),
    goals = createScalarValues(
      store,
      GOALS_TABLE,
      flatten(defaultGoals(), goalFields),
    ),
    settings = createScalarValues(
      store,
      SETTINGS_TABLE,
      flatten(defaultSettings(), settingFields),
    );
  if (settings.created)
    store.transaction(() => {
      for (const [field, list] of Object.entries(
        flattenLists(defaultSettings(), Object.keys(SettingsListsSchema.shape)),
      ))
        items.patch("settings", "1", field, list);
    });
  const goalLists = () =>
    GoalListsSchema.parse(
      Object.fromEntries(
        Object.keys(GoalListsSchema.shape).map((field) => [
          field,
          items.values("goals", "1", field),
        ]),
      ),
    );
  const settingLists = () =>
    SettingsListsSchema.parse(
      Object.fromEntries(
        Object.keys(SettingsListsSchema.shape).map((field) => [
          field,
          items.values("settings", "1", field),
        ]),
      ),
    );
  const goalValues = (): GoalValues =>
    GoalValuesSchema.parse({ fields: goals.read(), lists: goalLists() });
  const settingValues = (): SettingsValues =>
    SettingsValuesSchema.parse({
      fields: settings.read(),
      lists: settingLists(),
    });
  const readGoals = (): JobSearchPreferences =>
    JobSearchPreferencesSchema.parse(
      inflate({ ...goals.read(), ...goalLists() }),
    );
  const stages = (): ApplicationCrmStageDefinition[] => {
    const rows = store
      .sql(
        "SELECT id,label,base_stage AS baseStage,color,position,is_terminal AS isTerminal FROM profile_tracker_stages ORDER BY position,id",
      )
      .all() as (Omit<ApplicationCrmStageDefinition, "isTerminal"> & {
      isTerminal: number;
    })[];
    return rows.map((row) => ({ ...row, isTerminal: Boolean(row.isTerminal) }));
  };
  const readSettings = (): JobFinderSettings => {
    const data = inflate({ ...settings.read(), ...settingLists() });
    return JobFinderSettingsSchema.parse({
      ...data,
      applicationCrm: {
        ...(data.applicationCrm as Record<string, unknown>),
        customStages: stages(),
      },
    });
  };
  return {
    goals: {
      created: goals.created,
      values: goalValues,
      read: readGoals,
      replace(input: JobSearchPreferences): void {
        const next = JobSearchPreferencesSchema.parse(input);
        store.transaction(() => {
          let changed = goals.patch(
            Object.fromEntries(
              Object.entries(flatten(next, goalFields)).map(([key, value]) => [
                key,
                value ?? null,
              ]),
            ),
          );
          for (const [field, values] of Object.entries(
            flattenLists(next, Object.keys(GoalListsSchema.shape)),
          ))
            changed = items.patch("goals", "1", field, values) || changed;
          readGoals();
          if (changed)
            store.notify({
              cause: "profile",
              stages: [],
              ids: [],
              searchId: null,
            });
        });
      },
      patch(input: PatchGoalsInput): GoalValues {
        const patch = PatchGoalsInputSchema.parse(input);
        return store.transaction(() => {
          let changed = goals.patch(patch.fields, patch.expected);
          for (const [field, value] of Object.entries(patch.lists))
            if (value !== undefined)
              changed =
                items.patch(
                  "goals",
                  "1",
                  field,
                  value,
                  patch.expectedLists?.[
                    field as keyof typeof patch.expectedLists
                  ],
                ) || changed;
          readGoals();
          if (changed)
            store.notify({
              cause: "profile",
              stages: [],
              ids: [],
              searchId: null,
            });
          return goalValues();
        });
      },
    },
    settings: {
      created: settings.created,
      values: settingValues,
      read: readSettings,
      replace(input: JobFinderSettings): void {
        const next = JobFinderSettingsSchema.parse({
          ...defaultSettings(),
          ...Object.fromEntries(
            Object.entries(JobFinderSettingsSchema.parse(input)).filter(
              ([, value]) => value !== undefined,
            ),
          ),
          aiBehavior: AiBehaviorPreferenceSchema.parse(input.aiBehavior ?? {}),
          coverLetter: CoverLetterPreferenceSchema.parse(
            input.coverLetter ?? {},
          ),
          applicationCrm: ApplicationCrmSettingsSchema.parse(
            input.applicationCrm ?? {},
          ),
        });
        store.transaction(() => {
          const before = settings.read([
            "resumeApplicationMode",
            "resumeFormat",
            "fontPreset",
          ]);
          let changed = settings.patch(
            Object.fromEntries(
              Object.entries(flatten(next, settingFields)).map(
                ([key, value]) => [key, value ?? null],
              ),
            ),
          );
          for (const [field, values] of Object.entries(
            flattenLists(next, Object.keys(SettingsListsSchema.shape)),
          ))
            changed = items.patch("settings", "1", field, values) || changed;
          const ids = new Set(
            (next.applicationCrm?.customStages ?? []).map((stage) => stage.id),
          );
          for (const stage of stages())
            if (!ids.has(stage.id)) this.removeStage(stage.id);
          for (const stage of next.applicationCrm?.customStages ?? [])
            this.upsertStage(stage);
          readSettings();
          if (changed)
            applySettingsResumeEffects(
              store,
              before,
              settings.read([
                "resumeApplicationMode",
                "resumeFormat",
                "fontPreset",
              ]),
            );
          if (changed)
            store.notify({
              cause: "settings",
              stages: [],
              ids: [],
              searchId: null,
            });
        });
      },
      patch(input: PatchSettingsInput): SettingsValues {
        const patch = PatchSettingsInputSchema.parse(input);
        return store.transaction(() => {
          const before = settings.read([
            "resumeApplicationMode",
            "resumeFormat",
            "fontPreset",
          ]);
          let changed = settings.patch(patch.fields, patch.expected);
          for (const [field, value] of Object.entries(patch.lists))
            if (value !== undefined)
              changed =
                items.patch(
                  "settings",
                  "1",
                  field,
                  value,
                  patch.expectedLists?.[
                    field as keyof typeof patch.expectedLists
                  ],
                ) || changed;
          readSettings();
          if (changed)
            applySettingsResumeEffects(
              store,
              before,
              settings.read([
                "resumeApplicationMode",
                "resumeFormat",
                "fontPreset",
              ]),
            );
          if (changed)
            store.notify({
              cause: "settings",
              stages: [],
              ids: [],
              searchId: null,
            });
          return settingValues();
        });
      },
      upsertStage(input: ApplicationCrmStageDefinition): void {
        const row = ApplicationCrmStageDefinitionSchema.parse(input);
        store.transaction(() => {
          const result = store
            .sql(
              `INSERT INTO profile_tracker_stages(id,label,base_stage,color,position,is_terminal) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,base_stage=excluded.base_stage,color=excluded.color,position=excluded.position,is_terminal=excluded.is_terminal WHERE label<>excluded.label OR base_stage<>excluded.base_stage OR color<>excluded.color OR position<>excluded.position OR is_terminal<>excluded.is_terminal`,
            )
            .run(
              row.id,
              row.label,
              row.baseStage,
              row.color,
              row.position,
              Number(row.isTerminal),
            );
          if (result.changes)
            store.notify({
              cause: "settings",
              stages: [],
              ids: [],
              searchId: null,
            });
        });
      },
      removeStage(id: string): boolean {
        return store.transaction(() => {
          const removed = Boolean(
            store.sql("DELETE FROM profile_tracker_stages WHERE id=?").run(id)
              .changes,
          );
          if (removed)
            store.notify({
              cause: "settings",
              stages: [],
              ids: [],
              searchId: null,
            });
          return removed;
        });
      },
    },
  };
}
export type PreferencesStore = ReturnType<typeof createPreferencesStore>;
