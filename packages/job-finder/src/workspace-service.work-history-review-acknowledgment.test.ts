import type {
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  WorkHistoryReviewSuggestion,
} from "@nordri/contracts";
import type { BrowserSessionRuntime } from "@nordri/browser-runtime";
import { fnv1a32 } from "@nordri/core";
import { describe, expect, test } from "vitest";
import {
  listUnresolvedWorkHistoryOmissionSuggestions,
  matchWorkHistoryReviewAcknowledgment,
} from "./internal/resume-workspace-helpers";
import type { JobFinderWorkspaceService } from "./internal/workspace-service-contracts";
import { createAiClient } from "./workspace-service.test-runtimes";
import {
  createWorkspaceServiceHarness,
  createBrowserRuntime,
  createSeed,
} from "./workspace-service.test-support";

const HIDDEN_SALES_ROLE_ID = "experience_sales_bridge";
const HIDDEN_GAP_ROLE_ID = "experience_priority_gap";

const hiddenSalesExperience = {
  id: HIDDEN_SALES_ROLE_ID,
  companyName: "Bright Market",
  companyUrl: null,
  title: "Sales Operations Associate",
  employmentType: "Full-time",
  location: "Remote",
  workMode: ["remote" as const],
  startDate: "2019-01",
  endDate: "2019-12",
  isCurrent: false,
  isDraft: false,
  summary: "Maintained customer operations reporting.",
  achievements: ["Prepared weekly pipeline reporting for account teams."],
  skills: [],
  domainTags: [],
  peopleManagementScope: null,
  ownershipScope: null,
};

const hiddenGapExperience = {
  ...hiddenSalesExperience,
  id: HIDDEN_GAP_ROLE_ID,
  companyName: "Quiet Ledger",
  title: "Back Office Coordinator",
  startDate: "2018-02",
  endDate: "2018-11",
  summary: "Tracked invoice queues for a small operations team.",
  achievements: ["Reconciled weekly invoice backlogs."],
};

function createHiddenRoleHarness(options?: {
  browserRuntime?: BrowserSessionRuntime;
}) {
  const seed = createSeed();
  const baseAiClient = createAiClient();

  return createWorkspaceServiceHarness({
    seed: {
      ...seed,
      profile: {
        ...seed.profile,
        experiences: [
          ...seed.profile.experiences,
          hiddenSalesExperience,
          hiddenGapExperience,
        ],
      },
      searchPreferences: {
        ...seed.searchPreferences,
        tailoringMode: "balanced",
      },
    },
    aiClient: {
      ...baseAiClient,
      async createResumeDraft(input) {
        const base = await baseAiClient.createResumeDraft(input);

        return {
          ...base,
          coverageMetadata: [
            ...base.coverageMetadata.filter(
              (metadata) =>
                metadata.profileRecordId !== HIDDEN_SALES_ROLE_ID &&
                metadata.profileRecordId !== HIDDEN_GAP_ROLE_ID,
            ),
            {
              profileRecordId: HIDDEN_SALES_ROLE_ID,
              classification: "suggested_hidden" as const,
              careerFamilyFit: "weak" as const,
              reasons: ["weak career-family fit"],
              reviewGuidance: [
                "Hidden by default for review: this role has a weaker career-family fit for the target job.",
              ],
              coversMeaningfulGap: false,
            },
            {
              profileRecordId: HIDDEN_GAP_ROLE_ID,
              classification: "suggested_hidden" as const,
              careerFamilyFit: "unrelated" as const,
              reasons: ["covers a priority gap"],
              reviewGuidance: [
                "Hidden for review: this role could close a priority gap for the target job.",
              ],
              coversMeaningfulGap: true,
            },
          ],
        };
      },
    },
    ...(options?.browserRuntime
      ? { browserRuntime: options.browserRuntime }
      : {}),
  });
}

type AcknowledgeInput = Extract<
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  { intent: "acknowledge" }
>;

type EligibleOmissionSuggestion = WorkHistoryReviewSuggestion & {
  kind: "weak_fit" | "gap_coverage";
  action: "consider_showing";
};

function buildAcknowledgeInput(input: {
  jobId: string;
  draftId: string;
  draftUpdatedAt: string;
  suggestion: EligibleOmissionSuggestion;
}): AcknowledgeInput {
  return {
    intent: "acknowledge",
    jobId: input.jobId,
    draftId: input.draftId,
    expectedDraftUpdatedAt: input.draftUpdatedAt,
    suggestionId: input.suggestion.id,
    profileRecordId: input.suggestion.profileRecordId,
    kind: input.suggestion.kind,
    action: input.suggestion.action,
    messageContentHash: input.suggestion.messageContentHash,
    reason: "intentional_omission",
  };
}

function isEligibleOmissionSuggestion(
  suggestion: WorkHistoryReviewSuggestion,
): suggestion is EligibleOmissionSuggestion {
  return (
    (suggestion.kind === "weak_fit" || suggestion.kind === "gap_coverage") &&
    suggestion.action === "consider_showing"
  );
}

async function generateWithSuggestions(
  service: Pick<
    JobFinderWorkspaceService,
    "generateResume" | "getResumeWorkspace"
  >,
) {
  await service.generateResume("job_ready");
  const workspace = await service.getResumeWorkspace("job_ready");
  const omissionSuggestions = workspace.workHistoryReviewSuggestions.filter(
    isEligibleOmissionSuggestion,
  );

  if (omissionSuggestions.length < 2) {
    throw new Error(
      "Expected two hidden-role omission suggestions for the acknowledgment scenarios.",
    );
  }

  return {
    workspace,
    salesSuggestion: omissionSuggestions.find(
      (suggestion) => suggestion.profileRecordId === HIDDEN_SALES_ROLE_ID,
    )!,
    gapSuggestion: omissionSuggestions.find(
      (suggestion) => suggestion.profileRecordId === HIDDEN_GAP_ROLE_ID,
    )!,
  };
}

describe("work-history review acknowledgment commands", () => {
  test("projects eligible suggestions with server-computed fnv1a32 message hashes", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion, gapSuggestion } =
      await generateWithSuggestions(workspaceService);

    expect(salesSuggestion).toMatchObject({
      id: `work_history_review_${HIDDEN_SALES_ROLE_ID}`,
      kind: "weak_fit",
      action: "consider_showing",
    });
    expect(gapSuggestion).toMatchObject({
      kind: "gap_coverage",
      action: "consider_showing",
    });

    const storedDraft = await repository.getResumeDraftByJobId("job_ready");
    expect(storedDraft?.workHistoryReviewAcknowledgments).toEqual([]);
    expect(fnv1a32(salesSuggestion.message)).toBe(
      salesSuggestion.messageContentHash,
    );
    expect(fnv1a32(gapSuggestion.message)).toBe(
      gapSuggestion.messageContentHash,
    );
    expect(workspace.draft.updatedAt).toBeTruthy();
  });

  test("approval never waits on a hidden-role decision; an exact acknowledgment still stores server-owned metadata", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion } =
      await generateWithSuggestions(workspaceService);
    await workspaceService.setWorkHistoryReviewAcknowledgment(
      buildAcknowledgeInput({
        jobId: "job_ready",
        draftId: workspace.draft.id,
        draftUpdatedAt: (await repository.getResumeDraftByJobId("job_ready"))!
          .updatedAt,
        suggestion: salesSuggestion,
      }),
    );

    const storedDraft = await repository.getResumeDraftByJobId("job_ready");
    const acknowledgments = storedDraft!.workHistoryReviewAcknowledgments;

    expect(acknowledgments).toHaveLength(1);
    expect(acknowledgments[0]).toMatchObject({
      draftId: workspace.draft.id,
      profileRecordId: HIDDEN_SALES_ROLE_ID,
      kind: "weak_fit",
      action: "consider_showing",
      messageContentHash: salesSuggestion.messageContentHash,
      reason: "intentional_omission",
    });
    expect(
      acknowledgments[0]!.id.startsWith(
        `work_history_ack_${HIDDEN_SALES_ROLE_ID}_`,
      ),
    ).toBe(true);
    expect(Number.isNaN(Date.parse(acknowledgments[0]!.acknowledgedAt))).toBe(
      false,
    );
    expect(storedDraft!.status).toBe("needs_review");
  });

  test("approves once every omission is acknowledged and the export is fresh", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion, gapSuggestion } =
      await generateWithSuggestions(workspaceService);

    for (const suggestion of [salesSuggestion, gapSuggestion]) {
      await workspaceService.setWorkHistoryReviewAcknowledgment(
        buildAcknowledgeInput({
          jobId: "job_ready",
          draftId: workspace.draft.id,
          draftUpdatedAt: (await repository.getResumeDraftByJobId("job_ready"))!
            .updatedAt,
          suggestion,
        }),
      );
    }

    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;
    const approved = await workspaceService.approveResume(
      "job_ready",
      exportArtifact.id,
    );

    expect(
      approved.resumeDrafts.find((draft) => draft.jobId === "job_ready"),
    ).toMatchObject({ status: "approved" });
  });

  test("rejects every identity mismatch and leaves the draft untouched", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion } =
      await generateWithSuggestions(workspaceService);
    const before = await repository.getResumeDraftByJobId("job_ready");
    const revisionsBefore = await repository.listResumeDraftRevisions(
      workspace.draft.id,
    );
    const validInput = buildAcknowledgeInput({
      jobId: "job_ready",
      draftId: workspace.draft.id,
      draftUpdatedAt: workspace.draft.updatedAt,
      suggestion: salesSuggestion,
    });

    const mismatches: Array<
      [JobFinderSetWorkHistoryReviewAcknowledgmentInput, RegExp]
    > = [
      [
        { ...validInput, expectedDraftUpdatedAt: "2026-03-20T09:00:00.000Z" },
        /changed before this work-history decision/i,
      ],
      [
        { ...validInput, draftId: "resume_draft_other" },
        /Unable to find resume draft/i,
      ],
      [
        { ...validInput, jobId: "job_generating" },
        /Unable to find resume draft/i,
      ],
      [
        { ...validInput, suggestionId: "work_history_review_unknown_role" },
        /no longer projected/i,
      ],
      [
        { ...validInput, profileRecordId: "experience_someone_else" },
        /no longer matches profile record/i,
      ],
      [{ ...validInput, kind: "gap_coverage" }, /changed kind or action/i],
      [
        { ...validInput, messageContentHash: "fnv1a32:00000000" },
        /guidance text changed/i,
      ],
      [
        {
          ...validInput,
          kind: "compact_recommended" as const,
          action: "keep_compact" as const,
          reason: "intentional_compaction" as const,
        },
        /intentional_omission/i,
      ],
    ];

    for (const [input, pattern] of mismatches) {
      await expect(
        workspaceService.setWorkHistoryReviewAcknowledgment(input),
      ).rejects.toThrow(pattern);
    }

    const after = await repository.getResumeDraftByJobId("job_ready");
    const revisionsAfter = await repository.listResumeDraftRevisions(
      workspace.draft.id,
    );

    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after!.workHistoryReviewAcknowledgments).toEqual([]);
    expect(revisionsAfter).toHaveLength(revisionsBefore.length);
  });

  test("deduplicates repeated acknowledgments deterministically", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion } =
      await generateWithSuggestions(workspaceService);
    const input = buildAcknowledgeInput({
      jobId: "job_ready",
      draftId: workspace.draft.id,
      draftUpdatedAt: workspace.draft.updatedAt,
      suggestion: salesSuggestion,
    });

    await workspaceService.setWorkHistoryReviewAcknowledgment(input);
    const afterFirst = await repository.getResumeDraftByJobId("job_ready");

    await workspaceService.setWorkHistoryReviewAcknowledgment({
      ...input,
      expectedDraftUpdatedAt: afterFirst!.updatedAt,
    });
    const afterSecond = await repository.getResumeDraftByJobId("job_ready");

    expect(afterSecond!.workHistoryReviewAcknowledgments).toHaveLength(1);
    expect(afterSecond!.workHistoryReviewAcknowledgments[0]!.id).toBe(
      afterFirst!.workHistoryReviewAcknowledgments[0]!.id,
    );
    expect(afterSecond!.updatedAt).toBe(afterFirst!.updatedAt);
  });

  test("removes only records belonging to the draft and rejects unknown ids", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion } =
      await generateWithSuggestions(workspaceService);

    await workspaceService.setWorkHistoryReviewAcknowledgment(
      buildAcknowledgeInput({
        jobId: "job_ready",
        draftId: workspace.draft.id,
        draftUpdatedAt: workspace.draft.updatedAt,
        suggestion: salesSuggestion,
      }),
    );
    const acknowledgedState =
      await repository.getResumeDraftByJobId("job_ready");
    const acknowledgmentId =
      acknowledgedState!.workHistoryReviewAcknowledgments[0]!.id;

    await expect(
      workspaceService.setWorkHistoryReviewAcknowledgment({
        intent: "remove",
        jobId: "job_ready",
        draftId: workspace.draft.id,
        expectedDraftUpdatedAt: acknowledgedState!.updatedAt,
        acknowledgmentId: "work_history_ack_missing",
      }),
    ).rejects.toThrow(/Unable to find work-history review acknowledgment/i);

    await workspaceService.setWorkHistoryReviewAcknowledgment({
      intent: "remove",
      jobId: "job_ready",
      draftId: workspace.draft.id,
      expectedDraftUpdatedAt: acknowledgedState!.updatedAt,
      acknowledgmentId,
    });

    const clearedDraft = await repository.getResumeDraftByJobId("job_ready");

    expect(clearedDraft!.workHistoryReviewAcknowledgments).toEqual([]);

    await expect(
      workspaceService.setWorkHistoryReviewAcknowledgment({
        intent: "remove",
        jobId: "job_ready",
        draftId: workspace.draft.id,
        expectedDraftUpdatedAt: clearedDraft!.updatedAt,
        acknowledgmentId,
      }),
    ).rejects.toThrow(/Unable to find work-history review acknowledgment/i);
  });

  test("stale acknowledgments never satisfy gates after the projection changes", async () => {
    const { workspaceService } = createHiddenRoleHarness();
    const { workspace, salesSuggestion } =
      await generateWithSuggestions(workspaceService);

    await workspaceService.setWorkHistoryReviewAcknowledgment(
      buildAcknowledgeInput({
        jobId: "job_ready",
        draftId: workspace.draft.id,
        draftUpdatedAt: workspace.draft.updatedAt,
        suggestion: salesSuggestion,
      }),
    );

    // Show the hidden role: the omission disappears because the content now
    // includes the role, not because the stale acknowledgment says so.
    const patchedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const experienceSection = patchedWorkspace.draft.sections.find(
      (section) => section.id === salesSuggestion.sectionId,
    )!;
    const targetEntry = experienceSection.entries.find(
      (entry) => entry.profileRecordId === HIDDEN_SALES_ROLE_ID,
    )!;

    await workspaceService.saveResumeDraft({
      ...patchedWorkspace.draft,
      sections: patchedWorkspace.draft.sections.map((section) =>
        section.id === experienceSection.id
          ? {
              ...section,
              entries: section.entries.map((entry) =>
                entry.id === targetEntry.id
                  ? { ...entry, included: true }
                  : entry,
              ),
            }
          : section,
      ),
    });

    const savedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const reshowedSuggestion = savedWorkspace.workHistoryReviewSuggestions.find(
      (suggestion) => suggestion.profileRecordId === HIDDEN_SALES_ROLE_ID,
    );

    expect(reshowedSuggestion?.action).toBe("keep_compact");
    // The stale sales acknowledgment is retained truthfully but can no longer
    // match anything; the untouched gap omission still blocks.
    expect(
      savedWorkspace.draft.workHistoryReviewAcknowledgments.map(
        (acknowledgment) => acknowledgment.profileRecordId,
      ),
    ).toEqual([HIDDEN_SALES_ROLE_ID]);
    expect(
      listUnresolvedWorkHistoryOmissionSuggestions({
        draftId: savedWorkspace.draft.id,
        suggestions: savedWorkspace.workHistoryReviewSuggestions,
        acknowledgments: savedWorkspace.draft.workHistoryReviewAcknowledgments,
      }).map((suggestion) => suggestion.profileRecordId),
    ).toEqual([HIDDEN_GAP_ROLE_ID]);
  });

  test("an ordinary save cannot inject server-owned acknowledgments", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace } = await generateWithSuggestions(workspaceService);
    const forgedAcknowledgment = {
      id: "work_history_ack_forged",
      draftId: workspace.draft.id,
      profileRecordId: HIDDEN_SALES_ROLE_ID,
      kind: "weak_fit" as const,
      action: "consider_showing" as const,
      messageContentHash: fnv1a32("anything"),
      reason: "intentional_omission" as const,
      acknowledgedAt: "2026-03-20T10:05:00.000Z",
    };

    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      workHistoryReviewAcknowledgments: [forgedAcknowledgment],
    });

    const storedDraft = await repository.getResumeDraftByJobId("job_ready");

    expect(storedDraft!.workHistoryReviewAcknowledgments).toEqual([]);

    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;

    await expect(
      workspaceService.approveResume("job_ready", exportArtifact.id),
    ).resolves.toBeTruthy();
  });

  test("removing an acknowledgment clears approval and export bindings truthfully", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    const { workspace, salesSuggestion, gapSuggestion } =
      await generateWithSuggestions(workspaceService);

    for (const suggestion of [salesSuggestion, gapSuggestion]) {
      await workspaceService.setWorkHistoryReviewAcknowledgment(
        buildAcknowledgeInput({
          jobId: "job_ready",
          draftId: workspace.draft.id,
          draftUpdatedAt: (await repository.getResumeDraftByJobId("job_ready"))!
            .updatedAt,
          suggestion,
        }),
      );
    }

    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;
    const approved = await workspaceService.approveResume(
      "job_ready",
      exportArtifact.id,
    );

    expect(
      approved.resumeDrafts.find((draft) => draft.jobId === "job_ready"),
    ).toMatchObject({ status: "approved" });

    const beforeRemove = await repository.getResumeDraftByJobId("job_ready");
    await workspaceService.setWorkHistoryReviewAcknowledgment({
      intent: "remove",
      jobId: "job_ready",
      draftId: workspace.draft.id,
      expectedDraftUpdatedAt: beforeRemove!.updatedAt,
      acknowledgmentId: beforeRemove!.workHistoryReviewAcknowledgments.find(
        (acknowledgment) =>
          acknowledgment.profileRecordId === HIDDEN_SALES_ROLE_ID,
      )!.id,
    });

    const removedDraft = await repository.getResumeDraftByJobId("job_ready");

    expect(removedDraft).toMatchObject({
      status: "stale",
      approvedAt: null,
      approvedExportId: null,
    });
    expect(removedDraft!.staleReason).toContain("fresh review");
    expect(removedDraft!.workHistoryReviewAcknowledgments).toHaveLength(1);

    const reExported = await workspaceService.exportResumePdf("job_ready");
    const reExportedArtifact = reExported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;

    // The omission is unresolved again, but a hidden role is the person's
    // choice, never a blocker: a fresh export approves without it.
    await expect(
      workspaceService.approveResume("job_ready", reExportedArtifact.id),
    ).resolves.toBeTruthy();
  });

  test("hidden roles never hold an application back", async () => {
    const { workspaceService, repository } = createHiddenRoleHarness();
    await generateWithSuggestions(workspaceService);

    // No acknowledgments: which roles show is the writer's call for the job.
    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;
    await workspaceService.approveResume("job_ready", exportArtifact.id);
    expect(
      (await repository.getResumeDraftByJobId("job_ready"))!
        .workHistoryReviewAcknowledgments,
    ).toEqual([]);

    const autoApplyOutcome = await workspaceService
      .startAutoApplyRun("job_ready")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(String(autoApplyOutcome)).not.toMatch(/hidden role/i);

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const record = snapshot.applicationRecords.find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(record?.nextActionLabel ?? "").not.toMatch(/hidden role/i);
  });

  test("compact-only drafts never block approval", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(
      workspace.workHistoryReviewSuggestions.filter(
        (suggestion) =>
          (suggestion.kind === "weak_fit" ||
            suggestion.kind === "gap_coverage") &&
          suggestion.action === "consider_showing",
      ),
    ).toEqual([]);

    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    )!;
    const approved = await workspaceService.approveResume(
      "job_ready",
      exportArtifact.id,
    );

    expect(
      approved.resumeDrafts.find((draft) => draft.jobId === "job_ready"),
    ).toMatchObject({ status: "approved" });
  });

  test("an older tailored draft never blocks a job set to use the original resume", async () => {
    const baseRuntime = createBrowserRuntime();
    let preparedResumeSource: string | null = null;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      executeApplicationFlow(source, input, options) {
        preparedResumeSource = input.resumeArtifact.source;
        return baseRuntime.executeApplicationFlow(source, input, options);
      },
    };
    const { workspaceService } = createHiddenRoleHarness({ browserRuntime });
    await generateWithSuggestions(workspaceService);
    await workspaceService.setJobResumeApplicationMode(
      "job_ready",
      "original_resume",
    );

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const record = snapshot.applicationRecords.find(
      (entry) => entry.jobId === "job_ready",
    );

    expect(record?.latestBlocker?.summary ?? "").not.toMatch(
      /confirm the hidden role/i,
    );
    expect(snapshot.applyJobResults.at(-1)?.blockerReason).not.toBe(
      "required_human_input",
    );
    expect(preparedResumeSource).toBe("original_upload");
  });

  test("exact-match helper ignores stale, cross-draft, and non-omission identities", () => {
    const suggestion: WorkHistoryReviewSuggestion = {
      id: "work_history_review_experience_9",
      profileRecordId: "experience_9",
      sectionId: null,
      entryId: null,
      kind: "weak_fit",
      action: "consider_showing",
      severity: "info",
      message: "Hidden for review.",
      messageContentHash: fnv1a32("Hidden for review."),
    };
    const matchingAcknowledgment = {
      id: "work_history_ack_match",
      draftId: "draft_a",
      profileRecordId: "experience_9",
      kind: "weak_fit" as const,
      action: "consider_showing" as const,
      messageContentHash: fnv1a32("Hidden for review."),
      reason: "intentional_omission" as const,
      acknowledgedAt: "2026-03-20T10:05:00.000Z",
    };

    expect(
      matchWorkHistoryReviewAcknowledgment({
        draftId: "draft_a",
        suggestion,
        acknowledgments: [matchingAcknowledgment],
      })?.id,
    ).toBe("work_history_ack_match");
    expect(
      matchWorkHistoryReviewAcknowledgment({
        draftId: "draft_b",
        suggestion,
        acknowledgments: [matchingAcknowledgment],
      }),
    ).toBeNull();
    expect(
      matchWorkHistoryReviewAcknowledgment({
        draftId: "draft_a",
        suggestion: { ...suggestion, message: "Hidden for review. Rewritten." },
        acknowledgments: [matchingAcknowledgment],
      }),
    ).toBeNull();
    expect(
      listUnresolvedWorkHistoryOmissionSuggestions({
        draftId: "draft_b",
        suggestions: [
          suggestion,
          {
            ...suggestion,
            id: "review_compact",
            kind: "compact_recommended",
            action: "keep_compact",
          },
          {
            ...suggestion,
            id: "review_dates",
            kind: "date_quality",
            action: "fix_dates",
          },
        ],
        acknowledgments: [],
      }).map((entry) => entry.id),
    ).toEqual(["work_history_review_experience_9"]);
  });
});
