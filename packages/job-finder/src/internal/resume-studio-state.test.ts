import { describe, expect, test } from "vitest";
import {
  ApplicationRecordSchema,
  ResumeValidationResultSchema,
  resumeComparisonNeedsRefresh,
} from "@nestor/contracts";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  buildResumeCoverageComparison,
  seedResumeDraft,
} from "./resume-workspace-helpers";
import { hasResumeAffectingProfileChange } from "./resume-workspace-staleness";
import {
  buildResumeEntryDateQualityIssues,
  parseResumeEntryDateRange,
} from "./resume-entry-ordering";

describe("Resume Studio truthful state", () => {
  test("answer and eligibility changes do not change document inputs", () => {
    const profile = createSeed().profile;
    expect(
      hasResumeAffectingProfileChange(profile, {
        ...profile,
        answerBank: {
          ...profile.answerBank,
          relocation: "Not willing to relocate",
        },
        workEligibility: {
          ...profile.workEligibility,
          willingToRelocate: true,
        },
      }),
    ).toBe(false);
    expect(
      hasResumeAffectingProfileChange(profile, {
        ...profile,
        portfolioUrl: "https://synthetic.example/new",
      }),
    ).toBe(true);
  });
  test("profile edits stale pending drafts and keep submitted approvals and files", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness();
    for (const [index, job] of seed.savedJobs.slice(0, 2).entries()) {
      const draft = seedResumeDraft({
        profile: seed.profile,
        job,
        templateId: seed.settings.resumeTemplateId,
      });
      await repository.upsertResumeDraft({
        ...draft,
        status: index === 0 ? "approved" : "needs_review",
        approvedAt: index === 0 ? draft.updatedAt : null,
        approvedExportId: index === 0 ? "sent_pdf" : null,
      });
    }
    await repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        id: "sent",
        jobId: seed.savedJobs[0]!.id,
        status: "submitted",
        title: "Synthetic designer",
        company: "Synthetic studio",
        lastActionLabel: "Sent",
        nextActionLabel: null,
        lastUpdatedAt: "2026-10-05T00:00:00.000Z",
        createdAt: "2026-10-05T00:00:00.000Z",
        updatedAt: "2026-10-05T00:00:00.000Z",
      }),
    );
    await workspaceService.saveProfile({
      ...seed.profile,
      currentCity: "Toronto",
    });
    expect(
      await repository.getResumeDraftByJobId(seed.savedJobs[0]!.id),
    ).toMatchObject({ status: "approved", approvedExportId: "sent_pdf" });
    expect(
      await repository.getResumeDraftByJobId(seed.savedJobs[1]!.id),
    ).toMatchObject({ status: "stale" });
  });
  test("an unchanged compact role and existing languages are not additions", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      spokenLanguages: [
        {
          id: "spanish",
          language: "Spanish",
          proficiency: "Native",
          interviewPreference: false,
          notes: null,
        },
      ],
    };
    const job = seed.savedJobs[0]!;
    const draft = seedResumeDraft({
      profile,
      job,
      templateId: seed.settings.resumeTemplateId,
    });
    const comparison = buildResumeCoverageComparison({
      profile,
      draft,
      coverageMetadata: [
        {
          profileRecordId: profile.experiences[0]!.id,
          classification: "compact",
          careerFamilyFit: "strong",
          reasons: [],
          reviewGuidance: [],
          coversMeaningfulGap: false,
        },
      ],
    });
    expect(comparison.roles[0]?.status).toBe("unchanged");
    expect(comparison.addedKeywords).not.toContain("Spanish — Native");
  });
  test("rewritten bullets carry original text in the comparison", () => {
    const seed = createSeed();
    const draft = seedResumeDraft({
      profile: seed.profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });
    const entry = draft.sections.find(
      (section) => section.kind === "experience",
    )!.entries[0]!;
    const original = entry.bullets[0]!.text;
    entry.bullets[0]!.text =
      "Delivered the design system across core surfaces.";
    expect(
      buildResumeCoverageComparison({
        profile: seed.profile,
        draft,
      }).roles[0]?.removedClaims.map((claim) => claim.text),
    ).toContain(original);
  });
  test("date suggestions name the entry and preserve year-only precision", () => {
    const seed = createSeed();
    const draft = seedResumeDraft({
      profile: seed.profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });
    const entry = draft.sections.find(
      (section) => section.kind === "experience",
    )!.entries[0]!;
    Object.assign(entry, {
      title: "Copperline internship",
      startDate: "2026",
      endDate: "2026",
      isCurrent: false,
      dateRange: "2026 – 2026",
    });
    expect(
      parseResumeEntryDateRange(entry, new Date("2026-03-20")).hasFutureDate,
    ).toBe(false);
    Object.assign(entry, {
      startDate: null,
      endDate: null,
      dateRange: "2027 – 2028",
    });
    const warnings = buildResumeEntryDateQualityIssues(
      draft,
      new Date("2026-03-20"),
    );
    expect(
      warnings.find((issue) => issue.entryId === entry.id)?.message,
    ).toContain("Copperline internship");
    expect(
      warnings.find((issue) => issue.entryId === entry.id)?.message,
    ).toContain("2027 – 2028");
  });
});

test("manual edits retain a job’s Light level", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  await workspaceService.setJobResumeApplicationMode(
    "job_ready",
    "tailored_per_job",
    "conservative",
  );
  await workspaceService.generateResume("job_ready");
  const { draft } = await workspaceService.getResumeWorkspace("job_ready");
  await workspaceService.saveResumeDraft({
    ...draft,
    sections: draft.sections.map((section) =>
      section.kind === "summary"
        ? { ...section, text: "Design systems specialist." }
        : section,
    ),
  });
  expect(
    (await repository.listSavedJobs()).find((job) => job.id === "job_ready")
      ?.resumeTailoringMode,
  ).toBe("conservative");
});

test("persists an unfinished resume batch independently of running memory", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  const checkpoint = {
    id: "batch",
    jobIds: ["one", "two"],
    activeJobIds: ["two"],
    completedJobIds: ["one"],
    done: false,
    stopRequested: false,
  };
  await workspaceService.saveResumeBatchCheckpoint(checkpoint);
  expect(
    (await repository.getIntelligenceState()).resumeBatchCheckpoint,
  ).toEqual(checkpoint);
  expect(
    (await workspaceService.getWorkspaceSnapshot()).intelligence
      .resumeBatchCheckpoint,
  ).toEqual(checkpoint);
  await workspaceService.saveResumeBatchCheckpoint({
    ...checkpoint,
    done: true,
    activeJobIds: [],
  });
  expect(
    (await repository.getIntelligenceState()).resumeBatchCheckpoint?.done,
  ).toBe(true);
});

test("a stored error from an older check never reaches the Shortlisted review gate", async () => {
  const seed = createSeed();
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  const draft = seedResumeDraft({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  await repository.saveResumeDraftWithValidation({
    draft,
    validation: ResumeValidationResultSchema.parse({
      id: "thin_resume",
      draftId: draft.id,
      validatedAt: "2026-10-05T00:00:00.000Z",
      issues: [
        {
          id: "thin",
          category: "empty_section",
          severity: "error",
          message: "Add the saved internship before approval.",
        },
      ],
    }),
  });
  const item = (await workspaceService.getWorkspaceSnapshot()).reviewQueue.find(
    (item) => item.jobId === draft.jobId,
  );
  // Only an unbacked generated line can wait on the person (ADR 0051).
  expect(item?.resumeLinesToDecide).toBeUndefined();
});

test("every current-role suggestion names its entry and displayed dates", () => {
  const seed = createSeed();
  const draft = seedResumeDraft({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  const section = draft.sections.find(
    (section) => section.kind === "experience",
  )!;
  const entry = section.entries[0]!;
  section.entries = ["Copperline internship", "Campaign assistant"].map(
    (title, index) => ({
      ...entry,
      id: `current_${index}`,
      title,
      isCurrent: true,
      startDate: "2025",
      endDate: null,
      dateRange: "2025 – Present",
    }),
  );
  const issues = buildResumeEntryDateQualityIssues(draft).filter((issue) =>
    issue.id.includes("duplicate_current"),
  );
  expect(issues).toHaveLength(2);
  for (const [index, issue] of issues.entries()) {
    expect(issue.message).toContain(section.entries[index]!.title);
    expect(issue.message).toContain("2025 – Present");
  }
});

test("older translated fields without source links do not claim existing languages were added", () => {
  const seed = createSeed();
  const profile = {
    ...seed.profile,
    spokenLanguages: [
      {
        id: "pl",
        language: "Polish",
        proficiency: "C1",
        interviewPreference: false,
        notes: null,
      },
    ],
  };
  const draft = seedResumeDraft({
    profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  draft.language = "German";
  delete draft.writtenLanguage;
  const skills = draft.sections.find((section) => section.kind === "skills")!;
  skills.text = "Polnisch C1";
  skills.sourceRefs = [];
  expect(
    buildResumeCoverageComparison({ profile, draft }).addedKeywords,
  ).toEqual([]);
});

test("a draft that names its language but not its written language offers a refresh", () => {
  const seed = createSeed();
  const draft = seedResumeDraft({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  delete draft.writtenLanguage;
  draft.language = "German";
  expect(resumeComparisonNeedsRefresh(draft)).toBe(true);
});
