import { createProfileImportStore } from "./profile-import-store";
import {
  CandidateProfileSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ProfileSetupStateSchema,
  type ProfileCopilotMessage,
  type ProfileRevision,
} from "@nestor/contracts";
import type {
  JobFinderRepository,
  JobFinderRepositorySeed,
} from "../repository-types";
import {
  applyProfileCopilotMessagePatchFlags,
  findProfileCopilotMessageByPatchGroup,
} from "../profile-copilot-message-flags";
import { createProfileStore } from "./profile-store";
import { createPreferencesStore } from "./preferences-store";
import type { JobStore } from "./job-store";
export const PROFILE_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_setup(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,current_step TEXT NOT NULL,completed_at TEXT,last_resumed_at TEXT,reviewed_steps TEXT);
CREATE TABLE IF NOT EXISTS profile_setup_reviews(id TEXT PRIMARY KEY,position INTEGER NOT NULL,status TEXT NOT NULL,critical INTEGER NOT NULL,section TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_setup_reviews_status ON profile_setup_reviews(status,critical,position);
CREATE TABLE IF NOT EXISTS profile_messages(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,role TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_messages_created ON profile_messages(created_at,id);
CREATE TABLE IF NOT EXISTS profile_history(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,sequence INTEGER NOT NULL,trigger TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_history_created ON profile_history(created_at DESC,id);
`;
type ProfileMethods = Pick<
  JobFinderRepository,
  | "getProfile"
  | "readProfileProjection"
  | "getProfileWithRevision"
  | "saveProfile"
  | "commitProfileUpdate"
  | "getSearchPreferences"
  | "readSearchPreferencesProjection"
  | "saveSearchPreferences"
  | "saveProfileAndSearchPreferences"
  | "getSettings"
  | "saveSettings"
  | "commitSettingsUpdate"
  | "getProfileSetupState"
  | "saveProfileSetupState"
  | "commitProfileCopilotState"
  | "commitProfileCopilotPatchFlagUpdate"
  | "listProfileCopilotMessages"
  | "upsertProfileCopilotMessage"
  | "listProfileRevisions"
  | "upsertProfileRevision"
>;
/** Profile workflows share the same transaction as the fields they edit. */
export function createProfileWorkspace(
  store: JobStore,
  seed: JobFinderRepositorySeed,
) {
  const profile = createProfileStore(store),
    preferences = createPreferencesStore(store);
  const imports = createProfileImportStore(store, profile, preferences);
  const changed = () =>
    store.notify({ cause: "profile", ids: [], stages: [], searchId: null });
  const activityChanged = () =>
    store.notify({
      cause: "profile_activity",
      ids: [],
      stages: [],
      searchId: null,
    });
  const revision = () =>
    Number(
      store.sql("SELECT version FROM profile_revision WHERE id=1").get()!
        .version,
    );
  const current = () => CandidateProfileSchema.parse(profile.read());
  const messages = (): ProfileCopilotMessage[] =>
    store
      .sql("SELECT value FROM profile_messages ORDER BY created_at,id")
      .all()
      .map((row) =>
        ProfileCopilotMessageSchema.parse(JSON.parse(String(row.value))),
      );
  const history = (): ProfileRevision[] =>
    store
      .sql("SELECT value FROM profile_history ORDER BY created_at DESC,id")
      .all()
      .map((row) => ProfileRevisionSchema.parse(JSON.parse(String(row.value))));
  const setup = () => {
    const row = store.sql("SELECT * FROM profile_setup WHERE id=1").get();
    return ProfileSetupStateSchema.parse(
      row
        ? {
            status: row.status,
            currentStep: row.current_step,
            completedAt: row.completed_at,
            lastResumedAt: row.last_resumed_at,
            ...(row.reviewed_steps
              ? {
                  reviewedSteps: JSON.parse(
                    String(row.reviewed_steps),
                  ) as unknown,
                }
              : {}),
            reviewItems: store
              .sql(
                "SELECT value FROM profile_setup_reviews ORDER BY position,id",
              )
              .all()
              .map((item) => JSON.parse(String(item.value)) as unknown),
          }
        : {},
    );
  };
  const writeSetup = (input: unknown) => {
    const next = ProfileSetupStateSchema.parse(input);
    const count = store
      .sql(
        `INSERT INTO profile_setup(id,status,current_step,completed_at,last_resumed_at,reviewed_steps) VALUES(1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,current_step=excluded.current_step,completed_at=excluded.completed_at,last_resumed_at=excluded.last_resumed_at,reviewed_steps=excluded.reviewed_steps
      WHERE status IS NOT excluded.status OR current_step IS NOT excluded.current_step OR completed_at IS NOT excluded.completed_at OR last_resumed_at IS NOT excluded.last_resumed_at OR reviewed_steps IS NOT excluded.reviewed_steps`,
      )
      .run(
        next.status,
        next.currentStep,
        next.completedAt,
        next.lastResumedAt,
        next.reviewedSteps ? JSON.stringify(next.reviewedSteps) : null,
      ).changes;
    let touched = Boolean(count);
    const ids = new Set(next.reviewItems.map((item) => item.id));
    for (const row of store.sql("SELECT id FROM profile_setup_reviews").all())
      if (!ids.has(String(row.id))) {
        store
          .sql("DELETE FROM profile_setup_reviews WHERE id=?")
          .run(String(row.id));
        touched = true;
      }
    for (const [position, item] of next.reviewItems.entries()) {
      touched =
        Boolean(
          store
            .sql(
              `INSERT INTO profile_setup_reviews(id,position,status,critical,section,value) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET position=excluded.position,status=excluded.status,critical=excluded.critical,section=excluded.section,value=excluded.value WHERE value<>excluded.value OR position<>excluded.position`,
            )
            .run(
              item.id,
              position,
              item.status,
              Number(item.severity === "critical"),
              item.step,
              JSON.stringify(item),
            ).changes,
        ) || touched;
    }
    if (touched) changed();
  };
  const writeMessage = (input: ProfileCopilotMessage) => {
    const row = ProfileCopilotMessageSchema.parse(input);
    if (
      store
        .sql(
          `INSERT INTO profile_messages(id,created_at,role,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,role=excluded.role,value=excluded.value WHERE value<>excluded.value`,
        )
        .run(row.id, row.createdAt, row.role, JSON.stringify(row)).changes
    )
      activityChanged();
  };
  const writeHistory = (input: ProfileRevision) => {
    const row = ProfileRevisionSchema.parse(input);
    if (
      store
        .sql(
          `INSERT INTO profile_history(id,created_at,sequence,trigger,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,sequence=excluded.sequence,trigger=excluded.trigger,value=excluded.value WHERE value<>excluded.value`,
        )
        .run(
          row.id,
          row.createdAt,
          row.sequence,
          row.trigger,
          JSON.stringify(row),
        ).changes
    )
      activityChanged();
  };
  const reset = (input: JobFinderRepositorySeed) =>
    store.transaction(() => {
      profile.replace(input.profile);
      preferences.goals.replace(input.searchPreferences);
      preferences.settings.replace(input.settings);
      imports.reset(input);
      store.sql("DELETE FROM profile_setup_reviews").run();
      store.sql("DELETE FROM profile_messages").run();
      store.sql("DELETE FROM profile_history").run();
      writeSetup(input.profileSetupState);
      for (const row of input.profileCopilotMessages) writeMessage(row);
      for (const row of input.profileRevisions) writeHistory(row);
      changed();
    });
  store.transaction(() => {
    if (profile.created) {
      profile.replace(seed.profile);
      imports.reset(seed);
    }
    if (preferences.goals.created)
      preferences.goals.replace(seed.searchPreferences);
    if (preferences.settings.created)
      preferences.settings.replace(seed.settings);
    if (!store.sql("SELECT id FROM profile_setup WHERE id=1").get()) {
      writeSetup(seed.profileSetupState);
      for (const row of seed.profileCopilotMessages) writeMessage(row);
      for (const row of seed.profileRevisions) writeHistory(row);
    }
  });
  if (profile.created)
    store.transaction(() =>
      store.sql("UPDATE profile_revision SET version=1 WHERE id=1").run(),
    );
  const methods: ProfileMethods = {
    getProfile: () => Promise.resolve().then(() => current()),
    readProfileProjection: () => Promise.resolve().then(() => current()),
    getProfileWithRevision: () =>
      Promise.resolve().then(() => ({
        profile: current(),
        revision: revision(),
      })),
    saveProfile: (input) =>
      Promise.resolve().then(() => profile.replace(input)),
    commitProfileUpdate: (update, options) =>
      Promise.resolve().then(() =>
        store.transaction(() => {
          if (
            options?.expectedRevision !== undefined &&
            options.expectedRevision !== revision()
          )
            return {
              status: "stale" as const,
              profile: current(),
              revision: revision(),
            };
          profile.replace(update(current()));
          return {
            status: "applied" as const,
            profile: current(),
            revision: revision(),
          };
        }),
      ),
    getSearchPreferences: () =>
      Promise.resolve().then(() => preferences.goals.read()),
    readSearchPreferencesProjection: () =>
      Promise.resolve().then(() => preferences.goals.read()),
    saveSearchPreferences: (input) =>
      Promise.resolve().then(() => preferences.goals.replace(input)),
    saveProfileAndSearchPreferences: (input, goals) =>
      Promise.resolve().then(() =>
        store.transaction(() => {
          profile.replace(input);
          preferences.goals.replace(goals);
        }),
      ),
    getSettings: () =>
      Promise.resolve().then(() => preferences.settings.read()),
    saveSettings: (input) =>
      Promise.resolve().then(() => preferences.settings.replace(input)),
    commitSettingsUpdate: (update) =>
      Promise.resolve().then(() =>
        store.transaction(() => {
          preferences.settings.replace(update(preferences.settings.read()));
          return preferences.settings.read();
        }),
      ),
    getProfileSetupState: () => Promise.resolve().then(() => setup()),
    saveProfileSetupState: (input) =>
      Promise.resolve().then(() => store.transaction(() => writeSetup(input))),
    listProfileCopilotMessages: () => Promise.resolve().then(() => messages()),
    upsertProfileCopilotMessage: (input) =>
      Promise.resolve().then(() =>
        store.transaction(() => writeMessage(input)),
      ),
    listProfileRevisions: () => Promise.resolve().then(() => history()),
    upsertProfileRevision: (input) =>
      Promise.resolve().then(() =>
        store.transaction(() => writeHistory(input)),
      ),
    commitProfileCopilotState: (input) =>
      Promise.resolve().then(() =>
        store.transaction(() => {
          if (
            input.expectedProfileRevision !== undefined &&
            input.expectedProfileRevision !== revision()
          )
            return {
              status: "stale" as const,
              profile: current(),
              revision: revision(),
            };
          // Parse all incoming workflow data before changing any rows; SQLite rolls back any failure.
          profile.replace(input.profile);
          preferences.goals.replace(input.searchPreferences);
          writeSetup(input.profileSetupState);
          for (const row of input.messages ?? []) writeMessage(row);
          for (const row of input.revisions ?? []) writeHistory(row);
          for (const row of applyProfileCopilotMessagePatchFlags(
            messages(),
            input.messagePatchFlags ?? [],
          ))
            writeMessage(row);
          return {
            status: "applied" as const,
            profile: current(),
            revision: revision(),
          };
        }),
      ),
    commitProfileCopilotPatchFlagUpdate: (input) =>
      Promise.resolve().then(() =>
        store.transaction(() => {
          const rows = messages(),
            index = findProfileCopilotMessageByPatchGroup(rows, input);
          if (index < 0) return false;
          for (const row of applyProfileCopilotMessagePatchFlags(rows, [
            { ...input, messageId: rows[index]!.id },
          ]))
            writeMessage(row);
          return true;
        }),
      ),
  };
  return {
    profile,
    preferences,
    methods: { ...methods, ...imports.methods },
    reset,
    state: () => ({
      ...imports.state(),
      profile: current(),
      searchPreferences: preferences.goals.read(),
      settings: preferences.settings.read(),
      profileSetupState: setup(),
      profileCopilotMessages: messages(),
      profileRevisions: history(),
    }),
  };
}
