import { describe, expect, test } from "vitest";
import { isBlockingResumeClaimAssessment } from "@nestor/contracts";
import {
  collectResumeExportBlockers,
  evaluateResumeProposalGrounding,
  validateResumeDraft,
} from "./internal/resume-workspace-helpers";
import {
  createAiClient,
  fakeResumeClaimCheck,
} from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

/**
 * The exact wording a live Guided Edits run proposed, reported as grounded,
 * and then had rejected by the export/approval validator. Both layers must now
 * return the same verdict for this text.
 */
const LIVE_UNGROUNDED_SUMMARY =
  "Senior Software Engineer with 10+ years building secure, scalable healthcare SaaS platforms with C#, .NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and Azure/AWS. Delivered microservices and EHR-adjacent integrations for scheduling and billing, with resilient third-party integrations, CI/CD, and observability for reliable Agile delivery.";

function findEditableTextSection(
  sections: readonly { id: string; text: string | null }[],
) {
  const section = sections.find((entry) => entry.text?.trim());
  if (!section) {
    throw new Error(
      "Expected an editable text section in the generated resume.",
    );
  }
  return section;
}

function createSummaryRewriteHarness(newText: string) {
  const baseAiClient = createAiClient();

  return createWorkspaceServiceHarness({
    aiClient: {
      ...baseAiClient,
      // The fact check finds the invented summary unbacked; a line the AI has
      // not checked would not hold anything back.
      checkResumeClaims: fakeResumeClaimCheck({
        [LIVE_UNGROUNDED_SUMMARY]: "unsupported",
      }),
      reviseResumeDraft(input) {
        const section = findEditableTextSection(input.draft.sections);
        return Promise.resolve({
          content: "Updated one grounded section.",
          patches: [
            {
              id: "assistant_grounding_patch",
              draftId: input.draft.id,
              operation: "replace_section_text" as const,
              targetSectionId: section.id,
              targetEntryId: null,
              anchorEntryId: null,
              targetBulletId: null,
              anchorBulletId: null,
              position: null,
              newText,
              newIncluded: null,
              newLocked: null,
              newBullets: null,
              appliedAt: new Date().toISOString(),
              origin: "assistant" as const,
              conflictReason: null,
            },
          ],
        });
      },
    },
  });
}

describe("guided edits proposals share the export grounding rule", () => {
  test("a proposal the export gate would reject is not presented as grounded", async () => {
    const { workspaceService } = createSummaryRewriteHarness(
      LIVE_UNGROUNDED_SUMMARY,
    );
    await workspaceService.generateResume("job_ready");

    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Rewrite my summary for this job.",
    );
    const proposal = messages.find(
      (message) => message.role === "assistant" && message.patches.length > 0,
    );

    expect(proposal).toBeDefined();
    expect(proposal?.approvalBlockers ?? []).not.toHaveLength(0);
    expect(proposal?.content).toMatch(/would block approval/i);
    expect(proposal?.content).not.toMatch(/grounded/i);
    expect(
      (proposal?.approvalBlockers ?? []).map((blocker) => blocker.flaggedText),
    ).toContain(LIVE_UNGROUNDED_SUMMARY);
    expect((proposal?.approvalBlockers ?? [])[0]?.patchId).toBe(
      "assistant_grounding_patch",
    );

    // Accepting it must produce exactly the blocker the proposal warned about:
    // one rule, two layers.
    await workspaceService.resolveResumeAssistantProposal(
      "job_ready",
      proposal!.id,
      "accept",
      [proposal!.patches[0]!.id],
    );

    const accepted = await workspaceService.getResumeWorkspace("job_ready");
    const exportBlockers = collectResumeExportBlockers({
      draft: accepted.draft,
      validation: accepted.validation!,
    });

    expect(exportBlockers.length).toBeGreaterThan(0);
    expect(exportBlockers.map((blocker) => blocker.flaggedText)).toContain(
      LIVE_UNGROUNDED_SUMMARY,
    );
    expect(
      accepted.validation!.claimAssessments.some(
        (assessment) =>
          assessment.claimText === LIVE_UNGROUNDED_SUMMARY &&
          isBlockingResumeClaimAssessment({
            assessment,
            draft: accepted.draft,
          }),
      ),
    ).toBe(true);
  });

  test("a proposal the export gate accepts is still described as grounded", async () => {
    const { workspaceService } = createSummaryRewriteHarness("placeholder");
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(before.draft.sections);
    // A real change (the same words without the closing period): a proposal
    // that sets exactly what the resume already has is no longer offered.
    const groundedRewrite = `${section.text}`.trim().replace(/\.$/u, "");

    const { workspaceService: groundedService } =
      createSummaryRewriteHarness(groundedRewrite);
    await groundedService.generateResume("job_ready");
    const messages = await groundedService.sendResumeAssistantMessage(
      "job_ready",
      "Tidy my summary.",
    );
    const proposal = messages.find(
      (message) => message.role === "assistant" && message.patches.length > 0,
    );

    expect(proposal).toBeDefined();
    expect(proposal?.approvalBlockers ?? []).toEqual([]);
    expect(proposal?.content).toMatch(/grounded resume edit/i);
    expect(proposal?.content).not.toMatch(/would block approval/i);
  });

  test("the proposal gate and the export validator agree on unchecked text", async () => {
    const { workspaceService } = createSummaryRewriteHarness("placeholder");
    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(workspace.draft.sections);
    const evaluatedAt = new Date().toISOString();
    const patch = {
      id: "direct_gate_patch",
      draftId: workspace.draft.id,
      operation: "replace_section_text" as const,
      targetSectionId: section.id,
      targetEntryId: null,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: LIVE_UNGROUNDED_SUMMARY,
      newIncluded: null,
      newLocked: null,
      newBullets: null,
      appliedAt: evaluatedAt,
      origin: "assistant" as const,
      conflictReason: null,
    };

    const gate = evaluateResumeProposalGrounding({
      baselineDraft: workspace.draft,
      patches: [patch],
      job: workspace.job,
      evaluatedAt,
    });

    // Without a fact check both layers let the line through: a line the AI
    // has not checked never holds the person back.
    expect(gate.accepted).toBe(true);
    expect(gate.approvalBlockers).toEqual([]);

    const rewrittenDraft = {
      ...workspace.draft,
      sections: workspace.draft.sections.map((entry) =>
        entry.id === section.id
          ? {
              ...entry,
              origin: "assistant_edited" as const,
              text: LIVE_UNGROUNDED_SUMMARY,
            }
          : entry,
      ),
    };
    const exportBlockers = collectResumeExportBlockers({
      draft: rewrittenDraft,
      validation: validateResumeDraft({
        draft: rewrittenDraft,
        job: workspace.job,
        validatedAt: evaluatedAt,
      }),
    });

    expect(exportBlockers).toEqual([]);
  });
});
