import { describe, expect, test } from "vitest";
import {
  buildDeterministicStructuredResumeDraft,
  createOpenAiCompatibleJobFinderAiClient,
  createJobFinderAiClientFromEnvironment,
} from "./index";
import type { ProfileCopilotRelevantReviewItem } from "@nestor/contracts";
import { ProfileCopilotUnfinishedError } from "./openai-compatible";
import {
  createEnvironment,
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
  mockCapturingJsonFetch,
  mockJsonFetch,
} from "./test-fixtures";

describe("openai-compatible chat and draft behavior", () => {
  test("ignores model tool calls that were not offered in the request", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "unexpected_tool",
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        label: "AI resume agent",
      });

      const result = await client.chatWithTools(
        [{ role: "user", content: "hello" }],
        [
          {
            type: "function",
            function: {
              name: "expected_tool",
              description: "Expected tool",
              parameters: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          },
        ],
        { maxOutputTokens: 42 },
      );

      expect(result.toolCalls).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  test("fills missing structured draft fields with deterministic fallback content", async () => {
    const draftPayload = {
      label: "Tailored Resume",
      coreSkills: ["React"],
      notes: ["Model draft partial"],
    };
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify(draftPayload),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const input = {
        profile: createProfile(),
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
        evidence: {
          summary: ["Grounded summary"],
          candidateSummary: ["Candidate summary"],
          experience: ["Built reliable interfaces"],
          skills: ["React"],
          keywords: ["TypeScript"],
        },
        researchContext: {
          companyNotes: ["Company note"],
          domainVocabulary: ["workflow"],
          priorityThemes: ["systems"],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);
      const deterministicFallback =
        buildDeterministicStructuredResumeDraft(input);

      expect(result.label).toBe("Tailored Resume");
      expect(result.summary).toBe(deterministicFallback.summary);
      expect(result.experienceHighlights).toEqual(
        deterministicFallback.experienceHighlights,
      );
      expect(result.experienceEntries).toEqual(
        deterministicFallback.experienceEntries,
      );
      expect(result.educationEntries).toEqual(
        deterministicFallback.educationEntries,
      );
      expect(result.additionalSkills).toEqual(
        deterministicFallback.additionalSkills,
      );
      expect(result.fullText).toContain(result.label ?? "");
      expect(result.fullText).toContain(result.summary);
      expect(result.fullText).toContain("Core skills: React");
      expect(result.fullText).toContain(
        "Targeted keywords: TypeScript, workflow, systems, React",
      );
      expect(result.compatibilityScore).toBe(
        deterministicFallback.compatibilityScore,
      );
      expect(result.notes).toEqual([
        "AI completed the review without proposing wording changes, so your wording stayed unchanged.",
        ...deterministicFallback.notes.filter(
          (note) => note !== "Used the built-in deterministic resume tailorer.",
        ),
        "Generated with Primary AI (test-model).",
      ]);
      expect(result.generationProvenance).toEqual({
        method: "ai",
        reason: null,
        detail:
          "AI completed the review without proposing wording changes, so your wording stayed unchanged.",
      });
      expect(result.notes.join(" ")).toContain("Generated with Primary AI");
      expect(result.fullText).not.toContain("Model draft partial");
    } finally {
      restoreFetch();
    }
  });

  test("keeps the model's wording for the fact check and drops records the person does not have", async () => {
    const fabricatedSummary =
      "Fabricated executive summary claiming fifty million dollars in growth.";
    const fabricatedHighlight = "Invented a forty-million-dollar turnaround.";
    const fabricatedProject = "Project Mirage";
    const fabricatedSchool = "Imaginary University";
    const fabricatedCertification = "Quantum Cloud Grandmaster";
    const fabricatedLanguage = "Klingon — Native";
    const fabricatedKeyword = "Unverified Quantum Computing";
    const fabricatedNote = "Won an invented global engineering award.";
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "World-Class Executive Resume",
              summary: fabricatedSummary,
              experienceHighlights: [fabricatedHighlight],
              coreSkills: ["React", "ImaginarySkill"],
              targetedKeywords: [fabricatedKeyword],
              projectEntries: [
                {
                  name: fabricatedProject,
                  role: "Founder",
                  summary: "Built a fictional global platform.",
                  outcome: "Created one billion dollars in value.",
                  bullets: ["Served every person on earth."],
                  profileRecordId: "project_fabricated",
                },
              ],
              educationEntries: [
                {
                  school: fabricatedSchool,
                  degree: "PhD",
                  fieldOfStudy: "Quantum Leadership",
                  dateRange: "2020 – 2024",
                  profileRecordId: "education_fabricated",
                },
              ],
              certificationEntries: [
                {
                  name: fabricatedCertification,
                  issuer: "Imaginary Cloud Council",
                  dateRange: "2026",
                  profileRecordId: "certification_fabricated",
                },
              ],
              additionalSkills: ["TypeScript", "ImaginarySkill"],
              languages: [fabricatedLanguage],
              compatibilityScore: 91,
              notes: [fabricatedNote],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const input = {
        profile: {
          ...createProfile(),
          projects: [
            {
              id: "project_workflow_console",
              name: "Workflow Console",
              projectType: null,
              summary: "Built a canonical workflow operations console.",
              role: "Lead Engineer",
              skills: ["React", "TypeScript"],
              outcome: "Reduced canonical support response time by 20%.",
              projectUrl: null,
              repositoryUrl: null,
              caseStudyUrl: null,
            },
          ],
          education: [
            {
              id: "education_engineering",
              schoolName: "Canonical Technical University",
              degree: "BSc",
              fieldOfStudy: "Software Engineering",
              location: "London, UK",
              startDate: "2012",
              endDate: "2016",
              isDraft: false,
              summary:
                "Completed the canonical software engineering curriculum.",
            },
          ],
          certifications: [
            {
              id: "certification_cloud",
              name: "Canonical Cloud Practitioner",
              issuer: "Canonical Cloud Institute",
              issueDate: "2024",
              expiryDate: null,
              credentialUrl: null,
              isDraft: false,
            },
          ],
          spokenLanguages: [
            {
              id: "language_english",
              language: "English",
              proficiency: "Fluent",
              interviewPreference: true,
              notes: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", "TypeScript"],
          keywords: ["React", "TypeScript"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);
      const deterministicFallback =
        buildDeterministicStructuredResumeDraft(input);

      // The model's lines stand; the fact check, not a rule, decides whether
      // the person's evidence backs them (ADR 0041). Records the person does
      // not have (a project, school, certificate or language that is not on
      // their profile) never enter the draft.
      expect(result).toMatchObject({
        summary: fabricatedSummary,
        experienceHighlights: [fabricatedHighlight],
        targetedKeywords: deterministicFallback.targetedKeywords,
        projectEntries: deterministicFallback.projectEntries,
        educationEntries: deterministicFallback.educationEntries,
        certificationEntries: deterministicFallback.certificationEntries,
        languages: deterministicFallback.languages,
        generationProvenance: { method: "ai", reason: null },
        compatibilityScore: 91,
      });
      expect(result.coreSkills).toEqual(
        expect.arrayContaining(["React", "ImaginarySkill"]),
      );
      for (const fabricatedRecord of [
        fabricatedProject,
        fabricatedSchool,
        fabricatedCertification,
        fabricatedLanguage,
        fabricatedKeyword,
        fabricatedNote,
      ]) {
        expect(result.fullText).not.toContain(fabricatedRecord);
      }
    } finally {
      restoreFetch();
    }
  });

  test("backfills profile metadata on model-supplied experience entries", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceHighlights: ["Tailored highlight"],
              experienceEntries: [
                {
                  summary: "Tailored platform ownership summary",
                  bullets: ["Tailored platform ownership impact"],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const input = {
        profile: {
          ...createProfile(),
          experiences: [
            {
              id: "experience_acme",
              companyName: "Acme Labs",
              companyUrl: null,
              title: "Senior Frontend Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote"],
              startDate: "2020-01",
              endDate: null,
              isCurrent: true,
              isDraft: false,
              summary: "Built platform foundations.",
              achievements: ["Improved deployment reliability."],
              skills: [],
              domainTags: [],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
        evidence: {
          summary: ["Grounded summary"],
          candidateSummary: ["Candidate summary"],
          experience: ["Built reliable interfaces"],
          skills: ["React"],
          keywords: ["TypeScript"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);
      const deterministicFallback =
        buildDeterministicStructuredResumeDraft(input);

      expect(result.experienceEntries[0]).toEqual({
        ...deterministicFallback.experienceEntries[0],
      });
      expect(result.fullText).toContain("Senior Frontend Engineer");
      expect(result.fullText).toContain("Acme Labs");
      expect(result.fullText).toContain(
        deterministicFallback.experienceEntries[0]?.dateRange ?? "",
      );
    } finally {
      restoreFetch();
    }
  });

  test("accepts evidence-linked professional rewrites while preserving canonical role identity", async () => {
    const canonicalSummary =
      "Directed platform reliability for customer-facing workflow systems.";
    const canonicalBullets = [
      "Improved production uptime from 99.5% to 99.9%.",
      "Reduced median API latency by 30% after profiling critical requests.",
    ];
    const rewrittenProfileSummary =
      "Platform reliability for customer-facing workflow systems.";
    const rewrittenRoleSummary =
      "Platform reliability: customer-facing workflow systems.";
    const rewrittenBullets = [
      "Production uptime improved from 99.5% to 99.9%.",
      "Median API latency reduced by 30% after profiling critical requests.",
    ];
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: {
                text: rewrittenProfileSummary,
                evidenceRefs: ["experience:experience_platform:summary"],
              },
              experienceEntries: [
                {
                  title: "Platform Engineer",
                  employer: "Acme Labs",
                  summary: {
                    text: rewrittenRoleSummary,
                    evidenceRefs: ["experience:experience_platform:summary"],
                  },
                  bullets: [
                    {
                      text: rewrittenBullets[0],
                      evidenceRefs: [
                        "experience:experience_platform:achievement:0",
                      ],
                    },
                    {
                      text: rewrittenBullets[1],
                      evidenceRefs: [
                        "experience:experience_platform:achievement:1",
                      ],
                    },
                  ],
                  profileRecordId: "experience_platform",
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const input = {
        profile: {
          ...createProfile(),
          skills: ["TypeScript", "Node.js"],
          proofBank: [],
          experiences: [
            {
              id: "experience_platform",
              companyName: "Acme Labs",
              companyUrl: null,
              title: "Platform Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2022-01",
              endDate: null,
              isCurrent: true,
              isDraft: false,
              summary: canonicalSummary,
              achievements: canonicalBullets,
              skills: ["TypeScript", "Node.js"],
              domainTags: ["platform reliability"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Platform Engineer",
          company: "ExampleCo",
          keySkills: ["TypeScript", "Node.js"],
        },
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["TypeScript", "Node.js"],
          keywords: ["TypeScript", "Node.js"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(result.summary).toBe(rewrittenProfileSummary);
      expect(result.experienceEntries[0]).toMatchObject({
        title: "Platform Engineer",
        employer: "Acme Labs",
        profileRecordId: "experience_platform",
        summary: rewrittenRoleSummary,
        bullets: rewrittenBullets,
      });
      expect(result.fullText).toContain(rewrittenProfileSummary);
      expect(result.fullText).toContain(rewrittenBullets[0]);
      expect(result.fullText).not.toContain(canonicalBullets[0]);
      expect(result.generationQuality).toEqual({
        strategy: "evidence_linked",
        proposedRewriteCount: 4,
        acceptedRewriteCount: 4,
        rejectedRewriteCount: 0,
        acceptedRewriteCharacters:
          rewrittenProfileSummary.length +
          rewrittenRoleSummary.length +
          rewrittenBullets.reduce((sum, bullet) => sum + bullet.length, 0),
      });
    } finally {
      restoreFetch();
    }
  });

  test("keeps fallback coverage entries when a model returns a partial experience list", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceEntries: [
                {
                  title: "Senior Frontend Engineer",
                  employer: "Atlas Product",
                  summary: "Model kept only the newest role.",
                  bullets: ["Model bullet for newest role."],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const baseProfile = createProfile();
      const input = {
        profile: {
          ...baseProfile,
          skills: ["React", "TypeScript", ".NET"],
          experiences: [
            {
              id: "experience_frontend",
              companyName: "Atlas Product",
              companyUrl: null,
              title: "Senior Frontend Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2022-01",
              endDate: null,
              isCurrent: true,
              isDraft: false,
              summary: "Builds React workflow products.",
              achievements: ["Built React workflow products for hiring teams."],
              skills: ["React", "TypeScript"],
              domainTags: ["frontend platform"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
            {
              id: "experience_dotnet",
              companyName: "CoreLedger",
              companyUrl: null,
              title: ".NET Developer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2019-01",
              endDate: "2021-12",
              isCurrent: false,
              isDraft: false,
              summary: "Built .NET APIs and web applications.",
              achievements: [
                "Improved API latency by 25% through cached .NET endpoints.",
              ],
              skills: [".NET", "C#"],
              domainTags: ["web applications"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Full-Stack Engineer",
          keySkills: ["React", ".NET"],
        },
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", ".NET"],
          keywords: ["React", ".NET"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_frontend", "experience_dotnet"]);
      // The model's wording for the role it wrote stands (ADR 0041); the
      // role it left out keeps its saved entry.
      expect(result.experienceEntries[0]).toMatchObject({
        profileRecordId: "experience_frontend",
        summary: "Model kept only the newest role.",
        bullets: ["Model bullet for newest role."],
      });
      expect(result.experienceEntries[1]).toMatchObject({
        profileRecordId: "experience_dotnet",
        employer: "CoreLedger",
      });
    } finally {
      restoreFetch();
    }
  });

  test("repairs model metadata mistakes and preserves imported role detail", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceEntries: [
                {
                  title: "Full-Stack Software Engineer",
                  employer: "NORTHLANE",
                  location: "Remote, Kosovo",
                  dateRange: "Remote, Kosovo | Present",
                  summary: "NORTHLANE Remote Kosovo Present",
                  bullets: ["React and WebSockets"],
                  profileRecordId: "experience_full_stack",
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const baseProfile = createProfile();
      const input = {
        profile: {
          ...baseProfile,
          skills: ["React", "TypeScript", "Next.js"],
          experiences: [
            {
              id: "experience_full_stack",
              companyName: "NORTHLANE",
              companyUrl: null,
              title: "Full-Stack Software Engineer",
              employmentType: null,
              location: "Remote, Kosovo",
              workMode: ["remote" as const],
              startDate: "2023-07",
              endDate: null,
              isCurrent: true,
              isDraft: false,
              summary:
                "Led hands-on product engineering across order, kitchen, and billing workflows.",
              achievements: [
                "Engineered a real-time restaurant order platform with React, Next.js, TailwindCSS & WebSockets, synchronizing POS and kitchen screens and eliminating manual order calls. Improved release confidence across kitchen workflows.",
                "Integrated car-repair parts tracking and service scheduling; reducing car-parts load time by 87% (15s to 2s); improving ordering logic aligned with safety protocols.",
              ],
              skills: ["React", "Next.js", "WebSockets"],
              domainTags: ["restaurant operations"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Full-Stack Engineer",
          keySkills: ["React", "Next.js"],
        },
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", "Next.js"],
          keywords: ["React", "Next.js"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(result.experienceEntries[0]).toMatchObject({
        profileRecordId: "experience_full_stack",
        dateRange: "Jul 2023 – Present",
        summary:
          "Led hands-on product engineering across order, kitchen, and billing workflows.",
      });
      expect(result.experienceEntries[0]?.bullets).toEqual([
        "Engineered a real-time restaurant order platform with React, Next.js, TailwindCSS & WebSockets, synchronizing POS and kitchen screens and eliminating manual order calls. Improved release confidence across kitchen workflows.",
        "Integrated car-repair parts tracking and service scheduling; reducing car-parts load time by 87% (15s to 2s); improving ordering logic aligned with safety protocols.",
      ]);
      expect(result.fullText).toContain("Remote, Kosovo | Jul 2023 – Present");
      expect(result.fullText).not.toContain("Remote, Kosovo | Present");
    } finally {
      restoreFetch();
    }
  });

  test("rejects unknown model profileRecordId values and restores reverse chronological fallback order", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceEntries: [
                {
                  title: ".NET Developer",
                  employer: "CoreLedger",
                  profileRecordId: "fake_id",
                  bullets: ["Model reordered older role first."],
                },
                {
                  title: "Senior Frontend Engineer",
                  employer: "Atlas Product",
                  bullets: ["Model omitted id for newest role."],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const baseProfile = createProfile();
      const input = {
        profile: {
          ...baseProfile,
          skills: ["React", "TypeScript", ".NET"],
          experiences: [
            {
              id: "experience_frontend",
              companyName: "Atlas Product",
              companyUrl: null,
              title: "Senior Frontend Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2022-01",
              endDate: null,
              isCurrent: true,
              isDraft: false,
              summary: "Builds React workflow products.",
              achievements: ["Built React workflow products for hiring teams."],
              skills: ["React", "TypeScript"],
              domainTags: ["frontend platform"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
            {
              id: "experience_dotnet",
              companyName: "CoreLedger",
              companyUrl: null,
              title: ".NET Developer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2019-01",
              endDate: "2021-12",
              isCurrent: false,
              isDraft: false,
              summary: "Built .NET APIs and web applications.",
              achievements: [
                "Improved API latency by 25% through cached .NET endpoints.",
              ],
              skills: [".NET", "C#"],
              domainTags: ["web applications"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Full-Stack Engineer",
          keySkills: ["React", ".NET"],
        },
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", ".NET"],
          keywords: ["React", ".NET"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_frontend", "experience_dotnet"]);
      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).not.toContain("fake_id");
      expect(result.experienceEntries[0]?.bullets).toEqual([
        "Model omitted id for newest role.",
      ]);
      // The entry with an unknown id is matched to its role by title and
      // employer; its wording stands like any other model line.
      expect(result.experienceEntries[1]?.bullets).toEqual([
        "Model reordered older role first.",
      ]);
    } finally {
      restoreFetch();
    }
  });

  test("ignores conflicting known profileRecordId values and rematches experience entries by content", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceEntries: [
                {
                  title: ".NET Developer",
                  employer: "CoreLedger",
                  profileRecordId: "experience_frontend",
                  bullets: ["Model swapped the older role id."],
                },
                {
                  title: "Senior Frontend Engineer",
                  employer: "Atlas Product",
                  profileRecordId: "experience_dotnet",
                  bullets: ["Model swapped the newer role id."],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const baseProfile = createProfile();
      const input = {
        profile: {
          ...baseProfile,
          skills: ["React", "TypeScript", ".NET"],
          experiences: [
            {
              id: "experience_frontend",
              companyName: "Atlas Product",
              companyUrl: null,
              title: "Senior Frontend Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2022-01",
              endDate: null,
              isCurrent: true,
              isDraft: false,
              summary: "Builds React workflow products.",
              achievements: ["Built React workflow products for hiring teams."],
              skills: ["React", "TypeScript"],
              domainTags: ["frontend platform"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
            {
              id: "experience_dotnet",
              companyName: "CoreLedger",
              companyUrl: null,
              title: ".NET Developer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2019-01",
              endDate: "2021-12",
              isCurrent: false,
              isDraft: false,
              summary: "Built .NET APIs and web applications.",
              achievements: [
                "Improved API latency by 25% through cached .NET endpoints.",
              ],
              skills: [".NET", "C#"],
              domainTags: ["web applications"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Full-Stack Engineer",
          keySkills: ["React", ".NET"],
        },
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", ".NET"],
          keywords: ["React", ".NET"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_frontend", "experience_dotnet"]);
      expect(result.experienceEntries[0]?.bullets).toEqual([
        "Built React workflow products for hiring teams.",
      ]);
      expect(result.experienceEntries[1]?.bullets).toEqual([
        "Improved API latency by 25% through cached .NET endpoints.",
      ]);
    } finally {
      restoreFetch();
    }
  });

  test("uses date ranges to match repeated title and employer stints", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceEntries: [
                {
                  title: "Software Engineer",
                  employer: "Orbit Commerce",
                  dateRange: "Jan 2019 – Dec 2021",
                  bullets: ["Model text for the older Orbit stint."],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const baseProfile = createProfile();
      const input = {
        profile: {
          ...baseProfile,
          experiences: [
            {
              id: "experience_orbit_new",
              companyName: "Orbit Commerce",
              companyUrl: null,
              title: "Software Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2022-01",
              endDate: "2024-02",
              isCurrent: false,
              isDraft: false,
              summary: "Newest Orbit stint.",
              achievements: ["Built modern workflow tooling."],
              skills: ["React"],
              domainTags: ["commerce"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
            {
              id: "experience_orbit_old",
              companyName: "Orbit Commerce",
              companyUrl: null,
              title: "Software Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2019-01",
              endDate: "2021-12",
              isCurrent: false,
              isDraft: false,
              summary: "Older Orbit stint.",
              achievements: ["Maintained legacy workflow tooling."],
              skills: ["TypeScript"],
              domainTags: ["commerce"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", "TypeScript"],
          keywords: ["React", "TypeScript"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_orbit_new", "experience_orbit_old"]);
      expect(result.experienceEntries[0]?.bullets).toEqual([
        "Built modern workflow tooling.",
      ]);
      expect(result.experienceEntries[1]?.bullets).toEqual([
        "Model text for the older Orbit stint.",
      ]);
    } finally {
      restoreFetch();
    }
  });

  test("matches semantically equivalent date-range formats across normalized inputs", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Tailored summary",
              experienceEntries: [
                {
                  title: "Software Engineer",
                  employer: "Orbit Commerce",
                  dateRange: "2019-01 – 2021-12",
                  bullets: ["Model text for the older Orbit stint."],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const baseProfile = createProfile();
      const input = {
        profile: {
          ...baseProfile,
          experiences: [
            {
              id: "experience_orbit_new",
              companyName: "Orbit Commerce",
              companyUrl: null,
              title: "Software Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2022-01",
              endDate: "2024-02",
              isCurrent: false,
              isDraft: false,
              summary: "Newest Orbit stint.",
              achievements: ["Built modern workflow tooling."],
              skills: ["React"],
              domainTags: ["commerce"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
            {
              id: "experience_orbit_old",
              companyName: "Orbit Commerce",
              companyUrl: null,
              title: "Software Engineer",
              employmentType: null,
              location: "Remote",
              workMode: ["remote" as const],
              startDate: "2019-01",
              endDate: "2021-12",
              isCurrent: false,
              isDraft: false,
              summary: "Older Orbit stint.",
              achievements: ["Maintained legacy workflow tooling."],
              skills: ["TypeScript"],
              domainTags: ["commerce"],
              peopleManagementScope: null,
              ownershipScope: null,
            },
          ],
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["React", "TypeScript"],
          keywords: ["React", "TypeScript"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      } satisfies Parameters<typeof client.createResumeDraft>[0];

      const result = await client.createResumeDraft(input);

      expect(result.experienceEntries[1]?.profileRecordId).toBe(
        "experience_orbit_old",
      );
      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_orbit_new", "experience_orbit_old"]);
      expect(result.experienceEntries[1]?.bullets).toEqual([
        "Model text for the older Orbit stint.",
      ]);
    } finally {
      restoreFetch();
    }
  });

  test("treats invalid ISO months as unknown for deterministic chronology", () => {
    const baseProfile = createProfile();
    const input = {
      profile: {
        ...baseProfile,
        experiences: [
          {
            id: "experience_invalid_month",
            companyName: "Future Invalid",
            companyUrl: null,
            title: "Software Engineer",
            employmentType: null,
            location: "Remote",
            workMode: ["remote" as const],
            startDate: "2024-13",
            endDate: null,
            isCurrent: false,
            isDraft: false,
            summary: "Invalid date should not sort first.",
            achievements: ["Invalid date achievement."],
            skills: ["React"],
            domainTags: ["platform"],
            peopleManagementScope: null,
            ownershipScope: null,
          },
          {
            id: "experience_valid_month",
            companyName: "Valid Systems",
            companyUrl: null,
            title: "Software Engineer",
            employmentType: null,
            location: "Remote",
            workMode: ["remote" as const],
            startDate: "2023-12",
            endDate: null,
            isCurrent: false,
            isDraft: false,
            summary: "Valid date should sort first.",
            achievements: ["Valid date achievement."],
            skills: ["TypeScript"],
            domainTags: ["platform"],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
      },
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: createJobPosting(),
      resumeText: "Resume text",
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: ["React", "TypeScript"],
        keywords: ["React", "TypeScript"],
      },
      researchContext: {
        companyNotes: [],
        domainVocabulary: [],
        priorityThemes: [],
      },
    } satisfies Parameters<typeof buildDeterministicStructuredResumeDraft>[0];

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(
      result.experienceEntries.map((entry) => entry.profileRecordId),
    ).toEqual(["experience_valid_month", "experience_invalid_month"]);
  });

  test("compacts oversized resume assistant payloads before sending them to the model", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              content: "No changes applied.",
              patches: [],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const oversizedRequest = `please improve this draft ${"grounded request detail ".repeat(5000)}`;

      await client.reviseResumeDraft({
        draft: {
          id: "draft_1",
          jobId: "job_1",
          status: "draft",
          templateId: "classic_ats",
          identity: null,
          sections: Array.from({ length: 12 }, (_, sectionIndex) => ({
            id: `section_${sectionIndex + 1}`,
            kind: "experience",
            label: `Section ${sectionIndex + 1}`,
            text: null,
            bullets: Array.from({ length: 12 }, (_, bulletIndex) => ({
              id: `section_bullet_${sectionIndex + 1}_${bulletIndex + 1}`,
              text: `Section bullet ${bulletIndex + 1} ${"resume detail ".repeat(120)}`,
              origin: "ai_generated",
              locked: false,
              included: true,
              sourceRefs: [],
              lastGeneratedContentHash: null,
              updatedAt: "2026-03-20T10:00:00.000Z",
            })),
            entries: Array.from({ length: 10 }, (_, entryIndex) => ({
              id: `entry_${sectionIndex + 1}_${entryIndex + 1}`,
              entryType: "experience",
              title: `Entry ${entryIndex + 1}`,
              subtitle: `Company ${entryIndex + 1}`,
              location: "Remote",
              dateRange: "2020 - Present",
              startDate: "2020",
              endDate: null,
              isCurrent: true,
              summary: `Entry summary ${"grounded detail ".repeat(160)}`,
              bullets: Array.from({ length: 10 }, (_, nestedBulletIndex) => ({
                id: `entry_bullet_${sectionIndex + 1}_${entryIndex + 1}_${nestedBulletIndex + 1}`,
                text: `Nested bullet ${nestedBulletIndex + 1} ${"impact detail ".repeat(120)}`,
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                lastGeneratedContentHash: null,
                updatedAt: "2026-03-20T10:00:00.000Z",
              })),
              origin: "ai_generated",
              locked: false,
              included: true,
              sortOrder: entryIndex,
              profileRecordId: null,
              sourceRefs: [],
              updatedAt: "2026-03-20T10:00:00.000Z",
            })),
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: sectionIndex,
            entryOrderMode: "chronology",
            profileRecordId: null,
            sourceRefs: [],
            updatedAt: "2026-03-20T10:00:00.000Z",
          })),
          targetPageCount: 2,
          workHistoryReviewAcknowledgments: [],
          claimConfirmations: [],
          issueApprovals: [],
          generationMethod: "ai",
          approvedAt: null,
          approvedExportId: null,
          staleReason: null,
          createdAt: "2026-03-20T10:00:00.000Z",
          updatedAt: "2026-03-20T10:00:00.000Z",
        },
        job: createJobPosting(),
        request: oversizedRequest,
        validationIssues: Array.from(
          { length: 20 },
          (_, index) => `Validation issue ${index + 1} ${"detail ".repeat(80)}`,
        ),
        researchContext: {
          companyNotes: Array.from(
            { length: 20 },
            (_, index) => `Company note ${index + 1} ${"context ".repeat(80)}`,
          ),
          domainVocabulary: Array.from(
            { length: 20 },
            (_, index) => `Vocabulary ${index + 1} ${"term ".repeat(40)}`,
          ),
          priorityThemes: Array.from(
            { length: 20 },
            (_, index) => `Theme ${index + 1} ${"priority ".repeat(40)}`,
          ),
        },
      });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        messages?: Array<{ content?: string }>;
      };
      const userPayload = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
        request?: string;
        draft?: { sections?: unknown[] };
        validationIssues?: unknown[];
      };

      expect(userPayload.request?.length ?? 0).toBeLessThan(
        oversizedRequest.length,
      );
      expect(userPayload.request).toContain("please improve this draft");
      expect(userPayload.request).toContain("[truncated");
      expect(userPayload.draft?.sections?.length).toBeLessThan(12);
      expect(
        userPayload.draft?.sections?.every((section) => {
          if (!section || typeof section !== "object") {
            return true;
          }

          return "entryOrderMode" in section;
        }),
      ).toBe(true);
      expect(userPayload.validationIssues?.length ?? 0).toBeLessThanOrEqual(12);
    } finally {
      fetchMock.restore();
    }
  });

  test("sends a lean evidence-linked rewrite request instead of asking the model to recreate the resume", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Tailored Resume",
              summary: "Short summary",
              experienceHighlights: ["Highlight"],
            }),
          },
        },
      ],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });

      await client.createResumeDraft({
        profile: {
          ...createProfile(),
          summary: `Profile summary ${"experience ".repeat(5000)}`,
        },
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          description: `Job description ${"requirement ".repeat(5000)}`,
          responsibilities: Array.from(
            { length: 20 },
            (_, index) => `Responsibility ${index + 1} ${"detail ".repeat(80)}`,
          ),
          minimumQualifications: Array.from(
            { length: 20 },
            (_, index) =>
              `Minimum qualification ${index + 1} ${"detail ".repeat(80)}`,
          ),
          preferredQualifications: Array.from(
            { length: 20 },
            (_, index) =>
              `Preferred qualification ${index + 1} ${"detail ".repeat(80)}`,
          ),
        },
        resumeText: `Resume text ${"history ".repeat(8000)}`,
        evidence: {
          summary: Array.from(
            { length: 20 },
            (_, index) =>
              `Summary evidence ${index + 1} ${"detail ".repeat(80)}`,
          ),
          candidateSummary: Array.from(
            { length: 20 },
            (_, index) =>
              `Candidate summary ${index + 1} ${"detail ".repeat(80)}`,
          ),
          experience: Array.from(
            { length: 20 },
            (_, index) =>
              `Experience evidence ${index + 1} ${"detail ".repeat(80)}`,
          ),
          skills: Array.from(
            { length: 20 },
            (_, index) => `Skill ${index + 1} ${"detail ".repeat(40)}`,
          ),
          keywords: Array.from(
            { length: 20 },
            (_, index) => `Keyword ${index + 1} ${"detail ".repeat(40)}`,
          ),
        },
        researchContext: {
          companyNotes: Array.from(
            { length: 20 },
            (_, index) => `Company note ${index + 1} ${"detail ".repeat(80)}`,
          ),
          domainVocabulary: Array.from(
            { length: 20 },
            (_, index) => `Vocabulary ${index + 1} ${"detail ".repeat(40)}`,
          ),
          priorityThemes: Array.from(
            { length: 20 },
            (_, index) => `Theme ${index + 1} ${"detail ".repeat(40)}`,
          ),
        },
      });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        messages?: Array<{ content?: string }>;
      };
      const userPayload = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
        profile?: unknown;
        settings?: unknown;
        searchPreferences?: unknown;
        resumeText?: unknown;
        evidence?: unknown;
        groundingEvidence?: {
          items?: Array<{ id?: string; text?: string }>;
          compaction?: { applied?: boolean };
        };
        researchContext?: { companyNotes?: unknown[] };
        targetJob?: { description?: string; title?: string; company?: string };
      };

      expect(userPayload).not.toHaveProperty("profile");
      expect(userPayload).not.toHaveProperty("settings");
      expect(userPayload).not.toHaveProperty("searchPreferences");
      expect(userPayload).not.toHaveProperty("resumeText");
      expect(userPayload).not.toHaveProperty("evidence");
      // Candidate-safe compaction keeps the original resume and imported
      // evidence ahead of generic profile items under item pressure.
      expect(
        userPayload.groundingEvidence?.items?.some(
          (item) => item.id === "baseResume:text" && Boolean(item.text),
        ),
      ).toBe(true);
      expect(
        userPayload.groundingEvidence?.items?.some(
          (item) => item.id === "importEvidence:summary:0",
        ),
      ).toBe(true);
      expect(userPayload.groundingEvidence?.compaction?.applied).toBe(true);
      expect(Array.isArray(userPayload.researchContext?.companyNotes)).toBe(
        true,
      );
      expect(userPayload.targetJob).toMatchObject({
        title: createJobPosting().title,
        company: createJobPosting().company,
      });
      expect(userPayload.targetJob?.description?.length ?? 0).toBeLessThan(
        `Job description ${"requirement ".repeat(5000)}`.length,
      );
      expect(body.messages?.[0]?.content).toContain(
        "Compose {} when the cited evidence is already as clear and professional",
      );
      expect(body.messages?.[0]?.content).not.toContain(
        "Return one JSON object",
      );
      expect(body.messages?.[0]?.content).toContain('"profileRecordId":"..."');
    } finally {
      fetchMock.restore();
    }
  });

  test("compacts oversized profile copilot payloads before sending them to the model", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              content: "No profile edits proposed.",
              patchGroups: [],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const request = `change my experience to only 5 years ${"conversation fact ".repeat(5000)}`;

      // The stub never calls a tool, so both runs stop without a change and
      // the Assistant reports that it could not finish; only the payload the
      // model received matters here.
      await client
        .reviseCandidateProfile({
          profile: {
            ...createProfile(),
            summary: `Candidate summary ${"background ".repeat(4000)}`,
          },
          searchPreferences: {
            ...createPreferences(),
            targetRoles: Array.from(
              { length: 20 },
              (_, index) => `Role ${index + 1} ${"detail ".repeat(40)}`,
            ),
            locations: Array.from(
              { length: 20 },
              (_, index) => `Location ${index + 1} ${"detail ".repeat(40)}`,
            ),
          },
          context: { surface: "profile", section: "preferences" },
          relevantReviewItems: Array.from({ length: 20 }, (_, index) => ({
            id: `review_${index + 1}`,
            step: "essentials",
            target: { domain: "identity", key: "headline", recordId: null },
            label: `Review item ${index + 1}`,
            reason: `Reason ${index + 1} ${"detail ".repeat(60)}`,
            severity: "recommended",
            status: "pending",
            proposedValue: `Proposed ${index + 1}`,
            sourceSnippet: `Snippet ${index + 1} ${"source ".repeat(40)}`,
            sourceCandidateId: `candidate_${index + 1}`,
            sourceRunId: `run_${index + 1}`,
            createdAt: "2026-04-14T10:00:00.000Z",
            resolvedAt: null,
          })),
          request,
          conversationFacts: Array.from(
            { length: 20 },
            (_, index) => `Fact ${index + 1} ${"detail ".repeat(80)}`,
          ),
        })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(ProfileCopilotUnfinishedError);
        });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        messages?: Array<{ content?: string }>;
      };
      const userPayload = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
        request?: string;
        conversationFacts?: unknown[];
        relevantReviewItems?: unknown[];
      };

      expect(userPayload.request?.length ?? 0).toBeLessThan(request.length);
      expect(userPayload.request).toContain(
        "change my experience to only 5 years",
      );
      expect(Array.isArray(userPayload.conversationFacts)).toBe(true);
      expect(Array.isArray(userPayload.relevantReviewItems)).toBe(true);
    } finally {
      fetchMock.restore();
    }
  });

  test("compacts 200k-token-class profile copilot payloads before provider submission", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              content: "Large request accepted.",
              patchGroups: [],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const massiveContext = "very long context detail ".repeat(70_000);
      const request = `change my experience to only 5 years ${massiveContext}`;
      const conversationFacts = Array.from(
        { length: 120 },
        (_, index) => `Fact ${index + 1} ${"supporting detail ".repeat(120)}`,
      );
      const relevantReviewItems: ProfileCopilotRelevantReviewItem[] =
        Array.from({ length: 120 }, (_, index) => ({
          id: `review_extreme_${index + 1}`,
          step: "essentials",
          target: { domain: "identity", key: "headline", recordId: null },
          label: `Extreme review item ${index + 1}`,
          reason: `Reason ${index + 1} ${"detail ".repeat(120)}`,
          severity: "recommended",
          status: "pending",
          proposedValue: `Proposed ${index + 1}`,
          sourceSnippet: `Snippet ${index + 1} ${"source ".repeat(80)}`,
          sourceCandidateId: `candidate_extreme_${index + 1}`,
          sourceRunId: `run_extreme_${index + 1}`,
          createdAt: "2026-04-14T10:00:00.000Z",
          resolvedAt: null,
        }));
      const largePayload = {
        profile: {
          ...createProfile(),
          summary: `Candidate summary ${"background ".repeat(80_000)}`,
        },
        searchPreferences: {
          ...createPreferences(),
          targetRoles: Array.from(
            { length: 120 },
            (_, index) => `Role ${index + 1} ${"detail ".repeat(80)}`,
          ),
          locations: Array.from(
            { length: 120 },
            (_, index) => `Location ${index + 1} ${"detail ".repeat(80)}`,
          ),
        },
        context: { surface: "profile", section: "preferences" },
        relevantReviewItems,
        request,
        conversationFacts,
      } satisfies Parameters<typeof client.reviseCandidateProfile>[0];
      const originalPayloadSize = JSON.stringify(largePayload).length;

      expect(originalPayloadSize).toBeGreaterThan(1_000_000);

      // The stub never calls a tool; see the test above.
      await client
        .reviseCandidateProfile(largePayload)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(ProfileCopilotUnfinishedError);
        });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        messages?: Array<{ content?: string }>;
      };
      const providerUserContent = body.messages?.[1]?.content ?? "";
      const compactedPayload = JSON.parse(providerUserContent) as {
        request?: string;
        conversationFacts?: unknown[];
        relevantReviewItems?: unknown[];
      };

      expect(providerUserContent.length).toBeLessThan(500_000);
      expect(providerUserContent.length).toBeLessThan(originalPayloadSize);
      expect(compactedPayload.request).toContain(
        "change my experience to only 5 years",
      );
      expect(compactedPayload.request).toContain("[truncated");
      expect(Array.isArray(compactedPayload.conversationFacts)).toBe(true);
      expect(Array.isArray(compactedPayload.relevantReviewItems)).toBe(true);
    } finally {
      fetchMock.restore();
    }
  });

});

test("the provider forwards parallel tool proposals and returns both in order", async () => {
  const mock = mockCapturingJsonFetch({
    choices: [
      {
        message: {
          tool_calls: ["first", "second"].map((id) => ({
            id,
            type: "function",
            function: {
              name: "type",
              arguments: JSON.stringify({ ref: id, text: "Synthetic value" }),
            },
          })),
        },
      },
    ],
  });
  try {
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "synthetic-model",
      label: "Synthetic AI",
    });
    const result = await client.chatWithTools(
      [{ role: "user", content: "Prepare the synthetic fields." }],
      [
        {
          type: "function",
          function: {
            name: "type",
            description: "Write one checked field",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      { parallelToolCalls: true },
    );
    const body: unknown = JSON.parse(mock.getCapturedBody());
    expect(body).toMatchObject({ parallel_tool_calls: true });
    expect(result.toolCalls?.map((call) => call.id)).toEqual([
      "first",
      "second",
    ]);
  } finally {
    mock.restore();
  }
});
