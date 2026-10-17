import { describe, expect, test } from "vitest";
import {
  ResumeAssistantMessageSchema,
  ResumeClaimAssessmentSchema,
  ResumeDraftPatchSchema,
  ResumeDraftSchema,
  SavedJobSchema,
} from "@nestor/contracts";
import {
  buildRecentResumeAssistantConversation,
  checkResumeAssistantProposal,
  findResumeAssistantPatchesDroppedOnSave,
  listResumeLinesToConfirm,
} from "./resume-assistant-conversation";
import { fakeResumeClaimCheck } from "../workspace-service.test-runtimes";
import { createSeed } from "../workspace-service.test-fixtures";

const at = "2026-09-24T10:00:00.000Z";

function message(input: Record<string, unknown>) {
  return ResumeAssistantMessageSchema.parse({
    jobId: "job_1",
    patches: [],
    createdAt: at,
    ...input,
  });
}

function patch(input: Record<string, unknown>) {
  return ResumeDraftPatchSchema.parse({
    draftId: "draft_1",
    appliedAt: at,
    origin: "assistant",
    ...input,
  });
}

describe("buildRecentResumeAssistantConversation", () => {
  test("keeps the last turns oldest first, with each proposal's changes and status", () => {
    const messages = [
      message({ id: "m0", role: "user", content: "An old question" }),
      message({
        id: "m1",
        role: "user",
        content: "What would you change to fit this job better?",
      }),
      message({
        id: "m2",
        role: "assistant",
        content: "I prepared 2 resume edits.",
        proposalStatus: "accepted",
        resolvedPatchIds: ["resume_patch_2"],
        patches: [
          patch({
            id: "resume_patch_1",
            operation: "replace_section_text",
            targetSectionId: "summary",
            newText: "TypeScript-first frontend engineer.",
          }),
          patch({
            id: "resume_patch_2",
            operation: "toggle_include",
            targetSectionId: "skills",
            targetBulletId: "skill_sql",
            newIncluded: false,
          }),
        ],
      }),
      message({ id: "m3", role: "user", content: "the second one" }),
    ];

    const turns = buildRecentResumeAssistantConversation(messages, 3);

    expect(turns.map((turn) => turn.content)).toEqual([
      "What would you change to fit this job better?",
      "I prepared 2 resume edits.",
      "the second one",
    ]);
    expect(turns[0]?.proposal).toBeNull();
    expect(turns[1]?.proposal).toEqual({
      status: "accepted",
      changes: [
        {
          patchId: "resume_patch_1",
          operation: "replace_section_text",
          sectionId: "summary",
          entryId: null,
          bulletId: null,
          newText: "TypeScript-first frontend engineer.",
          applied: false,
        },
        {
          patchId: "resume_patch_2",
          operation: "toggle_include",
          sectionId: "skills",
          entryId: null,
          bulletId: "skill_sql",
          newText: "(hide)",
          applied: true,
        },
      ],
    });
  });

  test("a pending proposal reads as waiting for review", () => {
    const [turn] = buildRecentResumeAssistantConversation([
      message({
        id: "m1",
        role: "assistant",
        content: "One edit.",
        proposalStatus: "pending",
        patches: [
          patch({
            id: "resume_patch_1",
            operation: "replace_section_text",
            targetSectionId: "summary",
            newText: "Shorter summary.",
          }),
        ],
      }),
    ]);

    expect(turn?.proposal?.status).toBe("waiting_for_review");
    expect(turn?.proposal?.changes[0]?.applied).toBeNull();
  });
});

describe("checkResumeAssistantProposal", () => {
  const draft = ResumeDraftSchema.parse({
    id: "draft_1",
    jobId: "job_1",
    templateId: "classic_ats",
    status: "draft",
    identity: null,
    sections: [
      {
        id: "summary",
        kind: "summary",
        label: "Summary",
        text: "Frontend engineer building React design systems.",
        origin: "user_edited",
        locked: false,
        included: true,
        sortOrder: 0,
        updatedAt: at,
      },
    ],
    targetPageCount: 1,
    generationMethod: null,
    createdAt: at,
    updatedAt: at,
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
  });
  const job = SavedJobSchema.parse({
    id: "job_1",
    source: "target_site",
    sourceJobId: "job_1",
    discoveryMethod: "catalog_seed",
    canonicalUrl: "https://example.test/jobs/1",
    title: "Frontend Engineer",
    company: "Example",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: at,
    discoveredAt: at,
    salaryText: null,
    summary: "Build React interfaces.",
    description: "Build React interfaces.",
    keySkills: ["React"],
    status: "shortlisted",
    matchAssessment: {
      score: 80,
      reasons: [],
      gaps: [],
    },
  });

  test("a change that cannot be applied comes back as an apply error, not a crash", async () => {
    const result = await checkResumeAssistantProposal({
      aiClient: {},
      baselineDraft: draft,
      job,
      profile: undefined as never,
      patches: [
        patch({
          id: "resume_patch_1",
          operation: "replace_section_text",
          targetSectionId: "missing_section",
          newText: "Anything.",
        }),
      ],
    });

    expect(result.findings).toEqual([]);
    expect(result.applyError).toContain("missing_section");
  });

  test("a skill the profile does not show stays when saved, and the fact check judges it", async () => {
    const profile = {
      ...createSeed().profile,
      skills: ["React", "TypeScript"],
    };
    const skillsDraft = ResumeDraftSchema.parse({
      ...draft,
      sections: [
        {
          id: "skills",
          kind: "skills",
          label: "Core Skills",
          bullets: [
            {
              id: "skill_react",
              text: "React",
              origin: "user_edited",
              locked: false,
              included: true,
              updatedAt: at,
            },
          ],
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 0,
          updatedAt: at,
        },
      ],
    });
    const storybook = patch({
      id: "resume_patch_1",
      operation: "insert_bullet",
      targetSectionId: "skills",
      newText: "Storybook",
    });

    expect(
      findResumeAssistantPatchesDroppedOnSave({
        baselineDraft: skillsDraft,
        patches: [storybook],
        job,
        profile,
      }),
    ).toEqual([]);
    const checked = await checkResumeAssistantProposal({
      aiClient: {
        checkResumeClaims: fakeResumeClaimCheck({ Storybook: "unsupported" }),
      },
      baselineDraft: skillsDraft,
      patches: [storybook],
      job,
      profile,
    });
    expect(
      checked.findings.flatMap((finding) =>
        finding.flaggedText ? [finding.flaggedText] : [],
      ),
    ).toEqual(["Storybook"]);
  });
});

describe("listResumeLinesToConfirm", () => {
  test("lists only unbacked generated lines not yet approved; stretches are not chores", () => {
    const assessment = (input: Record<string, unknown>) =>
      ResumeClaimAssessmentSchema.parse({
        field: "section_bullet",
        sectionId: "section_skills",
        claimOrigin: "assistant_edited",
        contentHash: "fnv1a32:0000000a",
        verifier: "deterministic_candidate_evidence_v2",
        assessedAt: at,
        ...input,
      });
    const waiting = assessment({
      id: "a1",
      bulletId: "skill_sql",
      claimText: "SQL",
      status: "unsupported",
    });
    const kept = assessment({
      id: "a2",
      bulletId: "skill_apis",
      claimText: "APIs",
      status: "unsupported",
      contentHash: "fnv1a32:0000000b",
    });
    const stretch = assessment({
      id: "a4",
      bulletId: "skill_go",
      claimText: "Go",
      status: "confirm_needed",
      contentHash: "fnv1a32:0000000c",
    });
    const exact = assessment({
      id: "a3",
      bulletId: "skill_react",
      claimText: "React",
      status: "exact",
    });

    expect(
      listResumeLinesToConfirm({
        draft: {
          id: "draft_1",
          claimConfirmations: [
            {
              draftId: "draft_1",
              field: "section_bullet",
              sectionId: "section_skills",
              entryId: null,
              bulletId: "skill_apis",
              confirmedClaimContentHash: "fnv1a32:0000000b",
            },
          ] as never,
        },
        claimAssessments: [waiting, kept, exact, stretch],
      }),
    ).toEqual([
      {
        text: "SQL",
        sectionId: "section_skills",
        entryId: null,
        bulletId: "skill_sql",
      },
    ]);
  });
});
