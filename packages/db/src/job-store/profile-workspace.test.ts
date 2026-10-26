import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { ProfileCopilotMessageSchema } from "@nestor/contracts";
import { createFileJobFinderRepository } from "../file-repository";
import { createSeed } from "../test-fixtures";
import { createResumeImportArtifactsFixture } from "../file-repository.test-support";
import { openJobStore } from "./job-store";
import { createProfileStore } from "./profile-store";
import { createPreferencesStore } from "./preferences-store";
import { createSavedAnswersStore } from "./applications";
import { createProfileWorkspace } from "./profile-workspace";
import { JOB_STORE_SCHEMA } from "./schema";
import { PROFILE_SCHEMA } from "./profile-store";
import { PREFERENCES_SCHEMA } from "./preferences-store";
import { PROFILE_WORKFLOW_SCHEMA } from "./profile-workspace";
import { PROFILE_IMPORT_SCHEMA } from "./profile-import-store";

test("Profile tables add to an existing job store without copying old Profile or Settings", async () => {
  const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-profile-additive-"),
    ),
    filePath = path.join(directory, "jobs.sqlite"),
    legacyPath = path.join(directory, "workspace.sqlite");
  const before = new DatabaseSync(filePath);
  const newTables = new Set([
    PROFILE_SCHEMA,
    PREFERENCES_SCHEMA,
    PROFILE_WORKFLOW_SCHEMA,
    PROFILE_IMPORT_SCHEMA,
  ]);
  for (const ddl of JOB_STORE_SCHEMA) if (!newTables.has(ddl)) before.exec(ddl);
  before.exec("PRAGMA user_version = 6");
  before.exec(`INSERT INTO jobs(id,stage,stage_at,title,company,location,found_at,seen_at,source_label,url)
    VALUES(7,'shortlisted',1,'Saved Engineer','Synthetic Employer','Berlin',1,1,'My board','https://synthetic.test/jobs/7');
    INSERT INTO job_details(job_id,description) VALUES(7,'Full saved listing');
    CREATE TABLE retained_sentinel(value TEXT); INSERT INTO retained_sentinel VALUES('existing store');`);
  before.close();
  const old = new DatabaseSync(legacyPath);
  old.exec("CREATE TABLE singleton_state(key TEXT PRIMARY KEY,value TEXT)");
  old
    .prepare("INSERT INTO singleton_state VALUES(?,?)")
    .run("profile", "old unread profile");
  old
    .prepare("INSERT INTO singleton_state VALUES(?,?)")
    .run("settings", "old unread settings");
  old.close();
  const store = openJobStore(filePath);
  const seed = createSeed();
  const repository = await createFileJobFinderRepository({
    filePath: legacyPath,
    store,
    seed,
  });
  try {
    expect(store.getJob(7)).toMatchObject({
      title: "Saved Engineer",
      description: "Full saved listing",
      stage: "shortlisted",
    });
    expect(store.sql("SELECT value FROM retained_sentinel").get()?.value).toBe(
      "existing store",
    );
    expect((await repository.getProfile()).headline).toBe(
      seed.profile.headline,
    );
    expect(await repository.getSettings()).toMatchObject(seed.settings);
    createProfileStore(store).patch({
      fields: { headline: "New imported facts" },
    });
    await repository.close();
    const reopened = await createFileJobFinderRepository({
      filePath: legacyPath,
      store,
      seed,
    });
    try {
      expect((await reopened.getProfile()).headline).toBe("New imported facts");
      expect(store.getJob(7)?.stage).toBe("shortlisted");
    } finally {
      await reopened.close();
    }
  } finally {
    await repository.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Profile and Settings commands and shared readers use one durable store", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-profile-store-"),
  );
  const store = openJobStore(path.join(directory, "jobs.sqlite"));
  const filePath = path.join(directory, "workspace.sqlite");
  let repository = await createFileJobFinderRepository({
    filePath,
    store,
    seed: createSeed(),
  });
  try {
    const profile = createProfileStore(store),
      preferences = createPreferencesStore(store);
    profile.patch({
      fields: {
        headline: "Updated from Profile",
        "workEligibility.noticePeriodDays": 14,
      },
    });
    preferences.goals.patch({ lists: { targetRoles: ["Data Analyst"] } });
    preferences.settings.patch({ fields: { appearanceTheme: "dark" } });
    expect(await repository.getProfile()).toMatchObject({
      headline: "Updated from Profile",
      workEligibility: { noticePeriodDays: 14 },
    });
    expect((await repository.getSearchPreferences()).targetRoles).toEqual([
      "Data Analyst",
    ]);
    expect((await repository.getSettings()).appearanceTheme).toBe("dark");
    await repository.commitProfileUpdate((current) => ({
      ...current,
      summary: "Updated by the Assistant",
    }));
    expect(profile.read().summary).toBe("Updated by the Assistant");
    const legacy = new DatabaseSync(filePath, { readOnly: true });
    try {
      expect(
        legacy
          .prepare(
            "SELECT key FROM singleton_state WHERE key IN ('profile','search_preferences','settings','profile_setup_state')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      legacy.close();
    }
    await repository.close();
    repository = await createFileJobFinderRepository({
      filePath,
      store,
      seed: createSeed(),
    });
    expect((await repository.getProfile()).headline).toBe(
      "Updated from Profile",
    );
    expect((await repository.getSettings()).appearanceTheme).toBe("dark");
  } finally {
    await repository.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale Assistant edit cannot overwrite a Profile edit; a failed grouped edit rolls back every field", async () => {
  const store = openJobStore(":memory:");
  try {
    const workspace = createProfileWorkspace(store, createSeed()),
      api = workspace.methods;
    const captured = await api.getProfileWithRevision();
    createProfileStore(store).patch({
      fields: { headline: "Person's current headline" },
    });
    const stale = await api.commitProfileUpdate(
      (current) => ({ ...current, headline: "Stale response" }),
      { expectedRevision: captured.revision },
    );
    expect(stale.status).toBe("stale");
    const before = workspace.state(),
      token = await api.getProfileWithRevision();
    const message = ProfileCopilotMessageSchema.parse({
      id: "message",
      role: "assistant",
      content: "Changed",
      createdAt: "2026-10-25T12:00:00.000Z",
    });
    await expect(
      api.commitProfileCopilotState({
        profile: { ...before.profile, headline: "Must roll back" },
        searchPreferences: {
          ...before.searchPreferences,
          targetRoles: ["Nurse"],
        },
        profileSetupState: before.profileSetupState,
        messages: [{ ...message, createdAt: "invalid-date" }],
        expectedProfileRevision: token.revision,
      }),
    ).rejects.toThrow();
    expect(workspace.state()).toEqual(before);
    expect(await api.getProfileWithRevision()).toEqual(token);
    await api.commitSettingsUpdate((current) => ({
      ...current,
      appearanceTheme: "dark",
    }));
    await api.commitSettingsUpdate((current) => ({
      ...current,
      applicationAutomationMode: "autonomous_submit",
    }));
    expect(await api.getSettings()).toMatchObject({
      appearanceTheme: "dark",
      applicationAutomationMode: "autonomous_submit",
    });
  } finally {
    store.close();
  }
});

test("import commits Profile, artifacts and accepted saved answers together and preserves the person's answer", async () => {
  const store = openJobStore(":memory:");
  try {
    const workspace = createProfileWorkspace(store, createSeed()),
      api = workspace.methods,
      fixture = createResumeImportArtifactsFixture();
    const before = await api.getProfileWithRevision(),
      goals = await api.getSearchPreferences();
    await api.upsertResumeImportRun(fixture.run);
    expect((await api.getProfileWithRevision()).revision).toBe(before.revision);
    const answer = {
      key: "resume_import:self_intro",
      kind: "self_intro" as const,
      prompt: "Tell us about yourself",
      answer: "Imported introduction",
    };
    const input = {
      profile: { ...before.profile, headline: "Imported headline" },
      searchPreferences: goals,
      run: fixture.run,
      documentBundles: fixture.documentBundles,
      fieldCandidates: fixture.fieldCandidates,
      savedAnswers: [answer],
      expectedProfileRevision: before.revision,
    };
    const result = await api.finalizeResumeImportRun(input);
    expect(result.status).toBe("applied");
    expect((await api.getProfile()).headline).toBe("Imported headline");
    expect(await api.getLatestResumeImportRun()).toEqual(fixture.run);
    const answers = createSavedAnswersStore(store);
    expect(answers.get({ key: answer.key })?.answer).toBe(answer.answer);
    answers.upsert({ ...answer, answer: "The person's edited introduction" });
    const nextInput: Parameters<typeof api.finalizeResumeImportRun>[0] = {
      ...input,
    };
    delete nextInput.expectedProfileRevision;
    await api.finalizeResumeImportRun(nextInput);
    expect(answers.get({ key: answer.key })?.answer).toBe(
      "The person's edited introduction",
    );
    const stable = workspace.state();
    await expect(
      api.finalizeResumeImportRun({
        ...nextInput,
        profile: { ...input.profile, headline: "Must roll back" },
        savedAnswers: [
          {
            ...answer,
            key: "resume_import:invalid",
            kind: "career_transition",
            answer: "",
          },
        ],
      }),
    ).rejects.toThrow();
    expect(workspace.state()).toEqual(stable);
    expect(answers.get({ key: "resume_import:invalid" })).toBeNull();
  } finally {
    store.close();
  }
});

test("reset advances the Profile token even when resetting to the same values", async () => {
  const store = openJobStore(":memory:");
  try {
    const seed = createSeed(),
      workspace = createProfileWorkspace(store, seed),
      before = await workspace.methods.getProfileWithRevision();
    const settings = createPreferencesStore(store).settings;
    settings.patch({
      fields: {
        appearanceTheme: "dark",
        "coverLetter.sample": "Synthetic personal sample",
      },
    });
    workspace.reset(seed);
    expect(settings.read()).toMatchObject({
      appearanceTheme: seed.settings.appearanceTheme,
      coverLetter: { sample: null },
    });
    const result = await workspace.methods.commitProfileUpdate(
      (current) => ({ ...current, headline: "Late edit" }),
      { expectedRevision: before.revision },
    );
    expect(result.status).toBe("stale");
    expect(result.revision).toBeGreaterThan(before.revision);
  } finally {
    store.close();
  }
});
