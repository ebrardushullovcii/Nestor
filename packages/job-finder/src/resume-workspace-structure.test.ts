import { describe, expect, test } from "vitest";
import type { TailoredResumeDraft } from "@nestor/ai-providers";
import type {
  ResumeDraft,
  WorkHistoryReviewAcknowledgment,
} from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";
import {
  buildResumeRenderDocument,
  buildResumeDraftFromTailoredDraft,
  buildTailoredResumeTextFromResumeDraft,
  seedResumeDraft,
} from "./internal/resume-workspace-structure";
import { createSeed } from "./profile-service.test-support";

describe("buildResumeRenderDocument", () => {
  test("keeps the candidate's own headline on the generated resume and gives experienced candidates two pages", () => {
    const seed = createSeed();
    const job = {
      ...seed.savedJobs[0]!,
      title: "JavaScript Frontend Developer",
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      profile: { ...seed.profile, yearsExperience: 7 },
      draft: {
        label: "Tailored Resume",
        summary: "JavaScript frontend developer with React experience.",
        experienceHighlights: [],
        coreSkills: ["JavaScript", "React"],
        targetedKeywords: ["JavaScript", "React"],
        experienceEntries: [],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "JavaScript frontend developer with React experience.",
        compatibilityScore: 80,
        notes: [],
      },
    });

    // The first line a recruiter reads names the candidate, not the posting:
    // graders read a posting title there as a claimed level or team.
    expect(draft.identity?.headline).toBe(seed.profile.headline);
    expect(
      buildResumeRenderDocument({ ...seed.profile, yearsExperience: 7 }, draft)
        .headline,
    ).toBe(seed.profile.headline);
    expect(draft.targetPageCount).toBe(2);
  });

  test("keeps the candidate's own headline when the listing title is board marketing", () => {
    const seed = createSeed();
    const job = {
      ...seed.savedJobs[0]!,
      title: "FULL TIME: Software Engineer Position - React and Rest",
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      profile: seed.profile,
      draft: {
        label: "Tailored Resume",
        summary: "Software engineer with React experience.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "Software engineer with React experience.",
        compatibilityScore: 70,
        notes: [],
      },
    });

    expect(draft.identity?.headline).toBe(seed.profile.headline);
  });

  test("filters quantified job requirements from model-shaped candidate keyword sections", () => {
    const seed = createSeed();
    const qualifications = [
      "Seven years of frontend experience",
      "6 months of accessibility testing",
    ];
    const job = {
      ...seed.savedJobs[0]!,
      minimumQualifications: qualifications,
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-08-30T10:04:00.000Z",
      generationMethod: "ai",
      profile: seed.profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: [...qualifications, "React"],
        experienceEntries: [],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: qualifications.join("\n"),
        compatibilityScore: 90,
        notes: [],
      },
    });
    const keywordSection = draft.sections.find(
      (section) => section.kind === "keywords",
    );
    const candidateText = buildTailoredResumeTextFromResumeDraft(
      seed.profile,
      job,
      draft,
    );

    expect(job.minimumQualifications).toEqual(qualifications);
    expect(keywordSection).toMatchObject({
      id: "section_keywords",
      included: false,
    });
    expect(keywordSection?.bullets.map((bullet) => bullet.text)).toEqual([
      "React",
    ]);
    expect(candidateText).not.toContain(qualifications[0]);
    expect(candidateText).not.toContain(qualifications[1]);
  });

  test("renders experience entry metadata with tailored entry content", () => {
    const seed = createSeed();
    const profile = seed.profile;
    const draft: ResumeDraft = {
      id: "resume_draft_job_ready",
      jobId: "job_ready",
      status: "draft",
      templateId: "classic_ats",
      identity: {
        fullName: profile.fullName,
        headline: profile.headline,
        location: profile.currentLocation,
        email: profile.email,
        phone: profile.phone,
        portfolioUrl: profile.portfolioUrl,
        linkedinUrl: profile.linkedinUrl,
        githubUrl: profile.githubUrl,
        personalWebsiteUrl: profile.personalWebsiteUrl,
        additionalLinks: [],
      },
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          text: null,
          bullets: [],
          entries: [
            {
              id: "experience_experience_1",
              entryType: "experience",
              title: "Senior systems designer",
              subtitle: "Signal Systems",
              location: "London, UK",
              dateRange: "2020-01 – Present",
              startDate: "2020-01",
              endDate: null,
              isCurrent: true,
              summary: "Tailored workflow platform summary.",
              bullets: [
                {
                  id: "experience_bullet_1",
                  text: "Tailored workflow platform impact.",
                  origin: "ai_generated",
                  locked: false,
                  included: true,
                  sourceRefs: [],
                  lastGeneratedContentHash: null,
                  updatedAt: "2026-03-20T10:04:00.000Z",
                },
              ],
              origin: "ai_generated",
              locked: false,
              included: true,
              sortOrder: 0,
              profileRecordId: "experience_1",
              sourceRefs: [],
              updatedAt: "2026-03-20T10:04:00.000Z",
            },
          ],
          origin: "ai_generated",
          locked: false,
          included: true,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: "2026-03-20T10:04:00.000Z",
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
      createdAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:04:00.000Z",
    };

    const document = buildResumeRenderDocument(profile, draft);

    expect(document.sections[0]?.entries[0]).toEqual({
      id: "experience_experience_1",
      title: "Senior systems designer",
      subtitle: "Signal Systems",
      location: "London, UK",
      dateRange: "Jan 2020 – Present",
      startDate: "2020-01",
      endDate: null,
      isCurrent: true,
      // A vertical bar reads as a lowercase "l" in the resume face, so the
      // entry meta uses a middot separator.
      heading:
        "Senior systems designer — Signal Systems · London, UK · Jan 2020 – Present",
      summary: "Tailored workflow platform summary.",
      bullets: [
        {
          id: "experience_bullet_1",
          text: "Tailored workflow platform impact.",
        },
      ],
    });
  });

  test("seedResumeDraft formats imported year-month ranges for recruiter-facing output", () => {
    const seed = createSeed();
    const draft = seedResumeDraft({
      profile: seed.profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });

    const experience = draft.sections.find(
      (section) => section.kind === "experience",
    )?.entries[0];

    expect(experience?.dateRange).toMatch(/^[A-Z][a-z]{2} \d{4} – Present$/);
    expect(experience?.startDate).toMatch(/^\d{4}-\d{2}$/);
    expect(experience?.endDate).toBeNull();
    expect(experience?.isCurrent).toBe(true);
    expect(draft.targetPageCount).toBe(1);
  });

  test("seedResumeDraft normalizes imported profile experience to newest-first chronology", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          id: "older_dotnet",
          title: ".NET Developer",
          startDate: "2016-01",
          endDate: "2018-08",
          isCurrent: false,
        },
        {
          ...seed.profile.experiences[0]!,
          id: "recent_dotnet",
          title: ".NET Developer",
          startDate: "2019-08",
          endDate: "2022-01",
          isCurrent: false,
        },
        {
          ...seed.profile.experiences[0]!,
          id: "current_platform",
          title: "Platform Engineer",
          startDate: "2023-07",
          endDate: null,
          isCurrent: true,
        },
      ],
    };

    const draft = seedResumeDraft({
      profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });
    const experienceEntries =
      draft.sections.find((section) => section.kind === "experience")
        ?.entries ?? [];
    const documentEntries =
      buildResumeRenderDocument(profile, draft).sections.find(
        (section) => section.kind === "experience",
      )?.entries ?? [];

    expect(experienceEntries.map((entry) => entry.profileRecordId)).toEqual([
      "current_platform",
      "recent_dotnet",
      "older_dotnet",
    ]);
    expect(experienceEntries.map((entry) => entry.sortOrder)).toEqual([
      0, 1, 2,
    ]);
    expect(documentEntries.map((entry) => entry.id)).toEqual(
      experienceEntries.map((entry) => entry.id),
    );
  });

  test("seedResumeDraft rebuilds from structured profile records instead of flat tailored previews", () => {
    const seed = createSeed();
    const draft = seedResumeDraft({
      profile: seed.profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      tailoredAsset: {
        ...seed.tailoredAssets[0]!,
        generationMethod: "ai_assisted",
        previewSections: [
          {
            heading: "Experience",
            lines: ["Untraceable preview role", "Invented preview claim."],
          },
        ],
      },
    });

    const experienceSection = draft.sections.find(
      (section) => section.kind === "experience",
    );

    expect(draft.status).toBe("draft");
    expect(experienceSection?.entries[0]?.profileRecordId).toBe(
      seed.profile.experiences[0]?.id,
    );
    expect(
      experienceSection?.bullets.some((bullet) =>
        bullet.text.includes("Untraceable preview"),
      ),
    ).toBe(false);
  });

  test("seedResumeDraft marks preview-only content as needing factual review", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [],
      projects: [],
      education: [],
      certifications: [],
    };
    const draft = seedResumeDraft({
      profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      tailoredAsset: {
        ...seed.tailoredAssets[0]!,
        generationMethod: "ai_assisted",
        previewSections: [
          {
            heading: "Summary",
            lines: ["Preview-only summary."],
          },
          {
            heading: "Experience",
            lines: ["Preview-only role", "Preview-only claim."],
          },
        ],
      },
    });

    expect(draft.status).toBe("needs_review");
    expect(
      draft.sections
        .flatMap((section) => section.entries)
        .every((entry) => entry.profileRecordId === null),
    ).toBe(true);
  });

  test("keeps legacy targeted keywords excluded from the candidate resume", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [],
      projects: [],
      education: [],
      certifications: [],
    };
    const draft = seedResumeDraft({
      profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      tailoredAsset: {
        ...seed.tailoredAssets[0]!,
        previewSections: [
          { heading: "Summary", lines: ["Profile summary."] },
          { heading: "Targeted Keywords", lines: ["React", "TypeScript"] },
        ],
      },
    });

    expect(
      draft.sections.find((section) => section.kind === "keywords"),
    ).toMatchObject({ included: false });
  });

  test("preserves bounded imported evidence refs beyond the first preview", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      baseResume: {
        ...seed.profile.baseResume,
        textContent: [
          "Alex Vanguard",
          "Senior systems designer",
          "Organization: Northwind Labs",
          "Recorded supply counts in a shared spreadsheet for weekly operations.",
          "High School Diploma, Central Academy",
        ].join("\n"),
      },
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-08-30T10:04:00.000Z",
      generationMethod: "ai",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: [],
        experienceEntries: [],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const importedRefs = draft.sections
      .find((section) => section.kind === "summary")
      ?.sourceRefs.filter((ref) => ref.sourceKind === "resume");

    expect(importedRefs?.length).toBeGreaterThan(1);
    expect(
      importedRefs?.every((ref) => (ref.snippet?.length ?? 0) <= 220),
    ).toBe(true);
    expect(
      importedRefs?.some((ref) => ref.snippet?.includes("Organization")),
    ).toBe(true);
    expect(
      importedRefs?.some((ref) => ref.snippet?.includes("High School Diploma")),
    ).toBe(true);
  });

  test("binds generated summary and skills to saved profile provenance", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      baseResume: { ...seed.profile.baseResume, textContent: null },
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-08-30T10:04:00.000Z",
      generationMethod: "ai",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: profile.summary ?? "Grounded summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: [],
        experienceEntries: [],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: profile.summary ?? "Grounded summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const summary = draft.sections.find(
      (section) => section.kind === "summary",
    );
    const skills = draft.sections.find(
      (section) => section.kind === "skills" && section.label === "Core Skills",
    );

    expect(
      summary?.sourceRefs.some((ref) => ref.sourceKind === "profile"),
    ).toBe(true);
    expect(skills?.sourceRefs.some((ref) => ref.sourceKind === "profile")).toBe(
      true,
    );
  });

  test("buildResumeDraftFromTailoredDraft keeps suggested-hidden guidance out of rendered resume content", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [
        ...seed.profile.experiences,
        {
          id: "experience_sales_bridge",
          companyName: "Bright Market",
          companyUrl: null,
          title: "Sales Operations Associate",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote" as const],
          startDate: "2019-01",
          endDate: "2020-01",
          isCurrent: false,
          isDraft: false,
          summary: "Coordinated customer operations reporting.",
          achievements: [
            "Prepared weekly pipeline reporting for account teams.",
          ],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [
          {
            title: "Senior systems designer",
            employer: "Signal Systems",
            location: "London, UK",
            dateRange: "Jan 2020 – Present",
            summary: "Built workflow systems.",
            bullets: ["Built workflow systems with React."],
            profileRecordId: seed.profile.experiences[0]?.id ?? "experience_1",
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [
          {
            profileRecordId: "experience_sales_bridge",
            classification: "suggested_hidden",
            careerFamilyFit: "weak",
            reasons: ["weak career-family fit"],
            reviewGuidance: [
              "Hidden by default for review: this role has a weaker career-family fit for the target job.",
            ],
            coversMeaningfulGap: false,
          },
        ],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const experienceSection = draft.sections.find(
      (section) => section.kind === "experience",
    );
    const hiddenEntry = experienceSection?.entries.find(
      (entry) => entry.profileRecordId === "experience_sales_bridge",
    );
    const document = buildResumeRenderDocument(profile, draft);

    expect(hiddenEntry).toMatchObject({
      included: false,
      title: "Sales Operations Associate",
    });
    expect(JSON.stringify(document)).not.toContain("weaker career-family fit");
    expect(JSON.stringify(document)).not.toContain(
      "Sales Operations Associate",
    );
  });

  test("buildResumeDraftFromTailoredDraft does not append original bullets after grounded rewrites", () => {
    const seed = createSeed();
    const experience = seed.profile.experiences[0]!;
    const groundedRewrite =
      "Led a cross-functional design-system rollout across core product surfaces.";
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-08-09T12:00:00.000Z",
      generationMethod: "ai",
      profile: seed.profile,
      draft: {
        label: "Tailored Resume",
        summary: seed.profile.summary ?? "Grounded summary.",
        experienceHighlights: [],
        coreSkills: seed.profile.skills,
        targetedKeywords: ["Design Systems"],
        experienceEntries: [
          {
            title: experience.title,
            employer: experience.companyName,
            location: experience.location,
            dateRange: "Jan 2020 – Present",
            summary: experience.summary,
            bullets: [groundedRewrite],
            bulletSourceAchievementIds: [
              [`experience:${experience.id}:achievement:0`],
            ],
            profileRecordId: experience.id,
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: groundedRewrite,
        compatibilityScore: 86,
        notes: [],
      },
    });

    const bullets =
      draft.sections
        .find((section) => section.kind === "experience")
        ?.entries[0]?.bullets.map((bullet) => bullet.text) ?? [];

    expect(bullets).toEqual([groundedRewrite]);
    expect(bullets).not.toContain(experience.achievements[0]);
  });

  test("buildResumeDraftFromTailoredDraft drops source bullets a combined line already covers", () => {
    const seed = createSeed();
    const experience = seed.profile.experiences[0]!;
    const firstClaim =
      "Led a cross-functional design-system rollout across core product surfaces.";
    const secondClaim =
      "Cut onboarding time for new engineers from three weeks to four days.";
    experience.achievements = [firstClaim, secondClaim];
    const combined =
      "Led a cross-functional design-system rollout across core product surfaces and cut onboarding time for new engineers from three weeks to four days.";
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-08-09T12:00:00.000Z",
      generationMethod: "ai",
      profile: seed.profile,
      draft: {
        label: "Tailored Resume",
        summary: seed.profile.summary ?? "Grounded summary.",
        experienceHighlights: [],
        coreSkills: seed.profile.skills,
        targetedKeywords: ["Design Systems"],
        experienceEntries: [
          {
            title: experience.title,
            employer: experience.companyName,
            location: experience.location,
            dateRange: "Jan 2020 - Present",
            summary: experience.summary,
            // The provider returned the merged line and both lines it merged.
            bullets: [combined, firstClaim, secondClaim],
            bulletSourceAchievementIds: [
              [
                `experience:${experience.id}:achievement:0`,
                `experience:${experience.id}:achievement:1`,
              ],
              [`experience:${experience.id}:achievement:0`],
              [`experience:${experience.id}:achievement:1`],
            ],
            profileRecordId: experience.id,
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: combined,
        compatibilityScore: 86,
        notes: [],
      },
    });

    const bullets =
      draft.sections
        .find((section) => section.kind === "experience")
        ?.entries[0]?.bullets.map((bullet) => bullet.text) ?? [];

    expect(bullets).toContain(combined);
    expect(bullets).not.toContain(firstClaim);
    expect(bullets).not.toContain(secondClaim);
  });

  test("buildResumeDraftFromTailoredDraft keeps every canonical job available in the editor", () => {
    const seed = createSeed();
    const primaryExperience = seed.profile.experiences[0]!;
    const profile = {
      ...seed.profile,
      experiences: [
        primaryExperience,
        {
          ...primaryExperience,
          id: "experience_omitted",
          title: "Earlier operations role",
          startDate: "2018-01",
          endDate: "2019-01",
          isCurrent: false,
        },
        {
          ...primaryExperience,
          id: "experience_missing_from_provider",
          title: "Earlier support role",
          startDate: "2016-01",
          endDate: "2017-01",
          isCurrent: false,
        },
      ],
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [
          {
            title: primaryExperience.title,
            employer: primaryExperience.companyName,
            location: primaryExperience.location,
            dateRange: "Jan 2020 – Present",
            summary: primaryExperience.summary,
            bullets: primaryExperience.achievements,
            profileRecordId: primaryExperience.id,
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [
          {
            profileRecordId: "experience_omitted",
            classification: "omitted",
            careerFamilyFit: "weak",
            reasons: ["weak fit"],
            reviewGuidance: ["Keep available for review."],
            coversMeaningfulGap: false,
          },
        ],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });

    const entries =
      draft.sections.find((section) => section.kind === "experience")
        ?.entries ?? [];

    expect(entries.map((entry) => entry.profileRecordId)).toEqual([
      primaryExperience.id,
      "experience_omitted",
      "experience_missing_from_provider",
    ]);
    expect(
      entries.find((entry) => entry.profileRecordId === "experience_omitted")
        ?.included,
    ).toBe(false);
    expect(
      entries.find(
        (entry) => entry.profileRecordId === "experience_missing_from_provider",
      )?.included,
    ).toBe(true);
  });

  test("buildResumeDraftFromTailoredDraft preserves imported dates and detail when tailored entries are thin", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          id: "experience_full_stack",
          title: "Full-Stack Software Engineer",
          companyName: "BRIDGEWAY L.L.C",
          location: "Hybrid, Kosovo",
          startDate: "2019-08",
          endDate: "2021-10",
          isCurrent: false,
          summary:
            "Supported and enhanced a comprehensive .NET desktop application for business management covering inventory, sales, tax documentation, POS, restaurant orders, car repair, and fuel-pump control.",
          achievements: [
            "Improved Inventory Management accuracy by integrating live sales data for reliable stock tracking.",
            "Automated invoice generation, reporting, and customer management workflows.",
          ],
        },
      ],
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "ai",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [
          {
            title: "Full-Stack Software Engineer",
            employer: "BRIDGEWAY L.L.C",
            location: "Hybrid, Kosovo",
            dateRange: "Hybrid, Kosovo",
            summary: null,
            bullets: [
              "Supported and enhanced a comprehensive .NET desktop application for business management covering inventory, sales, tax documentation, POS, restaurant orders, car repair, and fuel-pump control.",
            ],
            profileRecordId: "experience_full_stack",
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const entry = draft.sections
      .find((section) => section.kind === "experience")
      ?.entries.find(
        (item) => item.profileRecordId === "experience_full_stack",
      );

    expect(entry?.dateRange).toBe("Aug 2019 – Oct 2021");
    expect(entry?.startDate).toBe("2019-08");
    expect(entry?.endDate).toBe("2021-10");
    expect(entry?.isCurrent).toBe(false);
    expect(entry?.summary).toBe(profile.experiences[0]?.summary);
    expect(entry?.bullets.map((bullet) => bullet.text)).toEqual([
      "Supported and enhanced a comprehensive .NET desktop application for business management covering inventory, sales, tax documentation, POS, restaurant orders, car repair, and fuel-pump control.",
      "Improved Inventory Management accuracy by integrating live sales data for reliable stock tracking.",
      "Automated invoice generation, reporting, and customer management workflows.",
    ]);
  });

  test("buildResumeDraftFromTailoredDraft preserves profile-backed education and certification dates", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      certifications: [
        {
          id: "cert_aws",
          name: "AWS Certified Developer",
          issuer: "Amazon Web Services",
          issueDate: "2021-05",
          expiryDate: "2024-05",
          credentialUrl: null,
          isDraft: false,
        },
      ],
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "ai",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [],
        projectEntries: [],
        educationEntries: [
          {
            school: "Royal College of Art",
            degree: "MA",
            fieldOfStudy: "Design Products",
            location: "London, UK",
            dateRange: "London, UK",
            summary: null,
            profileRecordId: "education_1",
          },
        ],
        certificationEntries: [
          {
            name: "AWS Certified Developer",
            issuer: "Amazon Web Services",
            dateRange: "Amazon Web Services",
            profileRecordId: "cert_aws",
          },
        ],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const education = draft.sections
      .find((section) => section.kind === "education")
      ?.entries.find((entry) => entry.profileRecordId === "education_1");
    const certification = draft.sections
      .find((section) => section.kind === "certifications")
      ?.entries.find((entry) => entry.profileRecordId === "cert_aws");

    expect(education).toMatchObject({
      subtitle: "MA, Design Products",
      dateRange: "Sep 2012 – Jun 2014",
      startDate: "2012-09",
      endDate: "2014-06",
    });
    expect(certification).toMatchObject({
      dateRange: "May 2021 – May 2024",
      startDate: "2021-05",
      endDate: "2024-05",
    });
  });

  test("buildResumeDraftFromTailoredDraft canonicalizes profile-backed metadata and preserves complete imported facts", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          id: "experience_operations_system",
          title: "Operations Systems Engineer",
          companyName: "NORTHLANE",
          location: "Remote, Kosovo",
          startDate: "01/07/2023",
          endDate: null,
          isCurrent: true,
          summary:
            "Led hands-on product engineering across order, kitchen, and billing workflows.",
          achievements: [
            "Project Lead (React, Next.js) – QA Management System",
            "Engineered a real-time restaurant order platform with React, Next.js, TailwindCSS & WebSockets, synchronizing POS and kitchen screens and eliminating manual order calls. Improved release confidence across kitchen workflows.",
            "Integrated car-repair parts tracking and service scheduling; reducing car-parts load time by 87% (15s to 2s); improving ordering logic aligned with safety protocols.",
          ],
        },
      ],
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "ai",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React", "Next.js"],
        targetedKeywords: ["React"],
        experienceEntries: [
          {
            title: "Generated Principal Platform Visionary",
            employer: "Generated Employer Name",
            location: "Generated Location",
            dateRange: "Remote, Kosovo | Present",
            summary: "NORTHLANE Remote Kosovo Present",
            bullets: ["React and WebSockets"],
            profileRecordId: "experience_operations_system",
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const entry = draft.sections
      .find((section) => section.kind === "experience")
      ?.entries.find(
        (item) => item.profileRecordId === "experience_operations_system",
      );

    expect(entry?.dateRange).toBe("Jul 2023 – Present");
    expect(entry?.title).toBe("Operations Systems Engineer");
    expect(entry?.subtitle).toBe("NORTHLANE");
    expect(entry?.location).toBe("Remote, Kosovo");
    expect(entry?.startDate).toBe("01/07/2023");
    expect(entry?.endDate).toBeNull();
    expect(entry?.isCurrent).toBe(true);
    expect(entry?.summary).toBe(
      "Led hands-on product engineering across order, kitchen, and billing workflows.",
    );
    expect(entry?.bullets.map((bullet) => bullet.text)).toEqual([
      "React and WebSockets",
      ...profile.experiences[0]!.achievements,
    ]);
  });

  test("buildResumeDraftFromTailoredDraft drops career-change meta from experience summaries", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          summary:
            "After deciding to return to my passion for development, I transitioned back into a hands-on role.",
        },
      ],
    };
    const profileExperience = profile.experiences[0]!;
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [
          {
            title: profileExperience.title,
            employer: profileExperience.companyName,
            location: profileExperience.location,
            dateRange: "Jan 2020 – Present",
            summary: "Remote, Kosovo",
            bullets: profileExperience.achievements,
            profileRecordId: profileExperience.id,
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const entry = draft.sections.find(
      (section) => section.kind === "experience",
    )?.entries[0];

    expect(entry?.summary).toBeNull();
    expect(entry?.bullets.length).toBeGreaterThan(0);
  });

  test("buildResumeDraftFromTailoredDraft chronologically reinserts suggested-hidden entries", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          id: "current_role",
          title: "Current role",
          startDate: "2023-07",
          endDate: null,
          isCurrent: true,
        },
        {
          ...seed.profile.experiences[0]!,
          id: "hidden_middle",
          title: "Hidden middle role",
          startDate: "2019-08",
          endDate: "2022-01",
          isCurrent: false,
        },
        {
          ...seed.profile.experiences[0]!,
          id: "older_role",
          title: "Older role",
          startDate: "2016-01",
          endDate: "2018-08",
          isCurrent: false,
        },
      ],
    };
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      profile,
      draft: {
        label: "Tailored Resume",
        summary: "Grounded software summary.",
        experienceHighlights: [],
        coreSkills: ["React"],
        targetedKeywords: ["React"],
        experienceEntries: [
          {
            title: "Older role",
            employer: "Example Co",
            location: "Remote",
            dateRange: "Jan 2016 - Aug 2018",
            summary: "Older summary.",
            bullets: ["Older impact."],
            profileRecordId: "older_role",
          },
          {
            title: "Current role",
            employer: "Example Co",
            location: "Remote",
            dateRange: "Jul 2023 - Present",
            summary: "Current summary.",
            bullets: ["Current impact."],
            profileRecordId: "current_role",
          },
        ],
        projectEntries: [],
        educationEntries: [],
        certificationEntries: [],
        coverageMetadata: [
          {
            profileRecordId: "hidden_middle",
            classification: "suggested_hidden",
            careerFamilyFit: "weak",
            reasons: ["weak fit"],
            reviewGuidance: ["Hidden for review."],
            coversMeaningfulGap: false,
          },
        ],
        additionalSkills: [],
        languages: [],
        fullText: "Grounded software summary.",
        compatibilityScore: 80,
        notes: [],
      },
    });
    const experienceEntries =
      draft.sections.find((section) => section.kind === "experience")
        ?.entries ?? [];

    expect(experienceEntries.map((entry) => entry.profileRecordId)).toEqual([
      "current_role",
      "hidden_middle",
      "older_role",
    ]);
    expect(
      experienceEntries.find(
        (entry) => entry.profileRecordId === "hidden_middle",
      )?.included,
    ).toBe(false);
  });

  test("surfaces preferred links and project URLs without turning project skills into bullets", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      githubUrl: "https://github.com/alex-vanguard",
      personalWebsiteUrl: "https://alex.dev",
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredEmail: "apply@example.com",
        preferredLinkIds: ["link_case_study"],
      },
      links: [
        ...seed.profile.links,
        {
          id: "link_case_study",
          label: "Case Study",
          url: "https://alex.example.com/case-study",
          kind: "case_study" as const,
          isDraft: false,
        },
      ],
      projects: [
        {
          id: "project_workflow_os",
          name: "Workflow OS",
          projectType: "product",
          summary: "Scaled a workflow design system.",
          role: "Design lead",
          skills: ["Figma", "React"],
          outcome: "Reduced release churn.",
          projectUrl: "https://alex.example.com/workflow-os",
          repositoryUrl: "https://github.com/alex-vanguard/workflow-os",
          caseStudyUrl: "https://alex.example.com/workflow-os-case-study",
        },
      ],
    };
    const draft = seedResumeDraft({
      profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });
    const document = buildResumeRenderDocument(profile, draft);
    const project = document.sections.find(
      (section) => section.kind === "projects",
    )?.entries[0];

    expect(document.contactItems).toEqual([
      { field: "email", text: "apply@example.com" },
      { field: "phone", text: "+44 7700 900123" },
      { field: "portfolioUrl", text: "https://alex.example.com" },
      { field: "personalWebsiteUrl", text: "https://alex.dev" },
      { field: "githubUrl", text: "https://github.com/alex-vanguard" },
      {
        field: "linkedinUrl",
        text: "https://www.linkedin.com/in/alex-vanguard",
      },
      { field: "additionalLinks", text: "https://alex.example.com/case-study" },
    ]);
    expect(project).toEqual({
      id: "project_project_workflow_os",
      title: "Workflow OS",
      subtitle: "Design lead",
      location: "https://alex.example.com/workflow-os-case-study",
      dateRange: null,
      startDate: null,
      endDate: null,
      isCurrent: false,
      heading:
        "Workflow OS — Design lead · https://alex.example.com/workflow-os-case-study",
      summary:
        "Scaled a workflow design system. Reduced release churn. Technologies: Figma, React.",
      bullets: [],
    });
  });

  test("prefers draft identity fields over the base profile for resume header rendering", () => {
    const seed = createSeed();
    const profile = seed.profile;
    const draft = seedResumeDraft({
      profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });

    const document = buildResumeRenderDocument(profile, {
      ...draft,
      identity: {
        ...(draft.identity ?? {
          fullName: null,
          headline: null,
          location: null,
          email: null,
          phone: null,
          portfolioUrl: null,
          linkedinUrl: null,
          githubUrl: null,
          personalWebsiteUrl: null,
          additionalLinks: [],
        }),
        fullName: "Alex Tailored",
        headline: "Staff platform engineer",
        location: "Remote",
        email: "tailored@example.com",
        phone: "+1 555 0100",
      },
    });

    expect(document.fullName).toBe("Alex Tailored");
    expect(document.headline).toBe("Staff platform engineer");
    expect(document.location).toBe("Remote");
    expect(document.contactItems[0]).toEqual({
      field: "email",
      text: "tailored@example.com",
    });
    expect(document.contactItems[1]).toEqual({
      field: "phone",
      text: "+1 555 0100",
    });
  });
});

describe("buildResumeDraftFromTailoredDraft work-history acknowledgment carry-forward", () => {
  const acknowledgedAt = "2026-03-20T09:00:00.000Z";
  const hiddenRoleGuidance = "Hidden for review.";

  const hiddenRoleMetadata: TailoredResumeDraft["coverageMetadata"][number] = {
    profileRecordId: "hidden_middle",
    classification: "suggested_hidden",
    careerFamilyFit: "weak",
    reasons: ["weak fit"],
    reviewGuidance: [hiddenRoleGuidance],
    coversMeaningfulGap: false,
  };

  function createTailoredDraft(
    coverageMetadata: TailoredResumeDraft["coverageMetadata"],
  ): TailoredResumeDraft {
    return {
      label: "Tailored Resume",
      summary: "Grounded software summary.",
      experienceHighlights: [],
      coreSkills: [],
      targetedKeywords: [],
      experienceEntries: [],
      projectEntries: [],
      educationEntries: [],
      certificationEntries: [],
      coverageMetadata,
      additionalSkills: [],
      languages: [],
      fullText: "Grounded software summary.",
      compatibilityScore: 80,
      notes: [],
    };
  }

  function createOmissionAcknowledgment(
    overrides?: Partial<WorkHistoryReviewAcknowledgment>,
  ): WorkHistoryReviewAcknowledgment {
    return {
      id: "work_history_ack_hidden_middle_1",
      draftId: "resume_draft_job_ready",
      profileRecordId: "hidden_middle",
      kind: "weak_fit",
      action: "consider_showing",
      messageContentHash: fnv1a32(hiddenRoleGuidance),
      reason: "intentional_omission",
      acknowledgedAt,
      ...overrides,
    };
  }

  test("keeps an acknowledgment whose omission suggestion is reprojected identically", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const acknowledgment = createOmissionAcknowledgment({
      draftId: `resume_draft_${job.id}`,
    });
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      draft: createTailoredDraft([hiddenRoleMetadata]),
      previousWorkHistoryReviewAcknowledgments: [acknowledgment],
    });

    expect(draft.workHistoryReviewAcknowledgments).toEqual([acknowledgment]);
  });

  test("drops an acknowledgment when the regenerated guidance text changed", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      draft: createTailoredDraft([
        {
          ...hiddenRoleMetadata,
          reviewGuidance: ["Hidden for review after regeneration."],
        },
      ]),
      previousWorkHistoryReviewAcknowledgments: [
        createOmissionAcknowledgment({ draftId: `resume_draft_${job.id}` }),
      ],
    });

    expect(draft.workHistoryReviewAcknowledgments).toEqual([]);
  });

  test("drops an acknowledgment when the suggestion is no longer projected", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      draft: createTailoredDraft([
        { ...hiddenRoleMetadata, classification: "detailed" },
      ]),
      previousWorkHistoryReviewAcknowledgments: [
        createOmissionAcknowledgment({ draftId: `resume_draft_${job.id}` }),
      ],
    });

    expect(draft.workHistoryReviewAcknowledgments).toEqual([]);
  });

  test("keeps only acknowledgments bound to the regenerated draft id", () => {
    const seed = createSeed();
    const currentAck = createOmissionAcknowledgment({
      draftId: "resume_draft_regenerated",
    });
    const staleDraftAck = createOmissionAcknowledgment({
      id: "work_history_ack_hidden_middle_2",
      draftId: "resume_draft_previous_generation",
    });
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      existingDraftId: "resume_draft_regenerated",
      draft: createTailoredDraft([hiddenRoleMetadata]),
      previousWorkHistoryReviewAcknowledgments: [staleDraftAck, currentAck],
    });

    expect(draft.workHistoryReviewAcknowledgments).toEqual([currentAck]);
  });

  test("still resets to no acknowledgments when none are carried in", () => {
    const seed = createSeed();
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "deterministic",
      draft: createTailoredDraft([hiddenRoleMetadata]),
    });

    expect(draft.workHistoryReviewAcknowledgments).toEqual([]);
  });
});

test("education graduation-only dates keep unknown starts empty", () => {
  const seed = createSeed();
  const education = {
    ...seed.profile.education[0]!,
    id: "student",
    schoolName: "Example University",
    degree: "MSc",
    startDate: null,
    endDate: "2027-03",
    summary: "Expected graduation March 2027",
    isDraft: false,
  };
  const draft = buildResumeDraftFromTailoredDraft({
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
    createdAt: "2026-10-02T10:00:00.000Z",
    generationMethod: "ai",
    profile: { ...seed.profile, education: [education] },
    draft: {
      label: "Tailored Resume",
      summary: "",
      experienceHighlights: [],
      coreSkills: [],
      targetedKeywords: [],
      experienceEntries: [],
      projectEntries: [],
      educationEntries: [
        {
          school: education.schoolName,
          degree: education.degree,
          fieldOfStudy: null,
          location: null,
          dateRange: "March 2027",
          summary: education.summary,
          profileRecordId: education.id,
        },
      ],
      certificationEntries: [],
      coverageMetadata: [],
      additionalSkills: [],
      languages: [],
      fullText: "",
      compatibilityScore: 80,
      notes: [],
    },
  });
  const entry = draft.sections.find((section) => section.kind === "education")
    ?.entries[0];
  expect(entry?.startDate).toBeNull();
  expect(entry?.endDate).toBe("2027-03");
  expect(entry?.summary).toBe("Expected graduation March 2027");
});

test("a source-linked model restatement keeps its wording without adding the source again", () => {
  const seed = createSeed();
  const edited =
    "Redesigned pension-app onboarding, lifting activation 23% in eight weeks.";
  const old =
    "Redesigned onboarding for a pensions app; activation up 23% in eight weeks.";
  const experience = {
    ...seed.profile.experiences[0]!,
    id: "designer",
    summary: old,
    achievements: [edited],
  };
  const profile = { ...seed.profile, experiences: [experience] };
  const draft = buildResumeDraftFromTailoredDraft({
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
    createdAt: "2026-10-02T10:00:00.000Z",
    generationMethod: "ai",
    profile,
    draft: {
      label: "Tailored Resume",
      summary: "",
      experienceHighlights: [],
      coreSkills: [],
      targetedKeywords: [],
      experienceEntries: [
        {
          title: experience.title,
          employer: experience.companyName,
          location: null,
          dateRange: null,
          summary: null,
          bullets: [old],
          bulletSourceAchievementIds: [
            [`experience:${experience.id}:achievement:0`],
          ],
          profileRecordId: experience.id,
        },
      ],
      projectEntries: [],
      educationEntries: [],
      certificationEntries: [],
      coverageMetadata: [],
      additionalSkills: [],
      languages: [],
      fullText: "",
      compatibilityScore: 80,
      notes: [],
    },
  });
  const entry = draft.sections.find((section) => section.kind === "experience")
    ?.entries[0];
  expect(entry?.bullets.map((bullet) => bullet.text)).toEqual([old]);
});

test("a degree that already names its field does not repeat it", () => {
  const seed = createSeed();
  const draft = buildResumeDraftFromTailoredDraft({
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
    createdAt: "2026-03-20T10:04:00.000Z",
    generationMethod: "ai",
    profile: seed.profile,
    draft: {
      label: "Tailored Resume",
      summary: "Grounded design summary.",
      experienceHighlights: [],
      coreSkills: ["Figma"],
      targetedKeywords: [],
      experienceEntries: [],
      projectEntries: [],
      educationEntries: [
        {
          school: "Central Saint Martins",
          degree: "BA (Hons) Graphic Communication Design",
          fieldOfStudy: "Graphic Communication Design",
          location: null,
          dateRange: "2015",
          summary: null,
          profileRecordId: null,
        },
      ],
      certificationEntries: [],
      coverageMetadata: [],
      additionalSkills: [],
      languages: [],
      fullText: "Grounded design summary.",
      compatibilityScore: 80,
      notes: [],
    },
  });

  expect(
    draft.sections.find((section) => section.kind === "education")?.entries[0]
      ?.subtitle,
  ).toBe("BA (Hons) Graphic Communication Design");
});

test.each([false, true])(
  "German restatements cover each source once even with overlapping combined lines (%s)",
  async (overlap) => {
    const { completeTailoredResumeDraft } =
      await import("@nestor/ai-providers");
    const { applyResumeLanguage, collectResumeLanguageFields } =
      await import("./internal/resume-workspace-language");
    const seed = createSeed();
    const experience = seed.profile.experiences[0]!;
    experience.achievements = [
      "Reduced picking errors by 38%.",
      "Trained 12 colleagues.",
    ];
    seed.profile.spokenLanguages = [
      {
        id: "de",
        language: "German",
        proficiency: "C1",
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
    seed.profile.certifications = [
      {
        id: "first_aid",
        name: "First aid",
        issuer: "Example Training",
        issueDate: "2025",
        expiryDate: null,
        credentialUrl: null,
        isDraft: false,
      },
    ];
    const tailored = completeTailoredResumeDraft(
      {
        experienceEntries: [
          {
            profileRecordId: experience.id,
            bullets: [
              {
                text: "Kommissionierfehler um 38 % reduziert.",
                evidenceRefs: [`experience:${experience.id}:achievement:0`],
                sourceAchievementIds: [
                  `experience:${experience.id}:achievement:0`,
                ],
              },
              ...(overlap
                ? [
                    {
                      text: "Kommissionierfehler um 38 % reduziert und 12 Kollegen geschult.",
                      evidenceRefs: [
                        `experience:${experience.id}:achievement:0`,
                        `experience:${experience.id}:achievement:1`,
                      ],
                      sourceAchievementIds: [
                        `experience:${experience.id}:achievement:0`,
                        `experience:${experience.id}:achievement:1`,
                      ],
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      {
        profile: seed.profile,
        job: seed.savedJobs[0]!,
        settings: seed.settings,
        searchPreferences: seed.searchPreferences,
        resumeText: null,
      },
    );
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      profile: seed.profile,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-03-20T10:04:00.000Z",
      generationMethod: "ai",
      draft: tailored,
    });
    const role = draft.sections
      .find((section) => section.kind === "experience")!
      .entries.find((entry) => entry.profileRecordId === experience.id)!;
    expect(role.bullets.map((bullet) => bullet.text)).toEqual([
      "Kommissionierfehler um 38 % reduziert.",
      "Trained 12 colleagues.",
    ]);
    expect(
      role.bullets.flatMap((bullet) =>
        bullet.sourceRefs.map((ref) => ref.sourceId),
      ),
    ).toEqual(
      expect.arrayContaining([
        `experience:${experience.id}:achievement:0`,
        `experience:${experience.id}:achievement:1`,
      ]),
    );
    const fields = collectResumeLanguageFields(draft);
    expect(fields.map((field) => field.text)).toEqual(
      expect.arrayContaining([
        "German — C1",
        "English — B1",
        "Trained 12 colleagues.",
      ]),
    );
    expect(fields.some((field) => field.id.startsWith("certification_"))).toBe(
      true,
    );
    const retained = fields.find(
      (field) => field.text === "Trained 12 colleagues.",
    )!;
    const translated = applyResumeLanguage(draft, {
      language: "German",
      translations: [
        { id: retained.id, text: "12 Kollegen geschult." },
        { id: "section_languages:label", text: "Sprachen" },
        {
          id: draft.sections.find(
            (section) => section.id === "section_languages",
          )!.bullets[0]!.id,
          text: "Deutsch — C1",
        },
        {
          id: draft.sections.find(
            (section) => section.id === "section_languages",
          )!.bullets[1]!.id,
          text: "Englisch — B1",
        },
        { id: "certification_first_aid:title", text: "Erste Hilfe" },
      ],
    });
    const { sanitizeResumeDraft } =
      await import("./internal/resume-workspace-helpers");
    const sanitized = sanitizeResumeDraft({
      draft: translated,
      job: seed.savedJobs[0]!,
      profile: seed.profile,
    });
    expect(
      sanitized.sections
        .find((section) => section.id === "section_languages")
        ?.bullets.map((bullet) => bullet.text),
    ).toEqual(["Deutsch — C1", "Englisch — B1"]);
    expect(
      sanitized.sections.find((section) => section.kind === "certifications")
        ?.entries[0]?.title,
    ).toBe("Erste Hilfe");
    expect(
      translated.sections
        .find((section) => section.kind === "experience")!
        .entries.find((entry) => entry.id === role.id)!
        .bullets.map((bullet) => bullet.text),
    ).toEqual([
      "Kommissionierfehler um 38 % reduziert.",
      "12 Kollegen geschult.",
    ]);
  },
);
