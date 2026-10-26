import { describe, expect, test } from "vitest";

import type { ResumeDraft, ResumeDraftEntry } from "@nestor/contracts";
import {
  ResumeClaimConfirmationSchema,
  ResumeDraftSchema,
  resumeClaimOwnershipStatement,
} from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";
import {
  buildResumeCoverageComparison,
  buildResumeDraftContentHash,
  buildResumeDraftFromTailoredDraft,
  buildResumeRenderDocument,
  buildPreviewSectionsFromResumeDraft,
  buildTailoredResumeTextFromResumeDraft,
  hasBlockingResumeClaimAssessment,
  sanitizeResumeDraft,
  seedResumeDraft,
  resumeClaimContentHash,
  validateResumeDraft,
} from "./resume-workspace-helpers";

/** The model's verdicts on named lines, kept on the draft (ADR 0041). */
function withClaimChecks(
  draft: ResumeDraft,
  verdicts: Readonly<Record<string, "supported" | "stretch" | "unsupported">>,
  styles: Readonly<Record<string, string>> = {},
): ResumeDraft {
  return {
    ...draft,
    claimChecks: Object.entries(verdicts).map(([text, verdict]) => ({
      contentHash: resumeClaimContentHash(text),
      verdict,
      reason: "Test verdict.",
      evidenceIds: [],
      fix: null,
      style: styles[text] ?? null,
      evidenceKey: null,
      checkedAt: "2026-08-17T10:00:00.000Z",
    })),
  };
}
import { createEntry } from "./resume-workspace-primitives";
import { normalizeText } from "./shared";
import { createSeed } from "../profile-service.test-support";

function createBullets(prefix: string, texts: string[]) {
  return texts.map((text, index) => ({
    id: `${prefix}_${index + 1}`,
    text,
    origin: "ai_generated" as const,
    locked: false,
    included: true,
    sourceRefs: [],
    lastGeneratedContentHash: null,
    updatedAt: "2026-03-20T10:04:00.000Z",
  }));
}

function createBaseDraft(): ResumeDraft {
  return {
    id: "resume_draft_job_ready",
    jobId: "job_ready",
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [
      {
        id: "section_summary",
        kind: "summary",
        label: "Summary",
        text: "Grounded summary.",
        bullets: [],
        entries: [],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
      {
        id: "section_skills",
        kind: "skills",
        label: "Core Skills",
        text: null,
        bullets: createBullets("skill_bullet", ["Figma"]),
        entries: [],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 1,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt: "2026-03-20T10:04:00.000Z",
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
            title: "Senior systems designer",
            subtitle: "Orbit Commerce",
            location: "London, UK",
            dateRange: "2020-01 – Present",
            startDate: "2020-01",
            endDate: null,
            isCurrent: true,
            summary: "Builds resilient workflow tools.",
            bullets: createBullets("experience_bullet", [
              "Led design-system rollout across core surfaces.",
            ]),
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
        sortOrder: 2,
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
}

function updateSection(
  draft: ResumeDraft,
  sectionId: string,
  updater: (
    section: ResumeDraft["sections"][number],
  ) => ResumeDraft["sections"][number],
): ResumeDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.id === sectionId ? updater(section) : section,
    ),
  };
}

function getSection(draft: ResumeDraft, sectionId: string) {
  const section = draft.sections.find((entry) => entry.id === sectionId);

  if (!section) {
    throw new Error(`Missing section '${sectionId}' in test draft.`);
  }

  return section;
}

function getExperienceEntry(draft: ResumeDraft) {
  const experienceSection = getSection(draft, "section_experience");
  const entry = experienceSection.entries[0];

  if (!entry) {
    throw new Error("Expected an experience entry in the test draft.");
  }

  return entry;
}

function createDuplicateExperienceEntry(
  source: ResumeDraftEntry,
): ResumeDraftEntry {
  return {
    ...source,
    id: "experience_2",
    title: "Principal systems designer",
    bullets: createBullets("experience_duplicate", [
      "Led design-system rollout across core surfaces.",
    ]),
  };
}

function getSeedContext() {
  const seed = createSeed();
  const profile = seed.profile;
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready");

  if (!job) {
    throw new Error("job not found: job_ready");
  }

  return { profile, job };
}

describe("resume workspace quality helpers", () => {
  test("never calls the candidate's own verbatim sentence unsupported", () => {
    // The verifier was flagging lines lifted straight out of the person's own
    // imported resume. Whatever else it can say about such a line, it cannot
    // say the product invented it.
    const { profile, job } = getSeedContext();
    const ownSentence =
      "Architected a quantum operating model for global logistics teams.";
    const profileWithOwnSentence = {
      ...profile,
      baseResume: {
        ...profile.baseResume,
        textContent: `${profile.baseResume.textContent ?? ""}
${ownSentence}`,
      },
    };
    const draft = ResumeDraftSchema.parse({
      id: "resume_draft_own_verbatim",
      jobId: job.id,
      status: "draft",
      templateId: "classic_ats",
      generationMethod: "ai",
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          origin: "ai_generated",
          sortOrder: 0,
          entries: [
            {
              id: "entry_own_verbatim",
              entryType: "experience",
              title: "Senior systems designer",
              subtitle: "Signal Systems",
              origin: "ai_generated",
              sortOrder: 0,
              profileRecordId: "experience_1",
              bullets: [
                {
                  id: "bullet_own_verbatim",
                  text: ownSentence,
                  origin: "ai_generated",
                  updatedAt: "2026-08-17T10:00:00.000Z",
                },
              ],
              updatedAt: "2026-08-17T10:00:00.000Z",
            },
          ],
          updatedAt: "2026-08-17T10:00:00.000Z",
        },
      ],
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    });

    const withoutOwnResume = validateResumeDraft({
      draft,
      job,
      profile,
      validatedAt: "2026-08-17T10:00:00.000Z",
    });
    const withOwnResume = validateResumeDraft({
      draft,
      job,
      profile: profileWithOwnSentence,
      validatedAt: "2026-08-17T10:00:00.000Z",
    });

    expect(
      withoutOwnResume.claimAssessments.find(
        (assessment) => assessment.bulletId === "bullet_own_verbatim",
      ),
      // Not the person's own words and not yet checked by the model.
    ).toMatchObject({ status: "review" });
    expect(
      withOwnResume.claimAssessments.find(
        (assessment) => assessment.bulletId === "bullet_own_verbatim",
      ),
    ).toMatchObject({ status: "exact" });
  });

  test("sanitizeResumeDraft drops how-the-job-ended sentences from a generated summary", () => {
    const { profile, job } = getSeedContext();
    const draft = updateSection(
      createBaseDraft(),
      "section_summary",
      (section) => ({
        ...section,
        text: "Product designer focused on reliable workflow software. Position ended in a company-wide reduction in July 2026.",
      }),
    );

    const sanitized = sanitizeResumeDraft({ draft, job, profile });

    expect(getSection(sanitized, "section_summary").text).toBe(
      "Product designer focused on reliable workflow software.",
    );
  });

  test("sanitization keeps a place-like skill the person locked", () => {
    const { profile, job } = getSeedContext();
    const listingJob = {
      ...job,
      location: "United States",
      minimumQualifications: [
        "Must be authorized to work in the United States.",
      ],
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_skills",
      (section) => ({
        ...section,
        bullets: createBullets("skill_bullet", ["States", "United"]).map(
          (bullet) =>
            bullet.text === "States" ? { ...bullet, locked: true } : bullet,
        ),
      }),
    );
    const sanitized = sanitizeResumeDraft({ draft, job: listingJob, profile });
    expect(
      getSection(sanitized, "section_skills").bullets.map(
        (bullet) => bullet.text,
      ),
    ).toEqual(["States"]);
  });

  test("sanitization removes generated country and authorization entries, and keeps hidden skills out of exports", () => {
    const { profile, job } = getSeedContext();
    const listingJob = {
      ...job,
      location: "United States",
      keySkills: [...job.keySkills, "Terraform", "United", "States"],
      minimumQualifications: [
        "Must be authorized to work in the United States.",
        "Experience with Terraform required.",
      ],
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_skills",
      (section) => ({
        ...section,
        bullets: createBullets("skill_bullet", [
          "United",
          "States",
          "United States",
          "authorized to work in the United States",
          "Figma",
          "Terraform",
        ]).map((bullet) =>
          bullet.text === "Figma" || bullet.text === "United"
            ? { ...bullet, included: false }
            : bullet,
        ),
      }),
    );
    const sanitized = sanitizeResumeDraft({ draft, job: listingJob, profile });
    const bullets = getSection(sanitized, "section_skills").bullets;
    expect(bullets.map((bullet) => bullet.text)).toEqual([
      "Figma",
      "Terraform",
    ]);
    expect(bullets[0]).toMatchObject({ included: false });
    const skillsRender = buildResumeRenderDocument(
      profile,
      sanitized,
    ).sections.find((section) => section.kind === "skills");
    expect(skillsRender?.bullets.map((bullet) => bullet.text)).toEqual([
      "Terraform",
    ]);
    const preview = buildPreviewSectionsFromResumeDraft(sanitized).find(
      (section) => section.heading === "Core Skills",
    );
    expect(preview?.lines).toEqual(["Terraform"]);
    const exportedText = buildTailoredResumeTextFromResumeDraft(
      profile,
      listingJob,
      sanitized,
    );
    expect(exportedText).not.toMatch(/United|States|Figma/);
    const validation = validateResumeDraft({
      draft: sanitized,
      job: listingJob,
      profile,
    });
    expect(
      validation.claimAssessments.find(
        (claim) => claim.bulletId === bullets[1]?.id,
      ),
      // A listing skill the profile does not show waits for the model's
      // fact check (ADR 0041).
    ).toMatchObject({ status: "review" });
  });

  test("sanitizeResumeDraft keeps job-listing technologies in the skills section", () => {
    const { profile, job } = getSeedContext();
    const listingJob = {
      ...job,
      keySkills: [...job.keySkills, "Kubernetes"],
      minimumQualifications: [
        ...job.minimumQualifications,
        "Kubernetes experience required.",
      ],
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_skills",
      (section) => ({
        ...section,
        bullets: createBullets("skill_bullet", ["Kubernetes", "Figma"]),
      }),
    );

    const sanitized = sanitizeResumeDraft({ draft, job: listingJob, profile });
    const visibleSkills = getSection(sanitized, "section_skills").bullets.map(
      (bullet) => bullet.text,
    );

    expect(visibleSkills).toEqual(["Kubernetes", "Figma"]);
  });

  test("validateResumeDraft does not ask to confirm a listing skill the profile already has under an alias", () => {
    const { profile, job } = getSeedContext();
    const profileWithPostgres = {
      ...profile,
      skills: [...profile.skills, "PostgreSQL"],
      skillGroups: {
        ...profile.skillGroups,
        coreSkills: [...profile.skillGroups.coreSkills, "PostgreSQL"],
      },
    };
    const listingJob = {
      ...job,
      keySkills: [...job.keySkills, "Postgres"],
      description: `${job.description} Postgres required.`,
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_skills",
      (section) => ({
        ...section,
        bullets: createBullets("skill_bullet", ["Postgres"]),
      }),
    );

    const validation = validateResumeDraft({
      draft,
      job: listingJob,
      profile: profileWithPostgres,
    });

    expect(
      validation.claimAssessments.find(
        (assessment) => assessment.bulletId === "skill_bullet_1",
      ),
    ).toMatchObject({ status: "exact" });
  });

  test("sanitizeResumeDraft drops Europass language chrome from skills and languages", () => {
    const { profile, job } = getSeedContext();
    const profileWithLanguages = {
      ...profile,
      spokenLanguages: [
        ...profile.spokenLanguages,
        {
          id: "language_albanian",
          language: "Albanian",
          proficiency: "Native",
          interviewPreference: true,
          notes: null,
        },
      ],
    };
    const skillsDraft = updateSection(
      createBaseDraft(),
      "section_skills",
      (section) => ({
        ...section,
        bullets: createBullets("skill_bullet", [
          "Figma",
          "Mother Tongue(S) — ALBANIAN",
          "English — C2",
        ]),
      }),
    );
    const languageSection = {
      ...getSection(skillsDraft, "section_skills"),
      id: "section_languages",
      label: "Languages",
      bullets: createBullets("language_bullet", [
        "Albanian — Native",
        "Levels — A1 and A2: Basic user; B1 and B2: Independent user",
      ]),
    };
    const draft = {
      ...skillsDraft,
      sections: [...skillsDraft.sections, languageSection],
    };

    const sanitized = sanitizeResumeDraft({
      draft,
      job,
      profile: profileWithLanguages,
    });
    const visibleSkills = getSection(sanitized, "section_skills").bullets.map(
      (bullet) => bullet.text,
    );
    const visibleLanguages = getSection(
      sanitized,
      "section_languages",
    ).bullets.map((bullet) => bullet.text);

    expect(visibleSkills).toEqual(["Figma"]);
    expect(visibleLanguages).toEqual(["Albanian — Native"]);
  });

  test("sanitizeResumeDraft keeps a qualification-only listing technology in the skills section", () => {
    const { profile, job } = getSeedContext();
    const listingJob = {
      ...job,
      keySkills: job.keySkills,
      minimumQualifications: [
        ...job.minimumQualifications,
        "Hands-on experience with Terraform.",
      ],
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_skills",
      (section) => ({
        ...section,
        bullets: createBullets("skill_bullet", ["Terraform", "Figma"]),
      }),
    );

    const sanitized = sanitizeResumeDraft({ draft, job: listingJob, profile });
    const visibleSkills = getSection(sanitized, "section_skills").bullets.map(
      (bullet) => bullet.text,
    );

    expect(visibleSkills).toEqual(["Terraform", "Figma"]);
  });

  test("sanitizeResumeDraft keeps grounded spoken languages visible", () => {
    const { job } = getSeedContext();
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      spokenLanguages: [
        {
          id: "language_1",
          language: "English",
          proficiency: "Native",
          interviewPreference: false,
          notes: null,
        },
      ],
    };
    const draft = {
      ...createBaseDraft(),
      sections: [
        ...createBaseDraft().sections,
        {
          id: "section_languages",
          kind: "skills" as const,
          label: "Languages",
          text: null,
          bullets: createBullets("language_bullet", ["English — Native"]),
          entries: [],
          origin: "ai_generated" as const,
          locked: false,
          included: true,
          sortOrder: 3,
          entryOrderMode: "chronology" as const,
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: "2026-03-20T10:04:00.000Z",
        },
      ],
    };

    const sanitized = sanitizeResumeDraft({ draft, job, profile });

    expect(
      getSection(sanitized, "section_languages").bullets.map(
        (bullet) => bullet.text,
      ),
    ).toEqual(["English — Native"]);
  });

  test("sanitizing visible resume text preserves distinct non-Latin achievements", () => {
    const { profile, job } = getSeedContext();
    const achievements = [
      "Réconcilié les dossiers de Montréal.",
      "Připravila přehled příjmů.",
      "Συντόνισε την υποστήριξη πελατών.",
      "Координировала обслуживание клиентов.",
      "顧客対応と資料管理を担当しました。",
      "负责客户支持和文档管理。",
      "نسقت خدمة العملاء وحافظت على دقة السجلات.",
      "顧客 20 件を担当しました。",
      "資料 20 件を確認しました。",
    ];
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          summary: "正確な記録を維持しました。",
          bullets: createBullets("multilingual", [
            ...achievements,
            achievements[0]!.normalize("NFD"),
          ]).map((bullet) => ({ ...bullet, origin: "user_edited" as const })),
        })),
      }),
    );

    const entry = getExperienceEntry(
      sanitizeResumeDraft({ draft, job, profile }),
    );
    expect(entry.summary).toBe("正確な記録を維持しました。");
    expect(entry.bullets.map((bullet) => bullet.text)).toEqual(achievements);
  });

  test("sanitizeResumeDraft keeps grounded action bullets that include multiple commas", () => {
    const { profile, job } = getSeedContext();
    const actionBullet =
      "Partnered with product, design, and platform engineering to standardize components, testing, and performance budgets.";
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          bullets: createBullets("experience_bullet", [
            "Led design-system rollout across core surfaces.",
            actionBullet,
          ]),
        })),
      }),
    );

    const sanitized = sanitizeResumeDraft({ draft, job, profile });
    const visibleBullets = getExperienceEntry(sanitized).bullets.map(
      (bullet) => bullet.text,
    );

    expect(visibleBullets).toEqual([
      "Led design-system rollout across core surfaces.",
      actionBullet,
    ]);
  });

  test("sanitizeResumeDraft keeps a comma-rich summary supported by the profile", () => {
    const { profile, job } = getSeedContext();
    const supportedSummary =
      "Frontend engineer focused on React, TypeScript, testing, performance, and mentoring.";
    const groundedProfile = {
      ...profile,
      summary: supportedSummary,
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_summary",
      (section) => ({
        ...section,
        text: supportedSummary,
      }),
    );

    const sanitized = sanitizeResumeDraft({
      draft,
      job,
      profile: groundedProfile,
    });

    expect(getSection(sanitized, "section_summary").text).toBe(
      supportedSummary,
    );
    expect(getSection(sanitized, "section_summary").included).toBe(true);
  });

  test("sanitizeResumeDraft removes summary sentences that repeat visible experience bullets", () => {
    const { profile, job } = getSeedContext();
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          summary:
            "Led design-system rollout across core surfaces. Reduced median load time from 4.2 seconds to 1.9 seconds. Mentored four engineers through accessibility reviews.",
          bullets: createBullets("experience_summary_overlap", [
            "Led design-system rollout across core surfaces.",
            "Reduced median load time from 4.2 seconds to 1.9 seconds.",
          ]),
        })),
      }),
    );

    const sanitized = sanitizeResumeDraft({ draft, job, profile });
    const experienceEntry = getExperienceEntry(sanitized);

    expect(experienceEntry.summary).toBe(
      "Mentored four engineers through accessibility reviews.",
    );
    expect(experienceEntry.bullets.map((bullet) => bullet.text)).toEqual([
      "Led design-system rollout across core surfaces.",
      "Reduced median load time from 4.2 seconds to 1.9 seconds.",
    ]);
  });

  test("validateResumeDraft shows the checker's style note on a generated line (ADR 0041)", () => {
    const { profile, job } = getSeedContext();
    const keywordList =
      "React, TypeScript, Design Systems, Figma, Playwright, Accessibility, Testing";
    const filler =
      "Results-driven team player who thrives in fast-paced environments.";
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          bullets: createBullets("experience_validate", [keywordList, filler]),
        })),
      }),
    );

    const validation = validateResumeDraft({
      draft: withClaimChecks(
        draft,
        { [keywordList]: "supported", [filler]: "supported" },
        {
          [keywordList]:
            "This reads as a list of tools, not something you did.",
        },
      ),
      job,
      profile,
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "vague_filler",
          bulletId: "experience_validate_1",
          message: "This reads as a list of tools, not something you did.",
        }),
      ]),
    );
    // No word rule judges a line the checker did not note.
    expect(
      validation.issues.filter(
        (issue) =>
          issue.category === "vague_filler" &&
          issue.bulletId === "experience_validate_2",
      ),
    ).toEqual([]);
  });

  test("validateResumeDraft flags duplicate bullets and duplicate entry summaries", () => {
    const { profile, job } = getSeedContext();
    const duplicateEntry = createDuplicateExperienceEntry(
      getExperienceEntry(createBaseDraft()),
    );
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: [...section.entries, duplicateEntry],
      }),
    );

    const validation = validateResumeDraft({ draft, job, profile });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "duplicate_bullet",
          bulletId: "experience_duplicate_1",
        }),
        expect.objectContaining({
          category: "duplicate_section_content",
          entryId: "experience_2",
        }),
      ]),
    );
  });

  test("validateResumeDraft flags thin output when only a fragment remains", () => {
    const { profile, job } = getSeedContext();
    const draft = {
      ...createBaseDraft(),
      sections: [
        {
          ...getSection(createBaseDraft(), "section_summary"),
          text: "Brief summary.",
          bullets: [],
          entries: [],
          included: true,
        },
        {
          ...getSection(createBaseDraft(), "section_skills"),
          bullets: [],
          included: false,
        },
        {
          ...getSection(createBaseDraft(), "section_experience"),
          bullets: [],
          entries: [],
          included: false,
        },
      ],
    };

    const validation = validateResumeDraft({ draft, job, profile });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "thin_output",
        }),
      ]),
    );
  });

  test("validateResumeDraft notes preview-derived content without candidate traceability, without blocking", () => {
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
          { heading: "Summary", lines: ["Preview-only summary."] },
          {
            heading: "Experience",
            lines: ["Preview-only role", "Preview-only claim."],
          },
        ],
      },
    });

    const validation = validateResumeDraft({
      draft,
      job: seed.savedJobs[0]!,
      profile,
    });

    const factualReviewIssue = validation.issues.find(
      (issue) => issue.category === "low_confidence_fact",
    );
    expect(factualReviewIssue?.severity).toBe("info");
    expect(factualReviewIssue?.message).toMatch(
      /needs factual review before approval/i,
    );
  });

  test("fills a thin generation with saved work without adding search metadata", () => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const draft = buildResumeDraftFromTailoredDraft({
      job,
      templateId: seed.settings.resumeTemplateId,
      createdAt: "2026-08-30T10:04:00.000Z",
      generationMethod: "deterministic",
      profile: seed.profile,
      draft: {
        label: "Tailored Resume",
        summary: "A short generated summary.",
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
        fullText: "A short generated summary.",
        compatibilityScore: 40,
        notes: [],
      },
    });
    const summary = draft.sections.find(
      (section) => section.kind === "summary",
    );

    expect(summary?.bullets).toEqual([]);
    expect(summary?.text).not.toMatch(
      /target role|preferred location|core tools/i,
    );

    const validation = validateResumeDraft({
      draft,
      job,
      profile: seed.profile,
    });

    const factualReviewIssue = validation.issues.find(
      (issue) => issue.category === "low_confidence_fact",
    );
    expect(factualReviewIssue).toBeUndefined();
    expect(
      draft.sections
        .find((section) => section.kind === "experience")
        ?.entries.some((entry) => entry.included),
    ).toBe(true);
  });

  test("notes an untraceable generated summary when another section is grounded", () => {
    const { profile, job } = getSeedContext();
    const candidateSourceRef = {
      id: "resume_source_profile_summary",
      sourceKind: "profile" as const,
      sourceId: "profile:summary",
      snippet: profile.summary,
    };
    const baseDraft = createBaseDraft();
    const draft = {
      ...baseDraft,
      sections: baseDraft.sections.map((section) => ({
        ...section,
        text: section.kind === "summary" ? job.description : section.text,
        sourceRefs: section.kind === "summary" ? [] : [candidateSourceRef],
      })),
    };

    const validation = validateResumeDraft({ draft, job, profile });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "low_confidence_fact",
          severity: "info",
        }),
      ]),
    );
  });

  test("does not flag generated sections when every visible section has candidate grounding", () => {
    const { profile, job } = getSeedContext();
    const candidateSourceRef = {
      id: "resume_source_profile_summary",
      sourceKind: "profile" as const,
      sourceId: "profile:summary",
      snippet: profile.summary,
    };
    const baseDraft = createBaseDraft();
    const draft = {
      ...baseDraft,
      sections: baseDraft.sections.map((section) => ({
        ...section,
        text: section.kind === "summary" ? profile.summary : section.text,
        sourceRefs: [candidateSourceRef],
      })),
    };

    const validation = validateResumeDraft({ draft, job, profile });

    expect(
      validation.issues.some(
        (issue) => issue.category === "low_confidence_fact",
      ),
    ).toBe(false);
  });

  test("validateResumeDraft notes page overflow quietly, never as a blocker", () => {
    const { profile, job } = getSeedContext();
    const validation = validateResumeDraft({
      draft: createBaseDraft(),
      job,
      profile,
      pageCount: 3,
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "page_overflow",
          severity: "info",
        }),
      ]),
    );
  });

  test("validateResumeDraft uses the draft page target in overflow messaging", () => {
    const { profile, job } = getSeedContext();
    const validation = validateResumeDraft({
      draft: {
        ...createBaseDraft(),
        targetPageCount: 1,
      },
      job,
      profile,
      pageCount: 2,
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "page_overflow",
          severity: "info",
          message:
            "The resume runs to 2 pages; the target is 1. Hide lines you do not need, or keep it as it is.",
        }),
      ]),
    );
  });

  test("validateResumeDraft does not mutate user-included entry included flags even under page overflow", () => {
    const { profile, job } = getSeedContext();
    const userIncludedWeakFit = {
      ...getExperienceEntry(createBaseDraft()),
      id: "experience_user_included_gap_role",
      title: "Sales Operations Associate",
      subtitle: "Bright Market",
      summary: "Kept customer operations reporting concise.",
      included: true,
      profileRecordId: "experience_sales_bridge",
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: [...section.entries, userIncludedWeakFit],
      }),
    );
    const validation = validateResumeDraft({
      draft,
      job,
      profile,
      pageCount: 3,
    });

    expect(
      getSection(draft, "section_experience").entries.find(
        (entry) => entry.id === "experience_user_included_gap_role",
      )?.included,
    ).toBe(true);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "page_overflow",
          severity: "info",
        }),
      ]),
    );
  });

  test("createEntry removes near-duplicate long bullets without dropping short skills", () => {
    const entry = createEntry({
      id: "experience_net_migration",
      entryType: "experience",
      title: ".NET Developer",
      subtitle: "TERRA-NO",
      bullets: [
        "Assisted in migrating a web-based ERP system from .NET Framework to .NET Core MVC, refactoring both front-end and back-end code to enhance performance, scalability, and alignment with the .NET Core MVC architecture.",
        "Refactored front-end and back-end code to align with .NET Core MVC architecture, improving the performance and scalability of the web application.",
        "Replaced 12 deprecated NuGet packages, eliminating 100+ security warnings in CI builds.",
      ],
      updatedAt: "2026-03-20T10:04:00.000Z",
      origin: "imported",
      sortOrder: 0,
    });

    expect(entry.bullets.map((bullet) => bullet.text)).toEqual([
      "Assisted in migrating a web-based ERP system from .NET Framework to .NET Core MVC, refactoring both front-end and back-end code to enhance performance, scalability, and alignment with the .NET Core MVC architecture.",
      "Replaced 12 deprecated NuGet packages, eliminating 100+ security warnings in CI builds.",
    ]);
  });

  test("validateResumeDraft leaves unchecked lines alone and catches near repetition", () => {
    const { profile, job } = getSeedContext();
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          summary:
            "I did a lot of different things. I did a lot of different things.",
          bullets: createBullets("claim_quality_tone", [
            "Single-handedly revolutionized the industry with a world-class platform.",
            "Worked on various things and helped with lots of stuff.",
            "TailwindCSS & WebSockets.",
            "Led design-system rollout across core surfaces.",
            "Led the design system rollout across core product surfaces.",
          ]),
        })),
      }),
    );

    const validation = validateResumeDraft({ draft, job, profile });

    // A line the AI has not checked yet does not wait on the person.
    expect(
      validation.issues.some(
        (issue) =>
          issue.category === "unsupported_claim" &&
          issue.bulletId === "claim_quality_tone_1",
      ),
    ).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "duplicate_bullet",
          bulletId: "claim_quality_tone_5",
        }),
      ]),
    );
  });

  test("validateResumeDraft reports missing and hidden canonical work-history roles", () => {
    const { profile, job } = getSeedContext();
    const canonicalRole = {
      ...profile.experiences[0]!,
      id: "experience_canonical_second",
      companyName: "Orbit Labs",
      title: "Product designer",
    };
    const profileWithSecondRole = {
      ...profile,
      experiences: [...profile.experiences, canonicalRole],
    };

    const missingValidation = validateResumeDraft({
      draft: createBaseDraft(),
      job,
      profile: profileWithSecondRole,
    });
    expect(missingValidation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "issue_work_history_experience_canonical_second",
          category: "work_history_review",
          message:
            "A canonical work-history role is missing from the resume draft.",
        }),
      ]),
    );

    const hiddenDraft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: [
          ...section.entries,
          {
            ...getExperienceEntry(createBaseDraft()),
            id: "experience_hidden_canonical",
            profileRecordId: canonicalRole.id,
            included: false,
          },
        ],
      }),
    );
    const hiddenValidation = validateResumeDraft({
      draft: hiddenDraft,
      job,
      profile: profileWithSecondRole,
    });
    expect(hiddenValidation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "issue_work_history_experience_canonical_second",
          category: "work_history_review",
          message:
            "A canonical work-history role is hidden from the visible resume.",
        }),
      ]),
    );
  });

  test("buildResumeCoverageComparison explains role, claim, order, and page changes", () => {
    const { profile } = getSeedContext();
    const secondRole = {
      ...profile.experiences[0]!,
      id: "experience_2",
      companyName: "Orbit Labs",
      title: "Product designer",
      summary: "Designed internal workflow products.",
      achievements: ["Shipped a shared operations dashboard."],
    };
    const profileWithHistory = {
      ...profile,
      experiences: [...profile.experiences, secondRole],
    };
    const comparisonDraft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: [
          {
            ...getExperienceEntry(createBaseDraft()),
            id: "experience_2",
            profileRecordId: secondRole.id,
            title: secondRole.title,
            subtitle: secondRole.companyName,
            summary: secondRole.summary,
            bullets: createBullets(
              "experience_2_bullet",
              secondRole.achievements,
            ),
            included: false,
            sortOrder: 0,
          },
          {
            ...getExperienceEntry(createBaseDraft()),
            summary: "Builds reliable workflow platforms for product teams.",
            bullets: createBullets("experience_rewritten", [
              "Led a grounded design-system rollout across core product surfaces.",
            ]),
            sortOrder: 1,
          },
        ],
      }),
    );

    const comparison = buildResumeCoverageComparison({
      profile: profileWithHistory,
      draft: comparisonDraft,
      pageCount: 3,
      validationIssues: [
        {
          id: "duplicate_1",
          severity: "warning",
          category: "duplicate_bullet",
          sectionId: "section_experience",
          entryId: "experience_1",
          bulletId: "experience_rewritten_1",
          message: "Repeated claim.",
        },
      ],
    });

    expect(comparison).toMatchObject({
      originalRoleCount: 2,
      representedRoleCount: 2,
      visibleRoleCount: 1,
      rewrittenRoleCount: 1,
      hiddenRoleCount: 1,
      reorderedRoleCount: 2,
      duplicateIssueCount: 1,
      pageImpact: "over_target",
      pageCount: 3,
      targetPageCount: 2,
    });
    const rewrittenRole = comparison.roles.find(
      (role) => role.profileRecordId === "experience_1",
    );
    expect(rewrittenRole).toMatchObject({
      status: "rewritten",
      reordered: true,
    });
    expect(rewrittenRole?.addedClaims).toContainEqual({
      field: "summary",
      text: "Builds reliable workflow platforms for product teams.",
      restorable: false,
    });
    expect(rewrittenRole?.removedClaims).toContainEqual({
      field: "summary",
      text: "Builds resilient workflow tools.",
      restorable: true,
      sourceAchievementIds: ["experience:experience_1:summary:0"],
    });
    expect(
      comparison.roles.find((role) => role.profileRecordId === "experience_2"),
    ).toMatchObject({
      status: "hidden",
      included: false,
    });

    const hiddenSectionComparison = buildResumeCoverageComparison({
      profile: profileWithHistory,
      draft: updateSection(
        comparisonDraft,
        "section_experience",
        (section) => ({
          ...section,
          included: false,
          entries: section.entries.map((entry) => ({
            ...entry,
            included: true,
          })),
        }),
      ),
    });

    expect(hiddenSectionComparison).toMatchObject({
      visibleRoleCount: 0,
      hiddenRoleCount: 2,
    });
    expect(
      hiddenSectionComparison.roles.flatMap((role) => role.removedClaims),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ restorable: false })]),
    );
  });

  test("sanitizeResumeDraft leaves a generated summary's wording to the checker (ADR 0041)", () => {
    const { profile, job } = getSeedContext();
    const casualSummary =
      "After deciding to return to my passion, I did a lot of different things and moved back into development.";
    const generatedDraft = updateSection(
      createBaseDraft(),
      "section_summary",
      (section) => ({
        ...section,
        text: casualSummary,
        origin: "ai_generated",
      }),
    );

    const sanitized = sanitizeResumeDraft({
      draft: generatedDraft,
      job,
      profile,
    });

    // No word rule swaps it out; the fact check notes it and fixes it when
    // the resume is generated.
    expect(getSection(sanitized, "section_summary").text).toBe(casualSummary);
    expect(getExperienceEntry(sanitized)).toMatchObject({
      profileRecordId: "experience_1",
      included: true,
    });
  });

  test("assesses every visible generated claim against candidate-only evidence", () => {
    const { profile, job } = getSeedContext();
    const groundedClaim = "Led design-system rollout across core surfaces.";
    const groundedProfile = {
      ...profile,
      experiences: profile.experiences.map((experience, index) =>
        index === 0
          ? {
              ...experience,
              achievements: [...experience.achievements, groundedClaim],
            }
          : experience,
      ),
    };
    const draft = updateSection(
      createBaseDraft(),
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          bullets: createBullets("claim_grounding", [
            groundedClaim,
            "Architected a quantum operating model for global logistics teams.",
          ]),
        })),
      }),
    );

    const validation = validateResumeDraft({
      draft: withClaimChecks(draft, {
        "Architected a quantum operating model for global logistics teams.":
          "unsupported",
      }),
      job,
      profile: groundedProfile,
    });
    const grounded = validation.claimAssessments.find(
      (assessment) => assessment.bulletId === "claim_grounding_1",
    );
    const unsupported = validation.claimAssessments.find(
      (assessment) => assessment.bulletId === "claim_grounding_2",
    );

    // A generated line that repeats the person's records is theirs; the
    // model's fact check decides the rest (ADR 0041).
    expect(grounded).toMatchObject({
      claimOrigin: "ai_generated",
      status: "exact",
      verifier: "model_fact_check_v1",
    });
    expect(unsupported).toMatchObject({
      claimOrigin: "ai_generated",
      status: "unsupported",
      evidenceRefs: [],
    });
    expect(validation.draftContentHash).toBe(
      buildResumeDraftContentHash(draft),
    );
  });

  test("keeps the person's own lines and invalidates hashes when claim text changes", () => {
    const { profile, job } = getSeedContext();
    const userEditedDraft = updateSection(
      createBaseDraft(),
      "section_summary",
      (section) => ({
        ...section,
        text: "Created a novel operating model that is not yet in candidate evidence.",
        origin: "user_edited",
      }),
    );
    const before = validateResumeDraft({
      draft: userEditedDraft,
      job,
      profile,
    });
    const editedDraft = updateSection(
      userEditedDraft,
      "section_summary",
      (section) => ({
        ...section,
        text: "Created a different novel operating model that is not yet in candidate evidence.",
      }),
    );
    const after = validateResumeDraft({ draft: editedDraft, job, profile });
    const beforeClaim = before.claimAssessments.find(
      (assessment) =>
        assessment.field === "section_text" &&
        assessment.sectionId === "section_summary",
    );
    const afterClaim = after.claimAssessments.find(
      (assessment) =>
        assessment.field === "section_text" &&
        assessment.sectionId === "section_summary",
    );

    // A line the person wrote is theirs (ADR 0041); a rewording still
    // changes its hash.
    expect(beforeClaim).toMatchObject({
      claimOrigin: "user_edited",
      status: "exact",
    });
    expect(beforeClaim?.contentHash).not.toBe(afterClaim?.contentHash);
    expect(before.draftContentHash).not.toBe(after.draftContentHash);

    const originOnlyEdit = updateSection(
      userEditedDraft,
      "section_summary",
      (section) => ({ ...section, origin: "ai_generated" }),
    );
    expect(buildResumeDraftContentHash(originOnlyEdit)).not.toBe(
      buildResumeDraftContentHash(userEditedDraft),
    );
  });

  test("maps the model's verdicts to statuses; only an unbacked generated line blocks, bound to locator and hash", () => {
    const { profile, job } = getSeedContext();
    const groundedDraft = updateSection(
      createBaseDraft(),
      "section_summary",
      (section) => ({
        ...section,
        text: profile.summary ?? "",
      }),
    );
    const draft = updateSection(
      groundedDraft,
      "section_experience",
      (section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          bullets: createBullets("grounding_confirm", [
            "Championed resilient delivery improvements across organizations.",
            "Delivered the design system rollout across core product surfaces.",
            "Ran the entire cloud migration single-handedly.",
          ]),
        })),
      }),
    );

    const checkedDraft = withClaimChecks(draft, {
      "Championed resilient delivery improvements across organizations.":
        "stretch",
      "Delivered the design system rollout across core product surfaces.":
        "supported",
      "Ran the entire cloud migration single-handedly.": "unsupported",
    });
    const validation = validateResumeDraft({
      draft: checkedDraft,
      job,
      profile,
    });
    const stretchClaim = validation.claimAssessments.find(
      (assessment) => assessment.bulletId === "grounding_confirm_1",
    );
    const paraphraseClaim = validation.claimAssessments.find(
      (assessment) => assessment.bulletId === "grounding_confirm_2",
    );
    const unbackedClaim = validation.claimAssessments.find(
      (assessment) => assessment.bulletId === "grounding_confirm_3",
    );

    // A stretch was accepted by choosing Aggressive: no chore, no block.
    expect(stretchClaim).toMatchObject({
      claimOrigin: "ai_generated",
      status: "confirm_needed",
      verifier: "model_fact_check_v1",
    });
    expect(
      validation.issues.some(
        (issue) => issue.category === "claim_confirmation_needed",
      ),
    ).toBe(false);
    expect(paraphraseClaim).toMatchObject({
      claimOrigin: "ai_generated",
      status: "paraphrase",
    });
    expect(unbackedClaim).toMatchObject({ status: "unsupported" });
    expect(
      hasBlockingResumeClaimAssessment({
        validation: { claimAssessments: [stretchClaim!, paraphraseClaim!] },
        draft,
      }),
    ).toBe(false);
    expect(hasBlockingResumeClaimAssessment({ validation, draft })).toBe(true);

    const confirmation = ResumeClaimConfirmationSchema.parse({
      id: "claim_confirmation_grounding_3",
      draftId: draft.id,
      field: unbackedClaim?.field ?? "section_bullet",
      sectionId: unbackedClaim?.sectionId ?? "",
      entryId: unbackedClaim?.entryId ?? null,
      bulletId: unbackedClaim?.bulletId ?? null,
      confirmedClaimContentHash: fnv1a32(
        normalizeText(unbackedClaim?.claimText ?? ""),
      ),
      ownershipStatement: resumeClaimOwnershipStatement,
      confirmedAt: "2026-08-26T10:00:00.000Z",
    });
    const confirmedDraft = { ...draft, claimConfirmations: [confirmation] };
    expect(
      hasBlockingResumeClaimAssessment({ validation, draft: confirmedDraft }),
    ).toBe(false);

    // A cross-draft confirmation never satisfies the gate.
    expect(
      hasBlockingResumeClaimAssessment({
        validation,
        draft: {
          ...draft,
          claimConfirmations: [
            {
              ...confirmation,
              id: "claim_confirmation_foreign_draft",
              draftId: "resume_draft_elsewhere",
            },
          ],
        },
      }),
    ).toBe(true);

    // A reworded line needs its own approval.
    expect(
      hasBlockingResumeClaimAssessment({
        validation: {
          ...validation,
          claimAssessments: validation.claimAssessments.map((assessment) =>
            assessment.id === unbackedClaim?.id
              ? { ...assessment, contentHash: fnv1a32("reworded claim") }
              : assessment,
          ),
        },
        draft: confirmedDraft,
      }),
    ).toBe(true);

    // The person's own line is theirs, whatever the checker says.
    expect(
      hasBlockingResumeClaimAssessment({
        validation: {
          claimAssessments: [
            { ...unbackedClaim!, claimOrigin: "user_edited" as const },
          ],
        },
        draft,
      }),
    ).toBe(false);
  });

  test("older verifiers follow the same rule: only an unbacked generated line blocks", () => {
    const { profile, job } = getSeedContext();
    const baseDraft = createBaseDraft();
    const validation = validateResumeDraft({ draft: baseDraft, job, profile });
    const row = validation.claimAssessments[0];
    if (!row) {
      throw new Error("Expected at least one claim assessment.");
    }
    const blocks = (overrides: Partial<typeof row>) =>
      hasBlockingResumeClaimAssessment({
        validation: { claimAssessments: [{ ...row, ...overrides }] },
        draft: baseDraft,
      });

    expect(
      blocks({
        claimOrigin: "ai_generated",
        status: "review",
        verifier: "deterministic_candidate_evidence_v1",
      }),
    ).toBe(false);
    expect(
      blocks({
        claimOrigin: "ai_generated",
        status: "unsupported",
        verifier: "deterministic_candidate_evidence_v1",
      }),
    ).toBe(true);
    expect(
      blocks({
        claimOrigin: "user_edited",
        status: "unsupported",
        verifier: "deterministic_candidate_evidence_v2",
      }),
    ).toBe(false);
    expect(
      blocks({
        claimOrigin: "user_edited",
        status: "review",
        verifier: "deterministic_candidate_evidence_v2",
      }),
    ).toBe(false);
  });
});

test("edited achievements replace old adjacent summary wording once", () => {
  const { profile, job } = getSeedContext();
  const edited =
    "Redesigned pension-app onboarding, lifting activation 23% in eight weeks.";
  const old =
    "Redesigned onboarding for a pensions app; activation up 23% in eight weeks.";
  const draft = updateSection(
    createBaseDraft(),
    "section_experience",
    (section) => ({
      ...section,
      entries: section.entries.map((entry) => ({
        ...entry,
        summary: old,
        bullets: createBullets("edited", [edited]),
      })),
    }),
  );
  const result = sanitizeResumeDraft({ draft, profile, job });
  expect(getExperienceEntry(result).summary).toBeNull();
  expect(
    getExperienceEntry(result).bullets.map((bullet) => bullet.text),
  ).toEqual([edited]);
});

test("comparison preserves sentences split into bullets and offers only missing facts", () => {
  const { profile } = getSeedContext();
  const facts = [
    "Built research dashboards for the payments team.",
    "Designed accessible prototypes for customer onboarding.",
    "Reduced review time 23% across eight weeks.",
  ];
  const role = {
    ...profile.experiences[0]!,
    id: "experience_1",
    summary: facts.join(" "),
    achievements: [],
  };
  const draft = updateSection(
    createBaseDraft(),
    "section_experience",
    (section) => ({
      ...section,
      entries: section.entries.map((entry) => ({
        ...entry,
        summary: null,
        bullets: createBullets("facts", facts),
      })),
    }),
  );
  expect(
    buildResumeCoverageComparison({
      profile: { ...profile, experiences: [role] },
      draft,
    }).removedClaimCount,
  ).toBe(0);
  const missing = updateSection(draft, "section_experience", (section) => ({
    ...section,
    entries: section.entries.map((entry) => ({
      ...entry,
      bullets: entry.bullets.slice(0, 2),
    })),
  }));
  expect(
    buildResumeCoverageComparison({
      profile: { ...profile, experiences: [role] },
      draft: missing,
    }).roles[0]?.removedClaims,
  ).toEqual([
    {
      field: "bullet",
      text: facts[2],
      restorable: true,
      sourceAchievementIds: ["experience:experience_1:summary:2"],
    },
  ]);
});

test("unconfirmed import roles are excluded from seed, preview and comparison", () => {
  const { profile, job } = getSeedContext();
  const candidate = {
    ...profile,
    experiences: [
      ...profile.experiences,
      {
        ...profile.experiences[0]!,
        id: "unconfirmed",
        title: "/",
        isDraft: true,
      },
    ],
  };
  const seeded = seedResumeDraft({
    profile: candidate,
    job,
    templateId: "classic_ats",
  });
  expect(
    seeded.sections
      .flatMap((section) => section.entries)
      .some((entry) => entry.profileRecordId === "unconfirmed"),
  ).toBe(false);
  expect(
    buildResumeCoverageComparison({ profile: candidate, draft: seeded })
      .originalRoleCount,
  ).toBe(profile.experiences.filter((role) => !role.isDraft).length);
});

test("comparison recognizes language name and level across separators and carries achievement source IDs", () => {
  const seed = createSeed();
  seed.profile.spokenLanguages = [
    {
      id: "pl",
      language: "Polish",
      proficiency: "Native",
      interviewPreference: false,
      notes: null,
    },
  ];
  const draft = seedResumeDraft({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  const role = draft.sections.find((section) => section.kind === "experience")!
    .entries[0]!;
  const source = seed.profile.experiences.find(
    (experience) => experience.id === role.profileRecordId,
  )!;
  const bullet = role.bullets[0]!;
  bullet.text =
    "Kommissionierfehler um 38 % reduziert. Reduced picking errors by 38%.";
  bullet.sourceRefs.push({
    id: "source_fact",
    sourceKind: "profile",
    sourceId: `experience:${source.id}:achievement:0`,
    snippet: source.achievements[0]!,
  });
  const language = draft.sections.find(
    (section) => section.id === "section_languages",
  )!.bullets[0]!;
  language.text = "Polish: Native";
  const comparison = buildResumeCoverageComparison({
    profile: seed.profile,
    draft,
  });
  expect(comparison.addedKeywords).not.toContain("Polish: Native");
  expect(comparison.removedKeywords).not.toContain("Polish — Native");
  const comparedRole = comparison.roles.find(
    (entry) => entry.profileRecordId === source.id,
  )!;
  expect(
    comparedRole.addedClaims.find((claim) => claim.text === bullet.text)
      ?.sourceAchievementIds,
  ).toEqual([`experience:${source.id}:achievement:0`]);
  expect(
    comparedRole.removedClaims.find(
      (claim) => claim.text === source.achievements[0],
    )?.sourceAchievementIds,
  ).toEqual([`experience:${source.id}:achievement:0`]);
  expect(comparedRole.retainedClaimCount).toBe(comparedRole.originalClaimCount);
});
