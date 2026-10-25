import { describe, expect, test } from "vitest";

import {
  ResumeImportFieldCandidateSchema,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import { reconcileCandidates } from "./internal/resume-import-reconciliation";
import {
  createFreshStartSeedProfile,
  createSeed,
} from "./workspace-service.test-fixtures";
import {
  createStageCandidate,
  createTestBundle,
} from "./workspace-service.resume-analysis.shared";

describe("resume import reconciliation", () => {
  const emptyProfile = () => ({
    ...createFreshStartSeedProfile(),
    skills: [],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
  });
  const scannedCandidate = (
    overrides: Partial<ResumeImportFieldCandidate> = {},
  ) =>
    ResumeImportFieldCandidateSchema.parse({
      ...createStageCandidate({
        target: { section: "identity", key: "headline", recordId: null },
        label: "Headline",
        value: "Senior Product Engineer",
        confidence: 0.95,
        overall: 0.56482,
        recommendation: "needs_review",
      }),
      id: "scanned_candidate",
      runId: "scanned_import",
      sourceKind: "vision_omni",
      createdAt: "2026-09-30T10:00:00.000Z",
      resolvedAt: null,
      resolution: "needs_review",
      confidenceBreakdown: {
        overall: 0.56482,
        parserQuality: 0.2836,
        evidenceQuality: 0.42,
        agreementScore: 0.34,
        normalizationRisk: 0.2,
        conflictRisk: 0.18,
        fieldSensitivity: "medium",
        recommendation: "needs_review",
      },
      visualEvidence: [
        {
          branch: "vision",
          sourceFileKind: "pdf",
          pageNumber: 1,
          regionHint: "Title below the name",
          confidence: 0.95,
          uncertaintyNotes: [],
        },
      ],
      ...overrides,
      valuePreview:
        overrides.valuePreview ??
        (overrides.value !== undefined
          ? JSON.stringify(overrides.value)
          : "Senior Product Engineer"),
      evidenceText:
        overrides.evidenceText ??
        (overrides.value !== undefined
          ? JSON.stringify(overrides.value)
          : "Senior Product Engineer"),
    });
  const scannedBundle = () =>
    createTestBundle({ fullText: "", blocks: [], qualityScore: 0.2836 });

  test("fills empty fields and collections from a clear scan despite an empty native text layer", () => {
    const seed = createSeed();
    const candidates = [
      scannedCandidate(),
      scannedCandidate({
        id: "scanned_skills",
        target: { section: "skill", key: "skills", recordId: null },
        value: ["React", "TypeScript"],
      }),
      scannedCandidate({
        id: "scanned_role",
        target: { section: "experience", key: "record", recordId: null },
        value: {
          companyName: "Northstar Labs",
          title: "Senior Product Engineer",
          startDate: "2022-03",
          isCurrent: true,
        },
      }),
      scannedCandidate({
        id: "scanned_education",
        target: { section: "education", key: "record", recordId: null },
        value: {
          schoolName: "Delft University of Technology",
          degree: "BSc Computer Science",
          startDate: "2015",
          endDate: "2018",
        },
      }),
    ];
    const reconciled = reconcileCandidates(
      emptyProfile(),
      seed.searchPreferences,
      candidates,
      scannedBundle(),
    );
    expect(reconciled).toHaveLength(4);
    for (const candidate of reconciled) {
      expect(candidate).toMatchObject({
        resolution: "auto_applied",
        resolutionReason: "applied_into_empty_profile",
        confidenceBreakdown: { overall: 0.56482 },
      });
    }
  });

  test.each([
    ["low extraction confidence", { confidence: 0.7 }],
    ["alternative readings", { alternatives: ["Staff Product Engineer"] }],
    ["missing visual evidence", { visualEvidence: [] }],
    [
      "unanchored region",
      {
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: 1,
            regionHint: null,
            confidence: 0.95,
            uncertaintyNotes: [],
          },
        ],
      },
    ],
    [
      "unanchored page",
      {
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: null,
            regionHint: "Title",
            confidence: 0.95,
            uncertaintyNotes: [],
          },
        ],
      },
    ],
    [
      "page outside the imported bundle",
      {
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: 9,
            regionHint: "Title",
            confidence: 0.95,
            uncertaintyNotes: [],
          },
        ],
      },
    ],
    [
      "uncertain reading",
      {
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: 1,
            regionHint: "Title",
            confidence: 0.95,
            uncertaintyNotes: ["Partly illegible"],
          },
        ],
      },
    ],
    [
      "low visual confidence",
      {
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: 1,
            regionHint: "Title",
            confidence: 0.65,
            uncertaintyNotes: [],
          },
        ],
      },
    ],
    ["inferred field", { notes: ["Inferred from the experience section"] }],
    [
      "shared memory",
      {
        target: {
          section: "narrative",
          key: "professionalStory",
          recordId: null,
        },
        value: "Builds reliable workflow software.",
      },
    ],
  ] satisfies [string, Partial<ResumeImportFieldCandidate>][])(
    "keeps %s in review for a scanned import",
    (_label, overrides) => {
      expect(
        reconcileCandidates(
          emptyProfile(),
          createSeed().searchPreferences,
          [scannedCandidate(overrides)],
          scannedBundle(),
        )[0]?.resolution,
      ).toBe("needs_review");
    },
  );

  test("keeps high-risk scans and abstentions out of automatic import", () => {
    const candidate = scannedCandidate();
    for (const confidenceBreakdown of [
      { ...candidate.confidenceBreakdown!, normalizationRisk: 0.8 },
      { ...candidate.confidenceBreakdown!, conflictRisk: 0.8 },
      {
        ...candidate.confidenceBreakdown!,
        recommendation: "abstain" as const,
        overall: 0.2,
      },
    ]) {
      expect(
        reconcileCandidates(
          emptyProfile(),
          createSeed().searchPreferences,
          [scannedCandidate({ confidenceBreakdown })],
          scannedBundle(),
        )[0]?.resolution,
      ).not.toBe("auto_applied");
    }
  });

  test("requires the imported document bundle to verify a visual-only promotion", () => {
    expect(
      reconcileCandidates(emptyProfile(), createSeed().searchPreferences, [
        scannedCandidate(),
      ])[0]?.resolution,
    ).toBe("needs_review");
  });

  test("keeps saved facts and a different identity protected from clear scans", () => {
    const seed = createSeed();
    const headline = scannedCandidate();
    expect(
      reconcileCandidates(
        { ...emptyProfile(), headline: "My chosen headline" },
        seed.searchPreferences,
        [headline],
        scannedBundle(),
      )[0],
    ).toMatchObject({
      resolution: "needs_review",
      resolutionReason: "conflicts_with_existing_profile_value",
    });
    const name = scannedCandidate({
      target: { section: "identity", key: "fullName", recordId: null },
      value: "Morgan Lee",
    });
    expect(
      reconcileCandidates(
        seed.profile,
        seed.searchPreferences,
        [name],
        scannedBundle(),
      )[0]?.resolution,
    ).toBe("needs_review");
    expect(
      reconcileCandidates(
        seed.profile,
        seed.searchPreferences,
        [name],
        scannedBundle(),
      )[0]?.resolutionReason,
    ).toMatch(/^identity_mismatch/);
  });

  test("keeps material text and scan disagreement in review on an empty profile", () => {
    const vision = scannedCandidate();
    const text = scannedCandidate({
      id: "text_headline",
      sourceKind: "model_identity_summary",
      value: "Staff Platform Engineer",
      sourceBlockIds: ["headline_block"],
      visualEvidence: [],
      confidenceBreakdown: {
        ...vision.confidenceBreakdown!,
        overall: 0.85,
        recommendation: "auto_apply",
      },
    });
    const reconciled = reconcileCandidates(
      emptyProfile(),
      createSeed().searchPreferences,
      [text, vision],
      scannedBundle(),
    );
    expect(
      reconciled.some((candidate) => candidate.resolution === "auto_applied"),
    ).toBe(false);
    expect(
      reconciled.find((candidate) => candidate.conflictChoices?.length === 2)
        ?.resolution,
    ).toBe("needs_review");
  });

  test("rejects a model date range proposed as a phone number", () => {
    const seed = createSeed();
    const candidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_phone",
      ...createStageCandidate({
        target: { section: "contact", key: "phone", recordId: null },
        label: "Phone",
        value: "2016 - 2020",
        sourceBlockIds: ["experience_block"],
        confidence: 0.96,
        overall: 0.94,
        recommendation: "auto_apply",
      }),
      id: "candidate_model_phone",
      sourceKind: "model_identity_summary",
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    expect(
      reconcileCandidates(seed.profile, seed.searchPreferences, [candidate])[0],
    ).toMatchObject({
      resolution: "rejected",
      resolutionReason: "invalid_phone_candidate",
    });
  });

  test("turns material text-vs-vision disagreement into explicit review choices", () => {
    const seed = createSeed();
    const baseCandidate = {
      runId: "resume_import_run_1",
      target: { section: "identity" as const, key: "headline", recordId: null },
      label: "Headline",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    };
    const textCandidate = ResumeImportFieldCandidateSchema.parse({
      ...baseCandidate,
      ...createStageCandidate({
        target: baseCandidate.target,
        label: baseCandidate.label,
        value: "Senior Software Engineer",
        sourceBlockIds: ["block_1"],
        confidence: 0.86,
        overall: 0.84,
        recommendation: "auto_apply",
      }),
      id: "candidate_text_headline",
      sourceKind: "model_identity_summary",
      resolution: "needs_review",
    });
    const visionCandidate = ResumeImportFieldCandidateSchema.parse({
      ...baseCandidate,
      ...createStageCandidate({
        target: baseCandidate.target,
        label: baseCandidate.label,
        value: "Staff Platform Engineer",
        sourceBlockIds: [],
        confidence: 0.82,
        overall: 0.8,
        recommendation: "auto_apply",
      }),
      id: "candidate_vision_headline",
      sourceKind: "vision_omni",
      resolution: "needs_review",
      visualEvidence: [
        {
          branch: "vision",
          sourceFileKind: "pdf",
          pageNumber: 1,
          regionHint: "top headline",
          confidence: 0.82,
          uncertaintyNotes: [],
        },
      ],
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [textCandidate, visionCandidate],
    );
    const winner = reconciled.find(
      (candidate) =>
        candidate.resolutionReason ===
        "text_vs_visual_conflict_requires_review",
    );

    expect(winner?.resolution).toBe("needs_review");
    expect(
      winner?.conflictChoices?.map((choice) => choice.sourceLabel),
    ).toEqual(["Document text", "Visual scan"]);
    expect(
      winner?.conflictChoices?.find(
        (choice) => choice.sourceLabel === "Document text",
      )?.recommended,
    ).toBe(true);
    expect(
      winner?.conflictChoices?.find(
        (choice) => choice.sourceLabel === "Visual scan",
      )?.visualEvidence[0],
    ).toMatchObject({
      branch: "vision",
      pageNumber: 1,
      regionHint: "top headline",
    });
    expect(winner?.alternatives).toEqual(["Staff Platform Engineer"]);
  });

  test("anchors full-name conflicts on grounded document text when vision reads a role headline as a name", () => {
    const seed = createSeed();
    const baseCandidate = {
      runId: "resume_import_run_name_conflict",
      target: { section: "identity" as const, key: "fullName", recordId: null },
      label: "Full name",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    };
    const textCandidate = ResumeImportFieldCandidateSchema.parse({
      ...baseCandidate,
      ...createStageCandidate({
        target: baseCandidate.target,
        label: baseCandidate.label,
        value: "Owen Mercer",
        sourceBlockIds: ["block_name"],
        confidence: 0.99,
        overall: 0.97,
        recommendation: "auto_apply",
      }),
      id: "candidate_text_full_name",
      sourceKind: "parser_literal",
      resolution: "auto_applied",
      resolvedAt: "2026-04-10T10:00:00.000Z",
    });
    const visionCandidate = ResumeImportFieldCandidateSchema.parse({
      ...baseCandidate,
      ...createStageCandidate({
        target: baseCandidate.target,
        label: baseCandidate.label,
        value: "Senior Software Engineer",
        sourceBlockIds: [],
        confidence: 0.72,
        overall: 0.72,
        recommendation: "needs_review",
      }),
      id: "candidate_vision_full_name",
      sourceKind: "vision_omni",
      resolution: "needs_review",
      visualEvidence: [
        {
          branch: "vision",
          sourceFileKind: "pdf",
          pageNumber: 1,
          regionHint: "top headline",
          confidence: 0.72,
          uncertaintyNotes: [],
        },
      ],
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [visionCandidate, textCandidate],
    );
    const reviewCandidate = reconciled.find(
      (candidate) =>
        candidate.resolutionReason ===
        "text_vs_visual_conflict_requires_review",
    );

    expect(reviewCandidate).toMatchObject({
      id: "candidate_text_full_name",
      sourceKind: "parser_literal",
      value: "Owen Mercer",
      resolution: "needs_review",
    });
    expect(
      reviewCandidate?.conflictChoices?.map((choice) => ({
        sourceLabel: choice.sourceLabel,
        value: choice.value,
        recommended: choice.recommended,
      })),
    ).toEqual([
      {
        sourceLabel: "Document text",
        value: "Owen Mercer",
        recommended: true,
      },
      {
        sourceLabel: "Visual scan",
        value: "Senior Software Engineer",
        recommended: false,
      },
    ]);
    expect(
      reconciled.find(
        (candidate) => candidate.id === "candidate_vision_full_name",
      )?.resolution,
    ).toBe("rejected");
  });

  test("keeps complementary text and vision skill lists auto-applied instead of conflict-gating them", () => {
    const seed = createSeed();
    const baseCandidate = {
      runId: "resume_import_run_skills",
      target: { section: "skill" as const, key: "skills", recordId: null },
      label: "Skills",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    };
    const textCandidate = ResumeImportFieldCandidateSchema.parse({
      ...baseCandidate,
      ...createStageCandidate({
        target: baseCandidate.target,
        label: baseCandidate.label,
        value: ["React", "TypeScript"],
        sourceBlockIds: ["block_skills"],
        confidence: 0.78,
        overall: 0.7,
        recommendation: "needs_review",
      }),
      id: "candidate_text_skills",
      sourceKind: "model_background",
      resolution: "needs_review",
    });
    const visionCandidate = ResumeImportFieldCandidateSchema.parse({
      ...baseCandidate,
      ...createStageCandidate({
        target: baseCandidate.target,
        label: baseCandidate.label,
        value: ["React", "Node.js"],
        sourceBlockIds: [],
        confidence: 0.76,
        overall: 0.68,
        recommendation: "needs_review",
      }),
      id: "candidate_vision_skills",
      sourceKind: "vision_omni",
      resolution: "needs_review",
      visualEvidence: [
        {
          branch: "vision",
          sourceFileKind: "pdf",
          pageNumber: 1,
          regionHint: "skills section",
          confidence: 0.76,
          uncertaintyNotes: [],
        },
      ],
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [textCandidate, visionCandidate],
    );

    expect(
      reconciled.filter((candidate) => candidate.resolution === "auto_applied"),
    ).toHaveLength(2);
    expect(
      reconciled.some(
        (candidate) =>
          candidate.resolutionReason ===
          "text_vs_visual_conflict_requires_review",
      ),
    ).toBe(false);
  });

  test("fills a first-person summary read from a scanned import", () => {
    // The person's own SUMMARY words fill the empty summary; they edit the
    // wording on the form rather than confirming it from a card first.
    expect(
      reconcileCandidates(
        { ...emptyProfile(), summary: "" },
        createSeed().searchPreferences,
        [
          scannedCandidate({
            target: { section: "identity", key: "summary", recordId: null },
            value: "I build reliable workflow software.",
          }),
        ],
        scannedBundle(),
      )[0]?.resolution,
    ).toBe("auto_applied");
  });

  test("fills empty search preferences from the resume", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, targetRoles: [] },
      searchPreferences: { ...baseSeed.searchPreferences, targetRoles: [] },
    };
    const targetRolesCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_target_roles",
      ...createStageCandidate({
        target: {
          section: "search_preferences",
          key: "targetRoles",
          recordId: null,
        },
        label: "Target roles",
        value: ["Project Lead (React, Next.js) – QA Management System"],
        sourceBlockIds: ["block_project_heading"],
        confidence: 0.82,
        overall: 0.8,
        recommendation: "auto_apply",
      }),
      id: "candidate_target_roles",
      sourceKind: "model_identity_summary",
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [targetRolesCandidate],
    );

    // The seed has no target roles yet, so the inferred one fills the field.
    expect(reconciled[0]).toMatchObject({
      id: "candidate_target_roles",
      resolution: "auto_applied",
      resolutionReason: "applied_into_empty_profile",
    });
  });

  test("does not merge skill record candidates through the generic list path", () => {
    const seed = createSeed();
    const skillRecordCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_skill_record",
      ...createStageCandidate({
        target: { section: "skill", key: "record", recordId: null },
        label: "Skill",
        value: "React",
        sourceBlockIds: [],
        confidence: 0.76,
        overall: 0.7,
        recommendation: "needs_review",
      }),
      id: "candidate_skill_record",
      sourceKind: "vision_omni",
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [skillRecordCandidate],
    );

    expect(reconciled[0]).toMatchObject({
      id: "candidate_skill_record",
      resolution: "needs_review",
    });
  });

  test("auto-applies grounded fresh-start education records", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: {
        ...baseSeed.profile,
        id: "candidate_fresh_start",
        firstName: "New",
        lastName: "Candidate",
        fullName: "New Candidate",
        headline: "Import your resume to begin",
        summary:
          "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
        currentLocation: "Set your preferred location",
        education: [],
      },
    };
    const educationCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_education",
      ...createStageCandidate({
        target: {
          section: "education",
          key: "record",
          recordId: "education_1",
        },
        label: "Florida State University",
        value: {
          schoolName: "Florida State University",
          degree: "Bachelor’s Degree",
          fieldOfStudy: "Computer Science and Physics",
          location: null,
          startDate: "May 2011",
          endDate: "Sept 2015",
          summary: null,
        },
        sourceBlockIds: ["block_education"],
        confidence: 0.8,
        overall: 0.68,
        recommendation: "needs_review",
      }),
      id: "candidate_education_record",
      sourceKind: "model_background",
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [educationCandidate],
    );

    expect(reconciled[0]).toMatchObject({
      id: "candidate_education_record",
      resolution: "auto_applied",
    });
  });

  test("normalizes JSON-encoded education records and removes redundant inferred fields", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: {
        ...baseSeed.profile,
        id: "candidate_fresh_start",
        firstName: "New",
        lastName: "Candidate",
        fullName: "New Candidate",
        headline: "Import your resume to begin",
        summary:
          "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
        currentLocation: "Set your preferred location",
        education: [],
      },
    };
    const evidenceText =
      "Bachelor of Science in Computer Science — Oregon State University, 2018";
    const educationCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_json_education",
      ...createStageCandidate({
        target: {
          section: "education",
          key: "record",
          recordId: "education_1",
        },
        label: "Education",
        value: JSON.stringify({
          schoolName: "Oregon State University",
          degree: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
          location: "Oregon State University",
          startDate: null,
          endDate: "2018",
          summary: evidenceText,
        }),
        sourceBlockIds: ["block_education"],
        confidence: 0.98,
        overall: 0.86,
        recommendation: "needs_review",
      }),
      id: "candidate_json_education_record",
      sourceKind: "model_background",
      evidenceText,
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [educationCandidate],
    );

    expect(reconciled[0]).toMatchObject({
      id: "candidate_json_education_record",
      resolution: "auto_applied",
      value: {
        schoolName: "Oregon State University",
        degree: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        location: null,
        startDate: null,
        endDate: "2018",
        summary: null,
      },
    });
  });

  test("rejects a raw education line already represented by a grounded structured record", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: {
        ...baseSeed.profile,
        id: "candidate_fresh_start",
        firstName: "New",
        lastName: "Candidate",
        fullName: "New Candidate",
        headline: "Import your resume to begin",
        summary:
          "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
        currentLocation: "Set your preferred location",
        education: [],
      },
    };
    const evidenceText =
      "Bachelor of Science in Computer Science — Oregon State University, 2018";
    const target = {
      section: "education" as const,
      key: "record",
      recordId: "education_1",
    };
    const rawCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_duplicate_education",
      ...createStageCandidate({
        target,
        label: "Education",
        value: evidenceText,
        sourceBlockIds: ["block_education"],
        confidence: 0.98,
        overall: 0.86,
        recommendation: "needs_review",
      }),
      id: "candidate_raw_education_record",
      sourceKind: "model_background",
      evidenceText,
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });
    const structuredCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_duplicate_education",
      ...createStageCandidate({
        target,
        label: "Oregon State University",
        value: {
          schoolName: "Oregon State University",
          degree: "Bachelor of Science in Computer Science",
          fieldOfStudy: null,
          location: null,
          startDate: null,
          endDate: "2018",
          summary: null,
        },
        sourceBlockIds: ["block_education"],
        confidence: 0.8,
        overall: 0.75,
        recommendation: "needs_review",
      }),
      id: "candidate_structured_education_record",
      sourceKind: "model_background",
      evidenceText,
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
      notes: ["deterministic_stage_fallback"],
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [rawCandidate, structuredCandidate],
    );

    expect(
      reconciled.find((candidate) => candidate.id === rawCandidate.id)
        ?.resolution,
    ).toBe("rejected");
    expect(
      reconciled.find((candidate) => candidate.id === structuredCandidate.id)
        ?.resolution,
    ).toBe("auto_applied");
    expect(
      reconciled.some((candidate) => candidate.resolution === "needs_review"),
    ).toBe(false);
  });

  test("rejects scalar, list, and education suggestions that already match the workspace", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, targetRoles: ["Principal Designer"] },
      searchPreferences: {
        ...baseSeed.searchPreferences,
        targetRoles: ["Principal Designer"],
      },
    };
    const common = {
      runId: "resume_import_run_saved_values",
      sourceKind: "model_background" as const,
      resolution: "needs_review" as const,
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    };
    const locationCandidate = ResumeImportFieldCandidateSchema.parse({
      ...common,
      ...createStageCandidate({
        target: { section: "location", key: "currentLocation", recordId: null },
        label: "Location",
        value: "London, UK",
        sourceBlockIds: ["block_location"],
        confidence: 0.9,
        overall: 0.9,
        recommendation: "needs_review",
      }),
      id: "candidate_saved_location",
    });
    const rolesCandidate = ResumeImportFieldCandidateSchema.parse({
      ...common,
      ...createStageCandidate({
        target: {
          section: "search_preferences",
          key: "targetRoles",
          recordId: null,
        },
        label: "Target roles",
        value: ["Principal Designer"],
        sourceBlockIds: ["block_roles"],
        confidence: 0.9,
        overall: 0.9,
        recommendation: "needs_review",
      }),
      id: "candidate_saved_roles",
    });
    const educationCandidate = ResumeImportFieldCandidateSchema.parse({
      ...common,
      ...createStageCandidate({
        target: {
          section: "education",
          key: "record",
          recordId: "education_1",
        },
        label: "Royal College of Art",
        value: {
          schoolName: "Royal College of Art",
          degree: "MA",
          fieldOfStudy: "Design Products",
          location: "London, UK",
          startDate: "2012-09",
          endDate: "2014-06",
          summary: null,
        },
        sourceBlockIds: ["block_education"],
        confidence: 0.9,
        overall: 0.9,
        recommendation: "needs_review",
      }),
      id: "candidate_saved_education",
      evidenceText:
        "Royal College of Art MA Design Products London UK 2012 2014",
    });

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      [locationCandidate, rolesCandidate, educationCandidate],
    );

    expect(reconciled).toHaveLength(3);
    expect(
      reconciled.every((candidate) => candidate.resolution === "rejected"),
    ).toBe(true);
    expect(
      reconciled.every(
        (candidate) =>
          candidate.resolutionReason === "already_matches_workspace_value",
      ),
    ).toBe(true);
  });

  test("keeps unsupported qualifications available for review instead of silently dropping them", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, education: [] },
    };
    const evidenceText =
      "Bachelor of Science in Computer Science — Oregon State University, 2018";
    const educationCandidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_unsupported_education",
      ...createStageCandidate({
        target: {
          section: "education",
          key: "record",
          recordId: "education_1",
        },
        label: "Oregon State University",
        value: {
          schoolName: "Oregon State University",
          degree: "MBA",
          fieldOfStudy: "Artificial Intelligence",
          location: "Boston, MA",
          startDate: null,
          endDate: "2018",
          summary: null,
        },
        sourceBlockIds: ["block_education"],
        confidence: 0.9,
        overall: 0.8,
        recommendation: "needs_review",
      }),
      id: "candidate_unsupported_education",
      sourceKind: "model_background",
      evidenceText,
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    expect(
      reconcileCandidates(seed.profile, seed.searchPreferences, [
        educationCandidate,
      ])[0],
    ).toMatchObject({
      resolution: "needs_review",
      value: {
        schoolName: "Oregon State University",
        degree: "MBA",
        fieldOfStudy: "Artificial Intelligence",
        location: null,
        endDate: "2018",
      },
    });
  });

  test("keeps a two-line employer-less title as one role", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, experiences: [] },
    };
    const values = [
      {
        companyName: "Senior Product",
        title: "Engineer",
        startDate: "2021-01",
        endDate: null,
        isCurrent: true,
        summary: "Built accessible workflows.",
      },
      {
        companyName: null,
        title: "Senior Product Engineer",
        startDate: "2021-01",
        endDate: null,
        isCurrent: true,
        summary: "Built accessible workflows.",
      },
    ];
    const candidates = values.map((value, index) =>
      ResumeImportFieldCandidateSchema.parse({
        runId: "resume_import_run_split_title",
        ...createStageCandidate({
          target: {
            section: "experience",
            key: "record",
            recordId: `experience_${index}`,
          },
          label:
            index === 0
              ? "Engineer at Senior Product"
              : "Senior Product Engineer",
          value,
          sourceBlockIds: [`block_${index}`],
          confidence: index === 0 ? 0.94 : 0.9,
          overall: index === 0 ? 0.92 : 0.88,
          recommendation: "auto_apply",
        }),
        id: `candidate_split_title_${index}`,
        sourceKind: "model_experience",
        resolution: "needs_review",
        createdAt: "2026-04-10T10:00:00.000Z",
        resolvedAt: null,
      }),
    );

    const applied = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      candidates,
    ).filter((candidate) => candidate.resolution === "auto_applied");

    expect(applied).toHaveLength(1);
    expect(applied[0]?.value).toMatchObject({
      companyName: null,
      title: "Senior Product Engineer",
      startDate: "2021-01",
      endDate: null,
      isCurrent: true,
    });
  });

  test("keeps a legitimate company-title pair without an unsplit duplicate", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, experiences: [] },
    };
    const candidate = ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_legitimate_company",
      ...createStageCandidate({
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_company",
        },
        label: "Engineer at Senior Product",
        value: {
          companyName: "Senior Product",
          title: "Engineer",
          startDate: "2021-01",
          endDate: null,
          isCurrent: true,
        },
        sourceBlockIds: ["block_company"],
        confidence: 0.94,
        overall: 0.92,
        recommendation: "auto_apply",
      }),
      id: "candidate_legitimate_company",
      sourceKind: "model_experience",
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
    });

    expect(
      reconcileCandidates(seed.profile, seed.searchPreferences, [candidate])[0]
        ?.value,
    ).toMatchObject({ companyName: "Senior Product", title: "Engineer" });
  });

  test("folds degree-only education into the complete record and rejects an empty record", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, education: [] },
    };
    const values = [
      {
        schoolName: null,
        degree: null,
        fieldOfStudy: null,
        location: null,
        startDate: null,
        endDate: null,
        summary: null,
      },
      {
        schoolName: null,
        degree: "BSc Computer Science",
        fieldOfStudy: null,
        location: null,
        startDate: null,
        endDate: null,
        summary: null,
      },
      {
        schoolName: "University of Somewhere",
        degree: "BSc Computer Science",
        fieldOfStudy: null,
        location: null,
        startDate: null,
        endDate: null,
        summary: null,
      },
    ];
    const candidates = values.map((value, index) =>
      ResumeImportFieldCandidateSchema.parse({
        runId: "resume_import_run_education_stubs",
        ...createStageCandidate({
          target: {
            section: "education",
            key: "record",
            recordId: `education_${index}`,
          },
          label: `Education ${index}`,
          value,
          sourceBlockIds: [`block_${index}`],
          confidence: 0.9,
          overall: 0.88,
          recommendation: "auto_apply",
        }),
        id: `candidate_education_stub_${index}`,
        sourceKind: "model_background",
        resolution: "needs_review",
        createdAt: "2026-04-10T10:00:00.000Z",
        resolvedAt: null,
      }),
    );

    const reconciled = reconcileCandidates(
      seed.profile,
      seed.searchPreferences,
      candidates,
    );
    const applied = reconciled.filter(
      (candidate) => candidate.resolution === "auto_applied",
    );

    expect(applied).toHaveLength(1);
    expect(applied[0]?.value).toMatchObject({
      schoolName: "University of Somewhere",
      degree: "BSc Computer Science",
    });
    expect(reconciled).toContainEqual(
      expect.objectContaining({
        id: "candidate_education_stub_0",
        resolution: "rejected",
        resolutionReason: "empty_record_candidate",
      }),
    );
  });

  test("keeps two real degrees from the same school", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      profile: { ...baseSeed.profile, education: [] },
    };
    const candidates = ["BSc Computer Science", "MSc Product Design"].map(
      (degree, index) =>
        ResumeImportFieldCandidateSchema.parse({
          runId: "resume_import_run_two_degrees",
          ...createStageCandidate({
            target: {
              section: "education",
              key: "record",
              recordId: `education_degree_${index}`,
            },
            label: degree,
            value: {
              schoolName: "University of Somewhere",
              degree,
              fieldOfStudy: null,
              location: null,
              startDate: null,
              endDate: null,
              summary: null,
            },
            sourceBlockIds: [`block_degree_${index}`],
            confidence: 0.9,
            overall: 0.88,
            recommendation: "auto_apply",
          }),
          id: `candidate_degree_${index}`,
          sourceKind: "model_background",
          resolution: "needs_review",
          createdAt: "2026-04-10T10:00:00.000Z",
          resolvedAt: null,
        }),
    );

    expect(
      reconcileCandidates(
        seed.profile,
        seed.searchPreferences,
        candidates,
      ).filter((candidate) => candidate.resolution === "auto_applied"),
    ).toHaveLength(2);
  });

  const modelCandidate = (
    overrides: Partial<ResumeImportFieldCandidate> & {
      target: ResumeImportFieldCandidate["target"];
      value: ResumeImportFieldCandidate["value"];
    },
  ) =>
    ResumeImportFieldCandidateSchema.parse({
      runId: "resume_import_run_fill",
      ...createStageCandidate({
        target: overrides.target,
        label: overrides.label ?? "Imported value",
        value: overrides.value,
        confidence: 0.82,
        overall: 0.82,
        recommendation: "needs_review",
      }),
      id:
        overrides.id ??
        `candidate_fill_${overrides.target.section}_${overrides.target.key}`,
      sourceKind: "model_identity_summary",
      resolution: "needs_review",
      createdAt: "2026-04-10T10:00:00.000Z",
      resolvedAt: null,
      ...overrides,
    });

  test("model-read headline, summary, years and target roles fill empty fields without block evidence", () => {
    const seed = createSeed();
    const profile = { ...emptyProfile(), targetRoles: [] };
    const preferences = { ...seed.searchPreferences, targetRoles: [] };
    const candidates = [
      modelCandidate({
        target: { section: "identity", key: "headline", recordId: null },
        label: "Headline",
        value: "Senior Product Engineer",
      }),
      modelCandidate({
        target: { section: "identity", key: "summary", recordId: null },
        label: "Professional summary",
        value:
          "I build product platforms end to end, from discovery through launch and iteration.",
      }),
      modelCandidate({
        target: {
          section: "identity",
          key: "yearsExperience",
          recordId: null,
        },
        label: "Years of experience",
        value: 8,
      }),
      modelCandidate({
        target: {
          section: "search_preferences",
          key: "targetRoles",
          recordId: null,
        },
        label: "Target roles",
        value: ["Product Engineer", "Staff Engineer"],
      }),
    ];

    const reconciled = reconcileCandidates(
      profile,
      preferences,
      candidates,
      undefined,
      {
        readByModel: true,
      },
    );

    expect(reconciled.map((candidate) => candidate.resolution)).toEqual([
      "auto_applied",
      "auto_applied",
      "auto_applied",
      "auto_applied",
    ]);
  });

  test("does not overwrite target roles the person already chose", () => {
    const seed = createSeed();
    // A profile already in use (not the untouched fresh-start seed).
    const profile = { ...seed.profile, targetRoles: ["Designer"] };
    const preferences = {
      ...seed.searchPreferences,
      targetRoles: ["Designer"],
    };
    const candidates = [
      modelCandidate({
        target: {
          section: "search_preferences",
          key: "targetRoles",
          recordId: null,
        },
        label: "Target roles",
        value: ["Product Engineer"],
      }),
    ];

    const reconciled = reconcileCandidates(
      profile,
      preferences,
      candidates,
      undefined,
      {
        readByModel: true,
      },
    );

    expect(reconciled[0]?.resolution).toBe("needs_review");
  });

  test("placeholder headline still fills after the name was already saved", () => {
    const seed = createSeed();
    const profile = {
      ...emptyProfile(),
      fullName: "Alex Morgan",
      firstName: "Alex",
      lastName: "Morgan",
    };
    const candidates = [
      modelCandidate({
        target: { section: "identity", key: "headline", recordId: null },
        label: "Headline",
        value: "Senior Product Engineer",
      }),
    ];

    const reconciled = reconcileCandidates(
      profile,
      seed.searchPreferences,
      candidates,
      undefined,
      { readByModel: true },
    );

    expect(reconciled[0]?.resolution).toBe("auto_applied");
  });
});
