import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import { cleanupTempDirectoryWithRetry } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

function createTwoGroupMessage() {
  return {
    id: "profile_copilot_assistant_message_flags",
    role: "assistant" as const,
    content: "Prepared changes.",
    context: { surface: "general" } as const,
    patchGroups: [
      {
        id: "patch_flag_headline",
        summary: "Set the headline",
        applyMode: "needs_review" as const,
        operations: [
          {
            operation: "replace_identity_fields" as const,
            value: { headline: "Flag Headline" },
          },
        ],
        createdAt: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "patch_flag_location",
        summary: "Set the location",
        applyMode: "needs_review" as const,
        operations: [
          {
            operation: "replace_identity_fields" as const,
            value: { currentLocation: "Flag Location" },
          },
        ],
        createdAt: "2026-05-01T10:00:00.000Z",
      },
    ],
    createdAt: "2026-05-01T10:00:00.000Z",
  };
}

async function expectSharedEpochAndFlagParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    const seed = createSeed();
    const baseline = await repository.getProfileWithRevision();

    // Preference-only and setup-state-only writes advance the shared
    // compare-and-swap epoch even though the profile value is untouched.
    const preferences = await repository.getSearchPreferences();
    await repository.saveSearchPreferences({
      ...preferences,
      minimumSalaryUsd: 190000,
      compensation: { ...preferences.compensation, minimum: 190000 },
    });
    expect((await repository.getProfileWithRevision()).revision).toBe(
      baseline.revision + 1,
    );

    const setupState = await repository.getProfileSetupState();
    await repository.saveProfileSetupState(setupState);
    expect((await repository.getProfileWithRevision()).revision).toBe(
      baseline.revision + 2,
    );

    // A copilot commit captured before those writes must go stale instead of
    // overwriting them with its preference/setup snapshots.
    const staleOutcome = await repository.commitProfileCopilotState({
      profile: baseline.profile,
      searchPreferences: seed.searchPreferences,
      profileSetupState: seed.profileSetupState,
      expectedProfileRevision: baseline.revision,
    });
    expect(staleOutcome.status).toBe("stale");
    if (staleOutcome.status !== "stale") {
      throw new Error("Expected stale outcome.");
    }
    expect((await repository.getSearchPreferences()).minimumSalaryUsd).toBe(
      190000,
    );

    // Flag deltas resolve against transaction-current rows: a sibling flip
    // landing between capture and commit survives the copilot commit.
    await repository.upsertProfileCopilotMessage(createTwoGroupMessage());
    await repository.commitProfileCopilotPatchFlagUpdate({
      patchGroupId: "patch_flag_location",
      applyMode: "rejected",
    });

    const captured = await repository.getProfileWithRevision();
    const applied = await repository.commitProfileCopilotState({
      profile: captured.profile,
      searchPreferences: await repository.getSearchPreferences(),
      profileSetupState: await repository.getProfileSetupState(),
      messagePatchFlags: [
        {
          messageId: createTwoGroupMessage().id,
          patchGroupId: "patch_flag_headline",
          applyMode: "applied",
        },
      ],
      expectedProfileRevision: captured.revision,
    });
    expect(applied.status).toBe("applied");

    const [message] = await repository.listProfileCopilotMessages();
    if (!message) {
      throw new Error("Expected the seeded copilot message to persist.");
    }
    expect(
      Object.fromEntries(
        message.patchGroups.map((group) => [group.id, group.applyMode]),
      ),
    ).toEqual({
      patch_flag_headline: "applied",
      patch_flag_location: "rejected",
    });

    // Unknown patch groups report a no-op miss instead of writing anything.
    expect(
      await repository.commitProfileCopilotPatchFlagUpdate({
        patchGroupId: "patch_flag_missing",
        applyMode: "rejected",
      }),
    ).toBe(false);

    // The atomic flip touches only its own group.
    expect(
      await repository.commitProfileCopilotPatchFlagUpdate({
        patchGroupId: "patch_flag_headline",
        applyMode: "needs_review",
      }),
    ).toBe(true);
    const [afterFlip] = await repository.listProfileCopilotMessages();
    if (!afterFlip) {
      throw new Error("Expected the seeded copilot message to persist.");
    }
    expect(
      Object.fromEntries(
        afterFlip.patchGroups.map((group) => [group.id, group.applyMode]),
      ),
    ).toEqual({
      patch_flag_headline: "needs_review",
      patch_flag_location: "rejected",
    });

    // Legacy provider IDs can occur in more than one message. A group-only
    // flag update must fail closed instead of selecting the oldest row.
    const duplicateSource = createTwoGroupMessage();
    await repository.upsertProfileCopilotMessage({
      ...duplicateSource,
      id: "profile_copilot_assistant_message_flags_duplicate",
      patchGroups: [duplicateSource.patchGroups[0]!],
    });
    expect(
      await repository.commitProfileCopilotPatchFlagUpdate({
        patchGroupId: "patch_flag_headline",
        applyMode: "rejected",
      }),
    ).toBe(false);
    expect(
      (await repository.listProfileCopilotMessages())
        .flatMap((message) => message.patchGroups)
        .filter((group) => group.id === "patch_flag_headline")
        .map((group) => group.applyMode),
    ).toEqual(["needs_review", "needs_review"]);
  } finally {
    await repository.close();
  }
}

describe("profile copilot shared epoch and patch-flag parity", () => {
  test("in-memory repository advances the shared epoch and flips flags atomically", async () => {
    await expectSharedEpochAndFlagParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository advances the shared epoch and flips flags atomically", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-copilot-flag-parity-"),
    );
    try {
      await expectSharedEpochAndFlagParity(() =>
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
