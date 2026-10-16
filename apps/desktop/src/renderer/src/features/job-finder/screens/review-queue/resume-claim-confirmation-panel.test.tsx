// @vitest-environment jsdom

import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  JobFinderResumeWorkspaceSchema,
  JobFinderSetResumeClaimConfirmationInputSchema,
  resumeClaimOwnershipStatement,
  type JobFinderResumeWorkspace,
  type JobFinderSetResumeClaimConfirmationInput,
  type ResumeClaimAssessment,
  type ResumeClaimConfirmation,
} from "@nordri/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApplyQueueDemoState } from "../../../../../../main/adapters/job-finder-demo-state";
import {
  buildResumeClaimConfirmationCommandInput,
  listConfirmNeededClaimAssessments,
  matchResumeClaimConfirmation,
  ResumeClaimConfirmationPanel,
} from "./resume-claim-confirmation-panel";

async function actAndFlush(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

const globalActScope = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const originalActEnvironment = globalActScope.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  globalActScope.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (originalActEnvironment === undefined) {
    delete globalActScope.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  globalActScope.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

function buildWorkspace(
  claimConfirmations: readonly ResumeClaimConfirmation[] = [],
): JobFinderResumeWorkspace {
  const state = createApplyQueueDemoState();
  const job = state.savedJobs.find((entry) => entry.id === "job_ready");
  const baseDraft = state.resumeDrafts.find(
    (entry) => entry.jobId === "job_ready",
  );

  if (!job || !baseDraft) {
    throw new Error(
      "Expected demo state to contain the ready resume workspace fixture.",
    );
  }

  return JobFinderResumeWorkspaceSchema.parse({
    job,
    draft: { ...baseDraft, claimConfirmations },
    exports: [],
    research: [],
    assistantMessages: [],
    tailoredAsset: null,
    sharedProfile: {},
    workHistoryReviewSuggestions: [],
  });
}

const bulletTargetLabel = "Experience · Senior systems designer · Bullet 1";

const confirmNeededBullet: ResumeClaimAssessment = {
  id: "claim_assessment_bullet",
  field: "entry_bullet",
  sectionId: "section_experience",
  entryId: "entry_signal_systems",
  bulletId: "bullet_signal_rollout",
  claimText: "Led design-system rollout across core workflow surfaces.",
  claimOrigin: "ai_generated",
  contentHash: "fnv1a32:11111111",
  status: "confirm_needed",
  evidenceRefs: [],
  verifier: "deterministic_candidate_evidence_v2",
  assessedAt: "2026-08-20T10:00:00.000Z",
};

function buildConfirmation(
  overrides?: Partial<ResumeClaimConfirmation>,
): ResumeClaimConfirmation {
  return {
    id: "claim_confirmation_1",
    draftId: "draft_under_test",
    field: confirmNeededBullet.field,
    sectionId: confirmNeededBullet.sectionId,
    entryId: confirmNeededBullet.entryId,
    bulletId: confirmNeededBullet.bulletId,
    confirmedClaimContentHash: confirmNeededBullet.contentHash,
    ownershipStatement: resumeClaimOwnershipStatement,
    confirmedAt: "2026-08-20T11:00:00.000Z",
    ...overrides,
  };
}

describe("resume claim confirmation helpers", () => {
  it("matches confirmations only on exact draft, locator, and hash", () => {
    const confirmation = buildConfirmation();

    expect(
      matchResumeClaimConfirmation({
        assessment: confirmNeededBullet,
        confirmations: [confirmation],
        draftId: confirmation.draftId,
      })?.id,
    ).toBe(confirmation.id);
    expect(
      matchResumeClaimConfirmation({
        assessment: confirmNeededBullet,
        confirmations: [confirmation],
        draftId: "other_draft",
      }),
    ).toBeNull();
    expect(
      matchResumeClaimConfirmation({
        assessment: { ...confirmNeededBullet, contentHash: "fnv1a32:22222222" },
        confirmations: [confirmation],
        draftId: confirmation.draftId,
      }),
    ).toBeNull();
    expect(
      matchResumeClaimConfirmation({
        assessment: { ...confirmNeededBullet, bulletId: "bullet_other" },
        confirmations: [confirmation],
        draftId: confirmation.draftId,
      }),
    ).toBeNull();
  });

  it("lists only current-verifier confirm_needed assessments", () => {
    expect(
      listConfirmNeededClaimAssessments([
        confirmNeededBullet,
        {
          ...confirmNeededBullet,
          id: "claim_v1",
          verifier: "deterministic_candidate_evidence_v1",
        },
        {
          ...confirmNeededBullet,
          id: "claim_unsupported",
          status: "unsupported",
        },
        { ...confirmNeededBullet, id: "claim_review", status: "review" },
        { ...confirmNeededBullet, id: "claim_exact", status: "exact" },
        {
          ...confirmNeededBullet,
          id: "claim_paraphrase",
          status: "paraphrase",
        },
      ]).map((assessment) => assessment.id),
    ).toEqual(["claim_assessment_bullet"]);
  });

  it("builds the add command with saved revision, locator, hash, and literal ownership statement", () => {
    const draft = buildWorkspace().draft;
    const input = buildResumeClaimConfirmationCommandInput({
      claimAssessments: [confirmNeededBullet],
      draft,
      jobId: "job_ready",
      request: { intent: "add", target: confirmNeededBullet },
    });

    expect(input).toEqual({
      intent: "add",
      jobId: "job_ready",
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "entry_signal_systems",
      bulletId: "bullet_signal_rollout",
      confirmedClaimContentHash: confirmNeededBullet.contentHash,
      ownershipStatement: resumeClaimOwnershipStatement,
    });
    expect(() =>
      JobFinderSetResumeClaimConfirmationInputSchema.parse(input),
    ).not.toThrow();
  });

  it("refuses add commands whose captured wording no longer matches the projection", () => {
    const draft = buildWorkspace().draft;

    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [confirmNeededBullet],
        draft,
        jobId: "job_ready",
        request: {
          intent: "add",
          target: { ...confirmNeededBullet, contentHash: "fnv1a32:33333333" },
        },
      }),
    ).toBeNull();
    // A generated claim the evidence cannot prove is approvable; the same
    // wording written by the person is only a note and has nothing to approve.
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [
          { ...confirmNeededBullet, status: "review", claimOrigin: "imported" },
        ],
        draft,
        jobId: "job_ready",
        request: { intent: "add", target: confirmNeededBullet },
      }),
    ).toBeNull();
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [
          {
            ...confirmNeededBullet,
            status: "review",
            claimOrigin: "ai_generated",
          },
        ],
        draft,
        jobId: "job_ready",
        request: { intent: "add", target: confirmNeededBullet },
      })?.intent,
    ).toBe("add");
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [
          {
            ...confirmNeededBullet,
            verifier: "deterministic_candidate_evidence_v1",
          },
        ],
        draft,
        jobId: "job_ready",
        request: { intent: "add", target: confirmNeededBullet },
      }),
    ).toBeNull();
  });

  it("builds the remove command only from a confirmation stored on the same draft", () => {
    const confirmation = buildConfirmation({ draftId: "draft_1" });
    const draft = { ...buildWorkspace([confirmation]).draft, id: "draft_1" };

    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [confirmNeededBullet],
        draft,
        jobId: "job_ready",
        request: { intent: "remove", confirmationId: confirmation.id },
      }),
    ).toEqual({
      intent: "remove",
      jobId: "job_ready",
      draftId: "draft_1",
      expectedDraftUpdatedAt: draft.updatedAt,
      confirmationId: confirmation.id,
    });
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [confirmNeededBullet],
        draft: { ...draft, id: "draft_2" },
        jobId: "job_ready",
        request: { intent: "remove", confirmationId: confirmation.id },
      }),
    ).toBeNull();
  });

  it("builds add_many from current confirm_needed skill locators", () => {
    const terraform: ResumeClaimAssessment = {
      ...confirmNeededBullet,
      id: "claim_terraform",
      field: "section_bullet",
      sectionId: "section_skills",
      entryId: null,
      bulletId: "skill_terraform",
      claimText: "Terraform",
      contentHash: "fnv1a32:aaaa1111",
    };
    const kubernetes: ResumeClaimAssessment = {
      ...terraform,
      id: "claim_kubernetes",
      bulletId: "skill_kubernetes",
      claimText: "Kubernetes",
      contentHash: "fnv1a32:bbbb2222",
    };
    const draft = buildWorkspace().draft;
    const input = buildResumeClaimConfirmationCommandInput({
      claimAssessments: [terraform, kubernetes],
      draft,
      jobId: "job_ready",
      request: { intent: "add_many", targets: [terraform, kubernetes] },
    });

    expect(input).toEqual({
      intent: "add_many",
      jobId: "job_ready",
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      ownershipStatement: resumeClaimOwnershipStatement,
      targets: [
        {
          field: "section_bullet",
          sectionId: "section_skills",
          entryId: null,
          bulletId: "skill_terraform",
          confirmedClaimContentHash: "fnv1a32:aaaa1111",
        },
        {
          field: "section_bullet",
          sectionId: "section_skills",
          entryId: null,
          bulletId: "skill_kubernetes",
          confirmedClaimContentHash: "fnv1a32:bbbb2222",
        },
      ],
    });
    expect(() =>
      JobFinderSetResumeClaimConfirmationInputSchema.parse(input),
    ).not.toThrow();
  });
});

describe("ResumeClaimConfirmationPanel", () => {
  afterEach(() => {
    cleanup();
  });

  function renderPanel(options?: {
    claimConfirmations?: readonly ResumeClaimConfirmation[];
    hasUnsavedChanges?: boolean;
    onSetResumeClaimConfirmation?: (
      input: JobFinderSetResumeClaimConfirmationInput,
    ) => Promise<unknown>;
    onEditClaim?: (assessment: ResumeClaimAssessment) => void;
    onRejectClaim?: (assessment: ResumeClaimAssessment) => void;
  }) {
    return render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[confirmNeededBullet]}
        draft={buildWorkspace(options?.claimConfirmations ?? []).draft}
        hasUnsavedChanges={options?.hasUnsavedChanges ?? false}
        isWorkspacePending={false}
        jobId="job_ready"
        {...(options?.onEditClaim ? { onEditClaim: options.onEditClaim } : {})}
        {...(options?.onRejectClaim
          ? { onRejectClaim: options.onRejectClaim }
          : {})}
        onSetResumeClaimConfirmation={
          options?.onSetResumeClaimConfirmation ?? vi.fn()
        }
      />,
    );
  }

  it("renders nothing when no line needs a decision", () => {
    const { container } = render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[
          { ...confirmNeededBullet, status: "exact" },
          {
            ...confirmNeededBullet,
            id: "claim_unsupported",
            status: "unsupported",
          },
        ]}
        draft={buildWorkspace().draft}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={vi.fn()}
      />,
    );

    expect(container.querySelector("section")).toBeNull();
  });

  it("shows one plain list: where the line is, the line, Keep and Remove, and the statement once", () => {
    const onRejectClaim = vi.fn();
    const onEditClaim = vi.fn();
    const { container } = renderPanel({ onEditClaim, onRejectClaim });

    expect(screen.getByText("Lines to confirm")).toBeTruthy();
    expect(screen.getByText("1 to decide")).toBeTruthy();
    expect(screen.getByText(bulletTargetLabel)).toBeTruthy();
    expect(screen.getByText(confirmNeededBullet.claimText)).toBeTruthy();
    expect(
      screen.getByText(`Keep records: “${resumeClaimOwnershipStatement}”`),
    ).toBeTruthy();
    // The statement is printed once for the list, not once per row.
    expect(
      container.textContent?.split(resumeClaimOwnershipStatement).length,
    ).toBe(2);
    expect(container.textContent).not.toMatch(
      /\b(lie|lies|lying|liar|dishonest|unethical|fraud)\b/i,
    );
    expect(container.textContent).not.toContain("claim_assessment_bullet");
    expect(container.textContent).not.toContain("fnv1a32");

    fireEvent.click(
      screen.getByRole("button", {
        name: `Remove “${confirmNeededBullet.claimText}” · ${bulletTargetLabel}`,
      }),
    );
    expect(onRejectClaim).toHaveBeenCalledWith(confirmNeededBullet);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Edit “${confirmNeededBullet.claimText}” · ${bulletTargetLabel}`,
      }),
    );
    expect(onEditClaim).toHaveBeenCalledWith(confirmNeededBullet);
  });

  it("lists only lines that need a decision, never unsupported or verified ones", () => {
    render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[
          confirmNeededBullet,
          {
            ...confirmNeededBullet,
            id: "claim_unsupported",
            claimText: "Cut costs by 90 percent.",
            status: "unsupported",
          },
          {
            ...confirmNeededBullet,
            id: "claim_exact",
            claimText: "Verbatim candidate evidence.",
            status: "exact",
          },
        ]}
        draft={buildWorkspace().draft}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText("Cut costs by 90 percent.")).toBeNull();
    expect(screen.queryByText("Verbatim candidate evidence.")).toBeNull();
  });

  it("submits the exact add command once and suppresses duplicate clicks while pending", async () => {
    let resolveCommand!: (value: unknown) => void;
    const onSetResumeClaimConfirmation = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const draft = buildWorkspace().draft;

    render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[confirmNeededBullet]}
        draft={draft}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={onSetResumeClaimConfirmation}
      />,
    );

    const keepButton = screen.getByRole("button", {
      name: `Keep “${confirmNeededBullet.claimText}” · ${bulletTargetLabel}`,
    });

    fireEvent.click(keepButton);
    expect(onSetResumeClaimConfirmation).toHaveBeenCalledTimes(1);
    expect(onSetResumeClaimConfirmation).toHaveBeenCalledWith({
      intent: "add",
      jobId: "job_ready",
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "entry_signal_systems",
      bulletId: "bullet_signal_rollout",
      confirmedClaimContentHash: confirmNeededBullet.contentHash,
      ownershipStatement: resumeClaimOwnershipStatement,
    });

    // Pending keeps the control exposed but inert, so focus stays put and a
    // second activation cannot submit twice.
    expect(keepButton.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(keepButton);
    expect(onSetResumeClaimConfirmation).toHaveBeenCalledTimes(1);

    await actAndFlush(() => {
      resolveCommand(undefined);
    });
    expect(keepButton.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("derives the kept state from the returned snapshot and undoes by confirmation id", async () => {
    const onSetResumeClaimConfirmation = vi
      .fn<
        (input: JobFinderSetResumeClaimConfirmationInput) => Promise<unknown>
      >()
      .mockResolvedValue({});
    const savedDraftId = buildWorkspace().draft.id;
    const confirmation = buildConfirmation({ draftId: savedDraftId });
    const { rerender } = renderPanel({ onSetResumeClaimConfirmation });

    await actAndFlush(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Keep “/ }));
    });

    // The committed workspace snapshot comes back through props: same
    // assessments, draft now carrying the stored confirmation.
    rerender(
      <ResumeClaimConfirmationPanel
        claimAssessments={[confirmNeededBullet]}
        draft={buildWorkspace([confirmation]).draft}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={onSetResumeClaimConfirmation}
      />,
    );

    expect(screen.getByText("Kept")).toBeTruthy();
    expect(screen.getByText("All decided")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Keep “/ })).toBeNull();

    const undoButton = screen.getByRole("button", {
      name: `Undo keeping “${confirmNeededBullet.claimText}” · ${bulletTargetLabel}`,
    });
    await actAndFlush(() => {
      fireEvent.click(undoButton);
    });

    expect(onSetResumeClaimConfirmation).toHaveBeenCalledTimes(2);
    expect(onSetResumeClaimConfirmation).toHaveBeenLastCalledWith({
      intent: "remove",
      jobId: "job_ready",
      draftId: savedDraftId,
      expectedDraftUpdatedAt: buildWorkspace([confirmation]).draft.updatedAt,
      confirmationId: confirmation.id,
    });
  });

  it("does not ask for approval again after all kept lines are approved", () => {
    const savedDraftId = buildWorkspace().draft.id;
    const draft = buildWorkspace([
      buildConfirmation({ draftId: savedDraftId }),
    ]).draft;
    render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[confirmNeededBullet]}
        draft={{ ...draft, status: "approved" }}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={vi.fn().mockResolvedValue({})}
      />,
    );
    expect(screen.getByText("All decided")).toBeTruthy();
    expect(
      screen.getByText("Every line is decided. This resume is approved."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Approve the resume when you are ready/),
    ).toBeNull();
  });

  it("keeps stale rejections visible with truthful retry copy and allows retrying", async () => {
    const onSetResumeClaimConfirmation = vi
      .fn<
        (input: JobFinderSetResumeClaimConfirmationInput) => Promise<unknown>
      >()
      .mockRejectedValueOnce(
        new Error(
          "Resume draft changed before this claim confirmation could be saved. Reload the workspace and try again.",
        ),
      )
      .mockResolvedValue({});
    const { container } = renderPanel({ onSetResumeClaimConfirmation });

    await actAndFlush(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Keep “/ }));
    });

    expect(screen.getByRole("alert").textContent).toBe(
      "Resume draft changed before this claim confirmation could be saved. Reload the workspace and try again.",
    );
    expect(container.querySelector("[data-pending]")).toBeNull();

    await actAndFlush(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Keep “/ }));
    });
    expect(onSetResumeClaimConfirmation).toHaveBeenCalledTimes(2);
  });

  it("notes that the list describes the last saved version while edits are unsaved", () => {
    renderPanel({ hasUnsavedChanges: true });

    expect(
      screen.getByText(
        "This list describes the last saved version. Save your edits to refresh it.",
      ),
    ).toBeTruthy();
  });

  it("groups listing-asked skills, offers Keep all for two or more, and keeps wording one-by-one", async () => {
    const terraform: ResumeClaimAssessment = {
      ...confirmNeededBullet,
      id: "claim_terraform",
      field: "section_bullet",
      sectionId: "section_skills",
      entryId: null,
      bulletId: "skill_terraform",
      claimText: "Terraform",
      contentHash: "fnv1a32:aaaa1111",
    };
    const kubernetes: ResumeClaimAssessment = {
      ...terraform,
      id: "claim_kubernetes",
      bulletId: "skill_kubernetes",
      claimText: "Kubernetes",
      contentHash: "fnv1a32:bbbb2222",
    };
    const workspace = buildWorkspace();
    const draft = JobFinderResumeWorkspaceSchema.parse({
      ...workspace,
      draft: {
        ...workspace.draft,
        sections: [
          ...workspace.draft.sections,
          {
            id: "section_skills",
            kind: "skills",
            label: "Core Skills",
            text: null,
            bullets: [
              {
                id: "skill_terraform",
                text: "Terraform",
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                updatedAt: workspace.draft.updatedAt,
              },
              {
                id: "skill_kubernetes",
                text: "Kubernetes",
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                updatedAt: workspace.draft.updatedAt,
              },
            ],
            entries: [],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: workspace.draft.sections.length,
            entryOrderMode: "chronology",
            profileRecordId: null,
            sourceRefs: [],
            updatedAt: workspace.draft.updatedAt,
          },
        ],
      },
    }).draft;
    const onSetResumeClaimConfirmation = vi.fn().mockResolvedValue({});

    render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[terraform, kubernetes, confirmNeededBullet]}
        draft={draft}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={onSetResumeClaimConfirmation}
      />,
    );

    expect(screen.getByText("Skills the job asked for")).toBeTruthy();
    expect(
      screen.getByText("Wording that stretches your evidence"),
    ).toBeTruthy();
    expect(screen.getByText("3 to decide")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Keep all 2 skills" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Keep “/ })).toHaveLength(3);

    await actAndFlush(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Keep all 2 skills" }),
      );
    });
    expect(onSetResumeClaimConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "add_many",
        targets: [
          expect.objectContaining({ bulletId: "skill_terraform" }),
          expect.objectContaining({ bulletId: "skill_kubernetes" }),
        ],
      }),
    );
  });

  it("does not offer Keep all for a single skill", () => {
    const terraform: ResumeClaimAssessment = {
      ...confirmNeededBullet,
      id: "claim_terraform",
      field: "section_bullet",
      sectionId: "section_skills",
      entryId: null,
      bulletId: "skill_terraform",
      claimText: "Terraform",
      contentHash: "fnv1a32:aaaa1111",
    };
    const workspace = buildWorkspace();
    const draft = JobFinderResumeWorkspaceSchema.parse({
      ...workspace,
      draft: {
        ...workspace.draft,
        sections: [
          ...workspace.draft.sections,
          {
            id: "section_skills",
            kind: "skills",
            label: "Core Skills",
            text: null,
            bullets: [
              {
                id: "skill_terraform",
                text: "Terraform",
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                updatedAt: workspace.draft.updatedAt,
              },
            ],
            entries: [],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: workspace.draft.sections.length,
            entryOrderMode: "chronology",
            profileRecordId: null,
            sourceRefs: [],
            updatedAt: workspace.draft.updatedAt,
          },
        ],
      },
    }).draft;

    render(
      <ResumeClaimConfirmationPanel
        claimAssessments={[terraform]}
        draft={draft}
        hasUnsavedChanges={false}
        isWorkspacePending={false}
        jobId="job_ready"
        onSetResumeClaimConfirmation={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Keep all / })).toBeNull();
    expect(screen.getByRole("button", { name: /^Keep “/ })).toBeTruthy();
  });
});
