import type {
  ResumeClaimAssessment,
  ResumeClaimAssessmentStatus,
  ResumeClaimField,
  ResumeDraft,
  ResumeDraftPatch,
  ResumeDraftSourceRef,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  findCurrentClaimAssessment,
  findProposalPatchTarget,
  formatProposalTargetLabel,
  PROPOSED_WORDING_CHECK_NOTE,
  resolveProposalProvenance,
} from "./resume-assistant-proposal-provenance";

const savedSummaryText =
  "Systems-focused product designer with deep workflow automation experience.";
const savedEntrySummary = "Leads design systems and workflow platform work.";
const savedBulletAText =
  "Led design-system rollout across core workflow surfaces.";
const savedBulletBText =
  "Authored rollout playbooks adopted by design and operations teams.";
const savedSectionBulletText =
  "Maintained legacy services while preserving release reliability.";

const jobSourceRef: ResumeDraftSourceRef = {
  id: "ref job one",
  sourceKind: "job",
  sourceId: null,
  snippet: "Own the workflow automation surface end to end.",
};

const profileSourceRef: ResumeDraftSourceRef = {
  id: "ref profile one",
  sourceKind: "profile",
  sourceId: null,
  snippet: "Ran the rollout playbook across teams.",
};

const researchSourceRef: ResumeDraftSourceRef = {
  id: "ref research one",
  sourceKind: "research",
  sourceId: null,
  snippet: "Rollout notes saved from company research.",
};

function buildDraft(): ResumeDraft {
  const updatedAt = "2026-04-27T00:00:00.000Z";

  return {
    id: "draft demo",
    jobId: "job demo",
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [
      {
        id: "sec summary",
        kind: "summary",
        label: "Summary",
        text: savedSummaryText,
        bullets: [],
        entries: [],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [jobSourceRef],
        updatedAt,
      },
      {
        id: "sec experience",
        kind: "experience",
        label: "Experience",
        text: null,
        bullets: [],
        entries: [
          {
            id: "ent design",
            entryType: "experience",
            title: "Senior Systems Designer",
            subtitle: "Signal Systems",
            location: "London, UK",
            dateRange: "2020 - Present",
            startDate: "2020",
            endDate: null,
            isCurrent: true,
            summary: savedEntrySummary,
            bullets: [
              {
                id: "bul a",
                text: savedBulletAText,
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                lastGeneratedContentHash: null,
                updatedAt,
              },
              {
                id: "bul b",
                text: savedBulletBText,
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [researchSourceRef],
                lastGeneratedContentHash: null,
                updatedAt,
              },
            ],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: 0,
            profileRecordId: null,
            sourceRefs: [profileSourceRef],
            updatedAt,
          },
        ],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 1,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt,
      },
      {
        id: "sec skills",
        kind: "skills",
        label: "Skills",
        text: null,
        bullets: [
          {
            id: "sbul one",
            text: savedSectionBulletText,
            origin: "imported",
            locked: false,
            included: true,
            sourceRefs: [jobSourceRef],
            lastGeneratedContentHash: null,
            updatedAt,
          },
        ],
        entries: [],
        origin: "imported",
        locked: false,
        included: true,
        sortOrder: 2,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [jobSourceRef],
        updatedAt,
      },
    ],
    targetPageCount: 2,
    generationMethod: "ai",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

let assessmentCounter = 0;

function buildAssessment(overrides?: {
  assessedAt?: string;
  bulletId?: string | null;
  claimText?: string;
  entryId?: string | null;
  field?: ResumeClaimField;
  sectionId?: string;
  status?: ResumeClaimAssessmentStatus;
}): ResumeClaimAssessment {
  assessmentCounter += 1;

  return {
    id: `assessment ${assessmentCounter}`,
    field: overrides?.field ?? "entry_bullet",
    sectionId: overrides?.sectionId ?? "sec experience",
    entryId:
      overrides?.entryId !== undefined
        ? overrides.entryId
        : overrides?.field === "section_text"
          ? null
          : "ent design",
    bulletId:
      overrides?.bulletId !== undefined
        ? overrides.bulletId
        : (overrides?.field ?? "entry_bullet") === "entry_bullet"
          ? "bul b"
          : null,
    claimText:
      overrides?.claimText ??
      ((overrides?.field ?? "entry_bullet") === "entry_bullet"
        ? savedBulletBText
        : overrides?.field === "section_text"
          ? savedSummaryText
          : savedEntrySummary),
    claimOrigin: "assistant_edited",
    contentHash: "fnv1a32:00000000",
    status: overrides?.status ?? "exact",
    evidenceRefs: [],
    verifier: "deterministic_candidate_evidence_v1",
    assessedAt: overrides?.assessedAt ?? "2026-04-27T01:00:00.000Z",
  };
}

function buildPatch(overrides?: Partial<ResumeDraftPatch>): ResumeDraftPatch {
  return {
    id: "patch demo",
    draftId: "draft demo",
    operation: "update_bullet",
    targetSectionId: "sec experience",
    targetEntryId: "ent design",
    anchorEntryId: null,
    targetBulletId: "bul b",
    anchorBulletId: null,
    position: null,
    newText: "Proposed replacement wording.",
    newIncluded: null,
    newLocked: null,
    newBullets: null,
    appliedAt: "2026-04-27T00:30:00.000Z",
    origin: "assistant",
    conflictReason: null,
    ...overrides,
  };
}

describe("resume assistant proposal provenance", () => {
  it("labels section, entry, and bullet targets with human locations", () => {
    const draft = buildDraft();

    const bulletPatch = buildPatch();
    expect(
      formatProposalTargetLabel({
        patch: bulletPatch,
        target: findProposalPatchTarget(draft, bulletPatch),
      }),
    ).toBe("Experience · Senior Systems Designer · Bullet 2");

    const summaryPatch = buildPatch({
      operation: "replace_section_text",
      targetSectionId: "sec summary",
      targetEntryId: null,
      targetBulletId: null,
    });
    const summaryTarget = findProposalPatchTarget(draft, summaryPatch);
    expect(summaryTarget.section?.label).toBe("Summary");
    expect(
      formatProposalTargetLabel({ patch: summaryPatch, target: summaryTarget }),
    ).toBe("Summary");

    const entryPatch = buildPatch({
      operation: "replace_entry_summary",
      targetBulletId: null,
    });
    expect(
      formatProposalTargetLabel({
        patch: entryPatch,
        target: findProposalPatchTarget(draft, entryPatch),
      }),
    ).toBe("Experience · Senior Systems Designer");

    const insertPatch = buildPatch({
      operation: "insert_bullet",
      targetBulletId: null,
    });
    expect(
      formatProposalTargetLabel({
        patch: insertPatch,
        target: findProposalPatchTarget(draft, insertPatch),
      }),
    ).toBe("Experience · Senior Systems Designer · New bullet");

    const sectionBulletPatch = buildPatch({
      targetSectionId: "sec skills",
      targetEntryId: null,
      targetBulletId: "sbul one",
    });
    expect(
      formatProposalTargetLabel({
        patch: sectionBulletPatch,
        target: findProposalPatchTarget(draft, sectionBulletPatch),
      }),
    ).toBe("Skills · Bullet 1");
  });

  it("falls back to subtitle and entry-type labels without leaking raw ids", () => {
    const draft = buildDraft();
    draft.sections[1]!.entries[0]!.title = null;
    draft.sections[1]!.entries[0]!.subtitle = null;

    const label = formatProposalTargetLabel({
      patch: buildPatch(),
      target: findProposalPatchTarget(draft, buildPatch()),
    });

    expect(label).toBe("Experience · Experience · Bullet 2");
    expect(label).not.toMatch(/_/);
  });

  it("matches saved assessments by exact locator and current text", () => {
    const draft = buildDraft();
    const patch = buildPatch();

    const matched = findCurrentClaimAssessment({
      claimAssessments: [
        buildAssessment({ field: "section_text", sectionId: "sec summary" }),
        buildAssessment(),
      ],
      patch,
      target: findProposalPatchTarget(draft, patch),
    });

    expect(matched?.claimText).toBe(savedBulletBText);
    expect(matched?.field).toBe("entry_bullet");
  });

  it("does not confuse entry bullets with section bullets at the same locator", () => {
    const draft = buildDraft();
    const patch = buildPatch();

    const mismatchedField = findCurrentClaimAssessment({
      claimAssessments: [
        // Same section and bullet ids, but recorded as a section-level bullet.
        buildAssessment({ entryId: null, field: "section_bullet" }),
      ],
      patch,
      target: findProposalPatchTarget(draft, patch),
    });
    expect(mismatchedField).toBeNull();

    const sectionLevelMatch = findCurrentClaimAssessment({
      claimAssessments: [
        buildAssessment({
          entryId: null,
          field: "section_bullet",
          sectionId: "sec skills",
          bulletId: "sbul one",
          claimText: savedSectionBulletText,
        }),
      ],
      patch: buildPatch({
        targetSectionId: "sec skills",
        targetEntryId: null,
        targetBulletId: "sbul one",
      }),
      target: findProposalPatchTarget(
        draft,
        buildPatch({
          targetSectionId: "sec skills",
          targetEntryId: null,
          targetBulletId: "sbul one",
        }),
      ),
    });
    expect(sectionLevelMatch?.status).toBe("exact");
  });

  it("reports no match when the locator, text, or validation is missing or stale", () => {
    const draft = buildDraft();

    // Stale: assessment describes older wording.
    expect(
      findCurrentClaimAssessment({
        claimAssessments: [
          buildAssessment({ claimText: "Older bullet wording." }),
        ],
        patch: buildPatch(),
        target: findProposalPatchTarget(draft, buildPatch()),
      }),
    ).toBeNull();

    // Wrong entry.
    expect(
      findCurrentClaimAssessment({
        claimAssessments: [buildAssessment({ entryId: "ent other" })],
        patch: buildPatch(),
        target: findProposalPatchTarget(draft, buildPatch()),
      }),
    ).toBeNull();

    // Wrong bullet.
    expect(
      findCurrentClaimAssessment({
        claimAssessments: [buildAssessment({ bulletId: "bul other" })],
        patch: buildPatch(),
        target: findProposalPatchTarget(draft, buildPatch()),
      }),
    ).toBeNull();

    // No validation at all.
    expect(
      findCurrentClaimAssessment({
        claimAssessments: [],
        patch: buildPatch(),
        target: findProposalPatchTarget(draft, buildPatch()),
      }),
    ).toBeNull();

    // Missing target node.
    const missingPatch = buildPatch({ targetBulletId: "bul gone" });
    expect(
      findCurrentClaimAssessment({
        claimAssessments: [buildAssessment()],
        patch: missingPatch,
        target: findProposalPatchTarget(draft, missingPatch),
      }),
    ).toBeNull();
  });

  it("prefers the most recent assessment when several still match", () => {
    const draft = buildDraft();
    const patch = buildPatch();

    const latest = findCurrentClaimAssessment({
      claimAssessments: [
        buildAssessment({
          status: "unsupported",
          assessedAt: "2026-04-27T00:30:00.000Z",
        }),
        buildAssessment({
          status: "exact",
          assessedAt: "2026-04-27T02:00:00.000Z",
        }),
      ],
      patch,
      target: findProposalPatchTarget(draft, patch),
    });

    expect(latest?.status).toBe("exact");
  });

  it("resolves nearest source refs with bullet beating entry beating section", () => {
    const draft = buildDraft();

    // Bullet b carries its own refs.
    expect(
      resolveProposalProvenance({
        draft,
        patch: buildPatch(),
      }).sourceRefs,
    ).toEqual([researchSourceRef]);

    // Bullet a has none, so the entry refs apply.
    expect(
      resolveProposalProvenance({
        draft,
        patch: buildPatch({ targetBulletId: "bul a" }),
      }).sourceRefs,
    ).toEqual([profileSourceRef]);

    // Insertions have no bullet yet and inherit the entry refs.
    expect(
      resolveProposalProvenance({
        draft,
        patch: buildPatch({ operation: "insert_bullet", targetBulletId: null }),
      }).sourceRefs,
    ).toEqual([profileSourceRef]);

    // Section text falls back to the section refs.
    expect(
      resolveProposalProvenance({
        draft,
        patch: buildPatch({
          operation: "replace_section_text",
          targetSectionId: "sec summary",
          targetEntryId: null,
          targetBulletId: null,
        }),
      }).sourceRefs,
    ).toEqual([jobSourceRef]);
  });

  it("builds honest display checks for wording and non-wording patches", () => {
    const draft = buildDraft();

    const exactCheck = resolveProposalProvenance({
      claimAssessments: [buildAssessment({ status: "exact" })],
      draft,
      patch: buildPatch(),
    });
    expect(exactCheck.savedTextCheck).toEqual({
      label: "Current saved text: Exact evidence.",
      tone: "positive",
    });
    expect(exactCheck.targetFound).toBe(true);

    const uncheckedCheck = resolveProposalProvenance({
      claimAssessments: [],
      draft,
      patch: buildPatch(),
    });
    expect(uncheckedCheck.savedTextCheck).toEqual({
      label: "Current saved text: Not checked yet.",
      tone: "neutral",
    });

    const unsupportedCheck = resolveProposalProvenance({
      claimAssessments: [buildAssessment({ status: "unsupported" })],
      draft,
      patch: buildPatch(),
    });
    expect(unsupportedCheck.savedTextCheck?.tone).toBe("attention");
    expect(unsupportedCheck.savedTextCheck?.label).toBe(
      "Current saved text: Unsupported claim.",
    );

    // Include/lock/order changes carry no proposed wording to check.
    for (const operation of [
      "toggle_include",
      "set_lock",
      "move_bullet",
      "move_entry",
      "reset_entry_order",
    ] as const) {
      expect(
        resolveProposalProvenance({
          claimAssessments: [buildAssessment()],
          draft,
          patch: buildPatch({ operation }),
        }).savedTextCheck,
      ).toBeNull();
    }
  });

  it("degrades honestly when the patch target is gone", () => {
    const provenance = resolveProposalProvenance({
      claimAssessments: [buildAssessment()],
      draft: buildDraft(),
      patch: buildPatch({
        targetSectionId: "sec removed",
        targetEntryId: null,
      }),
    });

    expect(provenance.targetFound).toBe(false);
    expect(provenance.targetLabel).toBe(
      "Original target is no longer in the draft",
    );
    expect(provenance.sourceRefs).toEqual([]);
    expect(provenance.savedTextCheck?.label).toBe(
      "Current saved text: Not checked yet.",
    );
  });

  it("never leaks raw ids through labels or checks", () => {
    const draft = buildDraft();
    const patches = [
      buildPatch(),
      buildPatch({
        operation: "replace_section_text",
        targetSectionId: "sec summary",
        targetEntryId: null,
        targetBulletId: null,
      }),
      buildPatch({ targetSectionId: "sec removed", targetEntryId: null }),
    ];

    for (const patch of patches) {
      const provenance = resolveProposalProvenance({
        claimAssessments: [buildAssessment()],
        draft,
        patch,
      });
      const renderedText = [
        provenance.targetLabel,
        provenance.savedTextCheck?.label ?? "",
        ...provenance.sourceRefs.map((ref) => ref.snippet ?? ""),
      ].join(" ");

      expect(renderedText).not.toMatch(/_/);
      expect(provenance.targetLabel.length).toBeGreaterThan(0);
    }
  });

  it("pins the proposed-wording reassurance copy", () => {
    expect(PROPOSED_WORDING_CHECK_NOTE).toBe(
      "New wording is checked after you accept and save.",
    );
  });
});
