import { describe, expect, test } from "vitest";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService – profile copilot preferences and extended fields", () => {
  test("profile copilot leaves discovery-target rewrites in review mode until the user applies them", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        searchPreferences: {
          ...createSeed().searchPreferences,
          discovery: {
            historyLimit: 5,
            targets: [],
          },
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "add a few job sources for me like linkedin and wellfound",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    const assistantMessage = snapshot.profileCopilotMessages.find((message) => message.role === "assistant");
    const patchGroup = assistantMessage?.patchGroups[0];
    const revisions = await repository.listProfileRevisions();

    expect(patchGroup).toEqual(
      expect.objectContaining({
        applyMode: "needs_review",
      }),
    );
    expect(assistantMessage?.content).toContain("review");
    expect(snapshot.searchPreferences.discovery.targets).toEqual([]);
    expect(revisions).toHaveLength(0);

    const appliedSnapshot = await workspaceService.applyProfileCopilotPatchGroup(patchGroup!.id);

    expect(appliedSnapshot.searchPreferences.discovery.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "LinkedIn Jobs",
          startingUrl: "https://www.linkedin.com/jobs/search/",
        }),
        expect.objectContaining({
          label: "Wellfound",
          startingUrl: "https://wellfound.com/jobs",
        }),
      ]),
    );
    expect(appliedSnapshot.profileRevisions[0]).toEqual(
      expect.objectContaining({
        trigger: "assistant_patch",
      }),
    );
  });

  test("profile copilot can re-enable an existing disabled job source after review", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        searchPreferences: {
          ...createSeed().searchPreferences,
          discovery: {
            historyLimit: 5,
            targets: [
              {
                id: "target_linkedin_jobs",
                label: "LinkedIn Jobs",
                startingUrl: "https://www.linkedin.com/jobs/search/",
                enabled: false,
                adapterKind: "auto",
                customInstructions: null,
                instructionStatus: "missing",
                validatedInstructionId: null,
                draftInstructionId: null,
                lastDebugRunId: null,
                lastVerifiedAt: null,
                staleReason: null,
              },
            ],
          },
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "please add linkedin jobs again",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    const patchGroup = snapshot.profileCopilotMessages.find((message) => message.role === "assistant")
      ?.patchGroups[0];

    expect(patchGroup).toEqual(
      expect.objectContaining({
        applyMode: "needs_review",
        summary: "Re-enable LinkedIn Jobs job source",
      }),
    );
    expect(snapshot.searchPreferences.discovery.targets[0]?.enabled).toBe(false);

    const appliedSnapshot = await workspaceService.applyProfileCopilotPatchGroup(patchGroup!.id);

    expect(appliedSnapshot.searchPreferences.discovery.targets[0]).toEqual(
      expect.objectContaining({
        label: "LinkedIn Jobs",
        enabled: true,
      }),
    );
  });

  test("profile copilot downgrades list-heavy search-preference edits to review mode", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          workEligibility: {
            ...createSeed().profile.workEligibility,
            remoteEligible: false,
          },
        },
        searchPreferences: {
          ...createSeed().searchPreferences,
          workModes: ["hybrid"],
        },
        profileSetupState: {
          ...createSeed().profileSetupState,
          status: "in_progress",
          currentStep: "targeting",
          completedAt: null,
          reviewItems: [
            {
              id: "review_work_mode",
              step: "targeting",
              target: {
                domain: "work_eligibility",
                key: "remoteEligible",
                recordId: null,
              },
              label: "Remote eligibility",
              reason: "Confirm remote preference before discovery starts from the wrong work-mode assumptions.",
              severity: "recommended",
              status: "pending",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
        },
      },
      aiClient: {
        ...createAiClient(),
        reviseCandidateProfile() {
          return Promise.resolve({
            content: "I applied a remote-work update for you.",
            patchGroups: [
              {
                id: "profile_patch_group_remote_preference",
                summary: "Prefer remote work",
                applyMode: "applied",
                operations: [
                  {
                    operation: "replace_search_preferences_fields",
                    value: {
                      workModes: ["remote"],
                    },
                  },
                  {
                    operation: "replace_work_eligibility_fields",
                    value: {
                      remoteEligible: true,
                    },
                  },
                  {
                    operation: "resolve_review_items",
                    reviewItemIds: ["review_work_mode"],
                    resolutionStatus: "edited",
                  },
                ],
                createdAt: "2026-04-14T10:01:00.000Z",
              },
            ],
          });
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "i prefer remote work",
      {
        surface: "setup",
        step: "targeting",
      },
    );
    const assistantMessage = snapshot.profileCopilotMessages.find((message) => message.role === "assistant");
    const patchGroup = assistantMessage?.patchGroups[0];
    const revisions = await repository.listProfileRevisions();

    expect(patchGroup?.applyMode).toBe("needs_review");
    expect(assistantMessage?.content).toContain("review");
    expect(snapshot.searchPreferences.workModes).toEqual(["hybrid"]);
    expect(snapshot.profile.workEligibility.remoteEligible).toBe(false);
    expect(revisions).toHaveLength(0);

    const appliedSnapshot = await workspaceService.applyProfileCopilotPatchGroup(patchGroup!.id);

    expect(appliedSnapshot.searchPreferences.workModes).toEqual(["remote"]);
    expect(appliedSnapshot.profile.workEligibility.remoteEligible).toBe(true);
    expect(
      appliedSnapshot.profileSetupState.reviewItems.find((item) => item.id === "review_work_mode")?.status,
    ).toBe("edited");
  });

  test("profile copilot can apply direct GitHub and work-eligibility updates from natural follow-up chat", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          githubUrl: null,
          workEligibility: {
            ...createSeed().profile.workEligibility,
            requiresVisaSponsorship: null,
            remoteEligible: null,
          },
        },
      },
    });

    const githubSnapshot = await workspaceService.sendProfileCopilotMessage(
      "https://github.com/elian-morava-example",
      {
        surface: "profile",
        section: "preferences",
      },
    );

    expect(githubSnapshot.profile.githubUrl).toBe("https://github.com/elian-morava-example");

    const eligibilitySnapshot = await workspaceService.sendProfileCopilotMessage(
      "no i dont want a visa im fine working remote",
      {
        surface: "profile",
        section: "preferences",
      },
    );

    expect(eligibilitySnapshot.profile.workEligibility.requiresVisaSponsorship).toBe(false);
    expect(eligibilitySnapshot.profile.workEligibility.remoteEligible).toBe(true);
  });

  test("profile copilot can combine multiple preference and identity edits from one request", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          yearsExperience: 6,
          workEligibility: {
            ...createSeed().profile.workEligibility,
            remoteEligible: false,
          },
        },
        searchPreferences: {
          ...createSeed().searchPreferences,
          workModes: ["hybrid"],
          targetSalaryUsd: null,
          discovery: {
            historyLimit: 5,
            targets: [],
          },
        },
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      "make my experience 7 years and my prefered work mode to be remote and make my expected salary to be 200000 and add linkedin, wellfound and kosovajob",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    const assistantMessage = snapshot.profileCopilotMessages.find((message) => message.role === "assistant");
    const patchGroups = assistantMessage?.patchGroups ?? [];

    expect(snapshot.profile.yearsExperience).toBe(7);
    // The seeded workspace never recorded an explicit compensation currency,
    // so the salary command stages for review with needs_clarification instead
    // of silently assuming USD.
    expect(snapshot.searchPreferences.targetSalaryUsd).toBeNull();
    expect(snapshot.searchPreferences.workModes).toEqual(["hybrid"]);
    expect(snapshot.searchPreferences.discovery.targets).toEqual([]);
    expect(patchGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: "Update years of experience", applyMode: "applied" }),
        expect.objectContaining({ summary: "Update expected salary", applyMode: "needs_review" }),
        expect.objectContaining({ summary: "Prefer remote work mode", applyMode: "needs_review" }),
        expect.objectContaining({
          summary: "Add LinkedIn Jobs, Wellfound, and KosovaJob job sources",
          applyMode: "needs_review",
        }),
      ]),
    );

    const salaryPatchGroup = patchGroups.find(
      (patchGroup) => patchGroup.summary === "Update expected salary",
    );
    expect(salaryPatchGroup).toBeTruthy();
    const workModePatchGroup = patchGroups.find((patchGroup) => patchGroup.summary === "Prefer remote work mode");
    const jobSourcesPatchGroup = patchGroups.find(
      (patchGroup) => patchGroup.summary === "Add LinkedIn Jobs, Wellfound, and KosovaJob job sources",
    );
    expect(workModePatchGroup).toBeTruthy();
    expect(jobSourcesPatchGroup).toBeTruthy();

    const afterWorkModeApply = await workspaceService.applyProfileCopilotPatchGroup(workModePatchGroup!.id);
    expect(afterWorkModeApply.searchPreferences.workModes).toEqual(["remote"]);
    expect(afterWorkModeApply.profile.workEligibility.remoteEligible).toBe(true);

    const afterSalaryApply = await workspaceService.applyProfileCopilotPatchGroup(salaryPatchGroup!.id);
    expect(afterSalaryApply.searchPreferences.compensation.maximum).toBe(200000);
    expect(afterSalaryApply.searchPreferences.compensation.currency).toBeNull();
    expect(afterSalaryApply.searchPreferences.compensation.currencyStatus).toBe("needs_clarification");

    const afterJobSourcesApply = await workspaceService.applyProfileCopilotPatchGroup(jobSourcesPatchGroup!.id);
    expect(afterJobSourcesApply.searchPreferences.discovery.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "LinkedIn Jobs" }),
        expect.objectContaining({ label: "Wellfound" }),
        expect.objectContaining({ label: "KosovaJob" }),
      ]),
    );
  });

  test("profile copilot proposes a typed monthly range and location without guessing currency", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    const proposedSnapshot = await workspaceService.sendProfileCopilotMessage(
      "look for jobs around 3-4k a month around New York",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    const patchGroup = proposedSnapshot.profileCopilotMessages
      .flatMap((message) => message.patchGroups)
      .find((group) => group.summary.includes("monthly compensation range"));

    expect(patchGroup).toEqual(
      expect.objectContaining({ applyMode: "needs_review" }),
    );
    expect(proposedSnapshot.searchPreferences.locations).not.toEqual(["New York"]);
    expect(proposedSnapshot.searchPreferences.compensation.currency).not.toBeNull();

    const appliedSnapshot = await workspaceService.applyProfileCopilotPatchGroup(
      patchGroup!.id,
    );

    expect(appliedSnapshot.searchPreferences.locations).toEqual(["New York"]);
    expect(appliedSnapshot.searchPreferences.compensation).toEqual({
      minimum: 3_000,
      maximum: 4_000,
      interval: "month",
      currency: null,
      currencyStatus: "needs_clarification",
    });
    expect(appliedSnapshot.searchPreferences.minimumSalaryUsd).toBeNull();
    expect(appliedSnapshot.searchPreferences.targetSalaryUsd).toBeNull();
  });

  test("profile copilot can auto-apply newly supported bounded field updates", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          preferredDisplayName: null,
          professionalSummary: {
            ...createSeed().profile.professionalSummary,
            strengths: [],
          },
          answerBank: {
            ...createSeed().profile.answerBank,
            selfIntroduction: null,
          },
          applicationIdentity: {
            ...createSeed().profile.applicationIdentity,
            preferredEmail: null,
          },
          skillGroups: {
            ...createSeed().profile.skillGroups,
            coreSkills: [],
          },
          skills: [],
        },
      },
    });

    const displayNameSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my preferred display name to Lex",
      {
        surface: "profile",
        section: "basics",
      },
    );
    expect(displayNameSnapshot.profile.preferredDisplayName).toBe("Lex");

    const strengthsSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my strengths to systems thinking, mentoring, frontend architecture",
      {
        surface: "profile",
        section: "basics",
      },
    );
    expect(strengthsSnapshot.profile.professionalSummary.strengths).toEqual([
      "systems thinking",
      "mentoring",
      "frontend architecture",
    ]);

    const introSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my short self introduction to Senior engineer focused on reliable AI workflows.",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    expect(introSnapshot.profile.answerBank.selfIntroduction).toBe(
      "Senior engineer focused on reliable AI workflows.",
    );

    const preferredEmailSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my preferred application email to jobs@example.com",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    expect(preferredEmailSnapshot.profile.applicationIdentity.preferredEmail).toBe(
      "jobs@example.com",
    );

    const coreSkillsSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my core skills to React, TypeScript, Node.js",
      {
        surface: "profile",
        section: "basics",
      },
    );
    expect(coreSkillsSnapshot.profile.skillGroups.coreSkills).toEqual([
      "React",
      "TypeScript",
      "Node.js",
    ]);

    const profileSkillsSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my overall skills to React, TypeScript, Electron",
      {
        surface: "profile",
        section: "basics",
      },
    );
    expect(profileSkillsSnapshot.profile.skills).toEqual([
      "React",
      "TypeScript",
      "Electron",
    ]);
  });

  test("profile copilot keeps broader list-heavy preference rewrites in review mode while applying scalar preferences", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          workEligibility: {
            ...createSeed().profile.workEligibility,
            availableStartDate: null,
          },
        },
      },
    });

    const availableStartDateSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my available start date to 2026-05-01",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    expect(availableStartDateSnapshot.profile.workEligibility.availableStartDate).toBe("2026-05-01");

    const salaryCurrencySnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my salary currency to eur",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    expect(salaryCurrencySnapshot.searchPreferences.salaryCurrency).toBe("EUR");
    expect(salaryCurrencySnapshot.searchPreferences.compensation).toEqual(
      expect.objectContaining({
        currency: "EUR",
        currencyStatus: "explicit",
      }),
    );

    const tailoringModeSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my tailoring mode to aggressive",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    // The strength is half of the resume level (Settings > AI behavior >
    // Resumes, and it can move a person off Original), so it arrives as a
    // resume-level card that waits for Apply & save instead of applying
    // itself.
    expect(tailoringModeSnapshot.searchPreferences.tailoringMode).toBe("balanced");
    const tailoringPatchGroup = tailoringModeSnapshot.profileCopilotMessages
      .flatMap((message) => message.patchGroups)
      .find((patchGroup) =>
        patchGroup.operations.some(
          (operation) => operation.operation === "set_resume_approach",
        ),
      );
    expect(tailoringPatchGroup).toEqual(
      expect.objectContaining({
        applyMode: "needs_review",
        operations: [{ operation: "set_resume_approach", value: "aggressive" }],
      }),
    );
    const tailoringAppliedSnapshot =
      await workspaceService.applyProfileCopilotPatchGroup(tailoringPatchGroup!.id);
    expect(tailoringAppliedSnapshot.searchPreferences.tailoringMode).toBe("aggressive");

    const reviewModeSnapshot = await workspaceService.sendProfileCopilotMessage(
      "set my preferred locations to Berlin, Prishtina, Remote",
      {
        surface: "profile",
        section: "preferences",
      },
    );
    const reviewPatchGroup = reviewModeSnapshot.profileCopilotMessages
      .flatMap((message) => message.patchGroups)
      .find((patchGroup) => patchGroup.summary === "Update preferred locations");
    const revisions = await repository.listProfileRevisions();

    expect(reviewPatchGroup).toEqual(
      expect.objectContaining({
        summary: "Update preferred locations",
        applyMode: "needs_review",
      }),
    );
    expect(reviewModeSnapshot.searchPreferences.locations).toEqual(["Remote", "London"]);
    expect(revisions.length).toBeGreaterThanOrEqual(3);

    const appliedSnapshot = await workspaceService.applyProfileCopilotPatchGroup(reviewPatchGroup!.id);
    expect(appliedSnapshot.searchPreferences.locations).toEqual([
      "Berlin",
      "Prishtina",
      "Remote",
    ]);
  });
});
