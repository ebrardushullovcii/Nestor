import { describe, expect, test } from "vitest";
import {
  createAiClient,
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import {
  createTestBundle,
  listLatestRunCandidates,
} from "./workspace-service.resume-analysis.shared";

describe("createJobFinderWorkspaceService", () => {
  test("keeps valid education candidates review-first instead of persisting them into the profile", async () => {
    const seed = createSeed();
    const baseClient = createAiClient();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseClient,
        extractResumeImportStage(input) {
          if (input.stage === "background") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [
                {
                  target: {
                    section: "education",
                    key: "record",
                    recordId: "education_1",
                  },
                  label: "Education",
                  value: {
                    schoolName: "Florida State University",
                    degree: "Bachelor’s Degree",
                    fieldOfStudy: "Computer Science and Physics",
                    location: null,
                    startDate: "May 2011",
                    endDate: "Sept 2015",
                    summary: null,
                  },
                  normalizedValue: null,
                  valuePreview: "Florida State University | Bachelor’s Degree",
                  evidenceText:
                    "Florida State University — Bachelor’s Degree in Computer Science and Physics",
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.9,
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
        id: "resume_review_only_education",
        fileName: "Owen Mercer Resume.pdf",
        textContent: [
          "Owen Mercer",
          "EDUCATION",
          "Florida State University — Bachelor’s Degree in Computer Science and Physics",
          "May 2011 - Sept 2015",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "Owen Mercer",
          "EDUCATION",
          "Florida State University — Bachelor’s Degree in Computer Science and Physics",
          "May 2011 - Sept 2015",
        ].join("\n"),
        qualityScore: 0.92,
      }),
    });

    const candidates = await listLatestRunCandidates(repository, {
      resolutions: ["needs_review", "abstained"],
    });
    const educationCandidate = candidates.find(
      (candidate) =>
        candidate.target.section === "education" &&
        candidate.target.key === "record",
    );

    expect(snapshot.profile.education).toEqual(seed.profile.education);
    expect(educationCandidate?.resolution).toBe("needs_review");
    expect(educationCandidate?.value).toEqual(
      expect.objectContaining({
        schoolName: "Florida State University",
        degree: "Bachelor’s Degree",
      }),
    );
  });

  test("keeps LinkedIn separate and leaves imported proof points available for review", async () => {
    const seed = createSeed();
    // No LinkedIn saved yet: a saved one that differs from the resume now
    // waits for review instead of being replaced (see the re-import test in
    // resume-import-work-eligibility.test.ts).
    // The resume below is this person's own (Robin Example).
    seed.profile = {
      ...seed.profile,
      fullName: "Robin Example",
      firstName: "Robin",
      lastName: "Example",
      linkedinUrl: null,
    };
    const baseClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
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
                  target: {
                    section: "identity",
                    key: "summary",
                    recordId: null,
                  },
                  label: "Summary",
                  value:
                    "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
                  normalizedValue: null,
                  valuePreview:
                    "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
                  evidenceText:
                    "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.9,
                  notes: [],
                  alternatives: [],
                },
                {
                  target: {
                    section: "contact",
                    key: "linkedinUrl",
                    recordId: null,
                  },
                  label: "LinkedIn URL",
                  value: "https://www.linkedin.com/in/robin-example-example0/",
                  normalizedValue: null,
                  valuePreview:
                    "https://www.linkedin.com/in/robin-example-example0/",
                  evidenceText:
                    "Website: https://www.linkedin.com/in/robin-example-example0/",
                  sourceBlockIds: ["page_1_block_3"],
                  confidence: 0.96,
                  notes: [],
                  alternatives: [],
                },
              ],
              notes: [],
            });
          }

          if (input.stage === "background") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [
                {
                  target: {
                    section: "link",
                    key: "record",
                    recordId: "link_1",
                  },
                  label: "LinkedIn",
                  value: {
                    label: "LinkedIn",
                    url: "https://www.linkedin.com/in/robin-example-example0/",
                    kind: "linkedin",
                  },
                  normalizedValue: null,
                  valuePreview: "LinkedIn",
                  evidenceText:
                    "Website: https://www.linkedin.com/in/robin-example-example0/",
                  sourceBlockIds: ["page_1_block_3"],
                  confidence: 0.94,
                  notes: [],
                  alternatives: [],
                },
              ],
              notes: [],
            });
          }

          if (input.stage === "shared_memory") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test AI",
              candidates: [
                {
                  target: {
                    section: "application_identity",
                    key: "preferredLinkUrls",
                    recordId: null,
                  },
                  label: "LinkedIn URL",
                  value: "https://www.linkedin.com/in/robin-example-example0/",
                  normalizedValue: null,
                  valuePreview:
                    "https://www.linkedin.com/in/robin-example-example0/",
                  evidenceText:
                    "Website: https://www.linkedin.com/in/robin-example-example0/",
                  sourceBlockIds: ["page_1_block_3"],
                  confidence: 0.99,
                  notes: [],
                  alternatives: [],
                },
                {
                  target: {
                    section: "narrative",
                    key: "professionalStory",
                    recordId: null,
                  },
                  label: "Professional summary",
                  value:
                    "Passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
                  normalizedValue: null,
                  valuePreview:
                    "Passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
                  evidenceText:
                    "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
                  sourceBlockIds: ["page_1_block_2"],
                  confidence: 0.98,
                  notes: [],
                  alternatives: [],
                },
                {
                  target: {
                    section: "proof_point",
                    key: "technicalAchievement",
                    recordId: null,
                  },
                  label: "Technical achievement - Performance optimization",
                  value:
                    "Cut query response times by up to 60% in critical workflows and reduced AWS hosting costs by 15% through targeted refactors as .NET Consultant.",
                  normalizedValue:
                    "60% query response improvement and 15% AWS cost reduction",
                  valuePreview:
                    "Cut query response times by up to 60% in critical workflows and reduced AWS hosting costs by 15% through targeted refactors as .NET Consultant.",
                  evidenceText:
                    "Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.",
                  sourceBlockIds: ["page_1_block_4"],
                  confidence: 0.95,
                  notes: [],
                  alternatives: [],
                },
                {
                  target: {
                    section: "proof_point",
                    key: "careerTransition",
                    recordId: null,
                  },
                  label: "Career transition proof point",
                  value:
                    "Returned to hands-on development after management experience, demonstrating renewed focus on technical execution.",
                  normalizedValue: null,
                  valuePreview:
                    "Returned to hands-on development after management experience, demonstrating renewed focus on technical execution.",
                  evidenceText:
                    "After deciding to return to my passion for development, I transitioned back into a hands-on developer role.",
                  sourceBlockIds: ["page_1_block_5"],
                  confidence: 0.95,
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
        id: "resume_shared_memory",
        fileName: "CV.pdf",
        textContent: [
          "Robin Example",
          "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
          "Website: https://www.linkedin.com/in/robin-example-example0/",
          "Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.",
          "After deciding to return to my passion for development, I transitioned back into a hands-on developer role.",
        ].join("\n"),
      },
      documentBundle: {
        id: "bundle_shared_memory",
        runId: "bundle_run_shared_memory",
        sourceResumeId: "resume_shared_memory",
        sourceFileKind: "pdf",
        primaryParserKind: "pdfjs_text",
        parserKinds: ["pdfjs_text"],
        createdAt: "2026-04-10T00:00:00.000Z",
        warnings: [],
        languageHints: [],
        pages: [],
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Robin Example",
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
            text: "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
            kind: "paragraph",
            sectionHint: "summary",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_3",
            pageNumber: 1,
            readingOrder: 2,
            text: "Website: https://www.linkedin.com/in/robin-example-example0/",
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
            text: "Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.",
            kind: "paragraph",
            sectionHint: "experience",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
          {
            id: "page_1_block_5",
            pageNumber: 1,
            readingOrder: 4,
            text: "After deciding to return to my passion for development, I transitioned back into a hands-on developer role.",
            kind: "paragraph",
            sectionHint: "summary",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.72,
          },
        ],
        fullText: [
          "Robin Example",
          "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
          "Website: https://www.linkedin.com/in/robin-example-example0/",
          "Provide on-call architecture and performance triage, cutting query response times by up to 60% in critical workflows.",
          "After deciding to return to my passion for development, I transitioned back into a hands-on developer role.",
        ].join("\n"),
      },
    });

    expect(snapshot.profile.linkedinUrl).toBe(
      "https://www.linkedin.com/in/robin-example-example0/",
    );
    expect(snapshot.profile.personalWebsiteUrl).toBeNull();
    expect(
      snapshot.profile.applicationIdentity.preferredLinkIds.length,
    ).toBeGreaterThan(0);
    // The identical resume summary already lands in the professional summary,
    // so it is not copied into the professional story as well; the story the
    // user already had is preserved instead of being duplicated over.
    expect(snapshot.profile.narrative.professionalStory).not.toContain(
      "Passionate software developer",
    );
    expect(snapshot.profile.narrative.careerTransitionSummary).toContain(
      "Returned to hands-on development",
    );
    expect(
      snapshot.profile.proofBank.some(
        (proof) =>
          proof.title === "Technical achievement - Performance optimization",
      ),
    ).toBe(false);
    expect(snapshot.latestResumeImportReviewCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            section: "proof_point",
          }) as unknown,
          resolution: "needs_review",
        }),
      ]),
    );
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).not.toContain("LinkedIn URL");
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).not.toContain("Professional summary");
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).not.toContain("Career transition summary");
  });
});
