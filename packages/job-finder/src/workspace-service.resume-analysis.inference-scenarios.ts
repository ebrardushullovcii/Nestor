import { describe, expect, test } from "vitest";
import {
  createAiClient,
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import {
  findExperienceCandidateByTitle,
  listLatestRunCandidates,
} from "./workspace-service.resume-analysis.shared";

describe("createJobFinderWorkspaceService", () => {
  test("enriches nearby company markers on review candidates and suppresses shared-memory duplicates from review", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({ seed });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_inferred_company",
        fileName: "CV.pdf",
        textContent: [
          "Elian Morava",
          "Address: Prishtina, Kosovo (Home)",
          "ABOUT ME",
          "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
          "WORK EXPERIENCE",
          "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
          ".NET CONSULTANT – 01/2022 – Current",
          "• Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.",
          ".NET DEVELOPER – 08/2019 – 01/2022",
          "• Supported and enhanced a comprehensive .NET desktop application for business management covering inventory, sales, tax documentation, POS, restaurant orders, car repair, and fuel-pump control.",
        ].join("\n"),
      },
      documentBundle: {
        id: "bundle_inferred_company",
        runId: "bundle_run_inferred_company",
        sourceResumeId: "resume_inferred_company",
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
              "Address: Prishtina, Kosovo (Home)",
              "ABOUT ME",
              "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
              "WORK EXPERIENCE",
              "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
              ".NET CONSULTANT – 01/2022 – Current",
              ".NET DEVELOPER – 08/2019 – 01/2022",
            ].join("\n"),
            charCount: 0,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
          },
        ],
        blocks: [
          { id: "page_1_block_1", pageNumber: 1, readingOrder: 0, text: "Elian Morava", kind: "paragraph", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_2", pageNumber: 1, readingOrder: 1, text: "Address: Prishtina, Kosovo (Home)", kind: "paragraph", sectionHint: "contact", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_3", pageNumber: 1, readingOrder: 2, text: "ABOUT ME", kind: "heading", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_4", pageNumber: 1, readingOrder: 3, text: "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.", kind: "paragraph", sectionHint: "summary", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_5", pageNumber: 1, readingOrder: 4, text: "WORK EXPERIENCE", kind: "heading", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_6", pageNumber: 1, readingOrder: 5, text: "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_7", pageNumber: 1, readingOrder: 6, text: ".NET CONSULTANT – 01/2022 – Current", kind: "paragraph", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_8", pageNumber: 1, readingOrder: 7, text: "• Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.", kind: "list_item", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_9", pageNumber: 1, readingOrder: 8, text: ".NET DEVELOPER – 08/2019 – 01/2022", kind: "paragraph", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_10", pageNumber: 1, readingOrder: 9, text: "• Supported and enhanced a comprehensive .NET desktop application for business management covering inventory, sales, tax documentation, POS, restaurant orders, car repair, and fuel-pump control.", kind: "list_item", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
        ],
        fullText: [
          "Elian Morava",
          "Address: Prishtina, Kosovo (Home)",
          "ABOUT ME",
          "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
          "WORK EXPERIENCE",
          "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
          ".NET CONSULTANT – 01/2022 – Current",
          "• Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.",
          ".NET DEVELOPER – 08/2019 – 01/2022",
          "• Supported and enhanced a comprehensive .NET desktop application for business management covering inventory, sales, tax documentation, POS, restaurant orders, car repair, and fuel-pump control.",
        ].join("\n"),
      },
    });

    const candidates = await listLatestRunCandidates(repository, {
      resolutions: ["needs_review", "abstained"],
    });
    const dotNetDeveloperCandidate = findExperienceCandidateByTitle(
      candidates,
      ".NET Developer",
    );

    expect(snapshot.profile.experiences).toEqual(seed.profile.experiences);
    expect(dotNetDeveloperCandidate?.resolution).toBe("needs_review");
    expect(dotNetDeveloperCandidate?.label).toContain("BRIDGEWAY L.L.C");
    expect(dotNetDeveloperCandidate?.value).toEqual(
      expect.objectContaining({
        title: ".NET Developer",
        companyName: "BRIDGEWAY L.L.C",
        location: "Prishtina, Kosovo",
      }),
    );
    expect(snapshot.latestResumeImportReviewCandidates.map((candidate) => candidate.label)).not.toContain(
      "Self introduction",
    );
    expect(snapshot.latestResumeImportReviewCandidates.map((candidate) => candidate.label)).not.toContain(
      "Professional story",
    );
  });

  test("infers the first cross-page role company into review candidates when bullets continue", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          experiences: [],
        },
      },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "experience") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            candidates: [
              {
                target: { section: "experience", key: "record", recordId: "experience_1" },
                label: "Experience 1",
                value: {
                  companyName: null,
                  companyUrl: null,
                  title: "Digital Marketing Manager",
                  employmentType: null,
                  location: null,
                  workMode: [],
                  startDate: "12/2017",
                  endDate: "04/2018",
                  isCurrent: false,
                  summary: null,
                  achievements: [
                    "Grew social reach by 120 % and email CTR by 35 % through data-driven A/B campaigns.",
                  ],
                  skills: [],
                  domainTags: [],
                  peopleManagementScope: null,
                  ownershipScope: null,
                },
                normalizedValue: null,
                valuePreview: "Digital Marketing Manager | 12/2017 | 04/2018 | false",
                evidenceText: "DIGITAL MARKETING MANAGER – 12/2017 – 04/2018",
                sourceBlockIds: ["page_3_block_2"],
                confidence: 0.62,
                notes: [],
                alternatives: [],
              },
            ],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_cross_page_company",
        fileName: "CV.pdf",
        textContent: [
          "LUMIQUE – PRISHTINA, KOSOVO",
          "PROJECT MANAGER – 04/2018 – 12/2018",
          "• Managed end-to-end project lifecycle for the development of e-commerce and landing sites, ensuring timely delivery and quality standards.",
          "• Standardized QA checklists, cutting post-launch defect reports by 40 %.",
          "DIGITAL MARKETING MANAGER – 12/2017 – 04/2018",
        ].join("\n"),
      },
      documentBundle: {
        id: "bundle_cross_page_company",
        runId: "bundle_run_cross_page_company",
        sourceResumeId: "resume_cross_page_company",
        sourceFileKind: "pdf",
        primaryParserKind: "pdfjs_text",
        parserKinds: ["pdfjs_text"],
        createdAt: "2026-04-10T00:00:00.000Z",
        warnings: [],
        languageHints: [],
        pages: [
          {
            pageNumber: 2,
            text: [
              "LUMIQUE – PRISHTINA, KOSOVO",
              "PROJECT MANAGER – 04/2018 – 12/2018",
              "• Managed end-to-end project lifecycle for the development of e-commerce and landing sites, ensuring timely delivery and quality standards.",
            ].join("\n"),
            charCount: 0,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
          },
          {
            pageNumber: 3,
            text: [
              "• Standardized QA checklists, cutting post-launch defect reports by 40 %.",
              "DIGITAL MARKETING MANAGER – 12/2017 – 04/2018",
              "• Grew social reach by 120 % and email CTR by 35 % through data-driven A/B campaigns.",
            ].join("\n"),
            charCount: 0,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
          },
        ],
        blocks: [
          { id: "page_2_block_1", pageNumber: 2, readingOrder: 0, text: "LUMIQUE – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_2_block_2", pageNumber: 2, readingOrder: 1, text: "PROJECT MANAGER – 04/2018 – 12/2018", kind: "heading", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_2_block_3", pageNumber: 2, readingOrder: 2, text: "• Managed end-to-end project lifecycle for the development of e-commerce and landing sites, ensuring timely delivery and quality standards.", kind: "list_item", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_3_block_1", pageNumber: 3, readingOrder: 0, text: "• Standardized QA checklists, cutting post-launch defect reports by 40 %.", kind: "list_item", sectionHint: "summary", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_3_block_2", pageNumber: 3, readingOrder: 1, text: "DIGITAL MARKETING MANAGER – 12/2017 – 04/2018", kind: "heading", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_3_block_3", pageNumber: 3, readingOrder: 2, text: "• Grew social reach by 120 % and email CTR by 35 % through data-driven A/B campaigns.", kind: "list_item", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
        ],
        fullText: [
          "LUMIQUE – PRISHTINA, KOSOVO",
          "PROJECT MANAGER – 04/2018 – 12/2018",
          "• Managed end-to-end project lifecycle for the development of e-commerce and landing sites, ensuring timely delivery and quality standards.",
          "• Standardized QA checklists, cutting post-launch defect reports by 40 %.",
          "DIGITAL MARKETING MANAGER – 12/2017 – 04/2018",
          "• Grew social reach by 120 % and email CTR by 35 % through data-driven A/B campaigns.",
        ].join("\n"),
      },
    });

    const candidates = await listLatestRunCandidates(repository, {
      resolutions: ["auto_applied", "needs_review", "abstained"],
    });
    const digitalMarketingCandidate = findExperienceCandidateByTitle(
      candidates,
      "Digital Marketing Manager",
    );

    expect(snapshot.profile.experiences.length).toBeGreaterThan(0);
    expect(digitalMarketingCandidate?.resolution).toBe("auto_applied");
    expect(digitalMarketingCandidate?.value).toEqual(
      expect.objectContaining({
        title: "Digital Marketing Manager",
        companyName: "LUMIQUE",
        location: "Prishtina, Kosovo",
      }),
    );
  });

  test("inherits previous page company for review candidates when a new page starts with same-section continuation bullets", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          experiences: [],
        },
      },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "experience") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            candidates: [
              {
                target: { section: "experience", key: "record", recordId: "experience_1" },
                label: "Experience 1",
                value: {
                  companyName: null,
                  companyUrl: null,
                  title: "Chief Experience Officer",
                  employmentType: null,
                  location: null,
                  workMode: [],
                  startDate: "11/2021",
                  endDate: "07/2023",
                  isCurrent: false,
                  summary: null,
                  achievements: [
                    "Led and oversaw customer experience initiatives, ensuring smooth and efficient interactions between support, QA, and development teams.",
                  ],
                  skills: [],
                  domainTags: [],
                  peopleManagementScope: null,
                  ownershipScope: null,
                },
                normalizedValue: null,
                valuePreview: "Chief Experience Officer | 11/2021 | 07/2023 | false",
                evidenceText: "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023",
                sourceBlockIds: ["page_2_block_3"],
                confidence: 0.62,
                notes: [],
                alternatives: [],
              },
            ],
            notes: [],
          });
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_ceo_previous_page_company",
        fileName: "CV.pdf",
        textContent: [
          "NORTHLANE – PRISHTINA, KOSOVO",
          "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current",
          "• Implemented a custom integration layer via API routes to run tests on demand and stream real-time results, accelerating feedback loops.",
          "• Built a centralized dashboard with ShadCN components for logging outcomes, generating reports, and tracking historical data, giving QA and engineering teams a single source of truth.",
          "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023",
        ].join("\n"),
      },
      documentBundle: {
        id: "bundle_ceo_previous_page_company",
        runId: "bundle_run_ceo_previous_page_company",
        sourceResumeId: "resume_ceo_previous_page_company",
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
              "NORTHLANE – PRISHTINA, KOSOVO",
              "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current",
              "• Implemented a custom integration layer via API routes to run tests on demand and stream real-time results, accelerating feedback loops.",
            ].join("\n"),
            charCount: 0,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
          },
          {
            pageNumber: 2,
            text: [
              "• Built a centralized dashboard with ShadCN components for logging outcomes, generating reports, and tracking historical data, giving QA and engineering teams a single source of truth.",
              "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023",
              "• Led and oversaw customer experience initiatives, ensuring smooth and efficient interactions between support, QA, and development teams.",
            ].join("\n"),
            charCount: 0,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
          },
        ],
        blocks: [
          { id: "page_1_block_1", pageNumber: 1, readingOrder: 0, text: "NORTHLANE – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_2", pageNumber: 1, readingOrder: 1, text: "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current", kind: "heading", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_3", pageNumber: 1, readingOrder: 2, text: "• Implemented a custom integration layer via API routes to run tests on demand and stream real-time results, accelerating feedback loops.", kind: "list_item", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_2_block_1", pageNumber: 2, readingOrder: 0, text: "• Built a centralized dashboard with ShadCN components for logging outcomes, generating reports, and tracking historical data, giving QA and engineering teams a single source of truth.", kind: "list_item", sectionHint: "summary", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_2_block_3", pageNumber: 2, readingOrder: 1, text: "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023", kind: "heading", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_2_block_4", pageNumber: 2, readingOrder: 2, text: "• Led and oversaw customer experience initiatives, ensuring smooth and efficient interactions between support, QA, and development teams.", kind: "list_item", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
        ],
        fullText: [
          "NORTHLANE – PRISHTINA, KOSOVO",
          "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current",
          "• Implemented a custom integration layer via API routes to run tests on demand and stream real-time results, accelerating feedback loops.",
          "• Built a centralized dashboard with ShadCN components for logging outcomes, generating reports, and tracking historical data, giving QA and engineering teams a single source of truth.",
          "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023",
          "• Led and oversaw customer experience initiatives, ensuring smooth and efficient interactions between support, QA, and development teams.",
        ].join("\n"),
      },
    });

    const candidates = await listLatestRunCandidates(repository, {
      resolutions: ["auto_applied", "needs_review", "abstained"],
    });
    const chiefExperienceOfficerCandidate = findExperienceCandidateByTitle(
      candidates,
      "Chief Experience Officer",
    );

    expect(snapshot.profile.experiences.length).toBeGreaterThan(0);
    expect(chiefExperienceOfficerCandidate?.resolution).toBe("auto_applied");
    expect(chiefExperienceOfficerCandidate?.value).toEqual(
      expect.objectContaining({
        title: "Chief Experience Officer",
        companyName: "NORTHLANE",
        location: "Prishtina, Kosovo",
      }),
    );
  });

  test("does not crash when an AI experience candidate omits array fields and normalizes review candidates", async () => {
    const seed = createSeed();
    const baseClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseClient,
        extractResumeImportStage(input) {
          if (input.stage === "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [
                {
                  target: { section: "identity", key: "fullName", recordId: null },
                  label: "Full name",
                  value: "Elian Morava",
                  normalizedValue: "Elian Morava",
                  valuePreview: "Elian Morava",
                  evidenceText: "Elian Morava",
                  sourceBlockIds: ["page_1_block_1"],
                  confidence: 0.98,
                  notes: [],
                  alternatives: [],
                },
              ],
              notes: [],
            });
          }

          if (input.stage === "experience") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [
                {
                  target: { section: "experience", key: "record", recordId: "experience_1" },
                  label: "Malformed experience",
                  value: {
                    companyName: "BRIDGEWAY L.L.C",
                    title: ".NET Developer",
                    startDate: "08/2019",
                    endDate: "01/2022",
                    isCurrent: false,
                  },
                  normalizedValue: null,
                  valuePreview: ".NET Developer | 08/2019 | 01/2022 | false",
                  evidenceText: ".NET DEVELOPER – 08/2019 – 01/2022",
                  sourceBlockIds: ["page_1_block_3"],
                  confidence: 0.84,
                  notes: [],
                  alternatives: [],
                },
              ],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
      documentManager: createDocumentManager(),
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_malformed_arrays",
        fileName: "CV.pdf",
        textContent: [
          "Elian Morava",
          "WORK EXPERIENCE",
          "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
          ".NET DEVELOPER – 08/2019 – 01/2022",
        ].join("\n"),
      },
      documentBundle: {
        id: "bundle_malformed_arrays",
        runId: "bundle_run_malformed_arrays",
        sourceResumeId: "resume_malformed_arrays",
        sourceFileKind: "pdf",
        primaryParserKind: "pdfjs_text",
        parserKinds: ["pdfjs_text"],
        createdAt: "2026-04-10T00:00:00.000Z",
        warnings: [],
        languageHints: [],
        pages: [],
        blocks: [
          { id: "page_1_block_1", pageNumber: 1, readingOrder: 0, text: "Elian Morava", kind: "paragraph", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_2", pageNumber: 1, readingOrder: 1, text: "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "identity", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
          { id: "page_1_block_3", pageNumber: 1, readingOrder: 2, text: ".NET DEVELOPER – 08/2019 – 01/2022", kind: "paragraph", sectionHint: "experience", bbox: null, sourceParserKinds: ["pdfjs_text"], sourceConfidence: 0.72 },
        ],
        fullText: [
          "Elian Morava",
          "WORK EXPERIENCE",
          "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
          ".NET DEVELOPER – 08/2019 – 01/2022",
        ].join("\n"),
      },
    });

    const candidates = await listLatestRunCandidates(repository, {
      resolutions: ["needs_review", "abstained"],
    });
    const malformedExperienceCandidate = findExperienceCandidateByTitle(
      candidates,
      ".NET Developer",
    );

    expect(snapshot.profile.experiences).toEqual(seed.profile.experiences);
    expect(malformedExperienceCandidate?.resolution).toBe("needs_review");
    expect(malformedExperienceCandidate?.value).toEqual(
      expect.objectContaining({
        companyName: "BRIDGEWAY L.L.C",
        title: ".NET Developer",
        achievements: [],
        skills: [],
        domainTags: [],
      }),
    );
  });
});
