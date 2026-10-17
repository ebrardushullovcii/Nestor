import { describe, expect, test } from "vitest";
import type { ResumeDraft } from "@nestor/contracts";
import { ResumeDraftSchema } from "@nestor/contracts";
import {
  buildResumeDraftStateHash,
  sanitizeResumeDraft,
} from "./internal/resume-workspace-helpers";
import { buildReviewQueue } from "./internal/matching-review-queue";
import { createAiClient } from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

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

describe("resume draft versioning", () => {
  test("returns the committed revision when an edited bullet is trimmed during save", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const section = before.draft.sections.find(
      (entry) => entry.bullets.length > 0,
    );
    expect(section).toBeDefined();
    const bulletId = section!.bullets[0]!.id;
    const edited = {
      ...before.draft,
      sections: before.draft.sections.map((entry) =>
        entry.id === section!.id
          ? {
              ...entry,
              bullets: entry.bullets.map((bullet) =>
                bullet.id === bulletId
                  ? { ...bullet, text: `${bullet.text}\n` }
                  : bullet,
              ),
            }
          : entry,
      ),
    };
    const result = await workspaceService.saveResumeDraft(edited);
    const after = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      after.draft.sections
        .find((entry) => entry.id === section!.id)
        ?.bullets.find((bullet) => bullet.id === bulletId)?.text,
    ).toBe(section!.bullets[0]!.text);
    expect(after.draft.sections).not.toEqual(edited.sections);
    expect(
      result.resumeDrafts.find((entry) => entry.id === before.draft.id)
        ?.updatedAt,
    ).toBe(after.draft.updatedAt);
    expect(after.draft.updatedAt).not.toBe(before.draft.updatedAt);
  });

  test("captures the exact pre-save draft and skips no-op revisions", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");

    await workspaceService.saveResumeDraft({
      ...before.draft,
      identity: {
        ...before.draft.identity!,
        fullName: before.draft.identity?.fullName ?? "Alex Vanguard",
        headline: "Senior workflow systems designer",
      },
    });

    const after = await workspaceService.getResumeWorkspace("job_ready");
    const revisions = await repository.listResumeDraftRevisions(
      before.draft.id,
    );

    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      actor: "user",
      mutationKind: "manual_save",
      parentRevisionId: null,
      restoredFromRevisionId: null,
      diff: { identityChanged: true },
    });
    expect(revisions[0]?.snapshotDraft).toEqual(before.draft);
    expect(revisions[0]?.beforeHash).toBe(
      buildResumeDraftStateHash(before.draft),
    );
    expect(revisions[0]?.afterHash).toBe(
      buildResumeDraftStateHash(after.draft),
    );

    await workspaceService.saveResumeDraft(after.draft);
    expect(
      await repository.listResumeDraftRevisions(before.draft.id),
    ).toHaveLength(1);
  });

  test("assistant edits stay proposed until selected changes are approved into version history", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "Updated one grounded section.",
            patches: [
              {
                id: "assistant_versioning_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Refined for clarity.`,
                newIncluded: null,
                newLocked: null,
                newBullets: null,
                appliedAt: new Date().toISOString(),
                origin: "assistant" as const,
                conflictReason: null,
              },
              {
                id: "assistant_versioning_patch_unselected",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} This alternative must stay unselected.`,
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
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");

    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Make one section clearer.",
    );

    const proposed = await workspaceService.getResumeWorkspace("job_ready");
    const proposal = messages.find(
      (message) => message.role === "assistant" && message.patches.length > 0,
    );
    expect(proposal).toMatchObject({
      proposalStatus: "pending",
      baseDraftUpdatedAt: before.draft.updatedAt,
      resolvedPatchIds: [],
    });
    expect(proposal?.content).toMatch(/prepared.*nothing changed yet/i);
    expect(proposal?.content).not.toMatch(/\bapplied\b/i);
    expect(proposed.draft).toEqual(before.draft);
    expect(
      await repository.listResumeDraftRevisions(before.draft.id),
    ).toHaveLength(0);

    await workspaceService.resolveResumeAssistantProposal(
      "job_ready",
      proposal!.id,
      "accept",
      [proposal!.patches[0]!.id],
    );

    const after = await workspaceService.getResumeWorkspace("job_ready");
    const revisions = await repository.listResumeDraftRevisions(
      before.draft.id,
    );

    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      actor: "assistant",
      mutationKind: "assistant_patch",
    });
    expect(revisions[0]?.snapshotDraft).toEqual(before.draft);
    expect(revisions[0]?.snapshotDraft?.sections).not.toEqual(
      after.draft.sections,
    );
    expect(revisions[0]?.afterHash).toBe(
      buildResumeDraftStateHash(after.draft),
    );
    expect(JSON.stringify(after.draft.sections)).not.toContain(
      "This alternative must stay unselected.",
    );
    const resolved = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.id === proposal!.id);
    expect(resolved).toMatchObject({
      proposalStatus: "accepted",
      resolvedPatchIds: [proposal!.patches[0]!.id],
      proposalError: null,
    });
  });

  test("rejects a proposal without mutating the draft", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "One optional rewrite.",
            patches: [
              {
                id: "assistant_rejected_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Optional rewrite.`,
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
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Offer a rewrite.",
    );
    const proposal = messages.find(
      (message) => message.proposalStatus === "pending",
    )!;

    await workspaceService.resolveResumeAssistantProposal(
      "job_ready",
      proposal.id,
      "reject",
      [],
    );

    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft,
    ).toEqual(before.draft);
    expect(
      await repository.listResumeDraftRevisions(before.draft.id),
    ).toHaveLength(0);
    expect(
      (await workspaceService.getResumeAssistantMessages("job_ready")).find(
        (message) => message.id === proposal.id,
      )?.proposalStatus,
    ).toBe("rejected");
  });

  test("serializes concurrent accept and reject actions for one proposal", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "One concurrent-safe rewrite.",
            patches: [
              {
                id: "assistant_concurrent_resolution_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Concurrent-safe wording.`,
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
    await workspaceService.generateResume("job_ready");
    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Prepare one rewrite.",
    );
    const proposal = messages.find(
      (message) => message.proposalStatus === "pending",
    );
    expect(proposal).toBeTruthy();

    const outcomes = await Promise.allSettled([
      workspaceService.resolveResumeAssistantProposal(
        "job_ready",
        proposal!.id,
        "accept",
        [proposal!.patches[0]!.id],
      ),
      workspaceService.resolveResumeAssistantProposal(
        "job_ready",
        proposal!.id,
        "reject",
        [],
      ),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const persistedProposal = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.id === proposal!.id);
    expect(persistedProposal).toMatchObject({
      proposalStatus: "accepted",
      resolvedPatchIds: [proposal!.patches[0]!.id],
      proposalError: null,
    });
    expect(
      await repository.listResumeDraftRevisions("resume_draft_job_ready"),
    ).toHaveLength(1);
  });

  test("does not offer an empty text replacement for approval", async () => {
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "Prepared a shorter summary.",
            patches: [
              {
                id: "assistant_empty_replacement",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: null,
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
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");

    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Shorten the summary.",
    );
    const reply = messages.find((message) => message.role === "assistant");

    expect(reply).toMatchObject({
      proposalStatus: "none",
      patches: [],
    });
    expect(reply?.content).toMatch(/no resume change was proposed/i);
    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft,
    ).toEqual(before.draft);
  });

  test("keeps a stale proposal pending and visible after a newer manual edit", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "One grounded rewrite is ready for review.",
            patches: [
              {
                id: "assistant_stale_proposal_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Proposed wording.`,
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
    await workspaceService.generateResume("job_ready");
    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Shorten the summary and tighten one experience bullet for ATS readability.",
    );
    const proposal = messages.find(
      (message) => message.proposalStatus === "pending",
    );
    expect(proposal).toBeTruthy();

    const current = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(current.draft.sections);
    await workspaceService.applyResumePatch({
      id: "newer_edit_before_proposal_acceptance",
      draftId: current.draft.id,
      operation: "replace_section_text",
      targetSectionId: section.id,
      targetEntryId: null,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: `${section.text} Newer manual wording.`,
      newIncluded: null,
      newLocked: null,
      newBullets: null,
      appliedAt: new Date().toISOString(),
      origin: "user",
      conflictReason: null,
    });

    await expect(
      workspaceService.resolveResumeAssistantProposal(
        "job_ready",
        proposal!.id,
        "accept",
        proposal!.patches.map((patch) => patch.id),
      ),
    ).rejects.toThrow(/changed after this proposal was created/i);

    const persistedProposal = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.id === proposal!.id);
    expect(persistedProposal).toMatchObject({
      proposalStatus: "pending",
    });
    expect(persistedProposal?.proposalError).toMatch(
      /changed after this proposal was created/i,
    );
    expect(
      await repository.listResumeDraftRevisions(current.draft.id),
    ).toHaveLength(1);
  });

  test("section regeneration proposes targeted changes without mutating the draft until accepted", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "Tightened the requested section.",
            patches: [
              {
                id: "regen_section_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Sharper for the target role.`,
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
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(before.draft.sections);

    await workspaceService.regenerateResumeSection("job_ready", section.id);

    const proposed = await workspaceService.getResumeWorkspace("job_ready");
    expect(proposed.draft).toEqual(before.draft);
    expect(
      await repository.listResumeDraftRevisions(before.draft.id),
    ).toHaveLength(0);

    const proposal = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.proposalStatus === "pending");
    expect(proposal).toMatchObject({
      role: "assistant",
      proposalStatus: "pending",
      baseDraftUpdatedAt: before.draft.updatedAt,
      resolvedPatchIds: [],
    });
    expect(proposal?.patches.map((patch) => patch.targetSectionId)).toEqual([
      section.id,
    ]);
    expect(proposal?.content).toMatch(/nothing changed yet/i);

    await workspaceService.resolveResumeAssistantProposal(
      "job_ready",
      proposal!.id,
      "accept",
      [proposal!.patches[0]!.id],
    );

    const revisions = await repository.listResumeDraftRevisions(
      before.draft.id,
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      actor: "assistant",
      mutationKind: "assistant_patch",
    });
    const applied = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      applied.draft.sections.find((entry) => entry.id === section.id)?.text,
    ).toContain("Sharper for the target role.");
  });

  test("section regeneration without a matching patch reports a truthful no-change instead of applying content", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "Rewrote a different section.",
            patches: [
              {
                id: "regen_other_section_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Rewritten wording.`,
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
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const rewrittenByModel = findEditableTextSection(before.draft.sections);
    const requestedSection = before.draft.sections.find(
      (entry) => entry.id !== rewrittenByModel.id,
    );
    expect(requestedSection).toBeTruthy();

    await workspaceService.regenerateResumeSection(
      "job_ready",
      requestedSection!.id,
    );

    const after = await workspaceService.getResumeWorkspace("job_ready");
    expect(after.draft).toEqual(before.draft);
    expect(
      await repository.listResumeDraftRevisions(before.draft.id),
    ).toHaveLength(0);

    const reply = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.role === "assistant");
    expect(reply).toMatchObject({
      proposalStatus: "none",
      patches: [],
      baseDraftUpdatedAt: null,
    });
    expect(reply?.content).toMatch(/no change was proposed/i);
  });

  test("model-claimed user origins are overridden so assistant lock and reorder rules stay enforced", async () => {
    let maliciousCallCount = 0;
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          const experience = input.draft.sections.find(
            (entry) => entry.entries.length > 0 && entry.id !== section.id,
          );
          if (!experience) {
            throw new Error(
              "Expected an experience section in the generated resume.",
            );
          }
          const basePatch = {
            draftId: input.draft.id,
            targetEntryId: null,
            anchorEntryId: null,
            targetBulletId: null,
            anchorBulletId: null,
            position: null,
            newText: null as string | null,
            newIncluded: null,
            newLocked: null,
            newBullets: null,
            appliedAt: new Date().toISOString(),
            origin: "user" as const,
            conflictReason: null,
          };
          maliciousCallCount += 1;
          const patches =
            maliciousCallCount === 1
              ? [
                  {
                    ...basePatch,
                    id: "malicious_user_reorder_patch",
                    operation: "reset_entry_order" as const,
                    targetSectionId: experience.id,
                  },
                ]
              : [
                  {
                    ...basePatch,
                    id: "malicious_user_text_patch",
                    operation: "replace_section_text" as const,
                    targetSectionId: section.id,
                    newText: `${section.text} Model-authored rewrite.`,
                  },
                ];
          return Promise.resolve({
            content: "Changes claiming user authorship.",
            patches,
          });
        },
      },
    });
    await workspaceService.generateResume("job_ready");
    const initial = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(initial.draft.sections);
    const experience = initial.draft.sections.find(
      (entry) => entry.entries.length > 0 && entry.id !== section.id,
    );
    if (!experience) {
      throw new Error(
        "Expected an experience section in the generated resume.",
      );
    }

    // Turn A: a model-authored reorder claiming user origin is refused when
    // the proposal is created instead of being stored for acceptance.
    const reorderAttempt = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Reset the entry order.",
    );
    const reorderReply = [...reorderAttempt]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(reorderReply?.content).toMatch(
      /no assistant changes were applied[\s\S]*cannot reorder resume entries/i,
    );
    expect(reorderReply?.patches).toEqual([]);
    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft,
    ).toEqual(initial.draft);
    expect(
      await repository.listResumeDraftRevisions(initial.draft.id),
    ).toHaveLength(0);

    // Turn B: a normal text rewrite is stored as a pending assistant
    // proposal even though the model claimed user origin.
    await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Rewrite the section.",
    );
    const proposal = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.proposalStatus === "pending");
    expect(proposal?.patches.map((patch) => patch.origin)).toEqual([
      "assistant",
    ]);
    expect(proposal?.baseDraftUpdatedAt).toBe(initial.draft.updatedAt);

    // The real user locks the section through the ordinary user patch path;
    // accepting the older proposal must fail without mutating anything.
    const lockedBefore = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.applyResumePatch({
      id: "user_locks_section_after_proposal",
      draftId: lockedBefore.draft.id,
      operation: "set_lock",
      targetSectionId: section.id,
      targetEntryId: null,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: null,
      newIncluded: null,
      newLocked: true,
      newBullets: null,
      appliedAt: new Date().toISOString(),
      origin: "user",
      conflictReason: null,
    });

    await expect(
      workspaceService.resolveResumeAssistantProposal(
        "job_ready",
        proposal!.id,
        "accept",
        ["malicious_user_text_patch"],
      ),
    ).rejects.toThrow(/changed after this proposal was created/i);
    const afterLock = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      afterLock.draft.sections.find((entry) => entry.id === section.id),
    ).toMatchObject({ locked: true, text: section.text ?? null });
    expect(
      await repository.listResumeDraftRevisions(afterLock.draft.id),
    ).toHaveLength(1);

    // A fresh proposal targeting the now-locked section is refused outright
    // under assistant lock semantics instead of being stored.
    const lockedAttempt = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Rewrite it again.",
    );
    const lockedReply = [...lockedAttempt]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(lockedReply?.content).toMatch(
      /no assistant changes were applied[\s\S]*cannot overwrite locked resume content/i,
    );
    expect(lockedReply?.patches).toEqual([]);
    expect(
      (await workspaceService.getResumeAssistantMessages("job_ready")).find(
        (message) => message.proposalStatus === "pending",
      )?.id,
    ).toBe(proposal!.id);
    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft,
    ).toEqual(afterLock.draft);
    expect(
      await repository.listResumeDraftRevisions(afterLock.draft.id),
    ).toHaveLength(1);
  });

  test("section regeneration stores canonical assistant origin even when the model claims user authorship", async () => {
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const section = findEditableTextSection(input.draft.sections);
          return Promise.resolve({
            content: "A rewrite claiming user authorship.",
            patches: [
              {
                id: "regen_malicious_origin_patch",
                draftId: input.draft.id,
                operation: "replace_section_text" as const,
                targetSectionId: section.id,
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: `${section.text} Claimed as user-authored.`,
                newIncluded: null,
                newLocked: null,
                newBullets: null,
                appliedAt: new Date().toISOString(),
                origin: "user" as const,
                conflictReason: null,
              },
            ],
          });
        },
      },
    });
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(before.draft.sections);

    await workspaceService.regenerateResumeSection("job_ready", section.id);

    const proposed = await workspaceService.getResumeWorkspace("job_ready");
    expect(proposed.draft).toEqual(before.draft);
    expect(
      await repository.listResumeDraftRevisions(before.draft.id),
    ).toHaveLength(0);

    const proposal = (
      await workspaceService.getResumeAssistantMessages("job_ready")
    ).find((message) => message.proposalStatus === "pending");
    expect(proposal?.patches.map((patch) => patch.origin)).toEqual([
      "assistant",
    ]);
  });

  test("rejects a stale editor save without overwriting newer work", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const staleWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(staleWorkspace.draft.sections);

    await workspaceService.applyResumePatch(
      {
        id: "newer_manual_patch",
        draftId: staleWorkspace.draft.id,
        operation: "replace_section_text",
        targetSectionId: section.id,
        targetEntryId: null,
        anchorEntryId: null,
        targetBulletId: null,
        anchorBulletId: null,
        position: null,
        newText: `${section.text} Newer saved edit.`,
        newIncluded: null,
        newLocked: null,
        newBullets: null,
        appliedAt: new Date().toISOString(),
        origin: "user",
        conflictReason: null,
      },
      "Newer manual edit",
    );
    const newerWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");

    await expect(
      workspaceService.saveResumeDraft({
        ...staleWorkspace.draft,
        identity: {
          ...staleWorkspace.draft.identity!,
          fullName: staleWorkspace.draft.identity?.fullName ?? "Alex Vanguard",
          headline: "Stale editor overwrite attempt",
        },
      }),
    ).rejects.toThrow(/changed before this edit could be saved/i);

    const persisted = await workspaceService.getResumeWorkspace("job_ready");
    expect(buildResumeDraftStateHash(persisted.draft)).toBe(
      buildResumeDraftStateHash(newerWorkspace.draft),
    );
    expect(
      await repository.listResumeDraftRevisions(staleWorkspace.draft.id),
    ).toHaveLength(1);
  });
  test("queues a newer edit behind a slow regeneration without failing either side", async () => {
    const baseAiClient = createAiClient();
    let generationCount = 0;
    let releaseSecondGeneration!: () => void;
    let markSecondGenerationStarted!: () => void;
    const secondGenerationGate = new Promise<void>((resolve) => {
      releaseSecondGeneration = resolve;
    });
    const secondGenerationStarted = new Promise<void>((resolve) => {
      markSecondGenerationStarted = resolve;
    });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        async createResumeDraft(input) {
          generationCount += 1;
          if (generationCount === 2) {
            markSecondGenerationStarted();
            await secondGenerationGate;
          }
          const result = await baseAiClient.createResumeDraft(input);
          return {
            ...result,
            summary: `${result.summary} Generation ${generationCount}.`,
          };
        },
      },
    });
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const section = findEditableTextSection(before.draft.sections);

    const regeneration = workspaceService.regenerateResumeDraft("job_ready");
    await secondGenerationStarted;
    // The patch joins the same per-job resume transition tail as the running
    // generation, so it waits instead of racing the stale generation
    // snapshot and winning the draft CAS.
    const userEdit = workspaceService.applyResumePatch(
      {
        id: "edit_while_regeneration_runs",
        draftId: before.draft.id,
        operation: "replace_section_text",
        targetSectionId: section.id,
        targetEntryId: null,
        anchorEntryId: null,
        targetBulletId: null,
        anchorBulletId: null,
        position: null,
        newText: `${section.text} User edit wins.`,
        newIncluded: null,
        newLocked: null,
        newBullets: null,
        appliedAt: new Date().toISOString(),
        origin: "user",
        conflictReason: null,
      },
      "Edit while regeneration runs",
    );
    // Nothing has landed while generation holds the transition tail.
    const midFlight = await workspaceService.getResumeWorkspace("job_ready");
    expect(buildResumeDraftStateHash(midFlight.draft)).toBe(
      buildResumeDraftStateHash(before.draft),
    );
    releaseSecondGeneration();

    await expect(regeneration).resolves.toBeTruthy();
    await expect(userEdit).resolves.toBeTruthy();

    // The queued edit applies on top of the regenerated draft instead of
    // being rejected or overwritten, and no false failed asset was recorded.
    const persisted = await workspaceService.getResumeWorkspace("job_ready");
    expect(findEditableTextSection(persisted.draft.sections).text).toContain(
      "User edit wins.",
    );
    expect(
      (await repository.listResumeDraftRevisions(before.draft.id)).map(
        (revision) => revision.mutationKind,
      ),
    ).toEqual(["manual_patch", "regenerate_draft"]);
    expect(
      (await repository.listTailoredAssets()).find(
        (asset) => asset.jobId === "job_ready",
      ),
    ).toMatchObject({
      status: "ready",
      failureMessage: null,
      failedAt: null,
    });
  });
  test("restores a prior draft as a new revision while invalidating approval and preserving the original CV", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();
    const profileBefore = await repository.getProfile();
    await workspaceService.generateResume("job_ready");
    const initial = await workspaceService.getResumeWorkspace("job_ready");

    await workspaceService.saveResumeDraft({
      ...initial.draft,
      identity: {
        ...initial.draft.identity!,
        headline: "First saved headline",
      },
    });
    const firstEdit = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...firstEdit.draft,
      identity: {
        ...firstEdit.draft.identity!,
        headline: "Second saved headline",
      },
    });
    const secondEdit = await workspaceService.getResumeWorkspace("job_ready");
    const targetRevision = secondEdit.revisions.find(
      (revision) => revision.parentRevisionId === null,
    );
    expect(targetRevision?.snapshotDraft).toEqual(initial.draft);

    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(exportArtifact).toBeTruthy();
    await workspaceService.approveResume("job_ready", exportArtifact!.id);
    const approved = await workspaceService.getResumeWorkspace("job_ready");

    await workspaceService.restoreResumeDraftRevision(
      "job_ready",
      targetRevision!.id,
    );
    const restored = await workspaceService.getResumeWorkspace("job_ready");
    const profileAfter = await repository.getProfile();

    expect(buildResumeDraftStateHash(restored.draft)).toBe(
      buildResumeDraftStateHash(initial.draft),
    );
    expect(restored.draft).toMatchObject({
      status: "needs_review",
      approvedAt: null,
      approvedExportId: null,
      staleReason: "Restored from resume history and needs a fresh review.",
    });
    expect(restored.exports.every((artifact) => !artifact.isApproved)).toBe(
      true,
    );
    expect(restored.tailoredAsset?.storagePath).toBeNull();
    expect(restored.validation?.draftContentHash).toBeTruthy();
    expect(restored.revisions[0]).toMatchObject({
      actor: "restore",
      mutationKind: "restore",
      parentRevisionId: secondEdit.revisions[0]?.id,
      restoredFromRevisionId: targetRevision?.id,
      snapshotDraft: approved.draft,
    });
    expect(profileAfter.baseResume).toEqual(profileBefore.baseResume);
  });

  test("restore reports review-pending truth, persists the exact sanitized draft, and a failed regenerate keeps the approved resume", async () => {
    let generationFailure: Error | null = null;
    const baseAiClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        createResumeDraft(input) {
          if (generationFailure) {
            return Promise.reject(generationFailure);
          }
          return baseAiClient.createResumeDraft(input);
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const initial = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...initial.draft,
      identity: {
        ...initial.draft.identity!,
        headline: "Edited headline after generation",
      },
    });
    const edited = await workspaceService.getResumeWorkspace("job_ready");
    const targetRevision = edited.revisions.find(
      (revision) => revision.parentRevisionId === null,
    );
    expect(targetRevision?.snapshotDraft).toEqual(initial.draft);

    const exported = await workspaceService.exportResumePdf("job_ready");
    const approvedExportId = exported.resumeExportArtifacts
      .filter((artifact) => artifact.jobId === "job_ready")
      .sort(
        (left, right) =>
          new Date(right.exportedAt).getTime() -
          new Date(left.exportedAt).getTime(),
      )[0]!.id;
    await workspaceService.approveResume("job_ready", approvedExportId);
    const beforeRestore = {
      draft: (await workspaceService.getResumeWorkspace("job_ready")).draft,
      job: (await repository.listSavedJobs()).find(
        (job) => job.id === "job_ready",
      )!,
      profile: await repository.getProfile(),
    };

    await workspaceService.restoreResumeDraftRevision(
      "job_ready",
      targetRevision!.id,
    );

    // Truthful restore state for the Review Queue: the tailored content still
    // exists and awaits a fresh review + export, so the asset is never mapped
    // to a generic failure and approval stays invalidated.
    const restoredAssets = await repository.listTailoredAssets();
    const restoredAsset = restoredAssets.find(
      (asset) => asset.jobId === "job_ready",
    )!;
    expect(restoredAsset).toMatchObject({
      status: "ready",
      storagePath: null,
      failureMessage: null,
      failedAt: null,
    });
    expect(restoredAsset.contentText).toBeTruthy();

    const queueItem = buildReviewQueue(
      await repository.listSavedJobs(),
      restoredAssets,
      await repository.listResumeDrafts(),
      await repository.listResumeExportArtifacts(),
      beforeRestore.profile,
      await repository.getSettings(),
    ).find((entry) => entry.jobId === "job_ready")!;
    expect(queueItem).toMatchObject({
      assetStatus: "ready",
      resumeReview: { status: "needs_review" },
    });

    // Exact persisted snapshot semantics: the restore revision snapshots the
    // exact pre-restore persisted draft, while afterHash and the persisted
    // current draft both describe the same sanitized restoredDraft instead of
    // the raw pre-sanitize target snapshot.
    const restored = await workspaceService.getResumeWorkspace("job_ready");
    expect(buildResumeDraftStateHash(restored.draft)).toBe(
      buildResumeDraftStateHash(initial.draft),
    );
    expect(restored.draft.status).toBe("needs_review");
    const restoreRevision = restored.revisions[0]!;
    expect(restoreRevision.snapshotDraft).toEqual(beforeRestore.draft);
    expect(restoreRevision.afterHash).toBe(
      buildResumeDraftStateHash(restored.draft),
    );
    const expectedRestoredDraft: ResumeDraft = sanitizeResumeDraft({
      draft: ResumeDraftSchema.parse({
        ...targetRevision!.snapshotDraft!,
        id: beforeRestore.draft.id,
        jobId: "job_ready",
        status: "needs_review",
        approvedAt: null,
        approvedExportId: null,
        staleReason: "Restored from resume history and needs a fresh review.",
        createdAt: beforeRestore.draft.createdAt,
        updatedAt: restored.draft.updatedAt,
      }),
      job: beforeRestore.job,
      profile: beforeRestore.profile,
    });
    expect(restored.draft).toEqual(expectedRestoredDraft);

    // Re-export/approval prerequisites are unchanged after a restore.
    const reExported = await workspaceService.exportResumePdf("job_ready");
    const reApprovedExportId = reExported.resumeExportArtifacts
      .filter((artifact) => artifact.jobId === "job_ready")
      .sort(
        (left, right) =>
          new Date(right.exportedAt).getTime() -
          new Date(left.exportedAt).getTime(),
      )[0]!.id;
    await workspaceService.approveResume("job_ready", reApprovedExportId);
    const reApproved = await workspaceService.getResumeWorkspace("job_ready");
    expect(reApproved.draft).toMatchObject({
      status: "approved",
      approvedExportId: reApprovedExportId,
    });
    expect(reApproved.tailoredAsset).toMatchObject({
      status: "ready",
    });
    expect(reApproved.tailoredAsset?.storagePath).toBeTruthy();

    // A failed regenerate keeps the approved file and saves its failure notice.
    const approvedAsset = (await repository.listTailoredAssets()).find(
      (asset) => asset.jobId === "job_ready",
    )!;
    generationFailure = new Error("Provider offline for tests");
    await expect(
      workspaceService.regenerateResumeDraft("job_ready"),
    ).rejects.toThrow(/Provider offline/);
    expect(
      (await repository.listTailoredAssets()).find(
        (asset) => asset.jobId === "job_ready",
      ),
    ).toEqual({
      ...approvedAsset,
      failureMessage: expect.stringContaining(
        "Your previous resume was kept",
      ) as unknown,
      failedAt: expect.any(String) as unknown,
    });
    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft,
    ).toMatchObject({
      status: "approved",
      approvedExportId: reApprovedExportId,
    });

    const keptQueueItem = buildReviewQueue(
      await repository.listSavedJobs(),
      await repository.listTailoredAssets(),
      await repository.listResumeDrafts(),
      await repository.listResumeExportArtifacts(),
      beforeRestore.profile,
      await repository.getSettings(),
    ).find((entry) => entry.jobId === "job_ready")!;
    expect(keptQueueItem.assetStatus).toBe("ready");
  });
});
