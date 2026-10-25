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
    workspace.reset(seed);
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
