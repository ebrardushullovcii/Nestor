import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { ProfileCopilotPatchGroup } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createAiClient,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function group(
  id: string,
  summary: string,
  operations: ProfileCopilotPatchGroup["operations"],
): ProfileCopilotPatchGroup {
  return {
    id,
    summary,
    applyMode: "needs_review",
    operations,
    createdAt: "2026-09-23T10:00:00.000Z",
  };
}

function createRepeatingAiClient(
  patchGroups: ProfileCopilotPatchGroup[],
  receipt?: Awaited<
    ReturnType<JobFinderAiClient["reviseCandidateProfile"]>
  >["executionReceipt"],
): JobFinderAiClient {
  return {
    ...createAiClient(),
    reviseCandidateProfile() {
      return Promise.resolve({
        content:
          "I prepared adding Staff Backend Engineer to your target roles.",
        patchGroups,
        ...(receipt ? { executionReceipt: receipt } : {}),
      });
    },
  };
}

async function proposeAndReadCards(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
  request: string,
) {
  const snapshot = await harness.workspaceService.proposeProfileCopilotChange(
    request,
    { surface: "general" },
  );
  const message = snapshot.profileCopilotMessages.find(
    (entry) => entry.role === "assistant",
  );
  return { cards: message?.patchGroups ?? [], content: message?.content ?? "" };
}

describe("Profile Assistant reply cards", () => {
  test("a card that repeats an earlier card in the same reply is shown once", async () => {
    // A built-app run showed five cards for "add a target role": the model
    // called the same tools twice and two cards were exact copies.
    const roles = ["Backend Engineer", "Staff Backend Engineer"];
    const harness = createWorkspaceServiceHarness({
      aiClient: createRepeatingAiClient([
        group("a", "Add Staff Backend Engineer to target roles", [
          {
            operation: "replace_profile_list_fields",
            value: { targetRoles: roles },
          },
        ]),
        group("b", "Match seniority filters", [
          {
            operation: "replace_search_preferences_fields",
            value: { seniorityLevels: ["Senior", "Staff"] },
          },
        ]),
        group("c", "Add Staff Backend Engineer to target roles", [
          {
            operation: "replace_profile_list_fields",
            value: { targetRoles: roles },
          },
        ]),
      ]),
    });

    const snapshot = await harness.workspaceService.proposeProfileCopilotChange(
      "Add Staff Backend Engineer to my target roles.",
      { surface: "general" },
    );

    const cards =
      snapshot.profileCopilotMessages.find(
        (message) => message.role === "assistant",
      )?.patchGroups ?? [];
    expect(cards.map((card) => card.summary)).toEqual([
      "Add Staff Backend Engineer to target roles",
      "Match seniority filters",
    ]);
    // Ids stay unique and in order after the copy is dropped.
    expect(new Set(cards.map((card) => card.id)).size).toBe(2);
  });

  test("two cards that change different things are both kept", async () => {
    const harness = createWorkspaceServiceHarness({
      aiClient: createRepeatingAiClient([
        group("a", "Add Staff Backend Engineer to profile target roles", [
          {
            operation: "replace_profile_list_fields",
            value: { targetRoles: ["Staff Backend Engineer"] },
          },
        ]),
        group("b", "Add Staff Backend Engineer to search target roles", [
          {
            operation: "replace_search_preferences_fields",
            value: { targetRoles: ["Staff Backend Engineer"] },
          },
        ]),
      ]),
    });

    const snapshot = await harness.workspaceService.proposeProfileCopilotChange(
      "Add Staff Backend Engineer to my target roles.",
      { surface: "general" },
    );

    expect(
      snapshot.profileCopilotMessages.find(
        (message) => message.role === "assistant",
      )?.patchGroups,
    ).toHaveLength(2);
  });

  test("the same target-role change proposed for both stored copies is one card that updates both", async () => {
    // Seed: the profile copy holds Principal Designer, the list Preferences
    // shows holds two more roles. Live, the Assistant proposed one card per
    // copy, so one request cost two presses.
    const harness = createWorkspaceServiceHarness({
      aiClient: createRepeatingAiClient([
        group("a", "Add Staff Designer to profile target roles", [
          {
            operation: "replace_profile_list_fields",
            value: { targetRoles: ["Principal Designer", "Staff Designer"] },
          },
        ]),
        group("b", "Add Staff Designer to search preferences for consistency", [
          {
            operation: "replace_search_preferences_fields",
            value: {
              targetRoles: [
                "Principal Designer",
                "Senior Product Designer",
                "Principal UX Engineer",
                "Staff Designer",
              ],
            },
          },
        ]),
      ]),
    });

    const { cards } = await proposeAndReadCards(
      harness,
      "Add Staff Designer to my target roles.",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.summary).toBe("Add Staff Designer to target roles");
    // The card shows the list Preferences shows.
    expect(cards[0]?.operations).toEqual([
      {
        operation: "replace_search_preferences_fields",
        value: {
          targetRoles: [
            "Principal Designer",
            "Senior Product Designer",
            "Principal UX Engineer",
            "Staff Designer",
          ],
        },
      },
    ]);

    const applied =
      await harness.workspaceService.applyProfileCopilotPatchGroup(
        cards[0]!.id,
      );
    expect(applied.searchPreferences.targetRoles).toEqual([
      "Principal Designer",
      "Senior Product Designer",
      "Principal UX Engineer",
      "Staff Designer",
    ]);
    expect(applied.profile.targetRoles).toEqual([
      "Principal Designer",
      "Staff Designer",
    ]);
  });

  test("a card that edits only the profile copy also changes the list Preferences shows", async () => {
    const harness = createWorkspaceServiceHarness({
      aiClient: createRepeatingAiClient([
        group("a", "Add Remote Europe to locations", [
          {
            operation: "replace_profile_list_fields",
            value: { locations: ["Remote", "Remote Europe"] },
          },
        ]),
      ]),
    });

    const { cards } = await proposeAndReadCards(
      harness,
      "Add Remote Europe to my locations.",
    );
    const applied =
      await harness.workspaceService.applyProfileCopilotPatchGroup(
        cards[0]!.id,
      );

    expect(applied.profile.locations).toEqual(["Remote", "Remote Europe"]);
    // London stays: only the addition is carried over.
    expect(applied.searchPreferences.locations).toEqual([
      "Remote",
      "London",
      "Remote Europe",
    ]);
  });

  test("removing a target role takes it off the list Preferences shows even when the profile copy lacks it", async () => {
    const harness = createWorkspaceServiceHarness({
      aiClient: createRepeatingAiClient([
        group("a", "Remove Senior Product Designer", [
          {
            operation: "remove_profile_list_entries",
            field: "targetRoles",
            values: ["Senior Product Designer"],
          },
        ]),
        group("b", "Remove Senior Product Designer from search", [
          {
            operation: "replace_search_preferences_fields",
            value: {
              targetRoles: ["Principal Designer", "Principal UX Engineer"],
            },
          },
        ]),
      ]),
    });

    const { cards } = await proposeAndReadCards(
      harness,
      "Remove Senior Product Designer from my target roles.",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.operations[0]?.operation).toBe(
      "remove_profile_list_entries",
    );

    const applied =
      await harness.workspaceService.applyProfileCopilotPatchGroup(
        cards[0]!.id,
      );
    expect(applied.searchPreferences.targetRoles).toEqual([
      "Principal Designer",
      "Principal UX Engineer",
    ]);
    expect(applied.profile.targetRoles).toEqual(["Principal Designer"]);
  });

  test("cards kept from a run that stopped early say so", async () => {
    const harness = createWorkspaceServiceHarness({
      aiClient: createRepeatingAiClient(
        [
          group("a", "Add Staff Designer to target roles", [
            {
              operation: "replace_search_preferences_fields",
              value: {
                targetRoles: ["Principal Designer", "Staff Designer"],
              },
            },
          ]),
        ],
        {
          taskId: "profile_copilot_1",
          capability: "profile_copilot",
          startedAt: "2026-09-23T10:00:00.000Z",
          completedAt: "2026-09-23T10:00:30.000Z",
          durationMs: 30_000,
          model: "test-model",
          reasoningEffort: null,
          providerCalls: 6,
          repairAttempts: 0,
          fallbackUsed: false,
          stopReason: "no_progress",
          finalValidationIssues: [],
          toolReceipts: [],
        },
      ),
    });

    const { cards, content } = await proposeAndReadCards(
      harness,
      "Add Staff Designer to my target roles.",
    );

    expect(cards).toHaveLength(1);
    expect(content).toContain(
      "I stopped before finishing every step, so check that these cards cover all of your request.",
    );
  });
});
