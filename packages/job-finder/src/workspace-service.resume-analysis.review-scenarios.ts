import { describe, expect, test } from "vitest";
import {
  createAiClient,
  createDocumentManager,
  createExtractionAiClient,
  createFreshStartSeedProfile,
  createResumeExtraction,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./workspace-service.resume-analysis.shared";

describe("createJobFinderWorkspaceService", () => {
  test("keeps the import run review_ready when only abstained candidates remain unresolved", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage === "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [
                createStageCandidate({
                  target: {
                    section: "identity",
                    key: "headline",
                    recordId: null,
                  },
                  label: "Headline",
                  value: "Uncertain Headline",
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.2,
                  recommendation: "abstain",
                  overall: 0.2,
                }),
              ],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_abstain_only",
        fileName: "resume.txt",
        textContent: ["Jamie Rivers", "Possibly Headline"].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: ["Jamie Rivers", "Possibly Headline"].join("\n"),
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Jamie Rivers",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["plain_text"],
            sourceConfidence: 0.98,
            parserLineage: ["plain_text"],
            readingOrderConfidence: 0.98,
            lineIds: ["line_1"],
            textSpan: null,
          },
          {
            id: "page_1_block_2",
            pageNumber: 1,
            readingOrder: 1,
            text: "Possibly Headline",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["plain_text"],
            sourceConfidence: 0.4,
            parserLineage: ["plain_text"],
            readingOrderConfidence: 0.6,
            lineIds: ["line_2"],
            textSpan: null,
          },
        ],
      }),
    });

    expect(snapshot.latestResumeImportRun?.status).toBe("review_ready");
    expect(
      snapshot.latestResumeImportRun?.candidateCounts.abstained,
    ).toBeGreaterThan(0);
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).toContain("Headline");
  });

  test("marks the import applied when only optional proof suggestions remain unresolved", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage === "shared_memory") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [
                createStageCandidate({
                  target: {
                    section: "proof_point",
                    key: "record",
                    recordId: "proof_1",
                  },
                  label: "Platform migration proof",
                  value: {
                    title: "Platform migration",
                    claim: "Cut migration time by 40% across three services.",
                    heroMetric: "40% faster",
                    supportingContext:
                      "Shipped a staged rollout with validation checkpoints.",
                    roleFamilies: [],
                    projectIds: [],
                    linkIds: [],
                  },
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.74,
                  recommendation: "needs_review",
                  overall: 0.74,
                }),
              ],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_optional_proof_only",
        fileName: "resume.txt",
        textContent: [
          "Alex Vanguard",
          "Cut migration time by 40% across three services.",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "Alex Vanguard",
          "Cut migration time by 40% across three services.",
        ].join("\n"),
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Alex Vanguard",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["plain_text"],
            sourceConfidence: 0.98,
            parserLineage: ["plain_text"],
            readingOrderConfidence: 0.98,
            lineIds: ["line_1"],
            textSpan: null,
          },
          {
            id: "page_1_block_2",
            pageNumber: 1,
            readingOrder: 1,
            text: "Cut migration time by 40% across three services.",
            kind: "paragraph",
            sectionHint: "summary",
            bbox: null,
            sourceParserKinds: ["plain_text"],
            sourceConfidence: 0.86,
            parserLineage: ["plain_text"],
            readingOrderConfidence: 0.9,
            lineIds: ["line_2"],
            textSpan: null,
          },
        ],
      }),
    });

    expect(snapshot.latestResumeImportRun?.status).toBe("applied");
    expect(snapshot.latestResumeImportRun?.candidateCounts.needsReview).toBe(1);
    expect(snapshot.profile.baseResume.analysisWarnings).toEqual([
      "1 optional proof suggestion is available to review before using it in tailored resume narratives.",
    ]);
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).toEqual(["Platform migration proof"]);
  });

  test("fills a placeholder headline and empty work history on an existing profile", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          id: "candidate_review_existing_profile",
          experiences: [],
          firstName: "Jamie",
          lastName: "Rivers",
          fullName: "Jamie Rivers",
          headline: "Import your resume to begin",
          currentLocation: "Berlin, Germany",
          email: null,
          phone: null,
          portfolioUrl: null,
          linkedinUrl: null,
          // No contact has been confirmed yet, so no preferred application
          // contact exists for the imported literals to contradict.
          applicationIdentity: {
            ...seed.profile.applicationIdentity,
            preferredEmail: null,
            preferredPhone: null,
          },
        },
      },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage === "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [
                createStageCandidate({
                  target: {
                    section: "identity",
                    key: "headline",
                    recordId: null,
                  },
                  label: "Headline",
                  value: "Staff Frontend Engineer",
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.9,
                  recommendation: "needs_review",
                  overall: 0.79,
                }),
              ],
              notes: [],
            });
          }

          if (input.stage === "experience") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [
                createStageCandidate({
                  target: {
                    section: "experience",
                    key: "record",
                    recordId: "experience_1",
                  },
                  label: "Staff Frontend Engineer at Signal Labs",
                  value: {
                    companyName: "Signal Labs",
                    companyUrl: null,
                    title: "Staff Frontend Engineer",
                    employmentType: "Full-time",
                    location: "Berlin, Germany",
                    workMode: ["remote"],
                    startDate: "2021-02",
                    endDate: null,
                    isCurrent: true,
                    summary: "Leads design system adoption.",
                    achievements: ["Built accessible shared components."],
                    skills: ["React", "TypeScript"],
                    domainTags: ["design systems"],
                    peopleManagementScope: null,
                    ownershipScope: null,
                  },
                  sourceBlockIds: ["page_1_block_7"],
                  confidence: 0.91,
                  recommendation: "needs_review",
                  overall: 0.76,
                }),
              ],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_literal_safe",
        fileName: "resume.pdf",
        textContent: [
          "Jamie Rivers",
          "Staff Frontend Engineer",
          "Berlin, Germany",
          "jamie@example.com",
          "+49 555 1234",
          "https://www.linkedin.com/in/jamie-rivers",
          "SIGNAL LABS – BERLIN, GERMANY",
          "STAFF FRONTEND ENGINEER – 2021-02 – Current",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "Jamie Rivers",
          "Staff Frontend Engineer",
          "Berlin, Germany",
          "jamie@example.com",
          "+49 555 1234",
          "https://www.linkedin.com/in/jamie-rivers",
          "SIGNAL LABS – BERLIN, GERMANY",
          "STAFF FRONTEND ENGINEER – 2021-02 – Current",
        ].join("\n"),
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Jamie Rivers",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.98,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.98,
            lineIds: ["line_1"],
            textSpan: null,
          },
          {
            id: "page_1_block_2",
            pageNumber: 1,
            readingOrder: 1,
            text: "Staff Frontend Engineer",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.9,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.95,
            lineIds: ["line_2"],
            textSpan: null,
          },
          {
            id: "page_1_block_3",
            pageNumber: 1,
            readingOrder: 2,
            text: "Berlin, Germany",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.92,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.95,
            lineIds: ["line_3"],
            textSpan: null,
          },
          {
            id: "page_1_block_4",
            pageNumber: 1,
            readingOrder: 3,
            text: "jamie@example.com",
            kind: "contact",
            sectionHint: "contact",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.99,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.99,
            lineIds: ["line_4"],
            textSpan: null,
          },
          {
            id: "page_1_block_5",
            pageNumber: 1,
            readingOrder: 4,
            text: "+49 555 1234",
            kind: "contact",
            sectionHint: "contact",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.96,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.98,
            lineIds: ["line_5"],
            textSpan: null,
          },
          {
            id: "page_1_block_6",
            pageNumber: 1,
            readingOrder: 5,
            text: "https://www.linkedin.com/in/jamie-rivers",
            kind: "contact",
            sectionHint: "contact",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.96,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.98,
            lineIds: ["line_6"],
            textSpan: null,
          },
          {
            id: "page_1_block_7",
            pageNumber: 1,
            readingOrder: 6,
            text: "SIGNAL LABS – BERLIN, GERMANY",
            kind: "heading",
            sectionHint: "experience",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.86,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.9,
            lineIds: ["line_7"],
            textSpan: null,
          },
          {
            id: "page_1_block_8",
            pageNumber: 1,
            readingOrder: 7,
            text: "STAFF FRONTEND ENGINEER – 2021-02 – Current",
            kind: "experience_header",
            sectionHint: "experience",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.86,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.9,
            lineIds: ["line_8"],
            textSpan: null,
          },
        ],
      }),
    });

    expect(snapshot.profile.fullName).toBe("Jamie Rivers");
    expect(snapshot.profile.firstName).toBe("Jamie");
    expect(snapshot.profile.lastName).toBe("Rivers");
    expect(snapshot.profile.headline).toBe("Staff Frontend Engineer");
    expect(snapshot.profile.email).toBe("jamie@example.com");
    expect(snapshot.profile.phone).toBe("+49 555 1234");
    expect(snapshot.profile.linkedinUrl).toBe(
      "https://www.linkedin.com/in/jamie-rivers",
    );
    expect(snapshot.profile.id).toBe("candidate_review_existing_profile");
    // The profile had no work history yet, so the record fills the empty
    // section instead of waiting in review; a placeholder headline is
    // replaced the same way.
    expect(snapshot.profile.experiences).toHaveLength(1);
    expect(
      snapshot.latestResumeImportRun?.candidateCounts.autoApplied,
    ).toBeGreaterThanOrEqual(4);
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).not.toContain("Staff Frontend Engineer at Signal Labs");

    const run = await repository.getLatestResumeImportRun();
    const appliedCandidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
      resolutions: ["auto_applied"],
    });

    expect(
      appliedCandidates.some(
        (candidate) =>
          candidate.target.section === "experience" &&
          candidate.resolutionReason === "applied_into_empty_profile",
      ),
    ).toBe(true);
  });

  test("auto-applies strong experience records on a fresh-start profile", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...createFreshStartSeedProfile(),
          experiences: [],
        },
      },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage === "experience") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [
                createStageCandidate({
                  target: {
                    section: "experience",
                    key: "record",
                    recordId: "experience_1",
                  },
                  label: "Staff Frontend Engineer at Signal Labs",
                  value: {
                    companyName: "Signal Labs",
                    companyUrl: null,
                    title: "Staff Frontend Engineer",
                    employmentType: "Full-time",
                    location: "Berlin, Germany",
                    workMode: ["remote"],
                    startDate: "2021-02",
                    endDate: null,
                    isCurrent: true,
                    summary: "Leads design system adoption.",
                    achievements: ["Built accessible shared components."],
                    skills: ["React", "TypeScript"],
                    domainTags: ["design systems"],
                    peopleManagementScope: null,
                    ownershipScope: null,
                  },
                  sourceBlockIds: ["page_1_block_7"],
                  confidence: 0.91,
                  recommendation: "needs_review",
                  overall: 0.76,
                }),
              ],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_fresh_start_experience_auto_apply",
        fileName: "resume.pdf",
        textContent: [
          "Jamie Rivers",
          "Staff Frontend Engineer",
          "Berlin, Germany",
          "SIGNAL LABS – BERLIN, GERMANY",
          "STAFF FRONTEND ENGINEER – 2021-02 – Current",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "Jamie Rivers",
          "Staff Frontend Engineer",
          "Berlin, Germany",
          "SIGNAL LABS – BERLIN, GERMANY",
          "STAFF FRONTEND ENGINEER – 2021-02 – Current",
        ].join("\n"),
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Jamie Rivers",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.98,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.98,
            lineIds: ["line_1"],
            textSpan: null,
          },
          {
            id: "page_1_block_2",
            pageNumber: 1,
            readingOrder: 1,
            text: "Staff Frontend Engineer",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.9,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.95,
            lineIds: ["line_2"],
            textSpan: null,
          },
          {
            id: "page_1_block_3",
            pageNumber: 1,
            readingOrder: 2,
            text: "Berlin, Germany",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.92,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.95,
            lineIds: ["line_3"],
            textSpan: null,
          },
          {
            id: "page_1_block_7",
            pageNumber: 1,
            readingOrder: 6,
            text: "SIGNAL LABS – BERLIN, GERMANY",
            kind: "heading",
            sectionHint: "experience",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.86,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.9,
            lineIds: ["line_7"],
            textSpan: null,
          },
          {
            id: "page_1_block_8",
            pageNumber: 1,
            readingOrder: 7,
            text: "STAFF FRONTEND ENGINEER – 2021-02 – Current",
            kind: "experience_header",
            sectionHint: "experience",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.86,
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.9,
            lineIds: ["line_8"],
            textSpan: null,
          },
        ],
      }),
    });

    expect(snapshot.profile.experiences).toEqual([
      expect.objectContaining({
        companyName: "Signal Labs",
        title: "Staff Frontend Engineer",
        location: "Berlin, Germany",
        isCurrent: true,
      }),
    ]);
    expect(snapshot.latestResumeImportRun?.status).toBe("applied");
    expect(snapshot.latestResumeImportReviewCandidates).toEqual([]);
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).not.toContain("Work history");
  });

  test("abstains low-confidence scalar conflicts instead of overwriting existing profile values", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage === "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [
                createStageCandidate({
                  target: {
                    section: "identity",
                    key: "headline",
                    recordId: null,
                  },
                  label: "Headline",
                  value: "Operations Wizard",
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.42,
                  recommendation: "abstain",
                  overall: 0.24,
                }),
                createStageCandidate({
                  target: {
                    section: "identity",
                    key: "summary",
                    recordId: null,
                  },
                  label: "Summary",
                  value: "Operations wizardry across galactic supply chains.",
                  sourceBlockIds: ["page_1_block_3"],
                  confidence: 0.4,
                  recommendation: "abstain",
                  overall: 0.22,
                }),
              ],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_abstain_conflict",
        fileName: "resume.pdf",
        textContent: [
          "Alex Vanguard",
          "Operations Wizard",
          "Operations wizardry across galactic supply chains.",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "Alex Vanguard",
          "Operations Wizard",
          "Operations wizardry across galactic supply chains.",
        ].join("\n"),
        qualityScore: 0.44,
      }),
    });

    expect(snapshot.profile.headline).toBe(seed.profile.headline);
    expect(snapshot.profile.summary).toBe(seed.profile.summary);
    expect(
      snapshot.latestResumeImportRun?.candidateCounts.abstained,
    ).toBeGreaterThanOrEqual(2);

    const run = await repository.getLatestResumeImportRun();
    const abstainedCandidates =
      await repository.listResumeImportFieldCandidates({
        runId: run?.id ?? "",
        resolution: "abstained",
      });

    expect(abstainedCandidates.map((candidate) => candidate.label)).toEqual(
      expect.arrayContaining(["Headline", "Summary"]),
    );
    expect(
      abstainedCandidates.every(
        (candidate) =>
          candidate.resolutionReason ===
          "composite_confidence_recommended_abstain",
      ),
    ).toBe(true);
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).toEqual(expect.arrayContaining(["Headline", "Summary"]));
  });

  test("keeps literal imported name and address when the model proposes invalid identity values", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: { ...seed, profile: createFreshStartSeedProfile() },
      aiClient: createExtractionAiClient(
        createResumeExtraction({
          fullName: "ABOUT ME",
          headline: "Senior Full-STACK Software Engineer",
          currentLocation:
            "recently decided to return to hands-on development, where my career initially began and where my true passion lies. I",
          email: "elian.morava@example.test",
          phone: "(+383) 44555010",
        }),
      ),
      documentManager: createDocumentManager(),
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_cv_pdf",
        fileName: "CV.pdf",
        textContent: "Elian Morava\nAddress: Prishtina, Kosovo (Home)",
      },
      documentBundle: {
        id: "bundle_cv_pdf",
        runId: "bundle_run_cv_pdf",
        sourceResumeId: "resume_cv_pdf",
        sourceFileKind: "pdf",
        primaryParserKind: "pdfjs_text",
        parserKinds: ["pdfjs_text"],
        createdAt: "2026-04-10T00:00:00.000Z",
        warnings: [],
        languageHints: [],
        pages: [
          {
            pageNumber: 1,
            text: [
              "Elian Morava",
              "Date of birth: 04/07/1998 Nationality: Kosovar Phone number: (+383) 44555010 (Mobile) Email address:",
              "elian.morava@example.test Website: https://www.linkedin.com/in/elian-morava-example/",
              "Address: Prishtina, Kosovo (Home)",
              "ABOUT ME",
              "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js,",
            ].join("\n"),
            charCount: 0,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
          },
        ],
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Elian Morava",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_2",
            pageNumber: 1,
            readingOrder: 1,
            text: "Date of birth: 04/07/1998 Nationality: Kosovar Phone number: (+383) 44555010 (Mobile) Email address:",
            kind: "paragraph",
            sectionHint: "contact",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_3",
            pageNumber: 1,
            readingOrder: 2,
            text: "elian.morava@example.test Website: https://www.linkedin.com/in/elian-morava-example/",
            kind: "contact",
            sectionHint: "contact",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_4",
            pageNumber: 1,
            readingOrder: 3,
            text: "Address: Prishtina, Kosovo (Home)",
            kind: "paragraph",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_5",
            pageNumber: 1,
            readingOrder: 4,
            text: "ABOUT ME",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_6",
            pageNumber: 1,
            readingOrder: 5,
            text: "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js,",
            kind: "paragraph",
            sectionHint: "summary",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
        ],
        fullText: [
          "Elian Morava",
          "Date of birth: 04/07/1998 Nationality: Kosovar Phone number: (+383) 44555010 (Mobile) Email address:",
          "elian.morava@example.test Website: https://www.linkedin.com/in/elian-morava-example/",
          "Address: Prishtina, Kosovo (Home)",
          "ABOUT ME",
          "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js,",
        ].join("\n"),
      },
    });

    expect(snapshot.profile.fullName).toBe("Elian Morava");
    expect(snapshot.profile.currentLocation).toBe("Prishtina, Kosovo");

    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });
    const rejectedNameCandidate = candidates.find(
      (candidate) =>
        candidate.target.section === "identity" &&
        candidate.target.key === "fullName" &&
        candidate.value === "ABOUT ME",
    );

    expect(rejectedNameCandidate?.resolution).toBe("rejected");
  });

  test("does not auto-apply low-confidence fallback full-name guesses from non-name text", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: { ...seed, profile: createFreshStartSeedProfile() },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_bad_name_fallback",
        fileName: "Noah Brenner Resume.pdf",
        textContent: [
          "+1 555-010-7911",
          "Noah Brenner Cedar Park, TX 78613",
          "linkedin.com/in/noah-brenner-example",
          "Senior Software Engineer noah.brenner@example.test",
          "Senior Software Engineer with 10+ years of experience building secure, scalable healthcare and SaaS platforms.",
          "Technical Mentorship",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "+1 555-010-7911",
          "Noah Brenner Cedar Park, TX 78613",
          "linkedin.com/in/noah-brenner-example",
          "Senior Software Engineer noah.brenner@example.test",
          "Senior Software Engineer with 10+ years of experience building secure, scalable healthcare and SaaS platforms.",
          "Technical Mentorship",
        ].join("\n"),
        qualityScore: 0.92,
      }),
    });

    expect(snapshot.profile.fullName).toBe("Noah Brenner");
    expect(snapshot.profile.firstName).toBe("Noah");
    expect(snapshot.profile.lastName).toBe("Brenner");
    expect(snapshot.profile.currentLocation).toBe("Cedar Park, TX 78613");
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.valuePreview,
      ),
    ).not.toContain("Technical Mentorship");

    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });

    expect(
      candidates.some(
        (candidate) =>
          candidate.target.section === "location" &&
          candidate.target.key === "currentLocation" &&
          candidate.value === "Set your preferred location",
      ),
    ).toBe(false);
  });
});
