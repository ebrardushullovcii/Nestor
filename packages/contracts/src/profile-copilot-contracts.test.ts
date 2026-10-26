import { describe, expect, test } from "vitest";

import {
  ProfileCoreListPatchFieldsSchema,
  ProfileCopilotMessageSchema,
  ProfileCopilotPatchGroupSchema,
  ProfileCopilotReplySchema,
  ProfileIdentityPatchFieldsSchema,
  ProfileRevisionSchema,
} from "./index";

describe("contracts profile copilot schemas", () => {
  test("parses assistant messages with typed patch groups", () => {
    const message = ProfileCopilotMessageSchema.parse({
      id: "profile_message_1",
      role: "assistant",
      content:
        "I tightened your positioning and suggested a stronger target role list.",
      context: {
        surface: "setup",
        step: "essentials",
      },
      patchGroups: [
        {
          id: "profile_patch_group_1",
          summary: "Refine headline and summary",
          applyMode: "needs_review",
          operations: [
            {
              operation: "replace_identity_fields",
              value: {
                headline: "Senior Product Designer",
                summary:
                  "Designs operational systems that help teams move faster.",
              },
            },
            {
              operation: "resolve_review_items",
              reviewItemIds: ["review_1"],
              resolutionStatus: "edited",
            },
          ],
          createdAt: "2026-04-12T10:00:00.000Z",
        },
      ],
      createdAt: "2026-04-12T10:00:00.000Z",
    });

    expect(message.context.surface).toBe("setup");
    expect(message.patchGroups[0]?.operations).toHaveLength(2);
  });

  test("parses patch groups for structured record upserts", () => {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_patch_group_2",
      summary: "Add one reusable proof point",
      applyMode: "needs_review",
      operations: [
        {
          operation: "upsert_proof_point",
          record: {
            id: null,
            title: "Improved activation",
            claim:
              "Raised product activation by 18% after redesigning onboarding.",
            heroMetric: "+18% activation",
            supportingContext: null,
            roleFamilies: ["product_design"],
            projectIds: [],
            linkIds: [],
          },
        },
      ],
      createdAt: "2026-04-12T10:05:00.000Z",
    });

    expect(patchGroup.operations[0]?.operation).toBe("upsert_proof_point");
  });

  test("still parses review-required record patch groups", () => {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_patch_group_unsafe",
      summary: "Remove one experience record",
      applyMode: "needs_review",
      operations: [
        {
          operation: "remove_experience_record",
          recordId: "experience_1",
        },
      ],
      createdAt: "2026-04-12T10:05:00.000Z",
    });

    expect(patchGroup.applyMode).toBe("needs_review");
  });

  test("keeps omitted experience fields omitted and explicit false values", () => {
    const base = {
      id: "profile_patch_group_experience_partial",
      summary: "Update one role",
      applyMode: "needs_review" as const,
      createdAt: "2026-04-12T10:05:00.000Z",
    };
    const locationPatch = ProfileCopilotPatchGroupSchema.parse({
      ...base,
      operations: [
        {
          operation: "upsert_experience_record",
          record: { id: "experience_1", location: "Hamburg, Germany" },
        },
      ],
    });
    const endingPatch = ProfileCopilotPatchGroupSchema.parse({
      ...base,
      id: "profile_patch_group_experience_ending",
      operations: [
        {
          operation: "upsert_experience_record",
          record: { id: "experience_1", isCurrent: false },
        },
      ],
    });

    expect(locationPatch.operations[0]).toEqual({
      operation: "upsert_experience_record",
      record: { id: "experience_1", location: "Hamburg, Germany" },
    });
    expect(endingPatch.operations[0]).toEqual({
      operation: "upsert_experience_record",
      record: { id: "experience_1", isCurrent: false },
    });
  });

  test("keeps record upserts partial and accepts explicit clears", () => {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_patch_group_partial_records",
      summary: "Update existing cards",
      applyMode: "needs_review",
      operations: [
        {
          operation: "upsert_experience_record",
          record: {
            id: "experience_1",
            location: null,
            achievements: [],
          },
        },
        {
          operation: "upsert_education_record",
          record: { id: "education_1", summary: "Updated focus" },
        },
      ],
      createdAt: "2026-04-12T10:05:00.000Z",
    });

    expect(patchGroup.operations).toEqual([
      {
        operation: "upsert_experience_record",
        record: {
          id: "experience_1",
          location: null,
          achievements: [],
        },
      },
      {
        operation: "upsert_education_record",
        record: { id: "education_1", summary: "Updated focus" },
      },
    ]);
  });

  test("rejects record upserts with no changed fields", () => {
    const result = ProfileCopilotPatchGroupSchema.safeParse({
      id: "profile_patch_group_empty_record",
      summary: "No actual update",
      applyMode: "needs_review",
      operations: [
        {
          operation: "upsert_education_record",
          record: { id: "education_1" },
        },
      ],
      createdAt: "2026-04-12T10:05:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  test("parses a complete duplicate-free education order", () => {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_patch_group_reorder_education",
      summary: "Reorder education",
      applyMode: "needs_review",
      operations: [
        {
          operation: "reorder_education_records",
          orderedRecordIds: ["education_2", "education_1"],
        },
      ],
      createdAt: "2026-04-12T10:05:00.000Z",
    });

    expect(patchGroup.operations[0]).toEqual({
      operation: "reorder_education_records",
      orderedRecordIds: ["education_2", "education_1"],
    });
    expect(
      ProfileCopilotPatchGroupSchema.safeParse({
        ...patchGroup,
        operations: [
          {
            operation: "reorder_education_records",
            orderedRecordIds: ["education_1", "education_1"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("parses newly supported top-level profile list field patch groups", () => {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_patch_group_lists",
      summary: "Update skills",
      applyMode: "applied",
      operations: [
        {
          operation: "replace_profile_list_fields",
          value: {
            skills: ["React", "TypeScript", "Electron"],
          },
        },
      ],
      createdAt: "2026-04-15T11:00:00.000Z",
    });

    expect(patchGroup.operations[0]).toEqual({
      operation: "replace_profile_list_fields",
      value: { skills: ["React", "TypeScript", "Electron"] },
    });
  });

  test("accepts explicit nullable and list clears but still rejects empty patches", () => {
    expect(
      ProfileIdentityPatchFieldsSchema.parse({ secondaryEmail: null }),
    ).toEqual({
      secondaryEmail: null,
    });
    expect(ProfileCoreListPatchFieldsSchema.parse({ skills: [] })).toEqual({
      skills: [],
    });

    expect(ProfileIdentityPatchFieldsSchema.safeParse({}).success).toBe(false);
    expect(ProfileCoreListPatchFieldsSchema.safeParse({}).success).toBe(false);
  });

  test("parses newly supported approval-mode preference updates", () => {
    const patchGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_patch_group_approval_mode",
      summary: "Update approval mode",
      applyMode: "needs_review",
      operations: [
        {
          operation: "replace_search_preferences_fields",
          value: {
            approvalMode: "full_auto",
          },
        },
      ],
      createdAt: "2026-04-15T11:00:00.000Z",
    });

    expect(patchGroup.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { approvalMode: "full_auto" },
    });
  });

  test("parses provider replies and revision snapshots", () => {
    const reply = ProfileCopilotReplySchema.parse({
      content:
        "I found one safe wording improvement and one proof-point suggestion.",
      patchGroups: [
        {
          id: "profile_patch_group_3",
          summary: "Clarify professional story",
          applyMode: "applied",
          operations: [
            {
              operation: "replace_narrative_fields",
              value: {
                professionalStory:
                  "I design workflow systems that remove friction for both users and operators.",
              },
            },
          ],
          createdAt: "2026-04-12T10:06:00.000Z",
        },
      ],
    });

    const revision = ProfileRevisionSchema.parse({
      id: "profile_revision_1",
      createdAt: "2026-04-12T10:06:00.000Z",
      reason: "Assistant request: improve my setup story",
      trigger: "assistant_patch",
      messageId: "profile_message_2",
      patchGroupId: "profile_patch_group_3",
      restoredFromRevisionId: null,
      snapshotProfile: {
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        preferredDisplayName: null,
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        currentCity: null,
        currentRegion: null,
        currentCountry: null,
        timeZone: null,
        yearsExperience: 10,
        email: "alex@example.com",
        secondaryEmail: null,
        phone: null,
        portfolioUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        personalWebsiteUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex.pdf",
          uploadedAt: "2026-04-12T09:55:00.000Z",
          storagePath: "/tmp/alex.pdf",
          textContent: "Alex Vanguard",
          textUpdatedAt: "2026-04-12T09:55:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-04-12T09:56:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        workEligibility: {},
        professionalSummary: {},
        narrative: {},
        proofBank: [],
        applicationIdentity: {},
        skillGroups: {},
        targetRoles: [],
        locations: [],
        skills: [],
        experiences: [],
        education: [],
        certifications: [],
        links: [],
        projects: [],
        spokenLanguages: [],
      },
      snapshotSearchPreferences: {
        targetRoles: ["Product Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
        discovery: { historyLimit: 5, targets: [] },
      },
      snapshotProfileSetupState: {
        status: "in_progress",
        currentStep: "narrative",
        completedAt: null,
        reviewItems: [],
        lastResumedAt: null,
      },
    });

    expect(reply.patchGroups[0]?.applyMode).toBe("applied");
    expect(revision.patchGroupId).toBe("profile_patch_group_3");
  });
});
