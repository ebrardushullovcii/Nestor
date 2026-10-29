import { describe, expect, test } from "vitest";
import {
  JobFinderResumePreviewSchema,
  ResumeDraftSchema,
  ResumeDraftSectionSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftPatchSchema,
  ResumeAssistantMessageSchema,
  ResumeExportArtifactSchema,
  ResumeValidationResultSchema,
  getResumeValidationIssueSeverity,
  isBlockingResumeValidationIssue,
  WorkHistoryReviewAcknowledgmentSchema,
  WorkHistoryReviewSuggestionSchema,
  type ResumeDraft,
  type WorkHistoryReviewAcknowledgment,
} from "./index";

describe("contracts resume workspace schemas", () => {
  test("only error-severity resume validation issues block approval", () => {
    expect(isBlockingResumeValidationIssue({ severity: "error" })).toBe(true);
    expect(isBlockingResumeValidationIssue({ severity: "warning" })).toBe(
      false,
    );
    expect(isBlockingResumeValidationIssue({ severity: "info" })).toBe(false);
  });

  test("page length never blocks, even when an older check saved it as an error", () => {
    // ADR 0051: length is a quiet note.
    expect(
      isBlockingResumeValidationIssue({
        severity: "error",
        category: "page_overflow",
      }),
    ).toBe(false);
    expect(
      getResumeValidationIssueSeverity({
        severity: "error",
        category: "page_overflow",
      }),
    ).toBe("info");
    expect(
      isBlockingResumeValidationIssue({
        severity: "error",
        category: "unsupported_claim",
      }),
    ).toBe(true);
  });

  test("rejects unsupported resume export formats", () => {
    expect(() =>
      ResumeExportArtifactSchema.parse({
        id: "resume_export_1",
        draftId: "resume_draft_1",
        jobId: "job_1",
        format: "docx",
        filePath: "/tmp/alex-signal.docx",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:03:10.000Z",
        isApproved: false,
      }),
    ).toThrow();
  });

  test("parses a live resume preview payload", () => {
    const preview = JobFinderResumePreviewSchema.parse({
      draftId: "resume_draft_1",
      revisionKey: "resume_preview_resume_draft_1_f49a0e2d",
      html: '<!doctype html><html><body><article data-resume-section-id="section_summary">Preview</article></body></html>',
      warnings: [
        {
          id: "preview_warning_1",
          source: "validation",
          severity: "warning",
          category: "poor_keyword_coverage",
          sectionId: "section_summary",
          entryId: null,
          bulletId: null,
          message: "Add one more role-specific keyword to the summary.",
        },
      ],
      metadata: {
        templateId: "classic_ats",
        renderedAt: "2026-03-20T10:04:00.000Z",
        pageCount: null,
        sectionCount: 2,
        entryCount: 1,
      },
    });

    expect(preview.metadata.templateId).toBe("classic_ats");
    expect(preview.warnings[0]?.source).toBe("validation");
    expect(preview.html).toContain("data-resume-section-id");
  });

  test("parses resume assistant messages and validation results", () => {
    const legacyMessage = ResumeAssistantMessageSchema.parse({
      id: "assistant_message_1",
      jobId: "job_1",
      role: "assistant",
      content: "Shortened the bullets and kept the metric grounded.",
      patches: [],
      createdAt: "2026-03-20T10:02:40.000Z",
    });
    expect(legacyMessage).toMatchObject({
      role: "assistant",
      proposalStatus: "none",
      baseDraftUpdatedAt: null,
      resolvedPatchIds: [],
      resolvedAt: null,
      proposalError: null,
    });

    expect(
      ResumeValidationResultSchema.parse({
        id: "resume_validation_1",
        draftId: "resume_draft_1",
        issues: [],
        pageCount: 2,
        validatedAt: "2026-03-20T10:02:35.000Z",
      }).pageCount,
    ).toBe(2);
  });

  test("parses entry ordering patch operations and section order metadata", () => {
    const section = ResumeDraftSectionSchema.parse({
      id: "section_experience",
      kind: "experience",
      label: "Experience",
      text: null,
      bullets: [],
      entries: [],
      origin: "user_edited",
      locked: false,
      included: true,
      sortOrder: 1,
      entryOrderMode: "manual",
      profileRecordId: null,
      sourceRefs: [],
      updatedAt: "2026-03-20T10:02:30.000Z",
    });
    const movePatch = ResumeDraftPatchSchema.parse({
      id: "resume_patch_move_entry",
      draftId: "resume_draft_1",
      operation: "move_entry",
      targetSectionId: "section_experience",
      targetEntryId: "experience_older",
      anchorEntryId: "experience_newer",
      targetBulletId: null,
      anchorBulletId: null,
      position: "before",
      newText: null,
      newIncluded: null,
      newLocked: null,
      newBullets: null,
      appliedAt: "2026-03-20T10:02:40.000Z",
      origin: "user",
      conflictReason: null,
    });
    const resetPatch = ResumeDraftPatchSchema.parse({
      id: "resume_patch_reset_entry_order",
      draftId: "resume_draft_1",
      operation: "reset_entry_order",
      targetSectionId: "section_experience",
      appliedAt: "2026-03-20T10:02:41.000Z",
      origin: "user",
    });

    expect(section.entryOrderMode).toBe("manual");
    expect(movePatch.anchorEntryId).toBe("experience_newer");
    expect(resetPatch).toMatchObject({
      anchorEntryId: null,
      operation: "reset_entry_order",
      targetEntryId: null,
    });
  });

  test("defaults legacy claim assessments and accepts candidate-only evidence", () => {
    const legacy = ResumeValidationResultSchema.parse({
      id: "resume_validation_legacy",
      draftId: "resume_draft_1",
      issues: [],
      pageCount: null,
      validatedAt: "2026-03-20T10:02:35.000Z",
    });
    expect(legacy).toMatchObject({
      draftContentHash: null,
      claimAssessments: [],
    });

    const parsed = ResumeValidationResultSchema.parse({
      ...legacy,
      draftContentHash: "fnv1a32:1234abcd",
      claimAssessments: [
        {
          id: "claim_1",
          field: "entry_bullet",
          sectionId: "section_experience",
          entryId: "experience_1",
          bulletId: "bullet_1",
          claimText: "Led design-system rollout across core surfaces.",
          claimOrigin: "ai_generated",
          contentHash: "fnv1a32:5678efab",
          status: "exact",
          evidenceRefs: [
            {
              id: "evidence_1",
              sourceKind: "profile",
              sourceId: "experience:experience_1:achievement:1",
              snippet: "Led design-system rollout across core surfaces.",
            },
          ],
          verifier: "deterministic_candidate_evidence_v1",
          assessedAt: "2026-03-20T10:02:35.000Z",
        },
      ],
    });
    expect(parsed.claimAssessments[0]?.status).toBe("exact");
  });

  test("rejects listing and research refs as resume claim evidence", () => {
    expect(() =>
      ResumeValidationResultSchema.parse({
        id: "resume_validation_bad_evidence",
        draftId: "resume_draft_1",
        issues: [],
        claimAssessments: [
          {
            id: "claim_1",
            field: "section_text",
            sectionId: "section_summary",
            entryId: null,
            bulletId: null,
            claimText: "Own the target company's design-system roadmap.",
            claimOrigin: "ai_generated",
            contentHash: "fnv1a32:5678efab",
            status: "exact",
            evidenceRefs: [
              {
                id: "evidence_job_1",
                sourceKind: "job",
                sourceId: "job_1",
                snippet: "Own the design-system roadmap.",
              },
            ],
            verifier: "deterministic_candidate_evidence_v1",
            assessedAt: "2026-03-20T10:02:35.000Z",
          },
        ],
        pageCount: null,
        validatedAt: "2026-03-20T10:02:35.000Z",
      }),
    ).toThrow();
  });
  test("keeps legacy resume revisions readable while supporting full version metadata", () => {
    const legacy = ResumeDraftRevisionSchema.parse({
      id: "resume_revision_legacy",
      draftId: "resume_draft_1",
      snapshotIdentity: null,
      snapshotSections: [],
      createdAt: "2026-03-20T10:02:35.000Z",
      reason: "Legacy revision",
    });

    expect(legacy).toMatchObject({
      parentRevisionId: null,
      actor: "system",
      mutationKind: "manual_patch",
      snapshotDraft: null,
      beforeHash: null,
      afterHash: null,
      diff: null,
      restoredFromRevisionId: null,
    });
  });
});

describe("resume work-history review acknowledgment contracts", () => {
  const baseLegacyDraft = {
    id: "resume_draft_legacy",
    jobId: "job_1",
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [],
    targetPageCount: 2,
    generationMethod: null,
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    createdAt: "2026-03-20T10:02:00.000Z",
    updatedAt: "2026-03-20T10:02:30.000Z",
  };

  const validAcknowledgment = {
    id: "work_history_ack_experience_1",
    draftId: "resume_draft_1",
    profileRecordId: "experience_1",
    kind: "weak_fit",
    action: "consider_showing",
    messageContentHash: "fnv1a32:0a1b2c3d",
    reason: "intentional_omission",
    acknowledgedAt: "2026-03-20T10:05:00.000Z",
  };

  function buildDraftWithAcknowledgment(acknowledgment: unknown) {
    return {
      ...baseLegacyDraft,
      id: "resume_draft_1",
      workHistoryReviewAcknowledgments: [acknowledgment],
    };
  }

  test("parses legacy drafts without acknowledgments using an empty default", () => {
    const legacy = ResumeDraftSchema.parse(baseLegacyDraft);

    expect(legacy.workHistoryReviewAcknowledgments).toEqual([]);
  });

  test("parses and roundtrips acknowledgment records on a draft", () => {
    const parsed = ResumeDraftSchema.parse(
      buildDraftWithAcknowledgment(validAcknowledgment),
    );

    expect(parsed.workHistoryReviewAcknowledgments[0]).toMatchObject({
      ...validAcknowledgment,
      reason: "intentional_omission",
    });

    const reparsed = ResumeDraftSchema.parse(parsed);
    expect(reparsed.workHistoryReviewAcknowledgments).toEqual(
      parsed.workHistoryReviewAcknowledgments,
    );
  });

  test("retains cross-draft identity fields for later server validation", () => {
    const crossDraftAcknowledgment = {
      ...validAcknowledgment,
      draftId: "resume_draft_other",
      profileRecordId: "experience_missing_role",
    };
    const parsed = ResumeDraftSchema.parse(
      buildDraftWithAcknowledgment(crossDraftAcknowledgment),
    );

    expect(parsed.id).toBe("resume_draft_1");
    expect(parsed.workHistoryReviewAcknowledgments[0]).toMatchObject({
      draftId: "resume_draft_other",
      profileRecordId: "experience_missing_role",
    });
  });

  test("rejects unknown fields on acknowledgment records", () => {
    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        issueId: "issue_work_history_experience_1",
      }),
    ).toThrow();

    expect(() =>
      ResumeDraftSchema.parse(
        buildDraftWithAcknowledgment({
          ...validAcknowledgment,
          entryId: "experience_1",
        }),
      ),
    ).toThrow();
  });

  test("rejects unsupported warning identity and reason enums", () => {
    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        kind: "missing_role",
      }),
    ).toThrow();

    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        action: "hide_forever",
      }),
    ).toThrow();

    expect(() =>
      ResumeDraftSchema.parse(
        buildDraftWithAcknowledgment({
          ...validAcknowledgment,
          reason: "changed_my_mind",
        }),
      ),
    ).toThrow();
  });

  test("requires identity, fingerprint, and timestamp fields", () => {
    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        draftId: "",
      }),
    ).toThrow();

    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        profileRecordId: undefined,
      }),
    ).toThrow();

    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        messageContentHash: "   ",
      }),
    ).toThrow();

    expect(() =>
      WorkHistoryReviewAcknowledgmentSchema.parse({
        ...validAcknowledgment,
        acknowledgedAt: "2026-03-20 10:05:00",
      }),
    ).toThrow();
  });

  test("caps stored acknowledgments at 100 per draft", () => {
    const acknowledgments = Array.from({ length: 100 }, (_, index) => ({
      ...validAcknowledgment,
      id: `work_history_ack_${index + 1}`,
      profileRecordId: `experience_${index + 1}`,
    }));

    expect(
      ResumeDraftSchema.parse({
        ...baseLegacyDraft,
        workHistoryReviewAcknowledgments: acknowledgments,
      }).workHistoryReviewAcknowledgments,
    ).toHaveLength(100);

    expect(() =>
      ResumeDraftSchema.parse({
        ...baseLegacyDraft,
        workHistoryReviewAcknowledgments: [
          ...acknowledgments,
          { ...validAcknowledgment, id: "work_history_ack_overflow" },
        ],
      }),
    ).toThrow();
  });

  test("pins parsed draft acknowledgments to a required array, not undefined", () => {
    type Expect<T extends true> = T;
    type Equal<X, Y> =
      (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
        ? true
        : false;

    type ParsedAcknowledgments =
      ResumeDraft["workHistoryReviewAcknowledgments"];

    const requiredArrayPin: Expect<
      Equal<ParsedAcknowledgments, WorkHistoryReviewAcknowledgment[]>
    > = true;
    const notUndefinedPin: Expect<
      Equal<undefined extends ParsedAcknowledgments ? false : true, true>
    > = true;

    expect(requiredArrayPin).toBe(true);
    expect(notUndefinedPin).toBe(true);
  });

  test("defaults legacy drafts to an empty array and rejects explicit null", () => {
    expect(ResumeDraftSchema.parse(baseLegacyDraft)).toMatchObject({
      workHistoryReviewAcknowledgments: [],
    });

    expect(() =>
      ResumeDraftSchema.parse({
        ...baseLegacyDraft,
        workHistoryReviewAcknowledgments: null,
      }),
    ).toThrow();
  });

  test("accepts only honest kind, action, and reason pairs", () => {
    const honestPairs = [
      {
        kind: "weak_fit",
        action: "consider_showing",
        reason: "intentional_omission",
      },
      {
        kind: "gap_coverage",
        action: "consider_showing",
        reason: "intentional_omission",
      },
      {
        kind: "compact_recommended",
        action: "keep_compact",
        reason: "intentional_compaction",
      },
    ] as const;

    for (const [index, pair] of honestPairs.entries()) {
      expect(
        WorkHistoryReviewAcknowledgmentSchema.parse({
          ...validAcknowledgment,
          id: `work_history_ack_honest_${index + 1}`,
          ...pair,
        }).reason,
      ).toBe(pair.reason);
    }

    const dishonestPairs = [
      { kind: "date_quality" },
      { action: "fix_dates" },
      { action: "review" },
      { action: "consider_hiding" },
      { kind: "compact_recommended", reason: "intentional_omission" },
      {
        kind: "weak_fit",
        action: "keep_compact",
        reason: "intentional_compaction",
      },
      {
        kind: "gap_coverage",
        action: "keep_compact",
        reason: "intentional_compaction",
      },
      { kind: "compact_recommended", action: "consider_showing" },
    ];

    for (const pair of dishonestPairs) {
      expect(() =>
        WorkHistoryReviewAcknowledgmentSchema.parse({
          ...validAcknowledgment,
          ...pair,
        }),
      ).toThrow();
    }
  });

  test("requires fnv1a32 content hashes over the exact canonical suggestion message", () => {
    const validHashes = [
      "fnv1a32:00000000",
      "fnv1a32:ffffffff",
      "fnv1a32:0a1b2c3d",
    ];

    for (const messageContentHash of validHashes) {
      expect(
        WorkHistoryReviewAcknowledgmentSchema.parse({
          ...validAcknowledgment,
          messageContentHash,
        }).messageContentHash,
      ).toBe(messageContentHash);
    }

    const invalidHashes = [
      "",
      "0a1b2c3d",
      "sha256:0a1b2c3d00000000000000000000000000000000000000000000000000000000",
      "fnv1a32:0a1b2c3",
      "fnv1a32:0a1b2c3de",
      "fnv1a32:0A1B2C3D",
      "fnv1a32:zzzzzzzz",
      "fnv1a32:0a1b2c3g",
    ];

    for (const messageContentHash of invalidHashes) {
      expect(() =>
        WorkHistoryReviewAcknowledgmentSchema.parse({
          ...validAcknowledgment,
          messageContentHash,
        }),
      ).toThrow();
    }
  });
});

describe("work-history review suggestion projection contracts", () => {
  const validSuggestion = {
    id: "work_history_review_experience_1",
    profileRecordId: "experience_1",
    sectionId: "section_experience",
    entryId: null,
    kind: "weak_fit",
    action: "consider_showing",
    severity: "info",
    message: "Hidden by default for review.",
    messageContentHash: "fnv1a32:4f9f2cab",
  };

  test("requires a server-computed fnv1a32 message hash on every suggestion", () => {
    expect(
      WorkHistoryReviewSuggestionSchema.parse(validSuggestion),
    ).toMatchObject({ messageContentHash: "fnv1a32:4f9f2cab" });

    expect(() =>
      WorkHistoryReviewSuggestionSchema.parse({
        ...validSuggestion,
        messageContentHash: undefined,
      }),
    ).toThrow();

    expect(() =>
      WorkHistoryReviewSuggestionSchema.parse({
        ...validSuggestion,
        messageContentHash: "adler32:deadbeef",
      }),
    ).toThrow();
  });

  test("keeps the projected hash stable for identical messages and distinct otherwise", () => {
    const reparsed = WorkHistoryReviewSuggestionSchema.parse(validSuggestion);
    expect(reparsed.messageContentHash).toBe(
      WorkHistoryReviewSuggestionSchema.parse(validSuggestion)
        .messageContentHash,
    );

    expect(
      WorkHistoryReviewSuggestionSchema.parse({
        ...validSuggestion,
        message: "Hidden by default for review? Rewritten guidance.",
        messageContentHash: "fnv1a32:0a1b2c3d",
      }).messageContentHash,
    ).not.toBe(reparsed.messageContentHash);
  });
});
