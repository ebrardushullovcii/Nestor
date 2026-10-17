import type {
  JobFinderSetResumeClaimConfirmationInput,
  ResumeClaimAssessment,
} from "@nestor/contracts";
import {
  isBlockingResumeClaimAssessment,
  resumeClaimOwnershipStatement,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  createAiClient,
  fakeResumeClaimCheck,
} from "./workspace-service.test-runtimes";
import {
  createWorkspaceServiceHarness,
  createSeed,
} from "./workspace-service.test-support";
import type { JobFinderWorkspaceService } from "./internal/workspace-service-contracts";

// The model's fact check calls this generated claim a stretch. In Aggressive
// tailoring choosing the level accepted it (ADR 0018); elsewhere generation
// settles it.
const WEAK_CLAIM_TEXT =
  "Championed resilient delivery improvements across organizations.";
// A metric the candidate evidence does not show: the fact check calls it
// unsupported, and generation leaves it off.
const UNSUPPORTED_CLAIM_TEXT =
  "Increased revenue by 340% within one quarter through delivery improvements.";
// Listing-asked technologies the profile does not show are stretches too.
const CLAIM_VERDICTS = {
  [WEAK_CLAIM_TEXT]: "stretch",
  [UNSUPPORTED_CLAIM_TEXT]: "unsupported",
  Terraform: "stretch",
  Kubernetes: "stretch",
  // A reworded stretch is checked again and is still a stretch.
  "Championed resilient delivery improvements across several organizations.":
    "stretch",
} as const;

function createClaimHarness(input: {
  bullets: readonly string[];
  aggressive?: boolean;
}) {
  const seed = createSeed();
  if (input.aggressive ?? true) {
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? { ...job, resumeTailoringMode: "aggressive" as const }
        : job,
    );
  }
  const baseAiClient = createAiClient();

  return createWorkspaceServiceHarness({
    seed,
    aiClient: {
      ...baseAiClient,
      checkResumeClaims: fakeResumeClaimCheck(CLAIM_VERDICTS),
      async createResumeDraft(draftInput) {
        const base = await baseAiClient.createResumeDraft(draftInput);

        return {
          ...base,
          experienceEntries: base.experienceEntries.map((entry, index) =>
            index === 0 ? { ...entry, bullets: [...input.bullets] } : entry,
          ),
        };
      },
    },
  });
}

type AddClaimConfirmationInput = Extract<
  JobFinderSetResumeClaimConfirmationInput,
  { intent: "add" }
>;

function findConfirmNeededAssessment(
  workspace: Awaited<
    ReturnType<JobFinderWorkspaceService["getResumeWorkspace"]>
  >,
): ResumeClaimAssessment {
  const assessment = findOutstandingConfirmNeededAssessmentOrNull(workspace);

  if (!assessment) {
    throw new Error("Expected a confirm_needed claim assessment.");
  }

  return assessment;
}

/**
 * Validation always projects `confirm_needed` rows for weak generated claims —
 * confirmed or not, because statuses describe content while confirmations live
 * on the draft. Mirror the export gate's exact matcher so only rows without an
 * owning confirmation (same draft, locator, and normalized content hash) count
 * as still outstanding.
 */
function findOutstandingConfirmNeededAssessmentOrNull(
  workspace: Awaited<
    ReturnType<JobFinderWorkspaceService["getResumeWorkspace"]>
  >,
): ResumeClaimAssessment | null {
  const confirmations = workspace.draft.claimConfirmations;
  return (
    workspace.validation?.claimAssessments.find(
      (candidate) =>
        candidate.status === "confirm_needed" &&
        !confirmations.some(
          (confirmation) =>
            confirmation.draftId === workspace.draft.id &&
            confirmation.field === candidate.field &&
            confirmation.sectionId === candidate.sectionId &&
            confirmation.entryId === candidate.entryId &&
            confirmation.bulletId === candidate.bulletId &&
            confirmation.confirmedClaimContentHash === candidate.contentHash,
        ),
    ) ?? null
  );
}

function buildAddInput(input: {
  jobId?: string;
  draftId?: string;
  draftUpdatedAt: string;
  assessment: ResumeClaimAssessment;
}): AddClaimConfirmationInput {
  return {
    intent: "add",
    jobId: input.jobId ?? "job_ready",
    draftId: input.draftId ?? "resume_draft_job_ready",
    expectedDraftUpdatedAt: input.draftUpdatedAt,
    field: input.assessment.field,
    sectionId: input.assessment.sectionId,
    entryId: input.assessment.entryId,
    bulletId: input.assessment.bulletId,
    confirmedClaimContentHash: input.assessment.contentHash,
    ownershipStatement: resumeClaimOwnershipStatement,
  };
}

describe("resume claim confirmation commands", () => {
  test("an Aggressive stretch stays on the resume and never blocks export or approval", async () => {
    const harness = createClaimHarness({ bullets: [WEAK_CLAIM_TEXT] });
    const { workspaceService } = harness;

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    expect(findConfirmNeededAssessment(workspace).claimText).toBe(
      WEAK_CLAIM_TEXT,
    );
    expect(
      workspace.validation?.claimAssessments.some((assessment) =>
        isBlockingResumeClaimAssessment({ assessment, draft: workspace.draft }),
      ),
    ).toBe(false);

    const exported = await workspaceService.exportResumePdf("job_ready");
    const approved = await workspaceService.approveResume(
      "job_ready",
      exported.resumeExportArtifacts.find(
        (artifact) => artifact.jobId === "job_ready",
      )!.id,
    );
    expect(
      approved.resumeDrafts.find((draft) => draft.jobId === "job_ready"),
    ).toMatchObject({ status: "approved" });
  });

  test("the review queue never lists lines for the person to decide", async () => {
    const harness = createClaimHarness({ bullets: [WEAK_CLAIM_TEXT] });
    const { workspaceService } = harness;

    await workspaceService.generateResume("job_ready");
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const item = snapshot.reviewQueue.find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(item).toBeDefined();
    expect(item?.resumeLinesToDecide ?? 0).toBe(0);
  });

  test("outside Aggressive, generation settles a stretch it has no fix for", async () => {
    const harness = createClaimHarness({
      bullets: [WEAK_CLAIM_TEXT],
      aggressive: false,
    });
    const { workspaceService } = harness;

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const shownLines = workspace.draft.sections.flatMap((section) =>
      section.entries.flatMap((entry) =>
        entry.included
          ? entry.bullets
              .filter((bullet) => bullet.included)
              .map((bullet) => bullet.text)
          : [],
      ),
    );
    expect(shownLines).not.toContain(WEAK_CLAIM_TEXT);
    await expect(
      workspaceService.exportResumePdf("job_ready"),
    ).resolves.toBeTruthy();
  });

  test("generation leaves off an unbacked line it has no fix for, so nothing waits on the person", async () => {
    const harness = createClaimHarness({ bullets: [UNSUPPORTED_CLAIM_TEXT] });
    const { workspaceService } = harness;

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const shownLines = workspace.draft.sections.flatMap((section) =>
      section.entries.flatMap((entry) =>
        entry.bullets
          .filter((bullet) => bullet.included)
          .map((bullet) => bullet.text),
      ),
    );
    expect(shownLines).not.toContain(UNSUPPORTED_CLAIM_TEXT);
    expect(
      workspace.validation?.issues.some((issue) => issue.severity === "error"),
    ).toBe(false);
    await expect(
      workspaceService.exportResumePdf("job_ready"),
    ).resolves.toBeTruthy();
  });

  test("rejects stale revisions, cross-draft ids, wrong hashes, unknown locators, and forged statements", async () => {
    const harness = createClaimHarness({ bullets: [WEAK_CLAIM_TEXT] });
    const { workspaceService, repository } = harness;

    await workspaceService.generateResume("job_ready");
    const assessment = findConfirmNeededAssessment(
      await workspaceService.getResumeWorkspace("job_ready"),
    );
    const before = await repository.getResumeDraftByJobId("job_ready");
    const revisionsBefore = await repository.listResumeDraftRevisions(
      before!.id,
    );
    const validInput = buildAddInput({
      draftUpdatedAt: before!.updatedAt,
      assessment,
    });

    const mismatches: Array<[AddClaimConfirmationInput, RegExp]> = [
      [
        { ...validInput, expectedDraftUpdatedAt: "2026-03-20T09:00:00.000Z" },
        /changed before this claim confirmation/i,
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
        {
          ...validInput,
          confirmedClaimContentHash: assessment.contentHash.replace(/.$/, "0"),
        },
        /no longer projected|wording changed/i,
      ],
      [
        { ...validInput, bulletId: "experience_1_bullet_99" },
        /no longer projected|wording changed/i,
      ],
    ];

    for (const [input, pattern] of mismatches) {
      await expect(
        workspaceService.setResumeClaimConfirmation(input),
      ).rejects.toThrow(pattern);
    }

    // Forged ownership statements are rejected by the typed contract itself.
    await expect(
      workspaceService.setResumeClaimConfirmation({
        ...validInput,
        ownershipStatement: "I promise this is accurate." as never,
      }),
    ).rejects.toThrow();

    const after = await repository.getResumeDraftByJobId("job_ready");

    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after!.claimConfirmations).toEqual([]);
    expect(await repository.listResumeDraftRevisions(before!.id)).toHaveLength(
      revisionsBefore.length,
    );
  });

  test("duplicate adds are deterministic no-ops", async () => {
    const harness = createClaimHarness({ bullets: [WEAK_CLAIM_TEXT] });
    const { workspaceService, repository } = harness;

    await workspaceService.generateResume("job_ready");
    const assessment = findConfirmNeededAssessment(
      await workspaceService.getResumeWorkspace("job_ready"),
    );

    await workspaceService.setResumeClaimConfirmation(
      buildAddInput({
        draftUpdatedAt: (await repository.getResumeDraftByJobId("job_ready"))!
          .updatedAt,
        assessment,
      }),
    );
    const afterFirst = await repository.getResumeDraftByJobId("job_ready");

    await workspaceService.setResumeClaimConfirmation(
      buildAddInput({
        draftUpdatedAt: afterFirst!.updatedAt,
        assessment,
      }),
    );
    const afterSecond = await repository.getResumeDraftByJobId("job_ready");

    expect(afterSecond!.claimConfirmations).toHaveLength(
      afterFirst!.claimConfirmations.length,
    );
    expect(afterSecond!.claimConfirmations[0]!.id).toBe(
      afterFirst!.claimConfirmations[0]!.id,
    );
    expect(afterSecond!.updatedAt).toBe(afterFirst!.updatedAt);
  });

  test("add_many rejects a mixed batch that includes a non-skill stretch", async () => {
    const harness = createClaimHarness({ bullets: [WEAK_CLAIM_TEXT] });
    const { workspaceService, repository } = harness;
    await workspaceService.generateResume("job_ready");
    const assessment = findConfirmNeededAssessment(
      await workspaceService.getResumeWorkspace("job_ready"),
    );
    const stored = await repository.getResumeDraftByJobId("job_ready");

    await expect(
      workspaceService.setResumeClaimConfirmation({
        intent: "add_many",
        jobId: "job_ready",
        draftId: stored!.id,
        expectedDraftUpdatedAt: stored!.updatedAt,
        ownershipStatement: resumeClaimOwnershipStatement,
        targets: [
          {
            field: assessment.field,
            sectionId: assessment.sectionId,
            entryId: assessment.entryId,
            bulletId: assessment.bulletId,
            confirmedClaimContentHash: assessment.contentHash,
          },
        ],
      }),
    ).rejects.toThrow(/Bulk confirmation is only for skills/i);

    expect(
      (await repository.getResumeDraftByJobId("job_ready"))!.claimConfirmations,
    ).toEqual([]);
  });
});
