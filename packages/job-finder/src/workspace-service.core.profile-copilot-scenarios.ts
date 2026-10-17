import type {
  ProfileCopilotMessage,
  ProfileCopilotPatchGroup,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("profile copilot can auto-apply safe changes and save a reversible revision", async () => {
    const patchGroupId = "profile_patch_group_apply";
    const reviewItemId = "review_narrative_story";
    const assistantPatchGroup: ProfileCopilotPatchGroup = {
      id: patchGroupId,
      summary: "Refresh professional story",
      applyMode: "applied",
      operations: [
        {
          operation: "replace_narrative_fields",
          value: {
            professionalStory:
              "Product systems leader who turns complex operating workflows into reliable, scalable experiences.",
          },
        },
        {
          operation: "resolve_review_items",
          reviewItemIds: [reviewItemId],
          resolutionStatus: "edited",
        },
      ],
      createdAt: "2026-04-12T10:00:00.000Z",
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profileSetupState: {
          ...createSeed().profileSetupState,
          status: "in_progress",
          currentStep: "narrative",
          completedAt: null,
          reviewItems: [
            {
              id: reviewItemId,
              step: "narrative",
              target: {
                domain: "narrative",
                key: "professionalStory",
                recordId: null,
              },
              label: "Professional story",
              reason: "Add a concise story before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-12T09:50:00.000Z",
              resolvedAt: null,
            },
          ],
        },
      },
      aiClient: {
        ...createAiClient(),
        reviseCandidateProfile(input) {
          return Promise.resolve({
            content: `Applied a grounded update for: ${input.request}`,
            patchGroups: [assistantPatchGroup],
          });
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "Tighten my professional story for setup",
      {
        surface: "setup",
        step: "narrative",
      },
    );
    const messages = await repository.listProfileCopilotMessages();
    const revisions = await repository.listProfileRevisions();

    expect(snapshot.profile.narrative.professionalStory).toBe(
      "Product systems leader who turns complex operating workflows into reliable, scalable experiences.",
    );
    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.id === reviewItemId,
      )?.status,
    ).toBe("edited");
    expect(messages).toHaveLength(2);
    const persistedPatchGroup = messages.find(
      (message) => message.role === "assistant",
    )?.patchGroups[0];
    expect(persistedPatchGroup).toEqual(
      expect.objectContaining({
        applyMode: "applied",
      }),
    );
    expect(persistedPatchGroup?.id).not.toBe(patchGroupId);
    expect(revisions[0]).toEqual(
      expect.objectContaining({
        trigger: "assistant_patch",
        patchGroupId: persistedPatchGroup?.id,
      }),
    );
  });

  test("profile copilot isolates repeated provider patch IDs across turns", async () => {
    const providerPatchGroupId = "profile_proposal_1";
    const responseHeadlines = [
      "First proposed headline",
      "Second proposed headline",
    ];
    let responseIndex = 0;
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...createAiClient(),
        reviseCandidateProfile() {
          const headline = responseHeadlines[responseIndex++];
          if (!headline) {
            throw new Error("Unexpected extra Profile Copilot response.");
          }

          return Promise.resolve({
            content: `I prepared ${headline}.`,
            patchGroups: [
              {
                id: providerPatchGroupId,
                summary: `Set headline to ${headline}`,
                applyMode: "needs_review" as const,
                operations: [
                  {
                    operation: "replace_identity_fields" as const,
                    value: { headline },
                  },
                ],
                createdAt: "2026-04-12T10:30:00.000Z",
              },
            ],
          });
        },
      },
    });

    const firstProposal = await workspaceService.proposeProfileCopilotChange(
      "set my headline to the first proposal",
      { surface: "profile", section: "basics" },
    );
    const firstAssistant = firstProposal.profileCopilotMessages.find(
      (message) => message.role === "assistant",
    );
    const firstPatchGroup = firstAssistant?.patchGroups[0];
    expect(firstPatchGroup).toBeDefined();
    if (!firstAssistant || !firstPatchGroup) {
      throw new Error("Expected the first Profile Copilot proposal.");
    }
    expect(firstPatchGroup.id).not.toBe(providerPatchGroupId);

    const secondProposal = await workspaceService.proposeProfileCopilotChange(
      "set my headline to the second proposal",
      { surface: "profile", section: "basics" },
    );
    const assistantMessages = secondProposal.profileCopilotMessages.filter(
      (message) => message.role === "assistant",
    );
    const secondAssistant = assistantMessages[1];
    const secondPatchGroup = secondAssistant?.patchGroups[0];
    expect(secondPatchGroup).toBeDefined();
    if (!secondAssistant || !secondPatchGroup) {
      throw new Error("Expected the second Profile Copilot proposal.");
    }
    expect(secondPatchGroup.id).not.toBe(providerPatchGroupId);
    expect(secondPatchGroup.id).not.toBe(firstPatchGroup.id);

    const rejectedSnapshot =
      await workspaceService.rejectProfileCopilotPatchGroup(firstPatchGroup.id);
    expect(
      rejectedSnapshot.profileCopilotMessages.find(
        (message) => message.id === firstAssistant.id,
      )?.patchGroups[0]?.applyMode,
    ).toBe("rejected");

    const appliedSnapshot =
      await workspaceService.applyProfileCopilotPatchGroup(secondPatchGroup.id);
    expect(appliedSnapshot.profile.headline).toBe("Second proposed headline");
    expect(
      appliedSnapshot.profileCopilotMessages.find(
        (message) => message.id === firstAssistant.id,
      )?.patchGroups[0]?.applyMode,
    ).toBe("rejected");
    expect(
      appliedSnapshot.profileCopilotMessages.find(
        (message) => message.id === secondAssistant.id,
      )?.patchGroups[0]?.applyMode,
    ).toBe("applied");

    const revisions = await repository.listProfileRevisions();
    expect(revisions).toHaveLength(1);
    const appliedRevision = revisions[0];
    expect(appliedRevision).toEqual(
      expect.objectContaining({
        messageId: secondAssistant.id,
        patchGroupId: secondPatchGroup.id,
      }),
    );

    const undoneSnapshot = await workspaceService.undoProfileRevision(
      appliedRevision!.id,
    );
    expect(undoneSnapshot.profile.headline).toBe(createSeed().profile.headline);
    expect(undoneSnapshot.profileRevisions[0]).toEqual(
      expect.objectContaining({
        trigger: "undo",
        restoredFromRevisionId: appliedRevision!.id,
      }),
    );
  });

  test("profile copilot can reject or later apply review-required patch groups", async () => {
    const reviewPatchGroupId = "profile_patch_group_review";
    const assistantMessageId = "assistant_review_message";
    const reviewMessage: ProfileCopilotMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "I prepared a broader preferences cleanup for review.",
      context: { surface: "profile", section: "preferences" },
      patchGroups: [
        {
          id: reviewPatchGroupId,
          summary: "Refresh search preferences",
          applyMode: "needs_review",
          operations: [
            {
              operation: "replace_search_preferences_fields",
              value: {
                targetRoles: [
                  "Principal Product Designer",
                  "Design Systems Lead",
                ],
                locations: ["Remote", "Berlin"],
              },
            },
          ],
          createdAt: "2026-04-12T10:15:00.000Z",
        },
      ],
      createdAt: "2026-04-12T10:15:00.000Z",
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profileCopilotMessages: [reviewMessage],
      },
    });

    const rejectedSnapshot =
      await workspaceService.rejectProfileCopilotPatchGroup(reviewPatchGroupId);
    expect(
      rejectedSnapshot.profileCopilotMessages.find(
        (message) => message.id === assistantMessageId,
      )?.patchGroups[0]?.applyMode,
    ).toBe("rejected");

    const appliedSnapshot =
      await workspaceService.applyProfileCopilotPatchGroup(reviewPatchGroupId);
    const revisions = await repository.listProfileRevisions();

    expect(appliedSnapshot.searchPreferences.targetRoles).toEqual([
      "Principal Product Designer",
      "Design Systems Lead",
    ]);
    expect(appliedSnapshot.searchPreferences.locations).toEqual([
      "Remote",
      "Berlin",
    ]);
    expect(
      appliedSnapshot.profileCopilotMessages.find(
        (message) => message.id === assistantMessageId,
      )?.patchGroups[0]?.applyMode,
    ).toBe("applied");
    expect(revisions[0]?.patchGroupId).toBe(reviewPatchGroupId);
  });

  test("profile copilot leaves unsafe record edits in review mode until the user applies them", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profileSetupState: {
          ...createSeed().profileSetupState,
          status: "in_progress",
          currentStep: "background",
          reviewItems: [
            {
              id: "review_experience_remote",
              step: "background",
              target: {
                domain: "experience",
                key: "record",
                recordId: "experience_1",
              },
              label: "Senior systems designer at Signal Systems",
              reason:
                "Work-history records stay review-first so resume tailoring and fit scoring do not assume the wrong role details.",
              severity: "critical",
              status: "pending",
              proposedValue: null,
              sourceSnippet: "Signal Systems",
              sourceCandidateId: "candidate_experience_remote",
              sourceRunId: "run_1",
              createdAt: "2026-04-14T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "for signal systems i actually worked remote can you fix that for me",
      {
        surface: "setup",
        step: "background",
      },
    );
    const assistantMessage = snapshot.profileCopilotMessages.find(
      (message) => message.role === "assistant",
    );
    const patchGroup = assistantMessage?.patchGroups[0];
    const revisions = await repository.listProfileRevisions();

    expect(patchGroup?.applyMode).toBe("needs_review");
    expect(snapshot.profile.experiences[0]?.workMode).toEqual(["hybrid"]);
    expect(revisions).toHaveLength(0);

    const appliedSnapshot =
      await workspaceService.applyProfileCopilotPatchGroup(patchGroup!.id);

    expect(appliedSnapshot.profile.experiences[0]?.workMode).toEqual([
      "remote",
    ]);
    expect(appliedSnapshot.profileRevisions[0]).toEqual(
      expect.objectContaining({
        trigger: "assistant_patch",
        patchGroupId: patchGroup!.id,
      }),
    );
  });

  test("undoes a profile revision back to the captured snapshot", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    await workspaceService.sendProfileCopilotMessage(
      'Update my headline to "Principal Product Designer"',
      {
        surface: "profile",
        section: "basics",
      },
    );
    const afterApply = await workspaceService.getWorkspaceSnapshot();
    const revisionId = afterApply.profileRevisions[0]?.id;

    expect(afterApply.profile.headline).toBe("Principal Product Designer");
    expect(revisionId).toBeTruthy();

    const undoneSnapshot = await workspaceService.undoProfileRevision(
      revisionId!,
    );

    expect(undoneSnapshot.profile.headline).toBe(seed.profile.headline);
    expect(undoneSnapshot.profileRevisions[0]).toEqual(
      expect.objectContaining({
        trigger: "undo",
        restoredFromRevisionId: revisionId,
      }),
    );
  });

  test("profile copilot can auto-apply a narrative story edit during setup", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profileSetupState: {
          ...createSeed().profileSetupState,
          status: "in_progress",
          currentStep: "narrative",
          reviewItems: [
            {
              id: "review_story",
              step: "narrative",
              target: {
                domain: "narrative",
                key: "professionalStory",
                recordId: null,
              },
              label: "Professional story",
              reason: "Add a concise story before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-12T09:50:00.000Z",
              resolvedAt: null,
            },
          ],
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "Update my professional story to: Product-focused frontend engineer who turns complex workflows into reliable systems.",
      {
        surface: "setup",
        step: "narrative",
      },
    );

    expect(snapshot.profile.narrative.professionalStory).toBe(
      "Product-focused frontend engineer who turns complex workflows into reliable systems.",
    );
    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.id === "review_story",
      )?.status,
    ).toBe("edited");
  });

  test("profile copilot can auto-apply a years-of-experience edit during setup", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          yearsExperience: 6,
        },
        profileSetupState: {
          ...createSeed().profileSetupState,
          status: "in_progress",
          currentStep: "essentials",
          reviewItems: [
            {
              id: "review_years_experience",
              step: "essentials",
              target: {
                domain: "identity",
                key: "yearsExperience",
                recordId: null,
              },
              label: "Years of experience",
              reason:
                "Confirm the imported years of experience before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "7",
              sourceSnippet: "7 years of experience",
              sourceCandidateId: "candidate_years_experience",
              sourceRunId: "run_1",
              createdAt: "2026-04-14T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "change my years of experience from 6 to 7",
      {
        surface: "setup",
        step: "essentials",
      },
    );

    expect(snapshot.profile.yearsExperience).toBe(7);
    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.id === "review_years_experience",
      )?.status,
    ).toBe("confirmed");
    expect(snapshot.profileRevisions[0]).toEqual(
      expect.objectContaining({
        trigger: "assistant_patch",
      }),
    );
  });

  test("profile copilot persists repeated oversized requests and keeps applying grounded edits", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          yearsExperience: 6,
        },
        profileSetupState: {
          ...createSeed().profileSetupState,
          status: "in_progress",
          currentStep: "essentials",
          reviewItems: [
            {
              id: "review_years_experience",
              step: "essentials",
              target: {
                domain: "identity",
                key: "yearsExperience",
                recordId: null,
              },
              label: "Years of experience",
              reason:
                "Confirm the imported years of experience before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "9",
              sourceSnippet: "9 years of experience",
              sourceCandidateId: "candidate_years_experience",
              sourceRunId: "run_1",
              createdAt: "2026-04-14T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
        },
      },
    });
    const filler = "context detail ".repeat(4_000);
    const requests = [
      `${filler} change my years of experience from 6 to 7`,
      `${filler} change my years of experience from 7 to 8`,
      `${filler} change my years of experience from 8 to 9`,
    ];

    for (const request of requests) {
      await workspaceService.sendProfileCopilotMessage(request, {
        surface: "setup",
        step: "essentials",
      });
    }

    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const messages = await repository.listProfileCopilotMessages();

    expect(snapshot.profile.yearsExperience).toBe(9);
    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.id === "review_years_experience",
      )?.status,
    ).toBe("edited");
    expect(snapshot.profileRevisions).toHaveLength(3);
    expect(messages).toHaveLength(6);
    expect(
      messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(requests);
    expect(
      messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(3);
  });
});
