import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import { describe, expect, test } from "vitest";

import { createJobFinderWorkspaceService } from "../index";
import { ProfileCommitStaleError } from "./profile-commit-stale-conflict";
import {
  createSeed,
} from "../workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "../workspace-service.test-runtimes";

function createTestHarness(repository: JobFinderRepository) {
  const workspaceService = createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: { exists: () => Promise.resolve(true) },
    researchAdapter: createResearchAdapter(),
  });
  return workspaceService;
}

function createCopilotPatchGroupMessage() {
  return {
    id: "profile_copilot_assistant_message_patch_1",
    role: "assistant" as const,
    content: "I prepared this change for your review.",
    context: { surface: "general" } as const,
    patchGroups: [
      {
        id: "patch_headline_1",
        summary: "Set the headline",
        applyMode: "needs_review" as const,
        operations: [
          {
            operation: "replace_identity_fields" as const,
            value: { headline: "Copilot Headline" },
          },
        ],
        createdAt: "2026-05-01T10:00:00.000Z",
      },
    ],
    createdAt: "2026-05-01T10:00:00.000Z",
  };
}

describe("profile copilot commit concurrency", () => {
  test("a second stale copilot commit raises a typed stale error without overwriting", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    let editCount = 0;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileCopilotState: async (input) => {
        const current = await base.getProfile();
        await base.saveProfile({
          ...current,
          summary: `Concurrent edit ${++editCount}`,
        });
        return base.commitProfileCopilotState(input);
      },
    };
    await repository.upsertProfileCopilotMessage(
      createCopilotPatchGroupMessage(),
    );
    const service = createTestHarness(repository);

    await expect(
      service.applyProfileCopilotPatchGroup("patch_headline_1"),
    ).rejects.toThrow(ProfileCommitStaleError);

    const profile = await repository.getProfile();
    expect(profile.headline).toBe(createSeed().profile.headline);

    const messages = await repository.listProfileCopilotMessages();
    expect(messages[0]?.patchGroups[0]?.applyMode).toBe("needs_review");
  });

  test("undo retries once past a concurrent edit and restores the revision snapshot", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const seed = createSeed();
    const undoTarget = {
      id: "profile_revision_target_1",
      createdAt: "2026-05-01T09:00:00.000Z",
      reason: null,
      trigger: "assistant_patch" as const,
      messageId: null,
      patchGroupId: null,
      restoredFromRevisionId: null,
      sequence: 1,
      snapshotProfile: seed.profile,
      snapshotSearchPreferences: seed.searchPreferences,
      snapshotProfileSetupState: seed.profileSetupState,
      snapshotProfileAfter: null,
      snapshotSearchPreferencesAfter: null,
      snapshotResumeApplicationMode: null,
      snapshotResumeApplicationModeAfter: null,
    };
    await base.upsertProfileRevision(undoTarget);
    await base.saveProfile({
      ...seed.profile,
      headline: "Edited after the revision",
    });

    let racedOnce = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileCopilotState: async (input) => {
        if (!racedOnce) {
          racedOnce = true;
          const current = await base.getProfile();
          await base.saveProfile({
            ...current,
            summary: "Concurrent edit during undo",
          });
        }
        return base.commitProfileCopilotState(input);
      },
    };
    const service = createTestHarness(repository);

    await service.undoProfileRevision(undoTarget.id);

    const profile = await repository.getProfile();
    expect(profile.headline).toBe(seed.profile.headline);
    expect(profile.summary).toBe(seed.profile.summary);
    const revisions = await repository.listProfileRevisions();
    expect(revisions.some((revision) => revision.trigger === "undo")).toBe(
      true,
    );
  });
});

describe("profile copilot preference and sibling-flag races", () => {
  function createTwoGroupCopilotMessage() {
    return {
      id: "profile_copilot_assistant_message_patch_2",
      role: "assistant" as const,
      content: "I prepared these changes for your review.",
      context: { surface: "general" } as const,
      patchGroups: [
        {
          id: "patch_headline_sibling",
          summary: "Set the headline",
          applyMode: "needs_review" as const,
          operations: [
            {
              operation: "replace_identity_fields" as const,
              value: { headline: "Copilot Headline" },
            },
          ],
          createdAt: "2026-05-01T10:00:00.000Z",
        },
        {
          id: "patch_location_sibling",
          summary: "Set the location",
          applyMode: "needs_review" as const,
          operations: [
            {
              operation: "replace_identity_fields" as const,
              value: { currentLocation: "Copilot Location" },
            },
          ],
          createdAt: "2026-05-01T10:00:00.000Z",
        },
      ],
      createdAt: "2026-05-01T10:00:00.000Z",
    };
  }

  async function readPatchGroupModes(
    repository: JobFinderRepository,
  ): Promise<Record<string, string>> {
    const [message] = await repository.listProfileCopilotMessages();
    return Object.fromEntries(
      (message?.patchGroups ?? []).map((group) => [group.id, group.applyMode]),
    );
  }

  test("a preference save landing during the copilot commit survives beside the patch", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    let racedOnce = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileCopilotState: async (input) => {
        if (!racedOnce) {
          racedOnce = true;
          const currentPreferences = await base.getSearchPreferences();
          await base.saveSearchPreferences({
            ...currentPreferences,
            minimumSalaryUsd: 185000,
            compensation: {
              ...currentPreferences.compensation,
              minimum: 185000,
            },
          });
        }
        return base.commitProfileCopilotState(input);
      },
    };
    await repository.upsertProfileCopilotMessage(
      createCopilotPatchGroupMessage(),
    );
    const service = createTestHarness(repository);

    await service.applyProfileCopilotPatchGroup("patch_headline_1");

    const [profile, preferences, messages] = await Promise.all([
      repository.getProfile(),
      repository.getSearchPreferences(),
      repository.listProfileCopilotMessages(),
    ]);
    expect(racedOnce).toBe(true);
    // The patch reapplies over a fresh capture instead of reverting the save.
    expect(profile.headline).toBe("Copilot Headline");
    expect(preferences.minimumSalaryUsd).toBe(185000);
    expect(messages[0]?.patchGroups[0]?.applyMode).toBe("applied");
  });

  test("undo retries past a concurrent preference save and restores its snapshots", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const seed = createSeed();
    const undoTarget = {
      id: "profile_revision_target_prefs",
      createdAt: "2026-05-01T09:00:00.000Z",
      reason: null,
      trigger: "assistant_patch" as const,
      messageId: null,
      patchGroupId: null,
      restoredFromRevisionId: null,
      sequence: 1,
      snapshotProfile: seed.profile,
      snapshotSearchPreferences: seed.searchPreferences,
      snapshotProfileSetupState: seed.profileSetupState,
      snapshotProfileAfter: null,
      snapshotSearchPreferencesAfter: null,
      snapshotResumeApplicationMode: null,
      snapshotResumeApplicationModeAfter: null,
    };
    await base.upsertProfileRevision(undoTarget);

    let racedOnce = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileCopilotState: async (input) => {
        if (!racedOnce) {
          racedOnce = true;
          const currentPreferences = await base.getSearchPreferences();
          await base.saveSearchPreferences({
            ...currentPreferences,
            minimumSalaryUsd: 195000,
            compensation: {
              ...currentPreferences.compensation,
              minimum: 195000,
            },
          });
        }
        return base.commitProfileCopilotState(input);
      },
    };
    const service = createTestHarness(repository);

    await service.undoProfileRevision(undoTarget.id);

    expect(racedOnce).toBe(true);
    // Undo deliberately restores the revision snapshot after the deterministic
    // retry re-checks the epoch; nothing from the stale attempt is applied.
    expect((await repository.getSearchPreferences()).minimumSalaryUsd).toBe(
      seed.searchPreferences.minimumSalaryUsd,
    );
    const revisions = await repository.listProfileRevisions();
    expect(revisions.some((revision) => revision.trigger === "undo")).toBe(
      true,
    );
  });

  test("a sibling rejection landing during an apply keeps its status", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    let racedOnce = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileCopilotState: async (input) => {
        if (!racedOnce) {
          racedOnce = true;
          // Simulates the user rejecting the sibling group while the apply
          // commit is in flight; a whole-message snapshot here would revert
          // this rejection back to needs_review.
          await base.commitProfileCopilotPatchFlagUpdate({
            patchGroupId: "patch_location_sibling",
            applyMode: "rejected",
          });
        }
        return base.commitProfileCopilotState(input);
      },
    };
    await repository.upsertProfileCopilotMessage(
      createTwoGroupCopilotMessage(),
    );
    const service = createTestHarness(repository);

    await service.applyProfileCopilotPatchGroup("patch_headline_sibling");

    const modes = await readPatchGroupModes(repository);
    expect(modes).toEqual({
      patch_headline_sibling: "applied",
      patch_location_sibling: "rejected",
    });
    const profile = await repository.getProfile();
    expect(profile.headline).toBe("Copilot Headline");
    expect(profile.currentLocation).not.toBe("Copilot Location");
  });

  test("a sibling apply landing during a rejection keeps its status", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    let racedOnce = false;
    const repository: JobFinderRepository = {
      ...base,
      commitProfileCopilotPatchFlagUpdate: async (input) => {
        if (!racedOnce) {
          racedOnce = true;
          // Simulates the sibling group being applied while the rejection is
          // in flight; the atomic flip must not revert it to needs_review.
          await base.commitProfileCopilotPatchFlagUpdate({
            patchGroupId: "patch_location_sibling",
            applyMode: "applied",
          });
        }
        return base.commitProfileCopilotPatchFlagUpdate(input);
      },
    };
    await repository.upsertProfileCopilotMessage(
      createTwoGroupCopilotMessage(),
    );
    const service = createTestHarness(repository);

    await service.rejectProfileCopilotPatchGroup("patch_headline_sibling");

    const modes = await readPatchGroupModes(repository);
    expect(modes).toEqual({
      patch_headline_sibling: "rejected",
      patch_location_sibling: "applied",
    });
  });

  test("rejecting an unknown patch group fails without writing", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    await base.upsertProfileCopilotMessage(createCopilotPatchGroupMessage());
    const service = createTestHarness(base);

    await expect(
      service.rejectProfileCopilotPatchGroup("patch_does_not_exist"),
    ).rejects.toThrow("Unknown profile copilot patch group");

    const modes = await readPatchGroupModes(base);
    expect(modes).toEqual({ patch_headline_1: "needs_review" });
  });
});
