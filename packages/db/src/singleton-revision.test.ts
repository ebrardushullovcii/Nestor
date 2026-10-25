import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CandidateProfile } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import { cleanupTempDirectoryWithRetry } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

async function expectSingletonRevisionParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    const seed = createSeed();
    const initial = await repository.getProfileWithRevision();
    expect(initial.revision).toBe(1);
    expect(initial.profile).toEqual(seed.profile);
    expect(await repository.getProfile()).toEqual(initial.profile);

    const applied = await repository.commitProfileUpdate((current) => ({
      ...current,
      headline: "Applied headline",
    }));
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") {
      throw new Error("Expected applied outcome.");
    }
    expect(applied.profile.headline).toBe("Applied headline");
    expect(applied.revision).toBe(initial.revision + 1);
    expect(await repository.getProfileWithRevision()).toEqual({
      profile: applied.profile,
      revision: applied.revision,
    });

    await repository.saveProfile({
      ...applied.profile,
      fullName: "Concurrent Editor",
    });
    expect((await repository.getProfileWithRevision()).revision).toBe(
      applied.revision + 1,
    );

    const captured = await repository.getProfileWithRevision();
    await repository.saveProfile({
      ...captured.profile,
      answerBank: {
        ...captured.profile.answerBank,
        customAnswers: [
          {
            id: "answer_1",
            kind: "other",
            label: "Notice period",
            question: "What is your notice period?",
            answer: "Two weeks",
            roleFamilies: [],
            proofEntryIds: [],
          },
        ],
      },
    });

    const stale = await repository.commitProfileUpdate(
      (current) => ({
        ...current,
        headline: "Stale overwrite attempt",
      }),
      { expectedRevision: captured.revision },
    );
    expect(stale.status).toBe("stale");
    if (stale.status !== "stale") {
      throw new Error("Expected stale outcome.");
    }
    expect(stale.revision).toBe(captured.revision + 1);
    expect(stale.profile.answerBank.customAnswers).toHaveLength(1);
    expect(stale.profile.headline).toBe("Applied headline");

    const persistedAfterStale = await repository.getProfileWithRevision();
    expect(persistedAfterStale.revision).toBe(captured.revision + 1);
    expect(persistedAfterStale.profile.headline).toBe("Applied headline");
    expect(persistedAfterStale.profile.answerBank.customAnswers).toHaveLength(
      1,
    );

    await expect(
      repository.commitProfileUpdate(() => {
        throw new Error("updater failed");
      }),
    ).rejects.toThrow("updater failed");
    const afterThrow = await repository.getProfileWithRevision();
    expect(afterThrow.revision).toBe(captured.revision + 1);
    expect(afterThrow.profile).toEqual(persistedAfterStale.profile);

    await expect(
      repository.commitProfileUpdate(
        (current) =>
          ({ ...current, yearsExperience: -1 }) as unknown as CandidateProfile,
      ),
    ).rejects.toThrow();
    const afterInvalid = await repository.getProfileWithRevision();
    expect(afterInvalid.revision).toBe(captured.revision + 1);
    expect(afterInvalid.profile).toEqual(persistedAfterStale.profile);

    const loserCapture = await repository.getProfileWithRevision();
    const winner = await repository.commitProfileUpdate((current) => ({
      ...current,
      summary: "Winner summary",
    }));
    expect(winner.status).toBe("applied");
    const loser = await repository.commitProfileUpdate(
      (current) => ({
        ...current,
        summary: "Loser summary",
      }),
      { expectedRevision: loserCapture.revision },
    );
    expect(loser.status).toBe("stale");
    if (loser.status !== "stale") {
      throw new Error("Expected stale outcome.");
    }
    expect(loser.profile.summary).toBe("Winner summary");
    expect((await repository.getProfile()).summary).toBe("Winner summary");
  } finally {
    await repository.close();
  }
}

/**
 * The profile revision is the compare-and-swap epoch shared by the profile,
 * search-preferences and profile-setup-state singletons. Both backends must
 * keep it monotonic across a reset: rewinding it to 1 makes a token captured
 * before the reset satisfy the equality check afterwards (a classic ABA hole).
 */
async function expectResetEpochParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    await repository.commitProfileUpdate((current) => ({
      ...current,
      headline: "Changed",
    }));
    await repository.commitProfileUpdate((current) => ({
      ...current,
      summary: "Changed again",
    }));
    const beforeReset = await repository.getProfileWithRevision();
    expect(beforeReset.revision).toBe(3);

    await repository.reset(createSeed());

    const afterReset = await repository.getProfileWithRevision();
    expect(afterReset.revision).toBeGreaterThan(beforeReset.revision);
    expect(afterReset.profile).toEqual(createSeed().profile);

    await repository.reset(createSeed());
    expect(
      (await repository.getProfileWithRevision()).revision,
    ).toBeGreaterThan(afterReset.revision);
  } finally {
    await repository.close();
  }
}

/**
 * The bootstrap epoch is 1, so a reset that rewinds to 1 lets renderer work
 * queued against the pre-reset workspace overwrite the freshly seeded one —
 * and `commitProfileCopilotState` writes search preferences and profile setup
 * state unconditionally once its compare-and-swap passes, so those are
 * clobbered too.
 */
async function expectPreResetTokenRejected(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const seed = createSeed();
  const repository = await createRepository();
  try {
    const captured = await repository.getProfileWithRevision();
    expect(captured.revision).toBe(1);

    await repository.reset(createSeed());

    const staleUpdate = await repository.commitProfileUpdate(
      (current) => ({ ...current, headline: "Pre-reset overwrite" }),
      { expectedRevision: captured.revision },
    );
    expect(staleUpdate.status).toBe("stale");
    expect((await repository.getProfile()).headline).toBe(
      seed.profile.headline,
    );

    await repository.reset(createSeed());
    const seededPreferences = await repository.getSearchPreferences();

    const staleCopilot = await repository.commitProfileCopilotState({
      profile: { ...captured.profile, headline: "Pre-reset copilot overwrite" },
      searchPreferences: {
        ...seed.searchPreferences,
        targetRoles: ["Pre-reset role"],
      },
      profileSetupState: seed.profileSetupState,
      messages: [],
      revisions: [],
      expectedProfileRevision: captured.revision,
    });
    expect(staleCopilot.status).toBe("stale");
    expect((await repository.getProfile()).headline).toBe(
      seed.profile.headline,
    );
    expect(await repository.getSearchPreferences()).toEqual(seededPreferences);
    expect((await repository.getSearchPreferences()).targetRoles).not.toContain(
      "Pre-reset role",
    );
    expect(await repository.listProfileCopilotMessages()).toHaveLength(0);
  } finally {
    await repository.close();
  }
}

describe("singleton profile revisions", () => {
  test("in-memory repository applies, increments, and rejects stale writes", async () => {
    await expectSingletonRevisionParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository applies, increments, and rejects stale writes", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-singleton-revision-"),
    );
    try {
      await expectSingletonRevisionParity(() =>
        createFileJobFinderRepository({
          filePath: path.join(tempDirectory, "job-finder-state.sqlite"),
          seed: createSeed(),
        }),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(tempDirectory);
    }
  });

  test("commitProfileCopilotState honors expectedProfileRevision in both repositories", async () => {
    const seed = createSeed();

    async function expectCopilotCasParity(
      createRepository: () =>
        | JobFinderRepository
        | Promise<JobFinderRepository>,
    ): Promise<void> {
      const repository = await createRepository();
      try {
        const captured = await repository.getProfileWithRevision();

        const stale = await repository.commitProfileCopilotState({
          profile: {
            ...captured.profile,
            headline: "Copilot overwrite attempt",
          },
          searchPreferences: seed.searchPreferences,
          profileSetupState: seed.profileSetupState,
          messages: [],
          revisions: [],
          expectedProfileRevision: captured.revision + 5,
        });
        expect(stale.status).toBe("stale");
        if (stale.status !== "stale") {
          throw new Error("Expected stale outcome.");
        }
        expect(stale.revision).toBe(captured.revision);
        expect(stale.profile).toEqual(seed.profile);
        expect((await repository.getProfile()).headline).toBe(
          seed.profile.headline,
        );
        expect(await repository.listProfileCopilotMessages()).toHaveLength(0);

        const applied = await repository.commitProfileCopilotState({
          profile: {
            ...captured.profile,
            headline: "Copilot headline",
          },
          searchPreferences: seed.searchPreferences,
          profileSetupState: seed.profileSetupState,
          messages: [
            {
              id: "profile_copilot_assistant_message_1",
              role: "assistant",
              content: "Applied your change.",
              context: { surface: "general" },
              patchGroups: [],
              createdAt: "2026-05-01T10:00:00.000Z",
            },
          ],
          revisions: [],
          expectedProfileRevision: captured.revision,
        });
        expect(applied.status).toBe("applied");
        if (applied.status !== "applied") {
          throw new Error("Expected applied outcome.");
        }
        expect(applied.revision).toBe(captured.revision + 1);
        expect((await repository.getProfile()).headline).toBe(
          "Copilot headline",
        );
        expect(await repository.listProfileCopilotMessages()).toHaveLength(1);
      } finally {
        await repository.close();
      }
    }

    await expectCopilotCasParity(() => createInMemoryJobFinderRepository(seed));

    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-copilot-cas-"),
    );
    try {
      await expectCopilotCasParity(() =>
        createFileJobFinderRepository({
          filePath: path.join(tempDirectory, "job-finder-state.sqlite"),
          seed,
        }),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(tempDirectory);
    }
  });

  test("reset advances the profile revision without rewinding it in both repositories", async () => {
    await expectResetEpochParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );

    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-reset-epoch-"),
    );
    try {
      await expectResetEpochParity(() =>
        createFileJobFinderRepository({
          filePath: path.join(tempDirectory, "job-finder-state.sqlite"),
          seed: createSeed(),
        }),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(tempDirectory);
    }
  });

  test("a token captured before reset is rejected afterwards in both repositories", async () => {
    await expectPreResetTokenRejected(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );

    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-reset-stale-token-"),
    );
    try {
      await expectPreResetTokenRejected(() =>
        createFileJobFinderRepository({
          filePath: path.join(tempDirectory, "job-finder-state.sqlite"),
          seed: createSeed(),
        }),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(tempDirectory);
    }
  });
});

describe("singleton_state revision migration", () => {
  /**
   * A workspace as version 10 left it: every table the earlier migrations
   * created, but singleton_state without its revision column and no record of
   * migration 11 onwards. It is built from a current workspace and rolled back
   * to that shape, so it carries the tables a real version 10 file had.
   */
  async function createLegacyVersion10Database(
    filePath: string,
  ): Promise<void> {
    const current = await createFileJobFinderRepository({
      filePath,
      seed: createSeed(),
    });
    await current.close();
    const database = new DatabaseSync(filePath);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM discovery_ledger").get()
          ?.count,
      ).toBe(0);
      database.exec(`
        BEGIN;
        CREATE TABLE singleton_state_v10 (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO singleton_state_v10 (key, value)
          SELECT key, value FROM singleton_state WHERE key = 'profile';
        DROP TABLE singleton_state;
        ALTER TABLE singleton_state_v10 RENAME TO singleton_state;
        -- The fixture predates migration 30, including its schema artifacts.
        DROP TRIGGER discovery_ledger_split_insert;
        DROP TRIGGER discovery_ledger_split_update;
        DROP TABLE discovery_ledger_observations;
        DELETE FROM schema_migrations WHERE version > 10;
        COMMIT;
      `);
      database
        .prepare("UPDATE singleton_state SET value = ? WHERE key = 'profile'")
        .run(JSON.stringify(createSeed().profile));
    } finally {
      database.close();
    }
  }

  test("legacy database gains revision 1 without changing values, idempotently", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-revision-migration-"),
    );
    const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
    try {
      await createLegacyVersion10Database(filePath);

      const firstOpen = await createFileJobFinderRepository({
        filePath,
        seed: createSeed(),
      });
      try {
        const migrated = await firstOpen.getProfileWithRevision();
        expect(migrated.revision).toBe(1);
        expect(migrated.profile).toEqual(createSeed().profile);

        await firstOpen.commitProfileUpdate((current) => ({
          ...current,
          headline: "Post-migration edit",
        }));
        expect((await firstOpen.getProfileWithRevision()).revision).toBe(2);
      } finally {
        await firstOpen.close();
      }

      const secondOpen = await createFileJobFinderRepository({
        filePath,
        seed: createSeed(),
      });
      try {
        const reopened = await secondOpen.getProfileWithRevision();
        expect(reopened.revision).toBe(2);
        expect(reopened.profile.headline).toBe("Post-migration edit");
      } finally {
        await secondOpen.close();
      }

      const raw = new DatabaseSync(filePath);
      try {
        const migrationRows = raw
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11 AND name = 'singleton_state_revision'",
          )
          .get() as { count: number };
        expect(Number(migrationRows.count)).toBe(1);
        const columns = raw
          .prepare("PRAGMA table_info(singleton_state)")
          .all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toContain("revision");
      } finally {
        raw.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(tempDirectory);
    }
  }, 30_000);

  test("fresh bootstrap initializes revision 1 deterministically", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-revision-bootstrap-"),
    );
    try {
      const repository = await createFileJobFinderRepository({
        filePath: path.join(tempDirectory, "job-finder-state.sqlite"),
        seed: createSeed(),
      });
      try {
        const bootstrapped = await repository.getProfileWithRevision();
        expect(bootstrapped.revision).toBe(1);
        expect(bootstrapped.profile).toEqual(createSeed().profile);
      } finally {
        await repository.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(tempDirectory);
    }
  });
});

test("a workspace that fails to open leaves its file unlocked", async () => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-db-failed-open-"),
  );
  const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
  // Claims every migration up to 10 but has none of their tables, so opening
  // it fails after the connection is open.
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE singleton_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (let version = 1; version <= 10; version += 1)
    database
      .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(version, `migration_${version}`);
  database.close();

  await expect(
    createFileJobFinderRepository({ filePath, seed: createSeed() }),
  ).rejects.toThrow();
  // On Windows an orphaned connection keeps the file locked until exit.
  await expect(
    rm(tempDirectory, { recursive: true, force: true }),
  ).resolves.toBeUndefined();
});
