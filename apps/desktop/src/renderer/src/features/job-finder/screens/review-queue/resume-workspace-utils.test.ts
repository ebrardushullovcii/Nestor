import { describe, expect, it } from "vitest";
import type {
  ResumeAssistantMessage,
  ResumeDraftRevision,
} from "@nestor/contracts";
import {
  findUnansweredAssistantRequest,
  describeAcceptedAssistantEdits,
  describeResumeDraftProvenance,
  describeResumeGenerationPath,
  describeResumeExportClaimBlock,
  resumeExportClaimBlockActionLabel,
  findLatestAssistantEditRevisionId,
  getDeterministicResumeFallbackMessage,
} from "./resume-workspace-utils";

describe("describeResumeGenerationPath", () => {
  it("says nothing for an AI-created draft", () => {
    expect(
      describeResumeGenerationPath({
        generationMethod: "ai_assisted",
        generationReason: null,
        generationDetail: null,
        notes: ["Used the built-in deterministic resume tailorer."],
      }),
    ).toBeNull();
  });

  it("explains a missing provider without offering a retry", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: "no_provider_configured",
      generationDetail: null,
      notes: [],
    });

    expect(disclosure?.message).toContain(
      "The first draft came from the built-in generator because AI writing is not available right now.",
    );
    expect(disclosure?.canRetryWithAi).toBe(true);
  });

  it("explains a forced deterministic session without offering a retry", () => {
    expect(
      describeResumeGenerationPath({
        generationMethod: "deterministic",
        generationReason: "forced_deterministic",
        generationDetail: "Desktop test API forces deterministic AI runtime.",
        notes: [],
      })?.canRetryWithAi,
    ).toBe(false);
  });

  it("names the provider failure and offers a retry", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: "provider_failed",
      generationDetail: "HTTP 502 from provider",
      notes: [],
    });

    expect(disclosure?.message).toContain(
      "The first draft came from the built-in generator because the AI draft failed (HTTP 502 from provider).",
    );
    expect(disclosure?.canRetryWithAi).toBe(true);
  });

  it("says a stopped AI run in plain words instead of its internal stop reason", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: "provider_failed",
      generationDetail:
        "Resume generation agent stopped before completing (permanent_failure).",
      notes: [],
    });

    expect(disclosure?.message).toContain(
      "because the AI draft failed (the AI stopped partway through).",
    );
    expect(disclosure?.message).not.toContain("permanent_failure");
  });

  it("distinguishes a timeout from a failure", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: "provider_timeout",
      generationDetail: "Model request timed out after 60s",
      notes: [],
    });

    expect(disclosure?.message).toMatch(
      /^The first draft came from the built-in generator because the AI draft timed out/,
    );
    expect(disclosure?.canRetryWithAi).toBe(true);
  });

  it("names a missing listing body plainly and offers no retry", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: "listing_text_missing",
      generationDetail: null,
      notes: [],
    });

    expect(disclosure?.message).toMatch(
      /^This listing's text was not captured, so the resume could not be tailored to it/,
    );
    // Not a model failure: nothing is gained by asking again without text.
    expect(disclosure?.message).not.toMatch(/built-in generator/);
    expect(disclosure?.canRetryWithAi).toBe(false);
  });

  it("explains rejected model proposals and offers a retry", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: "provider_output_unverified",
      generationDetail:
        "AI proposed 6 rewrites, but none could be verified against your saved evidence.",
      notes: [],
    });

    expect(disclosure?.message).toContain("proposed 6 rewrites");
    expect(disclosure?.message).toContain(
      "The first draft came from the built-in generator instead.",
    );
    expect(disclosure?.canRetryWithAi).toBe(true);
  });

  it("falls back to note prose for assets saved before the structured reason existed", () => {
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: null,
      generationDetail: null,
      notes: [
        "Fell back to the deterministic resume draft creator after the model call failed.",
        "Primary AI draft creation failed: Model request timed out after 60s",
      ],
    });

    expect(disclosure?.message).toBe(
      getDeterministicResumeFallbackMessage(["timed out after 60s"]),
    );
    expect(disclosure?.message).toMatch(
      /^The first draft came from the built-in generator because the AI resume draft timed out/,
    );
    expect(disclosure?.canRetryWithAi).toBe(true);
  });

  it("keeps the retry escape hatch on a plain deterministic note", () => {
    // The narrower prose match removed Retry with AI exactly on the assets
    // whose structured reason was never recorded, so the same draft lost the
    // escape hatch after approval.
    const disclosure = describeResumeGenerationPath({
      generationMethod: "deterministic",
      generationReason: null,
      generationDetail: null,
      notes: ["Used the deterministic resume draft creator."],
    });

    expect(disclosure?.message).toBeTruthy();
    expect(disclosure?.canRetryWithAi).toBe(true);
  });
});

function buildAssistantMessage(
  overrides: Partial<ResumeAssistantMessage>,
): ResumeAssistantMessage {
  return {
    id: "message_1",
    jobId: "job_1",
    role: "assistant",
    content: "Tightened the summary.",
    patches: [],
    proposalStatus: "none",
    baseDraftUpdatedAt: null,
    resolvedPatchIds: [],
    resolvedAt: null,
    proposalError: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  } as ResumeAssistantMessage;
}

function buildPatch(id: string, sectionId: string, entryId?: string) {
  return {
    id,
    origin: "assistant",
    operation: "replace_section_text",
    targetSectionId: sectionId,
    ...(entryId ? { targetEntryId: entryId } : {}),
  } as ResumeAssistantMessage["patches"][number];
}

describe("describeAcceptedAssistantEdits", () => {
  it("reports nothing while no proposal has been accepted", () => {
    expect(
      describeAcceptedAssistantEdits([
        buildAssistantMessage({
          proposalStatus: "pending",
          patches: [buildPatch("patch_1", "section_summary")],
        }),
      ]),
    ).toBeNull();
  });

  it("counts only the patches the user actually accepted", () => {
    const summary = describeAcceptedAssistantEdits([
      buildAssistantMessage({
        proposalStatus: "accepted",
        patches: [
          buildPatch("patch_1", "section_summary"),
          buildPatch("patch_2", "section_experience", "entry_1"),
        ],
        resolvedPatchIds: ["patch_1"],
      }),
    ]);

    expect(summary?.count).toBe(1);
    expect(summary?.label).toBe("1 AI edit applied");
    expect(summary?.changedTargetIds).toEqual(["section_summary"]);
  });

  it("collects every changed target across accepted proposals", () => {
    const summary = describeAcceptedAssistantEdits([
      buildAssistantMessage({
        id: "message_1",
        proposalStatus: "accepted",
        patches: [buildPatch("patch_1", "section_summary")],
        resolvedPatchIds: ["patch_1"],
      }),
      buildAssistantMessage({
        id: "message_2",
        proposalStatus: "accepted",
        patches: [buildPatch("patch_2", "section_experience", "entry_1")],
        resolvedPatchIds: ["patch_2"],
      }),
      buildAssistantMessage({
        id: "message_3",
        proposalStatus: "rejected",
        patches: [buildPatch("patch_3", "section_skills")],
        resolvedPatchIds: [],
      }),
    ]);

    expect(summary?.label).toBe("2 AI edits applied");
    expect(summary?.changedTargetIds).toEqual([
      "section_summary",
      "section_experience",
      "entry_1",
    ]);
  });
});

describe("describeResumeDraftProvenance", () => {
  const generationPath = describeResumeGenerationPath({
    generationMethod: "deterministic",
    generationReason: "provider_output_unverified",
    generationDetail:
      "AI could not produce usable rewrite suggestions this time",
    notes: [],
  });

  it("says nothing when neither fact exists", () => {
    expect(
      describeResumeDraftProvenance({
        acceptedAssistantEdits: null,
        generationPath: null,
      }),
    ).toBeNull();
  });

  it("separates who wrote the first draft from what was accepted since", () => {
    const message = describeResumeDraftProvenance({
      acceptedAssistantEdits: {
        changedTargetIds: ["section_summary"],
        count: 1,
        label: "1 AI edit applied",
      },
      generationPath,
    });

    // "1 AI edit applied" stacked above "the model returned no usable
    // rewrites" read as a contradiction; one ordered sentence pair does not.
    expect(message).toBe(
      "AI could not produce usable rewrite suggestions this time. The first draft came from the built-in generator instead. 1 assistant edit has been applied since, and the changed lines are marked in the preview. Read the draft against your own experience before you use it.",
    );
  });

  it("pluralizes the accepted-edit clause", () => {
    expect(
      describeResumeDraftProvenance({
        acceptedAssistantEdits: {
          changedTargetIds: [],
          count: 3,
          label: "3 AI edits applied",
        },
        generationPath,
      }),
    ).toContain("3 assistant edits have been applied since");
  });

  it("keeps each fact alone when only one of them holds", () => {
    expect(
      describeResumeDraftProvenance({
        acceptedAssistantEdits: null,
        generationPath,
      }),
    ).toBe(generationPath?.message);
    expect(
      describeResumeDraftProvenance({
        acceptedAssistantEdits: {
          changedTargetIds: [],
          count: 1,
          label: "1 AI edit applied",
        },
        generationPath: null,
      }),
    ).toBe("1 AI edit applied. The changed lines are marked in the preview.");
  });
});

describe("describeAcceptedAssistantEdits after Undo or regeneration", () => {
  const revision = (
    id: string,
    mutationKind: ResumeDraftRevision["mutationKind"],
    createdAt: string,
    restoredFromRevisionId: string | null = null,
  ) =>
    ({
      id,
      draftId: "draft_1",
      parentRevisionId: null,
      actor: "assistant",
      mutationKind,
      snapshotDraft: null,
      snapshotIdentity: null,
      snapshotSections: [],
      beforeHash: null,
      afterHash: null,
      diff: null,
      restoredFromRevisionId,
      createdAt,
      reason: null,
    }) as ResumeDraftRevision;
  const accepted = [
    buildAssistantMessage({
      id: "message_1",
      proposalStatus: "accepted",
      patches: [buildPatch("patch_1", "section_summary")],
      resolvedPatchIds: ["patch_1"],
      resolvedAt: "2026-09-03T10:00:00.000Z",
    }),
    buildAssistantMessage({
      id: "message_2",
      proposalStatus: "accepted",
      patches: [buildPatch("patch_2", "section_experience", "entry_1")],
      resolvedPatchIds: ["patch_2"],
      resolvedAt: "2026-09-03T11:00:00.000Z",
    }),
  ];

  it("stops counting and marking an AI edit once it is undone", () => {
    const summary = describeAcceptedAssistantEdits(accepted, [
      revision("rev_1", "assistant_patch", "2026-09-03T10:00:00.000Z"),
      revision("rev_2", "assistant_patch", "2026-09-03T11:00:00.000Z"),
      revision("rev_3", "restore", "2026-09-03T12:00:00.000Z", "rev_2"),
    ]);

    expect(summary?.label).toBe("1 AI edit applied");
    expect(summary?.changedTargetIds).toEqual(["section_summary"]);
  });

  it("reports nothing once every AI edit is undone or regenerated away", () => {
    expect(
      describeAcceptedAssistantEdits(accepted, [
        revision("rev_1", "assistant_patch", "2026-09-03T10:00:00.000Z"),
        revision("rev_2", "assistant_patch", "2026-09-03T11:00:00.000Z"),
        revision("rev_3", "regenerate_draft", "2026-09-03T12:00:00.000Z"),
      ]),
    ).toBeNull();
  });
});

describe("findLatestAssistantEditRevisionId", () => {
  const revision = (
    id: string,
    mutationKind: ResumeDraftRevision["mutationKind"],
    createdAt: string,
  ) =>
    ({
      id,
      draftId: "draft_1",
      parentRevisionId: null,
      actor: "assistant",
      mutationKind,
      snapshotDraft: null,
      snapshotIdentity: null,
      snapshotSections: [],
      beforeHash: null,
      afterHash: null,
      diff: null,
      restoredFromRevisionId: null,
      createdAt,
      reason: null,
    }) as ResumeDraftRevision;

  it("picks the newest assistant patch, which snapshots the pre-edit draft", () => {
    expect(
      findLatestAssistantEditRevisionId([
        revision("rev_1", "assistant_patch", "2026-09-03T10:00:00.000Z"),
        revision("rev_2", "manual_save", "2026-09-03T12:00:00.000Z"),
        revision("rev_3", "assistant_patch", "2026-09-03T11:00:00.000Z"),
      ]),
    ).toBe("rev_3");
  });

  it("skips AI edits already undone and those a full regeneration replaced", () => {
    const undo = {
      ...revision("rev_4", "restore", "2026-09-03T13:00:00.000Z"),
      restoredFromRevisionId: "rev_3",
    };
    expect(
      findLatestAssistantEditRevisionId([
        revision("rev_1", "assistant_patch", "2026-09-03T10:00:00.000Z"),
        revision("rev_3", "assistant_patch", "2026-09-03T11:00:00.000Z"),
        undo,
      ]),
    ).toBe("rev_1");
    expect(
      findLatestAssistantEditRevisionId([
        revision("rev_1", "assistant_patch", "2026-09-03T10:00:00.000Z"),
        revision("rev_2", "regenerate_draft", "2026-09-03T11:00:00.000Z"),
      ]),
    ).toBeNull();
  });

  it("returns null when the assistant has changed nothing", () => {
    expect(
      findLatestAssistantEditRevisionId([
        revision("rev_1", "manual_patch", "2026-09-03T10:00:00.000Z"),
      ]),
    ).toBeNull();
  });
});

describe("describeResumeExportClaimBlock", () => {
  it("counts the lines that need a decision, whatever kind of block each is", () => {
    expect(
      describeResumeExportClaimBlock({
        blockingAssessments: [
          { status: "confirm_needed" },
          { status: "unsupported" },
        ],
      }),
    ).toBe("2 lines need your decision before this resume can be approved.");
    expect(
      describeResumeExportClaimBlock({
        blockingAssessments: [{ status: "confirm_needed" }],
      }),
    ).toBe("1 line needs your decision before this resume can be approved.");
    expect(describeResumeExportClaimBlock({ blockingAssessments: [] })).toBe(
      null,
    );
  });

  it("names the count on the action", () => {
    expect(
      resumeExportClaimBlockActionLabel({
        blockingAssessments: [{ status: "confirm_needed" }],
      }),
    ).toBe("Review 1 line");
    expect(
      resumeExportClaimBlockActionLabel({
        blockingAssessments: [
          { status: "confirm_needed" },
          { status: "unsupported" },
          { status: "review" },
        ],
      }),
    ).toBe("Review 3 lines");
  });
});

describe("findUnansweredAssistantRequest", () => {
  const message = (
    role: "user" | "assistant",
    content: string,
    patchCount = 0,
  ) => ({
    role,
    content,
    patches: new Array<ResumeAssistantMessage["patches"][number]>(patchCount),
  });

  it("returns the newest request when its reply proposed nothing", () => {
    expect(
      findUnansweredAssistantRequest([
        message("user", "Shorten the summary."),
        message(
          "assistant",
          "This job sends your original resume file unchanged.",
        ),
      ]),
    ).toBe("Shorten the summary.");
  });

  it("returns null once a reply carried a proposal or nothing was asked", () => {
    expect(
      findUnansweredAssistantRequest([
        message("user", "Shorten the summary."),
        message("assistant", "Here is a change.", 1),
      ]),
    ).toBeNull();
    expect(findUnansweredAssistantRequest([])).toBeNull();
  });
});
