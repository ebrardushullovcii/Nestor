import { describe, expect, test } from "vitest";
import {
  JobFinderExportResumePdfInputSchema,
  JobFinderResumePreviewSchema,
  JobFinderResumeWorkspaceSchema,
  JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema,
  ResumeDraftSchema,
  ResumeDraftSectionSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftPatchSchema,
  ResumeAssistantMessageSchema,
  ResumeExportArtifactSchema,
  ResumeQualityBenchmarkReportSchema,
  ResumeValidationResultSchema,
  getResumeValidationIssueSeverity,
  isBlockingResumeValidationIssue,
  WorkHistoryReviewAcknowledgmentSchema,
  WorkHistoryReviewSuggestionSchema,
  type ResumeDraft,
  type WorkHistoryReviewAcknowledgment,
} from "./index";

describe("contracts resume workspace schemas", () => {
  test("distinguishes private approval rendering from an optional download", () => {
    expect(
      JobFinderExportResumePdfInputSchema.parse({ jobId: "job_1" }),
    ).toEqual({ intent: "download", jobId: "job_1" });
    expect(
      JobFinderExportResumePdfInputSchema.parse({
        intent: "approval",
        jobId: "job_1",
      }),
    ).toEqual({ intent: "approval", jobId: "job_1" });
    expect(() =>
      JobFinderExportResumePdfInputSchema.parse({
        intent: "submit",
        jobId: "job_1",
      }),
    ).toThrow();
  });

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

  test("parses a structured resume workspace payload", () => {
    const workspace = JobFinderResumeWorkspaceSchema.parse({
      job: {
        id: "job_1",
        source: "target_site",
        sourceJobId: "target_job_1",
        discoveryMethod: "catalog_seed",
        canonicalUrl: "https://jobs.example.com/roles/target_job_1",
        title: "Senior Product Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:01:00.000Z",
        salaryText: "$180k - $220k",
        summary: "Own the design system.",
        description: "Own the design system and workflow platform.",
        keySkills: ["Figma"],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: null,
        employmentType: null,
        department: null,
        team: null,
        employerWebsiteUrl: null,
        employerDomain: null,
        benefits: [],
        status: "ready_for_review",
        matchAssessment: {
          score: 96,
          reasons: ["Strong product design overlap"],
          gaps: [],
        },
        provenance: [],
      },
      draft: {
        id: "resume_draft_1",
        jobId: "job_1",
        status: "needs_review",
        templateId: "classic_ats",
        identity: {
          fullName: "Alex Vanguard",
          headline: "Senior Product Designer",
          location: "Remote",
          email: "alex@example.com",
          phone: "+44 7700 900123",
          portfolioUrl: "https://alex.example.com",
          linkedinUrl: "https://www.linkedin.com/in/alex-vanguard",
          githubUrl: null,
          personalWebsiteUrl: null,
          additionalLinks: [],
        },
        sections: [
          {
            id: "section_summary",
            kind: "summary",
            label: "Summary",
            text: "Lead design-systems work grounded in workflow tooling experience.",
            bullets: [],
            entries: [],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: 0,
            profileRecordId: null,
            sourceRefs: [
              {
                id: "source_1",
                sourceKind: "profile",
                sourceId: "experience_1",
                snippet: "Led design-system rollout across core surfaces.",
              },
            ],
            updatedAt: "2026-03-20T10:02:30.000Z",
          },
          {
            id: "section_experience",
            kind: "experience",
            label: "Experience",
            text: null,
            bullets: [],
            entries: [
              {
                id: "experience_1",
                entryType: "experience",
                title: "Senior Product Designer",
                subtitle: "Signal Systems",
                location: "Remote",
                dateRange: "2023 – Present",
                startDate: "2023",
                endDate: null,
                isCurrent: true,
                summary:
                  "Owned design-system adoption across platform surfaces.",
                bullets: [
                  {
                    id: "experience_1_bullet_1",
                    text: "Led rollout across core product surfaces used by design and operations teams.",
                    origin: "ai_generated",
                    locked: false,
                    included: true,
                    sourceRefs: [],
                    updatedAt: "2026-03-20T10:02:30.000Z",
                  },
                ],
                origin: "ai_generated",
                locked: false,
                included: true,
                sortOrder: 0,
                profileRecordId: "experience_1",
                sourceRefs: [],
                updatedAt: "2026-03-20T10:02:30.000Z",
              },
            ],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: 1,
            profileRecordId: null,
            sourceRefs: [],
            updatedAt: "2026-03-20T10:02:30.000Z",
          },
        ],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: null,
        approvedExportId: null,
        staleReason: null,
        createdAt: "2026-03-20T10:02:00.000Z",
        updatedAt: "2026-03-20T10:02:30.000Z",
      },
      validation: {
        id: "resume_validation_1",
        draftId: "resume_draft_1",
        issues: [
          {
            id: "issue_1",
            severity: "warning",
            category: "poor_keyword_coverage",
            sectionId: "section_summary",
            bulletId: null,
            message: "Add one more role-specific keyword to the summary.",
          },
        ],
        pageCount: 2,
        validatedAt: "2026-03-20T10:02:35.000Z",
      },
      exports: [
        {
          id: "resume_export_1",
          draftId: "resume_draft_1",
          jobId: "job_1",
          format: "pdf",
          filePath: "/tmp/alex-signal.pdf",
          pageCount: 2,
          templateId: "classic_ats",
          exportedAt: "2026-03-20T10:03:10.000Z",
          isApproved: false,
        },
      ],
      research: [
        {
          id: "resume_research_1",
          jobId: "job_1",
          sourceUrl: "https://signalsystems.example.com/about",
          pageTitle: "About Signal Systems",
          fetchedAt: "2026-03-20T10:01:30.000Z",
          extractedText: "Signal Systems builds workflow software.",
          companyNotes: "Workflow tooling for design and operations teams.",
          domainVocabulary: ["workflow platform"],
          priorityThemes: ["design systems"],
          fetchStatus: "success",
        },
      ],
      assistantMessages: [
        {
          id: "assistant_message_1",
          jobId: "job_1",
          role: "assistant",
          content:
            "I tightened the summary around workflow tooling and design systems.",
          patches: [],
          createdAt: "2026-03-20T10:02:40.000Z",
        },
      ],
      tailoredAsset: null,
      workHistoryReviewSuggestions: [
        {
          id: "work_history_review_experience_1",
          profileRecordId: "experience_1",
          sectionId: "section_experience",
          entryId: "experience_1",
          kind: "compact_recommended",
          action: "keep_compact",
          severity: "info",
          message:
            "Compact older strong-fit role: included for career coverage without crowding recent experience.",
          messageContentHash: "fnv1a32:4f9f2cab",
        },
      ],
    });

    expect(workspace.draft.sections[0]?.kind).toBe("summary");
    const parsedExperienceSection = ResumeDraftSectionSchema.parse(
      workspace.draft.sections[1],
    );
    expect(parsedExperienceSection.id).toBe("section_experience");
    expect(parsedExperienceSection.entries[0]).toMatchObject({
      entryType: "experience",
      id: "experience_1",
      title: "Senior Product Designer",
      subtitle: "Signal Systems",
      dateRange: "2023 – Present",
      startDate: "2023",
      endDate: null,
      isCurrent: true,
    });
    expect(Array.isArray(parsedExperienceSection.entries[0]?.bullets)).toBe(
      true,
    );
    expect(workspace.validation?.issues[0]?.category).toBe(
      "poor_keyword_coverage",
    );
    expect(workspace.exports[0]?.format).toBe("pdf");
    expect(workspace.workHistoryReviewSuggestions[0]?.kind).toBe(
      "compact_recommended",
    );
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

  test("parses resume quality benchmark reports", () => {
    const report = ResumeQualityBenchmarkReportSchema.parse({
      benchmarkVersion: "023-local-benchmark-v1",
      generatedAt: "2026-04-26T12:00:00.000Z",
      templates: [
        "classic_ats",
        "compact_exec",
        "modern_split",
        "technical_matrix",
        "project_showcase",
        "credentials_focus",
        "timeline_longform",
        "career_pivot",
      ],
      persistedArtifactsDirectory:
        "apps/desktop/test-artifacts/ui/resume-quality-benchmark",
      cases: [
        {
          caseId: "grounded_baseline",
          label: "Grounded baseline",
          templateId: "classic_ats",
          passed: true,
          visibleSkills: ["Figma", "Design Systems"],
          issueCategories: [],
          issueCount: 0,
          metrics: {
            groundedVisibleSkillRate: 1,
            workHistoryRepresentationRate: 1,
            visibleWorkHistoryCoverageRate: 1,
            fragmentFreeExperienceBulletRate: 1,
            professionalExperienceSummaryRate: 1,
            bleedFreeCaseRate: 1,
            keywordCoverageRate: 1,
            duplicateIssueFreeRate: 1,
            thinOutputFreeRate: 1,
            pageTargetPassRate: 1,
            atsRenderPassRate: 1,
            issueFreeCaseRate: 1,
          },
          htmlArtifactRelativePath: "grounded_baseline/classic_ats/sample.html",
          notes: [],
        },
      ],
      aggregate: {
        groundedVisibleSkillRate: 1,
        workHistoryRepresentationRate: 1,
        visibleWorkHistoryCoverageRate: 1,
        fragmentFreeExperienceBulletRate: 1,
        professionalExperienceSummaryRate: 1,
        bleedFreeCaseRate: 1,
        keywordCoverageRate: 1,
        duplicateIssueFreeRate: 1,
        thinOutputFreeRate: 1,
        pageTargetPassRate: 1,
        atsRenderPassRate: 1,
        issueFreeCaseRate: 1,
      },
      notes: [],
    });

    expect(report.templates).toEqual([
      "classic_ats",
      "compact_exec",
      "modern_split",
      "technical_matrix",
      "project_showcase",
      "credentials_focus",
      "timeline_longform",
      "career_pivot",
    ]);
    expect(report.persistedArtifactsDirectory).toBe(
      "apps/desktop/test-artifacts/ui/resume-quality-benchmark",
    );
    expect(report.cases[0]?.metrics.atsRenderPassRate).toBe(1);
    expect(report.cases[0]?.metrics.workHistoryRepresentationRate).toBe(1);
    expect(report.cases[0]?.metrics.visibleWorkHistoryCoverageRate).toBe(1);
    expect(report.providerMode).toBe("deterministic");
    expect(report.cases[0]?.generationDurationMs).toBe(0);
    expect(report.cases[0]?.generationDiagnostics).toBeNull();
  });

  test("defaults omitted resume quality acceptance metrics for old reports", () => {
    const metrics = ResumeQualityBenchmarkReportSchema.shape.aggregate.parse({
      groundedVisibleSkillRate: 1,
      bleedFreeCaseRate: 1,
      keywordCoverageRate: 1,
      duplicateIssueFreeRate: 1,
      thinOutputFreeRate: 1,
      pageTargetPassRate: 1,
      atsRenderPassRate: 1,
      issueFreeCaseRate: 1,
    });

    expect(metrics).toMatchObject({
      workHistoryRepresentationRate: 0,
      visibleWorkHistoryCoverageRate: 0,
      fragmentFreeExperienceBulletRate: 0,
      professionalExperienceSummaryRate: 0,
    });
  });

  test("parses draft templateId for template themes", () => {
    const workspace = JobFinderResumeWorkspaceSchema.parse({
      job: {
        id: "job_2",
        source: "target_site",
        sourceJobId: "target_job_2",
        discoveryMethod: "catalog_seed",
        canonicalUrl: "https://jobs.example.com/roles/target_job_2",
        title: "Staff Frontend Engineer",
        company: "Atlas Product",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:01:00.000Z",
        salaryText: null,
        summary: "Lead frontend platform work.",
        description: "Lead frontend platform work.",
        keySkills: ["React"],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: null,
        employmentType: null,
        department: null,
        team: null,
        employerWebsiteUrl: null,
        employerDomain: null,
        benefits: [],
        status: "ready_for_review",
        matchAssessment: {
          score: 91,
          reasons: ["Strong frontend overlap"],
          gaps: [],
        },
        provenance: [],
      },
      draft: {
        id: "resume_draft_2",
        jobId: "job_2",
        status: "needs_review",
        templateId: "technical_matrix",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: null,
        approvedExportId: null,
        staleReason: null,
        createdAt: "2026-03-20T10:02:00.000Z",
        updatedAt: "2026-03-20T10:02:30.000Z",
      },
      validation: null,
      exports: [],
      research: [],
      assistantMessages: [],
      tailoredAsset: null,
      sharedProfile: {},
    });

    expect(workspace.draft.templateId).toBe("technical_matrix");
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

describe("set work-history review acknowledgment command contracts", () => {
  const validAcknowledge = {
    intent: "acknowledge",
    jobId: "job_1",
    draftId: "resume_draft_1",
    expectedDraftUpdatedAt: "2026-03-20T10:02:30.000Z",
    suggestionId: "work_history_review_experience_1",
    profileRecordId: "experience_1",
    kind: "weak_fit",
    action: "consider_showing",
    messageContentHash: "fnv1a32:4f9f2cab",
    reason: "intentional_omission",
  };
  const validRemove = {
    intent: "remove",
    jobId: "job_1",
    draftId: "resume_draft_1",
    expectedDraftUpdatedAt: "2026-03-20T10:02:30.000Z",
    acknowledgmentId: "work_history_ack_experience_1_abc",
  };

  test("parses eligible acknowledge and remove commands", () => {
    const acknowledged =
      JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse(
        validAcknowledge,
      );
    expect(acknowledged).toMatchObject({
      intent: "acknowledge",
      draftId: "resume_draft_1",
      suggestionId: "work_history_review_experience_1",
    });

    const removed =
      JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse(validRemove);
    expect(removed).toMatchObject({
      intent: "remove",
      acknowledgmentId: "work_history_ack_experience_1_abc",
    });
  });

  test("accepts gap_coverage omissions and rejects ineligible pairs", () => {
    expect(
      JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
        ...validAcknowledge,
        kind: "gap_coverage",
      }),
    ).toMatchObject({ kind: "gap_coverage" });

    const ineligiblePairs = [
      {
        kind: "compact_recommended",
        action: "keep_compact",
        reason: "intentional_compaction",
      },
      { kind: "weak_fit", action: "keep_compact" },
      {
        kind: "weak_fit",
        action: "consider_showing",
        reason: "intentional_compaction",
      },
      { kind: "date_quality" },
      { action: "fix_dates" },
    ];

    for (const pair of ineligiblePairs) {
      expect(() =>
        JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
          ...validAcknowledge,
          ...pair,
        }),
      ).toThrow();
    }
  });

  test("rejects client-supplied record ids, timestamps, and unknown fields", () => {
    const clientSuppliedFields = [
      { id: "work_history_ack_client_minted" },
      { acknowledgedAt: "2026-03-20T10:05:00.000Z" },
      { staleReason: "because" },
    ];

    for (const field of clientSuppliedFields) {
      expect(() =>
        JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
          ...validAcknowledge,
          ...field,
        }),
      ).toThrow();

      expect(() =>
        JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
          ...validRemove,
          ...field,
        }),
      ).toThrow();
    }

    expect(() =>
      JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
        ...validAcknowledge,
        acknowledgmentId: "work_history_ack_extra",
      }),
    ).toThrow();
  });

  test("rejects invalid identity and fingerprint fields", () => {
    const invalidOverrides = [
      { jobId: "" },
      { draftId: undefined },
      { expectedDraftUpdatedAt: "2026-03-20 10:02:30" },
      { suggestionId: "" },
      { messageContentHash: "fnv1a32:4F9F2CAB" },
    ];

    for (const override of invalidOverrides) {
      expect(() =>
        JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
          ...validAcknowledge,
          ...override,
        }),
      ).toThrow();
    }

    expect(() =>
      JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
        ...validRemove,
        acknowledgmentId: "",
      }),
    ).toThrow();
  });

  test("rejects an unknown intent", () => {
    expect(() =>
      JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
        ...validAcknowledge,
        intent: "defer",
      }),
    ).toThrow();
  });
});
