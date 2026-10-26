import { describe, expect, test, vi } from "vitest";

import {
  PROFILE_SETUP_PLACEHOLDER_HEADLINE,
  PROFILE_SETUP_PLACEHOLDER_SUMMARY,
} from "@nestor/contracts";

import {
  mergeEducationRecords,
  mergeExperienceRecords,
} from "./internal/profile-merge";
import {
  createFreshStartSeedProfile,
  createSeed,
} from "./test-fixtures";
import {
  createAiClient,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";

describe("resume import deduplication", () => {
  test("imports two complete jobs once when the model keeps their city in the employer name", async () => {
    // Synthetic resume used in the configured sidebar import QA run.
    const fullText = `Jamie Rivers
Senior Full-stack and Platform Engineer
Berlin, Germany
jamie@example.com
+49 555 0000000
https://jamie.example.test
https://www.linkedin.com/in/jamie-rivers-test

Summary
Senior software engineer with 12 years of experience building React, TypeScript, Node.js and Python applications, APIs, cloud infrastructure and data pipelines. Experienced across frontend, backend, platform engineering and full-stack delivery.

Experience
Signal Systems, Berlin, Germany
Senior Full-stack Engineer
January 2020 - September 2026
Built React and TypeScript interfaces and Node.js REST APIs for business applications.
Led design system modernization and reusable component development across shared UI workflows.
Maintained PostgreSQL databases, Redis caches and asynchronous processing systems.
Created Python and SQL pipelines for product analytics and reliable data ingestion.
Deployed applications on AWS with Docker, Kubernetes, Terraform and GitHub Actions.
Improved release confidence through unit, integration and end-to-end tests.

Northstar Software, Berlin, Germany
Software Engineer
January 2014 - December 2019
Built JavaScript web applications and Python backend services.
Integrated third-party APIs and improved application accessibility and performance.
Maintained Linux services and automated production deployments.
Collaborated with product designers and customers to deliver clear usable workflows.

Education
Berlin Technical Institute
Bachelor of Science in Computer Science
2010 - 2013

Skills
React, TypeScript, JavaScript, Node.js, Python, SQL, PostgreSQL, Redis, AWS, Docker, Kubernetes, Terraform, GitHub Actions, REST APIs, GraphQL, HTML, CSS, Design Systems, Playwright, Vitest, Linux, Data Pipelines

Languages
English - fluent
German - fluent

Eligibility
Authorized to work in Germany and the European Union. No sponsorship required.

Target roles
Frontend Engineer, Backend Engineer, Full-stack Engineer, Platform Engineer, Data Engineer
Preferred location: Remote worldwide or Berlin, Germany`;
    const seed = createSeed();
    const fallbackClient = createAiClient();
    const { profileWork } = createProfileServiceHarness({
      seed: {
        ...seed,
        profile: { ...createFreshStartSeedProfile(), experiences: [] },
      },
      aiClient: {
        ...fallbackClient,
        extractResumeImportStage(input) {
          if (input.stage !== "experience") {
            return fallbackClient.extractResumeImportStage(input);
          }
          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates:
              input.stage === "experience"
                ? [
                    {
                      companyName: "Signal Systems, Berlin, Germany",
                      title: "Senior Full-Stack Engineer",
                      startDate: "2020-01",
                      endDate: "2026-09",
                      achievements: [
                        "Built React and TypeScript interfaces and Node.js REST APIs for business applications.",
                      ],
                    },
                    {
                      companyName: "Northstar Software, Berlin, Germany",
                      title: "Software Engineer",
                      startDate: "2014-01",
                      endDate: "2019-12",
                      achievements: [
                        "Built JavaScript web applications and Python backend services.",
                      ],
                    },
                  ]
                    .flatMap((role) => [
                      {
                        ...role,
                        companyName:
                          role.companyName.split(",")[0] ?? role.companyName,
                        location: "Berlin, Germany",
                      },
                      { ...role, location: null, achievements: [] },
                    ])
                    .map((role, index) =>
                      createStageCandidate({
                        target: {
                          section: "experience",
                          key: "record",
                          recordId: `model_experience_${index}`,
                        },
                        label: `${role.title} at ${role.companyName}`,
                        value: { ...role, isCurrent: false },
                        sourceBlockIds: [
                          `page_1_block_${
                            fullText
                              .split(/\n/)
                              .filter(Boolean)
                              .indexOf(
                                `${role.companyName.split(",")[0]}, Berlin, Germany`,
                              ) + 1
                          }`,
                        ],
                        confidence: 0.92,
                        recommendation: "auto_apply",
                      }),
                    )
                : [],
            notes: [],
          });
        },
      },
    });
    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_location_suffix_twins",
        fileName: "jamie-comprehensive-synthetic.txt",
        textContent: fullText,
      },
      documentBundle: createTestBundle({
        fullText,
        primaryParserKind: "plain_text",
      }),
    });

    expect(snapshot.profile.experiences).toHaveLength(2);
    expect(
      snapshot.profile.experiences.map((role) => role.companyName).sort(),
    ).toEqual(["Northstar Software", "Signal Systems"]);
    expect(
      snapshot.profile.experiences.every(
        (role) =>
          role.location === "Berlin, Germany" && role.achievements.length > 0,
      ),
    ).toBe(true);
    expect(snapshot.profile.spokenLanguages).toEqual([
      expect.objectContaining({ language: "English", proficiency: "fluent" }),
      expect.objectContaining({ language: "German", proficiency: "fluent" }),
    ]);
    expect(
      snapshot.latestResumeImportReviewCandidates.filter(
        (candidate) => candidate.target.section === "experience",
      ),
    ).toHaveLength(0);
  });

  test("reconciles duplicate experience candidates with different record ids into one review item", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed: {
        ...seed,
        // The resume below is this person's own (Jamie Rivers).
        profile: {
          ...seed.profile,
          fullName: "Jamie Rivers",
          firstName: "Jamie",
          lastName: "Rivers",
          experiences: [],
        },
      },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "experience") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

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
                label: "Senior Software Engineer at Mercury",
                value: {
                  companyName: "Mercury",
                  companyUrl: null,
                  title: "Senior Software Engineer",
                  employmentType: null,
                  location: "New York City Metropolitan Area",
                  workMode: [],
                  startDate: "Aug 2024",
                  endDate: "",
                  isCurrent: true,
                  summary: null,
                  achievements: [],
                  skills: [],
                  domainTags: [],
                  peopleManagementScope: null,
                  ownershipScope: null,
                },
                sourceBlockIds: ["page_1_block_3"],
                confidence: 0.8,
                recommendation: "needs_review",
                overall: 0.76,
              }),
              createStageCandidate({
                target: {
                  section: "experience",
                  key: "record",
                  recordId: "experience_8",
                },
                label: "Senior Software Engineer at Mercury",
                value: {
                  companyName: "Mercury",
                  companyUrl: null,
                  title: "Senior Software Engineer",
                  employmentType: null,
                  location: "New York City Metropolitan Area",
                  workMode: ["remote"],
                  startDate: "2024-08",
                  endDate: null,
                  isCurrent: true,
                  summary: "Leads core product work.",
                  achievements: ["Improved frontend performance."],
                  skills: ["React"],
                  domainTags: [],
                  peopleManagementScope: null,
                  ownershipScope: null,
                },
                sourceBlockIds: ["page_1_block_3"],
                confidence: 0.86,
                recommendation: "needs_review",
                overall: 0.81,
              }),
            ],
            notes: [],
          });
        },
      },
    });

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_duplicate_experience_ids",
        fileName: "resume.pdf",
        textContent: [
          "Jamie Rivers",
          "MERCURY - NEW YORK CITY METROPOLITAN AREA",
          "SENIOR SOFTWARE ENGINEER - 2024-08 - Current",
          "Leads core product work.",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        fullText: [
          "Jamie Rivers",
          "MERCURY - NEW YORK CITY METROPOLITAN AREA",
          "SENIOR SOFTWARE ENGINEER - 2024-08 - Current",
          "Leads core product work.",
        ].join("\n"),
      }),
    });

    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });
    const experienceCandidates = candidates.filter(
      (candidate) =>
        candidate.target.section === "experience" &&
        candidate.target.key === "record",
    );

    // One record survives the pair; on an empty profile it is applied
    // rather than queued, and the duplicate is rejected.
    expect(
      snapshot.latestResumeImportReviewCandidates.filter(
        (candidate) => candidate.target.section === "experience",
      ),
    ).toHaveLength(0);
    expect(experienceCandidates).toHaveLength(2);
    expect(
      experienceCandidates.filter(
        (candidate) => candidate.resolution === "auto_applied",
      ),
    ).toHaveLength(1);
    expect(snapshot.profile.experiences).toHaveLength(1);
    expect(
      experienceCandidates.filter(
        (candidate) => candidate.resolution === "rejected",
      ),
    ).toHaveLength(1);
  });

  test("keeps text import usable when the vision branch fails", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed: { ...seed, profile: createFreshStartSeedProfile() },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [
              createStageCandidate({
                target: { section: "contact", key: "email", recordId: null },
                label: "Email",
                value: "jamie@example.com",
                sourceBlockIds: ["page_1_block_2"],
                confidence: 0.9,
                recommendation: "auto_apply",
                overall: 0.86,
              }),
            ],
            notes: [],
          });
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Test vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 1000,
            detail: "test",
          };
        },
        extractResumeVision() {
          return Promise.reject(new Error("vision exploded"));
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_text_when_vision_fails",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers\njamie@example.com",
      },
      documentBundle: createTestBundle({
        fullText: "Jamie Rivers\njamie@example.com",
      }),
      visionArtifact: {
        id: "vision_artifact_failure_test",
        runId: "seed_run",
        sourceResumeId: "resume_text_when_vision_fails",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_1",
            sourceResumeId: "resume_text_when_vision_fails",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const run = await repository.getLatestResumeImportRun();
    const profile = await repository.getProfile();

    expect(run?.status).not.toBe("failed");
    expect(run?.modelRoles?.vision.status).toBe("failed");
    expect(run?.modelRoles?.vision.errorMessage).toBe("vision exploded");
    expect(profile.email).toBe("jamie@example.com");
  });

  test("skips vision branch when local image generation produced no page images", async () => {
    const seed = createSeed();
    let visionCalls = 0;
    const { repository, profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [
              createStageCandidate({
                target: { section: "contact", key: "email", recordId: null },
                label: "Email",
                value: "jamie@example.com",
                sourceBlockIds: ["page_1_block_2"],
                confidence: 0.9,
                recommendation: "auto_apply",
                overall: 0.86,
              }),
            ],
            notes: [],
          });
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Test vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 1000,
            detail: "test",
          };
        },
        extractResumeVision() {
          visionCalls += 1;
          return Promise.resolve({
            analysisProviderKind: "openai_compatible_vision",
            analysisProviderLabel: "Test vision",
            candidates: [
              createStageCandidate({
                target: {
                  section: "identity",
                  key: "headline",
                  recordId: null,
                },
                label: "Headline",
                value: "Misleading visual candidate",
                sourceBlockIds: [],
                confidence: 0.9,
                recommendation: "needs_review",
                overall: 0.9,
              }),
            ],
            notes: [],
            warnings: [],
            primaryErrorMessage: null,
          });
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_empty_vision_artifact",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers\njamie@example.com",
      },
      documentBundle: createTestBundle({
        fullText: "Jamie Rivers\njamie@example.com",
      }),
      visionArtifact: {
        id: "vision_artifact_empty_test",
        runId: "seed_run",
        sourceResumeId: "resume_empty_vision_artifact",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [],
        warnings: ["local image generation failed"],
      },
    });

    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });

    expect(visionCalls).toBe(0);
    expect(run?.modelRoles?.vision.status).toBe("skipped");
    expect(run?.modelRoles?.vision.warning).toBe(
      "No local resume page images were available for the vision branch.",
    );
    expect(
      candidates.some((candidate) => candidate.sourceKind === "vision_omni"),
    ).toBe(false);
  });

  test("records configured vision provider failures even when fallback candidates are returned", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed,
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Test vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 1000,
            detail: "test",
          };
        },
        extractResumeVision() {
          return Promise.resolve({
            analysisProviderKind: "openai_compatible_vision",
            analysisProviderLabel: "Test vision",
            candidates: [],
            notes: [
              "Configured vision failed; fallback returned no candidates.",
            ],
            warnings: ["Vision model request timed out after 1s"],
            primaryErrorMessage: "Vision model request timed out after 1s",
          });
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_primary_vision_failure",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers\njamie@example.com",
      },
      documentBundle: createTestBundle({
        fullText: "Jamie Rivers\njamie@example.com",
      }),
      visionArtifact: {
        id: "vision_artifact_primary_failure_test",
        runId: "seed_run",
        sourceResumeId: "resume_primary_vision_failure",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_primary_failure",
            sourceResumeId: "resume_primary_vision_failure",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const run = await repository.getLatestResumeImportRun();

    expect(run?.status).not.toBe("failed");
    expect(run?.modelRoles?.vision.status).toBe("timed_out");
    expect(run?.modelRoles?.vision.errorMessage).toBe(
      "Vision model request timed out after 1s",
    );
  });

  test("times out a slow vision branch without waiting beyond text completion", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed: { ...seed, profile: createFreshStartSeedProfile() },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [
              createStageCandidate({
                target: { section: "contact", key: "email", recordId: null },
                label: "Email",
                value: "jamie@example.com",
                sourceBlockIds: ["page_1_block_2"],
                confidence: 0.9,
                recommendation: "auto_apply",
                overall: 0.86,
              }),
            ],
            notes: [],
          });
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Slow vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 25,
            detail: "test",
          };
        },
        async extractResumeVision() {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            analysisProviderKind: "openai_compatible_vision" as const,
            analysisProviderLabel: "Slow vision",
            candidates: [],
            notes: [],
            warnings: [],
            primaryErrorMessage: null,
          };
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_slow_vision_timeout",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers\njamie@example.com",
      },
      documentBundle: createTestBundle({
        fullText: "Jamie Rivers\njamie@example.com",
      }),
      visionArtifact: {
        id: "vision_artifact_slow_timeout_test",
        runId: "seed_run",
        sourceResumeId: "resume_slow_vision_timeout",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_slow_timeout",
            sourceResumeId: "resume_slow_vision_timeout",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const run = await repository.getLatestResumeImportRun();
    const profile = await repository.getProfile();

    expect(run?.modelRoles?.vision.status).toBe("running");
    expect(run?.modelRoles?.vision.warning).toContain("text import is ready");
    expect(run?.modelRoles?.vision.providerKind).toBe(
      "openai_compatible_vision",
    );
    expect(profile.email).toBe("jamie@example.com");
  });

  test("does not wait for a hung vision branch with the default long provider deadline", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed: { ...seed, profile: createFreshStartSeedProfile() },
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [
              createStageCandidate({
                target: { section: "contact", key: "email", recordId: null },
                label: "Email",
                value: "jamie@example.com",
                sourceBlockIds: ["page_1_block_2"],
                confidence: 0.9,
                recommendation: "auto_apply",
                overall: 0.86,
              }),
            ],
            notes: [],
          });
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Hung vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 600_000,
            detail: "test",
          };
        },
        extractResumeVision() {
          return new Promise(() => {
            // Intentionally never settles; text import completion must not wait for this provider deadline.
          });
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_hung_vision_default_deadline",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers\njamie@example.com",
      },
      documentBundle: createTestBundle({
        fullText: "Jamie Rivers\njamie@example.com",
      }),
      visionArtifact: {
        id: "vision_artifact_hung_default_deadline_test",
        runId: "seed_run",
        sourceResumeId: "resume_hung_vision_default_deadline",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_hung_default_deadline",
            sourceResumeId: "resume_hung_vision_default_deadline",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const run = await repository.getLatestResumeImportRun();
    const profile = await repository.getProfile();

    expect(run?.status).toBe("applied");
    expect(run?.modelRoles?.vision.status).toBe("running");
    expect(run?.modelRoles?.vision.timeoutMs).toBe(600_000);
    expect(run?.modelRoles?.vision.warning).toContain("text import is ready");
    expect(profile.email).toBe("jamie@example.com");
  });

  test("completes a deferred slow vision branch in the background", async () => {
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
        experiences: [],
        education: [],
      },
    };
    const { repository, profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [
              createStageCandidate({
                target: { section: "contact", key: "email", recordId: null },
                label: "Email",
                value: "jamie@example.com",
                sourceBlockIds: ["page_1_block_2"],
                confidence: 0.9,
                recommendation: "auto_apply",
                overall: 0.86,
              }),
            ],
            notes: [],
          });
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Slow successful vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 1000,
            detail: "test",
          };
        },
        async extractResumeVision() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            analysisProviderKind: "openai_compatible_vision" as const,
            analysisProviderLabel: "Slow successful vision",
            candidates: [
              {
                ...createStageCandidate({
                  target: {
                    section: "identity",
                    key: "headline",
                    recordId: null,
                  },
                  label: "Headline",
                  value: "Staff Platform Engineer",
                  sourceBlockIds: [],
                  confidence: 0.84,
                  recommendation: "needs_review",
                  overall: 0.78,
                }),
                visualEvidence: [
                  {
                    branch: "vision" as const,
                    sourceFileKind: "pdf" as const,
                    pageNumber: 1,
                    regionHint: "top headline",
                    confidence: 0.84,
                    uncertaintyNotes: [],
                  },
                ],
              },
            ],
            notes: [],
            warnings: [],
            primaryErrorMessage: null,
          };
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_deferred_vision_success",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers\njamie@example.com",
      },
      documentBundle: createTestBundle({
        fullText: "Jamie Rivers\njamie@example.com",
      }),
      visionArtifact: {
        id: "vision_artifact_deferred_success_test",
        runId: "seed_run",
        sourceResumeId: "resume_deferred_vision_success",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_deferred_success",
            sourceResumeId: "resume_deferred_vision_success",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const returnedRun = await repository.getLatestResumeImportRun();

    expect(returnedRun?.modelRoles?.vision.status).toBe("running");

    await vi.waitFor(
      async () => {
        const run = await repository.getLatestResumeImportRun();
        expect(run?.modelRoles?.vision.status).toBe("completed");
      },
      { timeout: 1000, interval: 10 },
    );

    const finalRun = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: finalRun?.id ?? "",
    });
    const profile = await repository.getProfile();

    expect(
      candidates.some((candidate) => candidate.sourceKind === "vision_omni"),
    ).toBe(true);
    expect(profile.headline).toBe("Staff Platform Engineer");
  });

  test("preserves user review decisions when deferred vision completes", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          if (input.stage !== "identity_summary") {
            return Promise.resolve({
              stage: input.stage,
              analysisProviderKind: "deterministic",
              analysisProviderLabel: "Test AI",
              candidates: [],
              notes: [],
            });
          }

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            candidates: [
              createStageCandidate({
                target: { section: "identity", key: "summary", recordId: null },
                label: "Summary",
                value: "Builds resilient workflow tools for complex teams.",
                sourceBlockIds: ["page_1_block_3"],
                confidence: 0.78,
                recommendation: "needs_review",
                overall: 0.74,
              }),
            ],
            notes: [],
          });
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Slow successful vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 1000,
            detail: "test",
          };
        },
        async extractResumeVision() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            analysisProviderKind: "openai_compatible_vision" as const,
            analysisProviderLabel: "Slow successful vision",
            candidates: [
              {
                ...createStageCandidate({
                  target: {
                    section: "identity",
                    key: "headline",
                    recordId: null,
                  },
                  label: "Headline",
                  value: "Staff Platform Engineer",
                  sourceBlockIds: [],
                  confidence: 0.84,
                  recommendation: "needs_review",
                  overall: 0.78,
                }),
                visualEvidence: [
                  {
                    branch: "vision" as const,
                    sourceFileKind: "pdf" as const,
                    pageNumber: 1,
                    regionHint: "top headline",
                    confidence: 0.84,
                    uncertaintyNotes: [],
                  },
                ],
              },
            ],
            notes: [],
            warnings: [],
            primaryErrorMessage: null,
          };
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_deferred_preserve_review",
        fileName: "resume.pdf",
        textContent:
          "Jamie Rivers\nBuilds resilient workflow tools for complex teams.",
      },
      documentBundle: createTestBundle({
        fullText:
          "Jamie Rivers\nBuilds resilient workflow tools for complex teams.",
      }),
      visionArtifact: {
        id: "vision_artifact_deferred_preserve_review_test",
        runId: "seed_run",
        sourceResumeId: "resume_deferred_preserve_review",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_deferred_preserve_review",
            sourceResumeId: "resume_deferred_preserve_review",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const runBeforeReview = await repository.getLatestResumeImportRun();
    const summaryCandidate = (
      await repository.listResumeImportFieldCandidates({
        runId: runBeforeReview?.id ?? "",
      })
    ).find(
      (candidate) =>
        candidate.target.section === "identity" &&
        candidate.target.key === "summary",
    );

    expect(summaryCandidate?.resolution).toBe("needs_review");

    await repository.replaceResumeImportRunArtifacts({
      run: {
        ...runBeforeReview!,
        candidateCounts: {
          ...runBeforeReview!.candidateCounts,
          needsReview: Math.max(
            0,
            runBeforeReview!.candidateCounts.needsReview - 1,
          ),
          rejected: runBeforeReview!.candidateCounts.rejected + 1,
        },
      },
      documentBundles: await repository.listResumeImportDocumentBundles({
        runId: runBeforeReview?.id ?? "",
      }),
      fieldCandidates: (
        await repository.listResumeImportFieldCandidates({
          runId: runBeforeReview?.id ?? "",
        })
      ).map((candidate) =>
        candidate.id === summaryCandidate?.id
          ? {
              ...candidate,
              resolution: "rejected" as const,
              resolutionReason: "setup_dismissed",
              resolvedAt: "2026-04-10T10:00:01.000Z",
            }
          : candidate,
      ),
    });

    await vi.waitFor(
      async () => {
        const run = await repository.getLatestResumeImportRun();
        expect(run?.modelRoles?.vision.status).toBe("completed");
      },
      { timeout: 1000, interval: 10 },
    );

    const finalCandidates = await repository.listResumeImportFieldCandidates({
      runId: runBeforeReview?.id ?? "",
    });
    const finalSummaryCandidate = finalCandidates.find(
      (candidate) => candidate.id === summaryCandidate?.id,
    );

    expect(finalSummaryCandidate?.resolution).toBe("rejected");
    expect(finalSummaryCandidate?.resolutionReason).toBe("setup_dismissed");
    expect(
      finalCandidates.some(
        (candidate) => candidate.sourceKind === "vision_omni",
      ),
    ).toBe(true);
  });

  test("persists text and vision branch failures when neither branch has candidates", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage() {
          return Promise.reject(new Error("text branch exploded"));
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "openai_compatible_vision",
            role: "vision",
            ready: true,
            label: "Slow vision",
            model: "FelidaeAI-Omni-3.6",
            baseUrl: "https://example.com/v1",
            modelContextWindowTokens: 139000,
            reservedHeadroomTokens: 30000,
            requestTimeoutMs: 20,
            detail: "test",
          };
        },
        async extractResumeVision() {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            analysisProviderKind: "openai_compatible_vision" as const,
            analysisProviderLabel: "Slow vision",
            candidates: [],
            notes: [],
            warnings: [],
            primaryErrorMessage: null,
          };
        },
      },
    });

    await expect(
      profileWork.runResumeImport({
        baseResume: {
          ...seed.profile.baseResume,
          id: "resume_both_branch_failure_status",
          fileName: "resume.pdf",
          textContent: "Jamie Rivers",
        },
        documentBundle: createTestBundle({ fullText: "Jamie Rivers" }),
        visionArtifact: {
          id: "vision_artifact_both_branch_failure_test",
          runId: "seed_run",
          sourceResumeId: "resume_both_branch_failure_status",
          sourceFileKind: "pdf",
          createdAt: "2026-04-10T10:00:00.000Z",
          retained: "temporary",
          pages: [
            {
              id: "vision_page_both_branch_failure",
              sourceResumeId: "resume_both_branch_failure_status",
              sourceFileKind: "pdf",
              pageNumber: 1,
              renderKind: "pdf_page_image",
              mimeType: "image/png",
              width: 1200,
              height: 1600,
              byteLength: 4,
              sha256: "abc123",
              dataUrl: "data:image/png;base64,AAAA",
              storagePath: null,
              retained: "temporary",
              generatedAt: "2026-04-10T10:00:00.000Z",
              warnings: [],
            },
          ],
          warnings: [],
        },
      }),
    ).rejects.toThrow("The AI connection failed");

    const run = await repository.getLatestResumeImportRun();

    expect(run?.status).toBe("failed");
    expect(run?.modelRoles?.text.status).toBe("failed");
    expect(run?.modelRoles?.text.errorMessage).toContain(
      "The AI connection failed",
    );
    expect(run?.modelRoles?.vision.status).toBe("timed_out");
    expect(run?.modelRoles?.vision.errorMessage).toContain(
      "timed out after 20ms",
    );
  });

  test("can produce review candidates when text extraction fails but vision succeeds", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage() {
          return Promise.reject(new Error("text branch exploded"));
        },
      },
      visionProvider: {
        getStatus() {
          return {
            kind: "deterministic",
            role: "vision",
            ready: true,
            label: "Test deterministic vision",
            model: null,
            baseUrl: null,
            modelContextWindowTokens: null,
            reservedHeadroomTokens: null,
            requestTimeoutMs: null,
            detail: "test",
          };
        },
        extractResumeVision() {
          return Promise.resolve({
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test deterministic vision",
            candidates: [
              {
                ...createStageCandidate({
                  target: {
                    section: "identity",
                    key: "headline",
                    recordId: null,
                  },
                  label: "Headline",
                  value: "Staff Platform Engineer",
                  sourceBlockIds: [],
                  confidence: 0.76,
                  recommendation: "needs_review",
                  overall: 0.72,
                }),
                visualEvidence: [
                  {
                    branch: "vision" as const,
                    sourceFileKind: "pdf" as const,
                    pageNumber: 1,
                    regionHint: "top headline",
                    confidence: 0.76,
                    uncertaintyNotes: [],
                  },
                ],
              },
            ],
            notes: [],
            warnings: [],
            primaryErrorMessage: null,
          });
        },
      },
    });

    await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_vision_only",
        fileName: "resume.pdf",
        textContent: "Jamie Rivers",
      },
      documentBundle: createTestBundle({ fullText: "Jamie Rivers" }),
      visionArtifact: {
        id: "vision_artifact_success_test",
        runId: "seed_run",
        sourceResumeId: "resume_vision_only",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_1",
            sourceResumeId: "resume_vision_only",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });

    expect(run?.status).toBe("review_ready");
    expect(run?.modelRoles?.text.status).toBe("failed");
    expect(
      candidates.some(
        (candidate) =>
          candidate.sourceKind === "vision_omni" &&
          candidate.resolution === "needs_review",
      ),
    ).toBe(true);
  });

  test("mergeExperienceRecords treats current and empty-end-date duplicates as the same record", () => {
    const merged = mergeExperienceRecords(
      [],
      [
        {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: [],
          startDate: "Aug 2024",
          endDate: "",
          isCurrent: true,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: ["remote"],
          startDate: "2024-08",
          endDate: null,
          isCurrent: true,
          summary: "Leads core product work.",
          achievements: ["Improved frontend performance."],
          skills: ["React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      companyName: "Mercury",
      title: "Senior Software Engineer",
      startDate: "2024-08",
      isCurrent: true,
      summary: "Leads core product work.",
      workMode: ["remote"],
    });
  });

  test("mergeEducationRecords dedupes equivalent education records with different date formats", () => {
    const merged = mergeEducationRecords(
      [],
      [
        {
          schoolName: "Florida State University",
          degree: "Bachelor's Degree",
          fieldOfStudy: "Computer Science",
          location: null,
          startDate: "May 2011",
          endDate: "Sept 2015",
          summary: null,
        },
        {
          schoolName: "Florida State University",
          degree: "Bachelor's Degree",
          fieldOfStudy: "Computer Science",
          location: null,
          startDate: "2011-05",
          endDate: "2015-09",
          summary: "Graduated with honors.",
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      schoolName: "Florida State University",
      degree: "Bachelor's Degree",
      startDate: "2011-05",
      endDate: "2015-09",
      summary: "Graduated with honors.",
    });
  });

  test("mergeEducationRecords dedupes school and degree matches even when dates are missing", () => {
    const merged = mergeEducationRecords(
      [],
      [
        {
          schoolName: "University of Pennsylvania",
          degree: "Bachelor of Computer Science, 2014",
          fieldOfStudy: null,
          location: null,
          startDate: null,
          endDate: null,
          summary: null,
        },
        {
          schoolName: "University of Pennsylvania",
          degree: "Bachelor of Computer Science, 2014",
          fieldOfStudy: null,
          location: null,
          startDate: null,
          endDate: null,
          summary: "2014 – 2018",
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      schoolName: "University of Pennsylvania",
      degree: "Bachelor of Computer Science, 2014",
      summary: "2014 – 2018",
    });
  });

  test("mergeEducationRecords dedupes equivalent degrees with parenthetical variants", () => {
    const merged = mergeEducationRecords(
      [
        {
          id: "education_1",
          schoolName: "The University of Texas at Austin",
          degree: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
          location: null,
          startDate: "Sep 2012",
          endDate: "Jun 2016",
          isDraft: false,
          summary: null,
        },
      ],
      [
        {
          schoolName: "The University of Texas at Austin",
          degree: "Bachelor of Science (B.S.)",
          fieldOfStudy: "Computer Science",
          location: null,
          startDate: "2012-09",
          endDate: "2016-06",
          summary: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.degree).toBe("Bachelor of Science (B.S.)");
  });

  test("mergeEducationRecords dedupes a combined degree and field against split fields", () => {
    const merged = mergeEducationRecords(
      [],
      [
        {
          schoolName: "Oregon State University",
          degree: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
          location: null,
          startDate: null,
          endDate: "2018",
          summary: null,
        },
        {
          schoolName: "Oregon State University",
          degree: "Bachelor of Science in Computer Science",
          fieldOfStudy: null,
          location: null,
          startDate: null,
          endDate: "2018",
          summary: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      schoolName: "Oregon State University",
      degree: "Bachelor of Science in Computer Science",
      fieldOfStudy: "Computer Science",
      endDate: "2018",
    });
  });

  test("mergeExperienceRecords dedupes equivalent records across full slash and iso date formats", () => {
    const merged = mergeExperienceRecords(
      [],
      [
        {
          companyName: "NORTHLANE",
          companyUrl: null,
          title: "Chief Experience Officer",
          employmentType: null,
          location: "Remote, Kosovo",
          workMode: [],
          startDate: "2021-11-13",
          endDate: "2023-06-30",
          isCurrent: false,
          summary: "Led customer experience initiatives.",
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          companyName: "NORTHLANE",
          companyUrl: null,
          title: "Chief Experience Officer",
          employmentType: null,
          location: "Remote, Kosovo",
          workMode: [],
          startDate: "13/11/2021",
          endDate: "30/06/2023",
          isCurrent: false,
          summary: null,
          achievements: ["Managed and guided the QA team."],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      companyName: "NORTHLANE",
      title: "Chief Experience Officer",
      startDate: "13/11/2021",
      endDate: "30/06/2023",
      summary: "Led customer experience initiatives.",
      achievements: ["Managed and guided the QA team."],
    });
  });

  test("mergeExperienceRecords dedupes equivalent records across single-digit slash and iso month formats", () => {
    const merged = mergeExperienceRecords(
      [],
      [
        {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "Remote",
          workMode: [],
          startDate: "7/2023",
          endDate: "6/2024",
          isCurrent: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "Remote",
          workMode: ["remote"],
          startDate: "2023-07",
          endDate: "2024-06",
          isCurrent: false,
          summary: "Led core product work.",
          achievements: ["Improved frontend performance."],
          skills: ["React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      companyName: "Mercury",
      title: "Senior Software Engineer",
      startDate: "2023-07",
      endDate: "2024-06",
      summary: "Led core product work.",
      workMode: ["remote"],
    });
  });

  test("mergeExperienceRecords preserves richer stored details on equivalent re-imports", () => {
    const merged = mergeExperienceRecords(
      [
        {
          id: "experience_existing",
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "Remote",
          workMode: ["remote"],
          startDate: "Aug 2024",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Led frontend platform work across product teams.",
          achievements: ["Improved frontend performance."],
          skills: ["React"],
          domainTags: ["SaaS"],
          peopleManagementScope: "Mentored 3 engineers",
          ownershipScope: "Owned the design system roadmap",
        },
      ],
      [
        {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "Remote",
          workMode: [],
          startDate: "2024-08",
          endDate: null,
          isCurrent: true,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "experience_existing",
      startDate: "2024-08",
      summary: "Led frontend platform work across product teams.",
      achievements: ["Improved frontend performance."],
      skills: ["React"],
      domainTags: ["SaaS"],
      peopleManagementScope: "Mentored 3 engineers",
      ownershipScope: "Owned the design system roadmap",
      workMode: ["remote"],
    });
  });

  test("mergeEducationRecords preserves richer stored details on equivalent re-imports", () => {
    const merged = mergeEducationRecords(
      [
        {
          id: "education_existing",
          schoolName: "Florida State University",
          degree: "Bachelor's Degree",
          fieldOfStudy: "Computer Science",
          location: "Tallahassee, FL",
          startDate: "May 2011",
          endDate: "Sept 2015",
          isDraft: false,
          summary: "Graduated with honors.",
        },
      ],
      [
        {
          schoolName: "Florida State University",
          degree: "Bachelor's Degree",
          fieldOfStudy: null,
          location: null,
          startDate: "2011-05",
          endDate: "2015-09",
          summary: null,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "education_existing",
      startDate: "2011-05",
      endDate: "2015-09",
      fieldOfStudy: "Computer Science",
      location: "Tallahassee, FL",
      summary: "Graduated with honors.",
    });
  });

  test("mergeExperienceRecords folds an employer-less reading of a role into the reading that names the employer", () => {
    const merged = mergeExperienceRecords(
      [],
      [
        {
          companyName: null,
          companyUrl: null,
          title: "Software Engineer",
          employmentType: null,
          location: null,
          workMode: [],
          startDate: "2024-08",
          endDate: null,
          isCurrent: true,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          companyName: "Mercury",
          companyUrl: null,
          title: "Software Engineer",
          employmentType: null,
          location: "Remote",
          workMode: [],
          startDate: "Aug 2024",
          endDate: null,
          isCurrent: true,
          summary: "Distinct employer.",
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    );

    // A live import produced exactly this pair for one job: the model kept the
    // title and dates but lost the employer line, the text reader kept the
    // employer and the bullets. Two cards for one role is the defect.
    expect(merged).toHaveLength(1);
    expect(merged[0]?.companyName).toBe("Mercury");
    expect(merged[0]?.location).toBe("Remote");
  });

  test("mergeExperienceRecords keeps same-title jobs apart when both name different employers", () => {
    const base = {
      companyUrl: null,
      employmentType: null,
      location: null,
      workMode: [],
      startDate: "2024-08",
      endDate: null,
      isCurrent: true,
      summary: null,
      achievements: [],
      skills: [],
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    };
    const merged = mergeExperienceRecords(
      [],
      [
        { ...base, companyName: "Mercury", title: "Software Engineer" },
        { ...base, companyName: "Venus Labs", title: "Software Engineer" },
      ],
    );

    expect(merged).toHaveLength(2);
  });

  test("auto-applies grounded fresh-start fields including inferred search preferences", async () => {
    const seed = createSeed();
    const { profileWork } = createProfileServiceHarness({
      seed: {
        ...seed,
        profile: {
          // Legacy first-run workspace: the instructional headline and summary
          // strings were persisted before the fresh-start seed stopped writing
          // them, so this import must still replace them.
          ...createFreshStartSeedProfile(),
          headline: PROFILE_SETUP_PLACEHOLDER_HEADLINE,
          summary: PROFILE_SETUP_PLACEHOLDER_SUMMARY,
          experiences: [],
          targetRoles: [],
        },
        searchPreferences: {
          ...seed.searchPreferences,
          targetRoles: [],
          locations: [],
          workModes: [],
        },
      },
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_placeholder_replace",
        fileName: "Noah Brenner Resume.pdf",
        textContent: [
          "Noah Brenner",
          "+1 555-010-7911",
          "Cedar Park, TX 78613",
          "linkedin.com/in/noah-brenner-example",
          "Senior Software Engineer",
          "noah.brenner@example.test",
          "Senior Software Engineer with 10+ years of experience building secure, scalable healthcare and SaaS platforms with C#,.NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and cloud-native services on Azure and AWS. Proven record",
          "delivering microservices, third-party integrations, CI/CD automation, observability, and production support in Agile teams.",
          "PROFESSIONAL EXPERIENCE",
          "Senior Software Engineer — DataHub, Remote, CA (Dec 2021–Feb 2026)",
          "Designed C# and .NET services for a behavioral-health platform.",
        ].join("\n"),
      },
      documentBundle: createTestBundle({
        primaryParserKind: "local_pdf_layout",
        parserKinds: ["local_pdf_layout"],
        fullText: [
          "Noah Brenner",
          "+1 555-010-7911",
          "Cedar Park, TX 78613",
          "linkedin.com/in/noah-brenner-example",
          "Senior Software Engineer",
          "noah.brenner@example.test",
          "Senior Software Engineer with 10+ years of experience building secure, scalable healthcare and SaaS platforms with C#,.NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and cloud-native services on Azure and AWS. Proven record",
          "delivering microservices, third-party integrations, CI/CD automation, observability, and production support in Agile teams.",
          "PROFESSIONAL EXPERIENCE",
          "Senior Software Engineer — DataHub, Remote, CA (Dec 2021–Feb 2026)",
          "Designed C# and .NET services for a behavioral-health platform.",
        ].join("\n"),
      }),
    });

    expect(snapshot.profile.fullName).toBe("Noah Brenner");
    expect(snapshot.profile.headline).toBe("Senior Software Engineer");
    expect(snapshot.profile.summary).toContain(
      "10+ years of experience building secure, scalable healthcare and SaaS platforms",
    );
    expect(snapshot.profile.currentLocation).toBe("Cedar Park, TX 78613");
    expect(snapshot.profile.yearsExperience).toBe(10);
    expect(snapshot.profile.experiences).toEqual([
      expect.objectContaining({
        companyName: "DataHub",
        title: "Senior Software Engineer",
      }),
    ]);
    expect(
      snapshot.latestResumeImportReviewCandidates.some(
        (candidate) => candidate.target.section === "experience",
      ),
    ).toBe(false);
    const pendingTargetingKeys = snapshot.latestResumeImportReviewCandidates
      .filter((candidate) => candidate.target.section === "search_preferences")
      .map((candidate) => candidate.target.key);

    // Empty targeting fields take the resume's roles and location; the
    // person edits them on the Job targets step instead of confirming cards.
    expect(snapshot.searchPreferences.targetRoles).toEqual([
      "Senior Software Engineer",
    ]);
    expect(snapshot.searchPreferences.locations.length).toBeGreaterThan(0);
    expect(pendingTargetingKeys).not.toContain("targetRoles");
    expect(snapshot.latestResumeImportRun?.status).toBe("applied");
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).not.toContain("Work history");
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).not.toEqual(expect.arrayContaining(["Years of experience"]));
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).not.toContain("Headline");
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).not.toContain("Summary");
  });

  test("derives and auto-applies years of experience from dated work history on fresh-start imports", async () => {
    const seed = createSeed();
    const { profileWork } = createProfileServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          id: "candidate_fresh_start",
          firstName: "New",
          lastName: "Candidate",
          fullName: "New Candidate",
          headline: "Import your resume to begin",
          summary:
            "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
          currentLocation: "Set your preferred location",
          yearsExperience: 0,
          experiences: [],
          targetRoles: [],
        },
        searchPreferences: {
          ...seed.searchPreferences,
          targetRoles: [],
          locations: [],
          workModes: [],
        },
      },
      aiClient: createAiClient(),
    });

    const text = [
      "Owen Mercer",
      "Tampa, FL",
      "+1 555-010-5538",
      "owen.mercer@example.test",
      "Senior Software Engineer",
      "PROFESSIONAL SUMMARY",
      "Experienced Staff Engineer with a focus on leading complex, high-impact initiatives across full-stack systems.",
      "EXPERIENCE",
      "EdSights, Remote, NY — Staff/Senior Software Engineer",
      "Sep 2021 – Feb 2026",
      "Agile Thought, Tampa, FL — Senior Software Developer",
      "Jul 2019 - Sep 2021",
      "Agile Thought, Tampa, FL — Software Developer",
      "Sep 2016 - Jul 2019",
      "Three Five Two, Tampa, FL — Software Developer",
      "Jun 2015 - Aug 2016",
    ].join("\n");

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_date_derived_years_experience",
        fileName: "Owen Mercer Resume.pdf",
        textContent: text,
      },
      documentBundle: createTestBundle({
        primaryParserKind: "local_pdf_layout",
        parserKinds: ["local_pdf_layout"],
        fullText: text,
      }),
    });

    expect(snapshot.profile.yearsExperience).toBe(10);
    expect(["applied", "review_ready"]).toContain(
      snapshot.latestResumeImportRun?.status,
    );
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).not.toContain("Years of experience");
  });
});
