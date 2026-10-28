import { describe, expect, test } from "vitest";
import {
  buildDeterministicResumeText,
  buildDeterministicStructuredResumeDraft,
  completeTailoredResumeDraft,
  composeDeterministicFullText,
} from "./index";
import {
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
} from "./test-fixtures";

describe("resume generation quality", () => {
  test("aggressive generation filters country fragments from extraction and model output and keeps proposed skills", () => {
    const skills = [
      "React",
      "TypeScript",
      "JavaScript",
      "Node.js",
      "CSS",
      "HTML",
      "Git",
      "SQL",
    ];
    const baseProfile = createProfile();
    const profile = {
      ...baseProfile,
      skills,
      skillGroups: {
        coreSkills: skills,
        tools: [],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
      },
      education: [
        {
          id: "education_synthetic",
          schoolName: "Example College",
          degree: "BSc",
          fieldOfStudy: "Computer Science",
          location: "New Zealand",
          startDate: "2016",
          endDate: "2020",
          isDraft: false,
          summary: null,
        },
      ],
    };
    const job = {
      ...createJobPosting(),
      location: "Remote",
      keySkills: ["TypeScript"],
      minimumQualifications: [
        "Must be authorized to work in the United States.",
        "Experience with Terraform required.",
      ],
    };
    const input = {
      profile,
      job,
      searchPreferences: {
        ...createPreferences(),
        tailoringMode: "aggressive" as const,
      },
      settings: createSettings(),
      resumeText: profile.baseResume.textContent,
    };
    for (const primary of [
      {},
      {
        coreSkills: [
          "United",
          "States",
          "United States",
          "Terraform",
          "TypeScript",
        ],
      },
    ]) {
      const draft = completeTailoredResumeDraft(primary, input);
      const generatedSkills = [...draft.coreSkills, ...draft.additionalSkills];
      // A skill the model proposed stays for the fact check (ADR 0041);
      // place names are never skills.
      if ("coreSkills" in primary) {
        expect(generatedSkills).toContain("Terraform");
      }
      expect(generatedSkills).not.toContain("United");
      expect(generatedSkills).not.toContain("States");
      expect(generatedSkills).not.toContain("United States");
    }
    const fallback = buildDeterministicStructuredResumeDraft(input);
    for (const token of ["United", "States"]) {
      expect([
        ...fallback.coreSkills,
        ...fallback.additionalSkills,
      ]).not.toContain(token);
    }
  });

  test("keeps the saved fallback summary while ordering skills and roles for the job", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      headline: "Senior Full-Stack Software Engineer",
      summary:
        "Senior full-stack engineer across React, Node.js, C#, .NET, SQL Server, AWS, and Azure.",
      yearsExperience: 7,
      skills: ["C#", ".NET", "React", "TypeScript", "JavaScript", "Node.js"],
      skillGroups: {
        ...baseProfile.skillGroups,
        coreSkills: [
          "C#",
          ".NET",
          "React",
          "TypeScript",
          "JavaScript",
          "Node.js",
        ],
      },
      experiences: [
        {
          id: "experience_frontend",
          companyName: "Product Studio",
          companyUrl: null,
          title: "Senior Full-Stack Software Engineer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2023-07",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Built product software with React and Node.js.",
          achievements: [
            "Built responsive React and Next.js interfaces that raised tablet task completion from 83% to 98%.",
            "Implemented Node.js API routes for real-time test execution.",
          ],
          skills: ["React", "Next.js", "TypeScript", "JavaScript", "Node.js"],
          domainTags: ["frontend"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_marketing",
          companyName: "Brand Studio",
          companyUrl: null,
          title: "Digital Marketing Manager",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["onsite"],
          startDate: "2017-01",
          endDate: "2018-01",
          isCurrent: false,
          isDraft: false,
          summary: "Managed advertising campaigns.",
          achievements: [
            "Grew social reach by 120% through advertising campaigns.",
          ],
          skills: ["Marketing"],
          domainTags: ["marketing"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
      projects: [
        {
          id: "project_cpp",
          name: "ClipVault",
          role: "Creator",
          summary: "Desktop video capture software.",
          outcome: null,
          skills: ["C++"],
          projectType: "personal",
          projectUrl: null,
          repositoryUrl: null,
          caseStudyUrl: null,
        },
        {
          id: "project_react",
          name: "ShowTracker",
          role: "Creator and frontend engineer",
          summary: "Cross-platform React Native entertainment tracker.",
          outcome: "Built responsive discovery and tracking interfaces.",
          skills: ["React Native", "TypeScript"],
          projectType: "personal",
          projectUrl: null,
          repositoryUrl: null,
          caseStudyUrl: null,
        },
      ],
    };
    const job = {
      ...createJobPosting(),
      title: "JavaScript Frontend Developer",
      keySkills: ["JavaScript", "React", "TypeScript", "Node.js"],
      responsibilities: ["Build responsive client-side applications"],
    };

    const result = buildDeterministicStructuredResumeDraft({
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job,
      resumeText: profile.baseResume.textContent,
    });

    expect(result.summary).toBe(profile.summary);
    expect(result.coreSkills.slice(0, 4)).toEqual([
      "JavaScript",
      "React",
      "TypeScript",
      "Node.js",
    ]);
    expect(result.projectEntries[0]?.profileRecordId).toBe("project_react");
    expect(result.coverageMetadata).toContainEqual(
      expect.objectContaining({
        profileRecordId: "experience_marketing",
        classification: "compact",
      }),
    );
  });

  test("keeps quantified job qualifications for matching while excluding them from deterministic candidate output", () => {
    const profile = createProfile();
    const qualifications = [
      "Seven years of frontend experience",
      "6 months of accessibility testing",
    ];
    const job = {
      ...createJobPosting(),
      title: "Senior Frontend Engineer",
      keySkills: ["React", "TypeScript"],
      minimumQualifications: qualifications,
    };
    const targetedKeywords = [...qualifications, "React"];
    const directText = buildDeterministicResumeText(
      profile,
      job,
      "Grounded frontend summary.",
      [],
      ["React"],
      targetedKeywords,
    );
    const composedText = composeDeterministicFullText({
      label: "Tailored Resume",
      summary: "Grounded frontend summary.",
      experienceHighlights: [],
      coreSkills: ["React"],
      targetedKeywords,
    });
    const result = buildDeterministicStructuredResumeDraft({
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job,
      resumeText: profile.baseResume.textContent,
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: ["React"],
        keywords: targetedKeywords,
      },
    });

    expect(job.minimumQualifications).toEqual(qualifications);
    expect(directText).toContain("Keywords: React");
    expect(composedText).toContain("Targeted keywords: React");

    for (const qualification of qualifications) {
      expect(result.targetedKeywords).not.toContain(qualification);
      expect(result.fullText).not.toContain(qualification);
      expect(directText).not.toContain(qualification);
      expect(composedText).not.toContain(qualification);
    }
  });

  test("never accepts model-authored employment metadata for a canonical role", () => {
    const baseProfile = createProfile();
    const canonicalExperience = {
      id: "experience_metadata",
      companyName: "Signal Systems",
      companyUrl: null,
      title: "Software Engineer",
      employmentType: "Full-time",
      location: "Remote",
      workMode: ["remote" as const],
      startDate: null,
      endDate: null,
      isCurrent: false,
      isDraft: false,
      summary: "Built reliable workflow tools.",
      achievements: ["Improved release reliability for operations teams."],
      skills: ["TypeScript"],
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    };
    const profile = {
      ...baseProfile,
      experiences: [canonicalExperience],
    };
    const input = {
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: createJobPosting(),
      resumeText: profile.baseResume.textContent,
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: profile.skills,
        keywords: [],
      },
      researchContext: {
        companyNotes: [],
        domainVocabulary: [],
        priorityThemes: [],
      },
    };

    const result = completeTailoredResumeDraft(
      {
        experienceEntries: [
          {
            profileRecordId: canonicalExperience.id,
            title: canonicalExperience.title,
            employer: canonicalExperience.companyName,
            location: "Dubai, UAE",
            dateRange: "Jan 2024 - Present",
            summary: canonicalExperience.summary,
            bullets: canonicalExperience.achievements,
          },
        ],
      },
      input,
    );

    expect(result.experienceEntries[0]).toMatchObject({
      profileRecordId: canonicalExperience.id,
      title: canonicalExperience.title,
      employer: canonicalExperience.companyName,
      location: "Remote",
      dateRange: null,
    });
  });

  test("uses coverage policy instead of silently capping work history at the first three roles", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      skills: ["React", "TypeScript", "C#", ".NET"],
      experiences: [
        {
          id: "experience_current_frontend",
          companyName: "Atlas Product",
          companyUrl: null,
          title: "Senior Frontend Engineer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2024-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Builds React product experiences for workflow teams.",
          achievements: ["Built React workspace flows used by product teams."],
          skills: ["React", "TypeScript"],
          domainTags: ["frontend platform"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_sales",
          companyName: "Bright Market",
          companyUrl: null,
          title: "Sales Associate",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2022-01",
          endDate: "2023-12",
          isCurrent: false,
          isDraft: false,
          summary:
            "Coordinated CRM workflow automation handoffs with engineering.",
          achievements: [
            "Helped account teams prepare renewal notes and automation handoff checklists.",
          ],
          skills: ["Automation"],
          domainTags: ["workflow operations"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_support",
          companyName: "CareDesk",
          companyUrl: null,
          title: "Customer Support Lead",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2020-01",
          endDate: "2021-12",
          isCurrent: false,
          isDraft: false,
          summary: "Coordinated support operations.",
          achievements: ["Documented customer escalation playbooks."],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_dotnet",
          companyName: "CoreLedger",
          companyUrl: null,
          title: ".NET Developer",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["hybrid"],
          startDate: "2018-01",
          endDate: "2019-12",
          isCurrent: false,
          isDraft: false,
          summary: "Built .NET web applications and API integrations.",
          achievements: [
            "Migrated .NET services and improved API response time by 25% using cached reads.",
          ],
          skills: [".NET", "C#", "SQL"],
          domainTags: ["web applications"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };

    const result = buildDeterministicStructuredResumeDraft({
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Senior Full-Stack Engineer",
        keySkills: ["React", ".NET", "TypeScript"],
      },
      resumeText: profile.baseResume.textContent,
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
    });

    expect(
      result.experienceEntries.map((entry) => entry.profileRecordId),
    ).toEqual([
      "experience_current_frontend",
      "experience_sales",
      "experience_support",
      "experience_dotnet",
    ]);
    expect(result.experienceEntries).toHaveLength(4);
    expect(result.experienceEntries[3]?.bullets).toEqual([
      "Migrated .NET services and improved API response time by 25% using cached reads.",
    ]);
    expect(result.coverageMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileRecordId: "experience_dotnet",
          classification: "compact",
          careerFamilyFit: "strong",
        }),
        expect.objectContaining({
          profileRecordId: "experience_sales",
          classification: "compact",
        }),
        expect.objectContaining({
          profileRecordId: "experience_support",
          classification: "compact",
        }),
      ]),
    );
  });

  test("all tailoring modes preserve grounded weak-fit roles without inventing technical claims", () => {
    const baseProfile = createProfile();
    const weakFitExperience = {
      id: "experience_ops_tooling",
      companyName: "OpsBridge",
      companyUrl: null,
      title: "Operations Coordinator",
      employmentType: "Full-time",
      location: "Remote",
      workMode: ["remote" as const],
      startDate: "2021-01",
      endDate: "2022-12",
      isCurrent: false,
      isDraft: false,
      summary:
        "Maintained workflow automation dashboards for support operations.",
      achievements: [
        "Built workflow automation dashboards that reduced manual QA checks by 30% using Airtable and SQL exports.",
      ],
      skills: ["SQL", "Automation"],
      domainTags: ["workflow automation"],
      peopleManagementScope: null,
      ownershipScope: null,
    };
    const profile: typeof baseProfile = {
      ...baseProfile,
      skills: ["React", "TypeScript", "SQL", "Automation"],
      experiences: [
        {
          ...weakFitExperience,
        },
      ],
    };
    const input = {
      profile,
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Frontend Engineer",
        keySkills: ["React", "TypeScript"],
      },
      resumeText: profile.baseResume.textContent,
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
    };

    const conservativeResult = buildDeterministicStructuredResumeDraft({
      ...input,
      searchPreferences: {
        ...createPreferences(),
        tailoringMode: "conservative" as const,
      },
    });
    const balancedResult = buildDeterministicStructuredResumeDraft({
      ...input,
      searchPreferences: createPreferences(),
    });

    expect(conservativeResult.experienceEntries[0]).toMatchObject({
      profileRecordId: "experience_ops_tooling",
      title: "Operations Coordinator",
      employer: "OpsBridge",
      bullets: [
        "Built workflow automation dashboards that reduced manual QA checks by 30% using Airtable and SQL exports.",
      ],
    });
    expect(conservativeResult.coverageMetadata[0]).toMatchObject({
      profileRecordId: "experience_ops_tooling",
      classification: "compact",
      careerFamilyFit: "weak",
    });
    expect(balancedResult.experienceEntries[0]).toMatchObject({
      profileRecordId: "experience_ops_tooling",
      title: "Operations Coordinator",
      employer: "OpsBridge",
    });
    expect(balancedResult.coverageMetadata[0]).toMatchObject({
      profileRecordId: "experience_ops_tooling",
      classification: "compact",
      careerFamilyFit: "weak",
    });
    expect(balancedResult.fullText).not.toMatch(
      /React.*OpsBridge|Frontend Engineer.*OpsBridge/,
    );
  });

  test("keeps usable canonical history compact across tailoring modes", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      experiences: [
        {
          id: "experience_technical_support",
          companyName: "BYTE BY BYTE",
          companyUrl: null,
          title: "Technical Support Agent",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["onsite"],
          startDate: "2017-05",
          endDate: "2017-11",
          isCurrent: false,
          isDraft: false,
          summary: "Resolved account and access questions for callers.",
          achievements: [
            "Escalated unresolved requests to the appropriate team.",
          ],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_call_center",
          companyName: "TREGI KOSOVO",
          companyUrl: null,
          title: "Call Center Agent",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["onsite"],
          startDate: "2016-03",
          endDate: "2017-04",
          isCurrent: false,
          isDraft: false,
          summary: "Answered inbound inquiries and routed follow-up requests.",
          achievements: [
            "Recorded outcomes and passed unresolved requests to supervisors.",
          ],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const input = {
      profile,
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Backend Engineer",
        summary: "Build reliable distributed services.",
        description: "Build reliable distributed services.",
        keySkills: ["Go", "Kubernetes"],
        responsibilities: ["Coordinate support handoffs for release teams."],
      },
      resumeText: profile.baseResume.textContent,
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: [],
        keywords: [],
      },
      researchContext: {
        companyNotes: [],
        domainVocabulary: [],
        priorityThemes: [],
      },
    };
    const balancedResult = buildDeterministicStructuredResumeDraft({
      ...input,
      searchPreferences: createPreferences(),
    });
    const aggressiveResult = buildDeterministicStructuredResumeDraft({
      ...input,
      searchPreferences: {
        ...createPreferences(),
        tailoringMode: "aggressive" as const,
      },
    });
    const conservativeResult = buildDeterministicStructuredResumeDraft({
      ...input,
      searchPreferences: {
        ...createPreferences(),
        tailoringMode: "conservative" as const,
      },
    });

    for (const result of [aggressiveResult]) {
      // Aggressive keeps the full history visible for continuity; hiding a
      // role either removed real experience or exported a title with no
      // bullets. The role stays compact instead.
      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_technical_support", "experience_call_center"]);
      expect(result.coverageMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            profileRecordId: "experience_technical_support",
            classification: "compact",
            careerFamilyFit: "weak",
          }),
          expect.objectContaining({
            profileRecordId: "experience_call_center",
            classification: "compact",
            careerFamilyFit: "unrelated",
          }),
        ]),
      );
    }

    for (const result of [balancedResult, conservativeResult]) {
      expect(
        result.experienceEntries.map((entry) => entry.profileRecordId),
      ).toEqual(["experience_technical_support", "experience_call_center"]);
      expect(result.coverageMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            profileRecordId: "experience_technical_support",
            classification: "compact",
            careerFamilyFit: "weak",
          }),
          expect.objectContaining({
            profileRecordId: "experience_call_center",
            classification: "compact",
            careerFamilyFit: "unrelated",
          }),
        ]),
      );
    }
  });

  test("preserves long career-pivot and contract history without adding unsupported claims", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      experiences: [
        {
          id: "experience_current_engineer",
          companyName: "Atlas Product",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2024-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Builds TypeScript workflow products.",
          achievements: ["Reduced release rollback time by 35%."],
          skills: ["TypeScript", "React"],
          domainTags: ["workflow software"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_contract_engineer",
          companyName: "Northstar Labs",
          companyUrl: null,
          title: "Contract Web Developer",
          employmentType: "Contract",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2022-05",
          endDate: "2023-12",
          isCurrent: false,
          isDraft: false,
          summary: "Delivered customer portals under a fixed-term contract.",
          achievements: ["Shipped three customer portals on schedule."],
          skills: ["JavaScript"],
          domainTags: ["web applications"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_freelance",
          companyName: "Independent",
          companyUrl: null,
          title: "Freelance Web Developer",
          employmentType: "Freelance",
          location: "Prishtina, Kosovo",
          workMode: ["hybrid"],
          startDate: "2021-01",
          endDate: "2022-04",
          isCurrent: false,
          isDraft: false,
          summary: "Maintained small-business websites.",
          achievements: [
            "Delivered accessible websites for four local clients.",
          ],
          skills: ["JavaScript"],
          domainTags: ["small business"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_customer_success",
          companyName: "CareDesk",
          companyUrl: null,
          title: "Customer Success Specialist",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["onsite"],
          startDate: "2019-01",
          endDate: "2020-12",
          isCurrent: false,
          isDraft: false,
          summary: "Supported onboarding and account adoption.",
          achievements: ["Documented onboarding answers for support teams."],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_operations",
          companyName: "City Logistics",
          companyUrl: null,
          title: "Operations Coordinator",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["onsite"],
          startDate: "2017-01",
          endDate: "2018-12",
          isCurrent: false,
          isDraft: false,
          summary: "Coordinated daily delivery schedules.",
          achievements: [
            "Reconciled daily delivery records for dispatch teams.",
          ],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_retail",
          companyName: "Market House",
          companyUrl: null,
          title: "Retail Associate",
          employmentType: null,
          location: null,
          workMode: [],
          startDate: null,
          endDate: null,
          isCurrent: false,
          isDraft: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const expectedRecordIds = [
      "experience_current_engineer",
      "experience_contract_engineer",
      "experience_freelance",
      "experience_customer_success",
      "experience_operations",
      "experience_retail",
    ];

    for (const tailoringMode of [
      "conservative",
      "balanced",
      "aggressive",
    ] as const) {
      const result = buildDeterministicStructuredResumeDraft({
        profile,
        searchPreferences: {
          ...createPreferences(),
          tailoringMode,
        },
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Senior Frontend Engineer",
          keySkills: ["React", "TypeScript"],
        },
        resumeText: profile.baseResume.textContent,
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
      });

      const visibleRecordIds = result.experienceEntries.map(
        (entry) => entry.profileRecordId,
      );
      expect(visibleRecordIds).toEqual(expectedRecordIds);
      if (tailoringMode === "aggressive") {
        expect(result.coverageMetadata).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              profileRecordId: "experience_operations",
              classification: "compact",
            }),
            expect.objectContaining({
              profileRecordId: "experience_retail",
              classification: "compact",
            }),
          ]),
        );
      }
      expect(
        result.experienceEntries.find(
          (entry) => entry.profileRecordId === "experience_contract_engineer",
        ),
      ).toMatchObject({
        title: "Contract Web Developer",
        employer: "Northstar Labs",
        bullets: ["Shipped three customer portals on schedule."],
      });
      if (tailoringMode === "conservative") {
        expect(
          result.experienceEntries.find(
            (entry) => entry.profileRecordId === "experience_retail",
          ),
        ).toMatchObject({
          title: "Retail Associate",
          employer: "Market House",
          summary: null,
          bullets: [],
        });
      }
      expect(result.fullText).not.toMatch(
        /React.*(?:CareDesk|City Logistics|Market House)/,
      );
    }
  });

  test("requires actual missing-month overlap before using weak roles as gap coverage", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      skills: ["React", "TypeScript", "SQL", "Automation"],
      experiences: [
        {
          id: "experience_current_frontend",
          companyName: "Atlas Product",
          companyUrl: null,
          title: "Senior Frontend Engineer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2024-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Builds React workflow products.",
          achievements: ["Built React workflow products."],
          skills: ["React", "TypeScript"],
          domainTags: ["frontend platform"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_boundary_touching_ops",
          companyName: "OpsBridge",
          companyUrl: null,
          title: "Operations Coordinator",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2023-12",
          endDate: "2023-12",
          isCurrent: false,
          isDraft: false,
          summary:
            "Maintained workflow automation dashboards for support operations.",
          achievements: [
            "Maintained workflow automation dashboards using SQL exports.",
          ],
          skills: ["SQL", "Automation"],
          domainTags: ["workflow automation"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_dotnet",
          companyName: "CoreLedger",
          companyUrl: null,
          title: ".NET Developer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2019-01",
          endDate: "2023-12",
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
    };

    const result = buildDeterministicStructuredResumeDraft({
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Full-Stack Engineer",
        keySkills: ["React", ".NET", "TypeScript"],
      },
      resumeText: profile.baseResume.textContent,
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
    });

    expect(result.coverageMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileRecordId: "experience_boundary_touching_ops",
          classification: "compact",
          coversMeaningfulGap: false,
        }),
      ]),
    );
    expect(
      result.experienceEntries.map((entry) => entry.profileRecordId),
    ).toContain("experience_boundary_touching_ops");
  });

  test("keeps visible skills grounded to the candidate instead of job-only terms", () => {
    const baseProfile = createProfile();
    const profile = {
      ...baseProfile,
      skills: ["React", "TypeScript"],
      skillGroups: {
        ...baseProfile.skillGroups,
        tools: ["Figma"],
      },
    };
    const input = {
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        company: "Northwind Labs",
        keySkills: [
          "React",
          "Northwind Labs",
          "Greenhouse",
          "Remote-first collaboration",
        ],
        benefits: ["Remote-first collaboration"],
        atsProvider: "Greenhouse",
      },
      resumeText: profile.baseResume.textContent,
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: ["React", "Northwind Labs", "Greenhouse"],
        keywords: ["React", "Greenhouse"],
      },
      researchContext: {
        companyNotes: [
          "Northwind Labs builds internal tooling for design teams.",
        ],
        domainVocabulary: ["workflow systems"],
        priorityThemes: ["platform ownership"],
      },
    };

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(result.coreSkills).toEqual(["React", "TypeScript"]);
    expect(result.additionalSkills).toEqual(["Figma"]);
    expect(result.targetedKeywords).toEqual(
      expect.arrayContaining(["React", "Greenhouse", "workflow systems"]),
    );
    expect(result.coreSkills).not.toEqual(
      expect.arrayContaining(["Northwind Labs", "Greenhouse"]),
    );
    expect(result.additionalSkills).not.toEqual(
      expect.arrayContaining(["Northwind Labs", "Remote-first collaboration"]),
    );
  });

  test("does not fall back to employer research prose for the candidate summary", () => {
    const baseProfile = createProfile();
    const profile = {
      ...baseProfile,
      headline: "Staff Frontend Engineer",
      yearsExperience: 9,
      professionalSummary: {
        ...baseProfile.professionalSummary,
        fullSummary: null,
      },
    };
    const input = {
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Staff Frontend Engineer",
        company: "Acme Cloud",
        keySkills: ["React", "TypeScript"],
      },
      resumeText: profile.baseResume.textContent,
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: ["React"],
        keywords: ["React"],
      },
      researchContext: {
        companyNotes: [
          "Acme Cloud is redefining enterprise workflow orchestration for distributed teams.",
        ],
        domainVocabulary: ["workflow orchestration"],
        priorityThemes: ["enterprise platform"],
      },
    };

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(result.summary).not.toContain(
      "Acme Cloud is redefining enterprise workflow orchestration",
    );
    expect(result.summary).toBe(input.profile.summary);
  });

  test("keeps saved fallback summary while cleaning role-level career-change meta", () => {
    const baseProfile = createProfile();
    const careerChangeMeta =
      "After deciding to return to my passion for development, I transitioned back into a hands-on developer role.";
    const profile: typeof baseProfile = {
      ...baseProfile,
      headline: "Senior Frontend Engineer",
      yearsExperience: 8,
      professionalSummary: {
        ...baseProfile.professionalSummary,
        fullSummary: careerChangeMeta,
      },
      experiences: [
        {
          id: "experience_frontend_return",
          companyName: "Atlas Product",
          companyUrl: null,
          title: "Senior Frontend Engineer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2023-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: careerChangeMeta,
          achievements: ["Built React workflow tools for product teams."],
          skills: ["React", "TypeScript"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };

    const result = buildDeterministicStructuredResumeDraft({
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Senior Frontend Engineer",
        keySkills: ["React", "TypeScript", "Unproven Job Keyword"],
      },
      resumeText: profile.baseResume.textContent,
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
    });

    expect(result.summary).toBe(profile.professionalSummary.fullSummary);
    expect(result.summary).not.toContain("Unproven Job Keyword");
    expect(result.experienceEntries[0]?.summary).toBeNull();
    expect(result.experienceEntries[0]?.bullets).toContain(
      "Built React workflow tools for product teams.",
    );
  });

  test("does not surface raw experience evidence as visible experience bullets", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      experiences: [
        {
          id: "experience_signal_systems",
          companyName: "Signal Systems",
          companyUrl: null,
          title: "Senior Frontend Engineer",
          employmentType: null,
          location: "Remote",
          workMode: ["remote"],
          startDate: "2022-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Led frontend delivery for workflow tooling.",
          achievements: ["Shipped recruiter-safe resume workflows."],
          skills: ["React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const rawEvidenceLine =
      "Signal Systems | Senior Frontend Engineer | Built resume tooling from raw imported evidence blobs and copied employer notes.";
    const input: Parameters<typeof buildDeterministicStructuredResumeDraft>[0] =
      {
        profile,
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Senior Frontend Engineer",
          company: "Northwind Labs",
        },
        resumeText: profile.baseResume.textContent,
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [rawEvidenceLine],
          skills: ["React"],
          keywords: ["React"],
        },
        researchContext: {
          companyNotes: ["Northwind Labs is hiring for workflow tooling."],
          domainVocabulary: ["workflow tooling"],
          priorityThemes: ["frontend platform"],
        },
      };

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(result.experienceHighlights).not.toContain(rawEvidenceLine);
    expect(result.fullText).not.toContain(rawEvidenceLine);
    expect(result.experienceEntries[0]?.summary).toBe(
      "Led frontend delivery for workflow tooling.",
    );
    expect(result.experienceEntries[0]?.bullets).toContain(
      "Shipped recruiter-safe resume workflows.",
    );
  });

  test("prefers stronger candidate summary evidence and avoids project skill-tag bullets", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      headline: "Senior systems designer",
      summary: "Builds resilient workflow systems and design tooling.",
      professionalSummary: {
        ...baseProfile.professionalSummary,
        shortValueProposition:
          "Systems-focused product designer for workflow platforms.",
        fullSummary:
          "Systems-focused product designer with 10 years of experience building workflow tools, design systems, and platform operating models.",
      },
      projects: [
        {
          id: "project_workflow_os",
          name: "Workflow OS",
          projectType: "product",
          summary: "Scaled an internal design system.",
          role: "Design lead",
          skills: ["Figma", "Design Systems", "Accessibility"],
          outcome: "Reduced release churn for operations teams.",
          projectUrl: null,
          repositoryUrl: null,
          caseStudyUrl: null,
        },
      ],
    };
    const input: Parameters<typeof buildDeterministicStructuredResumeDraft>[0] =
      {
        profile,
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Senior Product Designer",
          keySkills: ["Figma", "Design Systems", "Accessibility"],
        },
        resumeText: profile.baseResume.textContent,
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["Figma"],
          keywords: ["Figma", "Design Systems"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: ["workflow platforms"],
          priorityThemes: ["design systems"],
        },
      };

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(result.summary).toBe(
      "Systems-focused product designer with 10 years of experience building workflow tools, design systems, and platform operating models.",
    );
    expect(result.projectEntries[0]?.bullets).toEqual([]);
    expect(result.fullText).not.toContain("- Figma");
    expect(result.fullText).toContain(
      "Scaled an internal design system. Reduced release churn for operations teams.",
    );
  });

  test("adds grounded proof metrics while retaining the complete source achievement", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      proofBank: [
        {
          id: "proof_design_system_rollout",
          title: "Design-system rollout",
          claim:
            "Led design-system rollout across core product surfaces used by design and operations teams.",
          heroMetric:
            "Adoption reached 80% of core product surfaces within two quarters.",
          supportingContext:
            "Worked across product, engineering, and operations to standardize component and content patterns.",
          roleFamilies: ["product design", "design systems"],
          projectIds: [],
          linkIds: [],
        },
      ],
      experiences: [
        {
          id: "experience_orbit",
          companyName: "Orbit Commerce",
          companyUrl: null,
          title: "Senior systems designer",
          employmentType: "Full-time",
          location: "London, UK",
          workMode: ["hybrid"],
          startDate: "2020-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Builds resilient workflow tools.",
          achievements: ["Led design-system rollout across core surfaces."],
          skills: ["Figma", "Design Systems"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const input: Parameters<typeof buildDeterministicStructuredResumeDraft>[0] =
      {
        profile,
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Senior Product Designer",
          keySkills: ["Figma", "Design Systems"],
        },
        resumeText: profile.baseResume.textContent,
        evidence: {
          summary: [],
          candidateSummary: [],
          experience: [],
          skills: ["Figma"],
          keywords: ["Figma"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      };

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(result.experienceEntries[0]?.bullets[0]).toBe(
      "Led design-system rollout across core surfaces. Adoption reached 80% of core product surfaces within two quarters.",
    );
  });

  test("adds grounded proof supporting context when it strengthens flat experience bullets", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      proofBank: [
        {
          id: "proof_frontend_platform_context",
          title: "Frontend platform consolidation",
          claim:
            "Unified fragmented frontend foundations across product teams into a shared platform adoption program.",
          heroMetric:
            "Cut release regressions by 42% across three product lines in two quarters.",
          supportingContext:
            "Partnered with product, design, and platform engineering to standardize components, testing, and performance budgets.",
          roleFamilies: ["frontend engineering", "platform"],
          projectIds: [],
          linkIds: [],
        },
      ],
      experiences: [
        {
          id: "experience_frontend_platform",
          companyName: "Northstar Cloud",
          companyUrl: null,
          title: "Staff frontend engineer",
          employmentType: "Full-time",
          location: "Toronto, Canada",
          workMode: ["remote"],
          startDate: "2021-03",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary:
            "Leads frontend platform modernization across product teams.",
          achievements: [
            "Unified fragmented frontend foundations across product teams into a shared platform adoption program.",
            "Improved accessibility review coverage across customer-facing releases.",
          ],
          skills: ["React", "TypeScript", "Design Systems", "Playwright"],
          domainTags: ["frontend platform"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const input: Parameters<typeof buildDeterministicStructuredResumeDraft>[0] =
      {
        profile,
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          title: "Staff Frontend Engineer",
          keySkills: ["React", "TypeScript", "Accessibility", "Performance"],
        },
        resumeText: profile.baseResume.textContent,
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
      };

    const result = buildDeterministicStructuredResumeDraft(input);

    expect(result.experienceEntries[0]?.bullets).toEqual([
      "Unified fragmented frontend foundations across product teams into a shared platform adoption program. Cut release regressions by 42% across three product lines in two quarters.",
      "Improved accessibility review coverage across customer-facing releases.",
      "Partnered with product, design, and platform engineering to standardize components, testing, and performance budgets.",
    ]);
    expect(result.experienceEntries[0]?.dateRange).toBe("Mar 2021 – Present");
    expect(result.fullText).toContain("Toronto, Canada | Mar 2021 – Present");
    expect(result.fullText).not.toContain("2021-03 – Present");
  });

  test("ranks source-backed outcome bullets ahead of generic first-listed duties", () => {
    const baseProfile = createProfile();
    const profile: typeof baseProfile = {
      ...baseProfile,
      proofBank: [],
      experiences: [
        {
          id: "experience_delivery",
          companyName: "Signal Systems",
          companyUrl: null,
          title: "Software Engineer",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2022-01",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: "Delivered workflow software for operations teams.",
          achievements: [
            "Project Lead (React, Next.js) – QA Management System",
            "Adopted agile sprints and Trello boards.",
            "Reduced critical page load time by 87% from 15 seconds to 2 seconds.",
            "Collaborated with product and operations stakeholders.",
          ],
          skills: ["TypeScript", "React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };

    const result = buildDeterministicStructuredResumeDraft({
      profile,
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: {
        ...createJobPosting(),
        title: "Software Engineer",
        keySkills: ["TypeScript", "React"],
      },
      resumeText: profile.baseResume.textContent,
      evidence: {
        summary: [],
        candidateSummary: [],
        experience: [],
        skills: ["TypeScript", "React"],
        keywords: ["TypeScript", "React"],
      },
      researchContext: {
        companyNotes: [],
        domainVocabulary: [],
        priorityThemes: [],
      },
    });

    expect(result.experienceEntries[0]?.bullets[0]).toBe(
      "Reduced critical page load time by 87% from 15 seconds to 2 seconds.",
    );
    expect(result.experienceEntries[0]?.bullets).not.toContain(
      "Project Lead (React, Next.js) – QA Management System",
    );
  });
});

test("keeps achievement source IDs and all saved language proficiencies for translated drafts", () => {
  const profile = createProfile();
  profile.spokenLanguages = [
    {
      id: "de",
      language: "German",
      proficiency: "C1 (proficient user)",
      interviewPreference: false,
      notes: null,
    },
    {
      id: "en",
      language: "English",
      proficiency: "B1",
      interviewPreference: false,
      notes: null,
    },
  ];
  profile.experiences = [
    {
      id: "warehouse",
      companyName: "Example Logistics",
      companyUrl: null,
      title: "Warehouse lead",
      employmentType: null,
      location: null,
      workMode: [],
      startDate: "2020",
      endDate: null,
      isCurrent: true,
      isDraft: false,
      summary: null,
      achievements: ["Reduced picking errors by 38%."],
      skills: [],
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    },
  ];
  const experience = profile.experiences[0]!;
  const id = `experience:${experience.id}:achievement:0`;
  profile.proofBank = [
    {
      id: "errors",
      title: "Picking errors",
      claim: "Reduced picking errors across warehouse operations.",
      heroMetric: "Maintained the reduction for two years.",
      supportingContext: null,
      roleFamilies: [],
      projectIds: [],
      linkIds: [],
    },
  ];
  const builtIn = buildDeterministicStructuredResumeDraft({
    profile,
    job: createJobPosting(),
    settings: createSettings(),
    searchPreferences: createPreferences(),
    resumeText: null,
  });
  const builtInEntry = builtIn.experienceEntries.find(
    (entry) => entry.profileRecordId === experience.id,
  )!;
  expect(builtInEntry.bullets[0]).toContain("Reduced picking errors by 38%.");
  expect(builtInEntry.bulletSourceAchievementIds?.[0]).toEqual([id]);
  const draft = completeTailoredResumeDraft(
    {
      experienceEntries: [
        {
          profileRecordId: experience.id,
          bullets: [
            {
              text: "Kommissionierfehler um 38 % reduziert.",
              evidenceRefs: [id],
              sourceAchievementIds: [id],
            },
          ],
        },
      ],
    },
    {
      profile,
      job: createJobPosting(),
      settings: createSettings(),
      searchPreferences: createPreferences(),
      resumeText: null,
    },
  );
  expect(
    draft.experienceEntries.find(
      (entry) => entry.profileRecordId === experience.id,
    ),
  ).toMatchObject({ bulletSourceAchievementIds: [[id]] });
  expect(draft.languages).toEqual([
    "German — C1 (proficient user)",
    "English — B1",
  ]);
});
