import path from "node:path";
import { expect, test } from "vitest";
import { ProfileCopilotMessageSchema } from "@nestor/contracts";
import {
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import { readFileSync } from "node:fs";
import { openJobStore } from "./job-store";
import { createProfileStore } from "./profile-store";
import { createSavedAnswersStore } from "./applications";
import { createProfileWorkspace } from "./profile-workspace";

type Api = ReturnType<typeof createProfileWorkspace>["methods"];

/** Everything a profile write can change, read back. */
async function snapshot(api: Api) {
  return {
    profile: await api.getProfile(),
    searchPreferences: await api.getSearchPreferences(),
    profileSetupState: await api.getProfileSetupState(),
    profileCopilotMessages: await api.listProfileCopilotMessages(),
    resumeImportRuns: await api.listResumeImportRuns(),
    resumeImportDocumentBundles: await api.listResumeImportDocumentBundles(),
    resumeImportFieldCandidates: await api.listResumeImportFieldCandidates(),
  };
}

const stored = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      path.join(__dirname, "stored-json", `${name}.full.json`),
      "utf8",
    ),
  );

/** One import run with its document and a candidate, from the stored rows. */
function createResumeImportArtifactsFixture() {
  const run = ResumeImportRunSchema.parse({
    ...(stored("resume-import-run") as object),
    id: "resume_import_run_1",
  });
  return {
    run,
    documentBundles: [
      ResumeDocumentBundleSchema.parse({
        ...(stored("resume-document-bundle") as object),
        runId: run.id,
        sourceResumeId: run.sourceResumeId,
      }),
    ],
    fieldCandidates: [
      ResumeImportFieldCandidateSchema.parse({
        ...(stored("resume-import-field-candidate") as object),
        runId: run.id,
        sourceResumeId: run.sourceResumeId,
      }),
    ],
  };
}

test("a stale Assistant edit cannot overwrite a Profile edit; a failed grouped edit rolls back every field", async () => {
  const store = openJobStore(":memory:");
  try {
    const workspace = createProfileWorkspace(store),
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
    const before = await snapshot(api),
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
    expect(await snapshot(api)).toEqual(before);
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
    const workspace = createProfileWorkspace(store),
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
    const stable = await snapshot(api);
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
    expect(await snapshot(api)).toEqual(stable);
    expect(answers.get({ key: "resume_import:invalid" })).toBeNull();
  } finally {
    store.close();
  }
});
