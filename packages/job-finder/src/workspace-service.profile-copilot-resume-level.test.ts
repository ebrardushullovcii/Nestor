import type {
  JobFinderAiClient,
  ReviseCandidateProfileInput,
} from "@nestor/ai-providers";
import type {
  ProfileCopilotPatchOperation,
  ResumeApplicationMode,
  TailoringMode,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/**
 * The resume level lives in two halves: Original is a Settings field
 * (`settings.resumeApplicationMode`), the strength is a search preference
 * (`searchPreferences.tailoringMode`). The Profile Assistant used to see only
 * the strength, told a person on Original "you're already on Light", and could
 * not move anyone onto or off Original. These tests pin the route: the
 * Assistant is told the saved level, one Apply writes both halves exactly as
 * Settings does, and Undo puts the saved level back.
 */

function createProposingAiClient(
  operations: ProfileCopilotPatchOperation[],
  seen: ReviseCandidateProfileInput[],
  applyMode: "applied" | "needs_review" = "needs_review",
): JobFinderAiClient {
  return {
    ...createAiClient(),
    reviseCandidateProfile(input) {
      seen.push(input);
      return Promise.resolve({
        content:
          "Original sends your imported file unchanged, so I prepared a switch to Light.",
        patchGroups: [
          {
            id: "provider_group",
            summary: "Use Light resumes for new jobs",
            applyMode,
            operations,
            createdAt: "2026-09-23T10:00:00.000Z",
          },
        ],
      });
    },
  };
}

function createHarness(input: {
  resumeApplicationMode: ResumeApplicationMode;
  tailoringMode: TailoringMode;
  operations: ProfileCopilotPatchOperation[];
  applyMode?: "applied" | "needs_review";
}) {
  const seed = createSeed();
  const seen: ReviseCandidateProfileInput[] = [];
  const harness = createWorkspaceServiceHarness({
    seed: {
      ...seed,
      settings: {
        ...seed.settings,
        resumeApplicationMode: input.resumeApplicationMode,
      },
      searchPreferences: {
        ...seed.searchPreferences,
        tailoringMode: input.tailoringMode,
      },
    },
    aiClient: createProposingAiClient(input.operations, seen, input.applyMode),
  });
  return { ...harness, seen };
}

async function proposeAndApply(
  harness: ReturnType<typeof createHarness>,
  request: string,
) {
  const proposal = await harness.workspaceService.proposeProfileCopilotChange(
    request,
    { surface: "general" },
  );
  const groupId = proposal.profileCopilotMessages.find(
    (message) => message.role === "assistant",
  )?.patchGroups[0]?.id;
  expect(groupId).toBeTruthy();
  return harness.workspaceService.applyProfileCopilotPatchGroup(groupId!);
}

async function readLevel(harness: ReturnType<typeof createHarness>) {
  const [settings, preferences] = await Promise.all([
    harness.repository.getSettings(),
    harness.repository.getSearchPreferences(),
  ]);
  return {
    resumeApplicationMode: settings.resumeApplicationMode ?? "tailored_per_job",
    tailoringMode: preferences.tailoringMode,
  };
}

describe("Profile Assistant and the saved resume level", () => {
  test("tells the Assistant a person on Original is on Original, not on the stored strength", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "conservative",
      operations: [{ operation: "set_resume_approach", value: "conservative" }],
    });

    await harness.workspaceService.proposeProfileCopilotChange(
      "Make my resume shorter.",
      { surface: "general" },
    );

    expect(harness.seen[0]?.resumeApproach).toBe("original_resume");
    expect(
      harness.seen[0]?.conversationFacts?.some((fact) =>
        fact.startsWith("Resume level for new jobs (Settings): Original."),
      ),
    ).toBe(true);
  });

  test("moves a person off Original onto Light with one Apply, and Undo puts Original back", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      operations: [{ operation: "set_resume_approach", value: "conservative" }],
    });

    const applied = await proposeAndApply(harness, "Make my resume shorter.");

    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "tailored_per_job",
      tailoringMode: "conservative",
    });
    const revision = applied.profileRevisions[0];
    // The snapshot carries a summary; the stored revision holds both halves.
    const stored = (await harness.repository.listProfileRevisions()).find(
      (entry) => entry.id === revision?.id,
    );
    expect(stored).toMatchObject({
      trigger: "assistant_patch",
      snapshotResumeApplicationMode: "original_resume",
      snapshotResumeApplicationModeAfter: "tailored_per_job",
    });

    await harness.workspaceService.undoProfileRevision(revision!.id);

    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
    });
  });

  test("moves a person onto Original without touching the stored strength, and Undo takes them off it", async () => {
    const harness = createHarness({
      resumeApplicationMode: "tailored_per_job",
      tailoringMode: "balanced",
      operations: [
        { operation: "set_resume_approach", value: "original_resume" },
      ],
    });

    const applied = await proposeAndApply(
      harness,
      "Stop rewriting my resume. Send my original file from now on.",
    );

    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
    });

    await harness.workspaceService.undoProfileRevision(
      applied.profileRevisions[0]!.id,
    );

    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "tailored_per_job",
      tailoringMode: "balanced",
    });
  });

  test("a strength chosen while on Original also moves the person off Original", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "conservative",
      operations: [
        {
          operation: "replace_search_preferences_fields",
          value: { tailoringMode: "aggressive" },
        },
      ],
    });

    await proposeAndApply(harness, "Use Aggressive resumes.");

    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "tailored_per_job",
      tailoringMode: "aggressive",
    });
  });

  test("a job already on Shortlisted keeps Original when the Assistant moves new jobs to Light", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      operations: [{ operation: "set_resume_approach", value: "conservative" }],
    });
    const before = await harness.repository.listSavedJobs();
    expect(
      before.find((job) => job.id === "job_ready")?.resumeApplicationMode,
    ).toBeNull();

    await proposeAndApply(harness, "Use Light resumes from now on.");

    const after = await harness.repository.listSavedJobs();
    expect(
      after.find((job) => job.id === "job_ready")?.resumeApplicationMode,
    ).toBe("original_resume");
  });

  test("Undo keeps a level the person chose in Settings after the Assistant's change", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      operations: [{ operation: "set_resume_approach", value: "conservative" }],
    });
    const applied = await proposeAndApply(harness, "Make my resume shorter.");

    // The person goes back to Original in Settings themselves.
    await harness.workspaceService.updateAiBehavior({
      resumeApproach: "original_resume",
    });
    await harness.workspaceService.undoProfileRevision(
      applied.profileRevisions[0]!.id,
    );

    const level = await readLevel(harness);
    expect(level.resumeApplicationMode).toBe("original_resume");
    // The strength half is the Assistant's to put back.
    expect(level.tailoringMode).toBe("balanced");
  });
  test("a repeated strength beside another edit keeps a person on Original", async () => {
    // Found by review: the model echoed the saved strength next to a target
    // role, and Apply & save moved the person off Original without a word.
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      operations: [
        {
          operation: "replace_search_preferences_fields",
          value: { targetRoles: ["Staff Designer"], tailoringMode: "balanced" },
        },
      ],
    });

    const proposal = await harness.workspaceService.proposeProfileCopilotChange(
      "Add Staff Designer to my target roles.",
      { surface: "general" },
    );
    const card = proposal.profileCopilotMessages.find(
      (message) => message.role === "assistant",
    )?.patchGroups[0];
    // The card carries only the edit that was asked for.
    expect(card?.operations).toEqual([
      {
        operation: "replace_search_preferences_fields",
        value: { targetRoles: ["Staff Designer"] },
      },
    ]);
    await harness.workspaceService.applyProfileCopilotPatchGroup(card!.id);

    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
    });
    expect(
      (await harness.repository.getSearchPreferences()).targetRoles,
    ).toContain("Staff Designer");
  });

  test("a card saved before the guard still keeps Original when it repeats the strength", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      operations: [],
    });
    await harness.repository.upsertProfileCopilotMessage({
      id: "stored_assistant_message",
      role: "assistant",
      content: "I prepared this change for your review.",
      context: { surface: "general" },
      patchGroups: [
        {
          id: "stored_group",
          summary: "Add Staff Designer to target roles",
          applyMode: "needs_review",
          operations: [
            {
              operation: "replace_search_preferences_fields",
              value: {
                targetRoles: ["Staff Designer"],
                tailoringMode: "balanced",
              },
            },
          ],
          createdAt: "2026-09-23T10:00:00.000Z",
        },
      ],
      executionAttribution: null,
      createdAt: "2026-09-23T10:00:00.000Z",
    });

    await harness.workspaceService.applyProfileCopilotPatchGroup(
      "stored_group",
    );

    expect((await readLevel(harness)).resumeApplicationMode).toBe(
      "original_resume",
    );
  });

  test("a strength the Assistant marks safe still waits for review as a resume level card", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      applyMode: "applied",
      operations: [
        {
          operation: "replace_search_preferences_fields",
          value: { tailoringMode: "conservative" },
        },
      ],
    });

    const snapshot = await harness.workspaceService.sendProfileCopilotMessage(
      "Use Light resumes.",
      { surface: "general" },
    );

    const card = snapshot.profileCopilotMessages.find(
      (message) => message.role === "assistant",
    )?.patchGroups[0];
    expect(card?.applyMode).toBe("needs_review");
    expect(card?.operations).toEqual([
      { operation: "set_resume_approach", value: "conservative" },
    ]);
    // Nothing moved until the person presses Apply & save.
    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
    });
  });

  test("a group that only repeats the saved strength is not shown as a change", async () => {
    const harness = createHarness({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
      applyMode: "applied",
      operations: [
        {
          operation: "replace_search_preferences_fields",
          value: { tailoringMode: "balanced" },
        },
      ],
    });

    const snapshot = await harness.workspaceService.sendProfileCopilotMessage(
      "What resume level am I on?",
      { surface: "general" },
    );

    expect(
      snapshot.profileCopilotMessages.find(
        (message) => message.role === "assistant",
      )?.patchGroups,
    ).toEqual([]);
    expect(await readLevel(harness)).toEqual({
      resumeApplicationMode: "original_resume",
      tailoringMode: "balanced",
    });
  });
});
