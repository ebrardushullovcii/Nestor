import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createTempRepository } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

test("older settings gain new defaults without losing saved choices", async () => {
  const temp = await createTempRepository("nestor-settings-legacy-");
  const legacyPath = temp.filePath.replace(/\.sqlite$/, ".json");
  try {
    const seed = createSeed();
    await writeFile(
      legacyPath,
      JSON.stringify({
        ...seed,
        settings: {
          resumeFormat: "pdf",
          resumeTemplateId: "classic_ats",
          fontPreset: "space_grotesk_display",
          humanReviewRequired: true,
          allowAutoSubmitOverride: false,
          keepSessionAlive: true,
        },
      }),
    );
    const repository = await temp.createRepository();
    const settings = await repository.getSettings();
    expect(settings).toMatchObject({
      appearanceTheme: "system",
      discoveryOnly: false,
      fontPreset: "space_grotesk_display",
      keepSessionAlive: true,
    });
    expect(settings.applicationAutomationMode).toBeUndefined();
    await repository.close();
    const reopened = await temp.createRepository();
    expect(await reopened.getSettings()).toEqual(settings);
    await reopened.close();
  } finally {
    await temp.cleanup();
  }
});

test("invalid legacy settings preserve valid preferences and the source JSON", async () => {
  const temp = await createTempRepository("nestor-settings-invalid-legacy-");
  const legacyPath = temp.filePath.replace(/\.sqlite$/, ".json");
  try {
    const seed = createSeed();
    const legacy = JSON.stringify({
      ...seed,
      settings: {
        ...seed.settings,
        appearanceTheme: "dark",
        keepSessionAlive: !seed.settings.keepSessionAlive,
        maxApplicationsPerLocalDay: "broken",
      },
    });
    await writeFile(legacyPath, legacy);
    const repository = await temp.createRepository();
    expect(await repository.getSettings()).toMatchObject({
      ...seed.settings,
      appearanceTheme: "dark",
      keepSessionAlive: !seed.settings.keepSessionAlive,
    });
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
    await repository.close();
  } finally {
    await temp.cleanup();
  }
});

test.each([
  "not JSON",
  JSON.stringify({ ...createSeed().settings, maxApplicationsPerLocalDay: 0 }),
])(
  "corrupt SQLite settings reject load and retain their original bytes (%s)",
  async (corrupt) => {
    const temp = await createTempRepository("nestor-settings-corrupt-");
    try {
      const repository = await temp.createRepository();
      await repository.close();
      const database = new DatabaseSync(temp.filePath);
      database
        .prepare("UPDATE singleton_state SET value = ? WHERE key = 'settings'")
        .run(corrupt);
      database.close();
      await expect(temp.createRepository()).rejects.toThrow(
        'Corrupted persisted row in table "singleton_state"',
      );
      const check = new DatabaseSync(temp.filePath);
      expect(
        check
          .prepare("SELECT value FROM singleton_state WHERE key = 'settings'")
          .get()?.value,
      ).toBe(corrupt);
      check.close();
    } finally {
      await temp.cleanup();
    }
  },
);

test("legacy repair keeps valid nested choices and disables corrupt permissions", async () => {
  const temp = await createTempRepository(
    "nestor-settings-repair-permissions-",
  );
  try {
    const seed = createSeed();
    await writeFile(
      temp.filePath.replace(/\.sqlite$/, ".json"),
      JSON.stringify({
        ...seed,
        settings: {
          ...seed.settings,
          appearanceTheme: "removed_theme",
          applicationAutomationMode: "send_whenever",
          humanReviewRequired: "no",
          allowAutoSubmitOverride: "yes",
          aiBehavior: {
            profileAssistant: {
              initiative: "proactive",
              replyStyle: "conversational",
            },
            jobSearch: {
              selectivity: "best_matches",
              remoteCountsAsAnyLocation: false,
            },
            applying: {
              coverLetterPolicy: "unknown",
              writtenAnswerLength: "full",
              preApprovedDeclarations: ["invalid_permission"],
            },
          },
          coverLetter: {
            tone: "formal",
            length: "longer_than_allowed",
            language: "German",
            sample: null,
          },
        },
      }),
    );
    const repository = await temp.createRepository();
    try {
      const recovered = await repository.getSettings();
      expect(recovered).toMatchObject({
        appearanceTheme: seed.settings.appearanceTheme,
        applicationAutomationMode: "prepare_only",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        aiBehavior: {
          profileAssistant: {
            initiative: "proactive",
            replyStyle: "conversational",
          },
          jobSearch: {
            selectivity: "best_matches",
            remoteCountsAsAnyLocation: false,
          },
          applying: {
            coverLetterPolicy: "never",
            writtenAnswerLength: "full",
            preApprovedDeclarations: [],
          },
        },
        coverLetter: {
          tone: "formal",
          length: "standard",
          language: "German",
          sample: null,
        },
      });
    } finally {
      await repository.close();
    }
  } finally {
    await temp.cleanup();
  }
});

test("unrelated legacy repair preserves valid explicit authority and partial behavior defaults", async () => {
  const temp = await createTempRepository("nestor-settings-repair-siblings-");
  try {
    const seed = createSeed();
    await writeFile(
      temp.filePath.replace(/\.sqlite$/, ".json"),
      JSON.stringify({
        ...seed,
        settings: {
          ...seed.settings,
          appearanceTheme: "removed_theme",
          applicationAutomationMode: "confirm_before_submit",
          aiBehavior: { profileAssistant: { initiative: "answer_only" } },
        },
      }),
    );
    const repository = await temp.createRepository();
    try {
      const recovered = await repository.getSettings();
      expect(recovered.applicationAutomationMode).toBe("confirm_before_submit");
      expect(recovered.aiBehavior?.profileAssistant.initiative).toBe(
        "answer_only",
      );
      expect(recovered.aiBehavior?.applying.coverLetterPolicy).toBe(
        "when_required",
      );
      expect(recovered.aiBehavior?.applying.preApprovedDeclarations).toEqual([
        "truthfulness_certification",
        "privacy_notice_acknowledgement",
        "terms_acceptance",
        "background_check_consent",
      ]);
    } finally {
      await repository.close();
    }
  } finally {
    await temp.cleanup();
  }
});

test("legacy tracker repair keeps valid stages and a disabled follow-up rule", async () => {
  const temp = await createTempRepository("nestor-settings-repair-tracker-");
  const stage = {
    id: "screen",
    label: "Screen",
    baseStage: "reviewing",
    color: "blue",
    position: 0,
    isTerminal: false,
  };
  try {
    const seed = createSeed();
    await writeFile(
      temp.filePath.replace(/\.sqlite$/, ".json"),
      JSON.stringify({
        ...seed,
        settings: {
          ...seed.settings,
          applicationCrm: {
            noResponseAutomation: { enabled: false, afterDays: 999 },
            customStages: [
              stage,
              { ...stage, id: "broken", baseStage: "old_stage" },
            ],
          },
        },
      }),
    );
    const repository = await temp.createRepository();
    try {
      expect((await repository.getSettings()).applicationCrm).toEqual({
        noResponseAutomation: { enabled: false, afterDays: 14 },
        customStages: [stage],
      });
    } finally {
      await repository.close();
    }
  } finally {
    await temp.cleanup();
  }
});
