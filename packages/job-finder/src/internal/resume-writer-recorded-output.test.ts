import { describe, expect, test, vi } from "vitest";
import { CandidateProfileSchema, ResumeDraftSchema } from "@nestor/contracts";
import { completeTailoredResumeDraft } from "@nestor/ai-providers";
import type { ResumeClaimCheckInput } from "@nestor/ai-providers";
import { createSeed } from "../profile-service.test-support";
import {
  withResumeClaimChecks,
  withResumeClaimFixes,
} from "./resume-claim-checks";
import {
  buildResumeDraftFromTailoredDraft,
  validateResumeDraft,
} from "./resume-workspace-helpers";

const at = "2026-10-05T00:00:00.000Z";
function generated(text: string, kind = "summary") {
  return ResumeDraftSchema.parse({
    id: "recorded_writer",
    jobId: "job_ready",
    templateId: "classic_ats",
    status: "draft",
    createdAt: at,
    updatedAt: at,
    sections: [
      {
        id: "recorded_section",
        kind,
        label: kind,
        text,
        bullets: [],
        entries: [],
        origin: "ai_generated",
        included: true,
        locked: false,
        sortOrder: 0,
        updatedAt: at,
      },
    ],
  });
}

const recordedWording = [
  {
    id: "R3-001",
    original: "Built settlement services using JavaScript.",
    bad: "Built remote Dallas settlement services with TypeScript and replayable settlement offsets.",
    fix: "Built settlement services using JavaScript.",
    verdict: "unsupported" as const,
  },
  {
    id: "R3-152",
    original: "Excel (advanced)",
    bad: "Excel",
    fix: "Excel (advanced)",
    verdict: "unsupported" as const,
    kind: "skills",
  },
  {
    id: "R3-159",
    original:
      "Prepared IFRS reporting and CFO dashboards using Excel and Power BI.",
    bad: "Prepared Power BI IFRS reporting and Power BI dashboards used by the CFO in Excel and Power BI.",
    fix: "Prepared IFRS reporting and CFO dashboards using Excel and Power BI.",
    verdict: "supported" as const,
  },
  {
    id: "R3-211",
    original: "Exceeded the sales target by 20%.",
    bad: "Strong communication, willingness to learn and communication skills, with willingness to learn.",
    fix: "Exceeded the sales target by 20%.",
    verdict: "unsupported" as const,
  },
];

describe("recorded synthetic writer and checker responses", () => {
  test.each(recordedWording)(
    "$id repairs the recorded bad wording and rechecks it",
    async (record) => {
      const seed = createSeed();
      const profile = {
        ...seed.profile,
        summary: record.original,
        baseResume: {
          ...seed.profile.baseResume,
          textContent: record.original,
        },
      };
      const checker = vi.fn((input: ResumeClaimCheckInput) =>
        Promise.resolve(
          input.claims.map((claim) => ({
            id: claim.id,
            verdict:
              claim.text === record.bad
                ? record.verdict
                : ("supported" as const),
            reason: "Recorded synthetic fact check.",
            evidenceIds: [],
            fix: claim.text === record.bad ? record.fix : null,
            style:
              claim.text === record.bad && record.verdict === "supported"
                ? "Repeated tools make this hard to read."
                : null,
          })),
        ),
      );
      const base = {
        aiClient: { checkResumeClaims: checker },
        profile,
        job: seed.savedJobs[0]!,
        tailoringStrength: "conservative",
      };
      const checked = await withResumeClaimChecks({
        ...base,
        draft: generated(record.bad, record.kind),
      });
      // The imported resume reaches the checker once, as cited evidence.
      expect(checker.mock.calls[0]![0].resumeText).toBeNull();
      expect(
        checker.mock.calls[0]![0].evidence.map((entry) => entry.text),
      ).toContain(record.original);
      const fixed = await withResumeClaimFixes({
        ...base,
        draft: checked,
        stretchesAreThePersons: false,
      });
      expect(fixed.sections[0]!.text).toBe(record.fix);
      expect(
        validateResumeDraft({
          draft: fixed,
          profile,
          job: seed.savedJobs[0]!,
        }).claimAssessments.some((claim) => claim.status === "unsupported"),
      ).toBe(false);
    },
  );

  test("R3-207 the model sees an earlier achievement when it removes a repeated paraphrase", async () => {
    const seed = createSeed();
    const original = "Exceeded the sales target by 20%.";
    const duplicate = "Delivered quota performance 20% above the sales target.";
    const draft = generated(duplicate);
    draft.sections.unshift({
      ...draft.sections[0]!,
      id: "original",
      text: original,
      origin: "user_edited",
    });
    const checker = vi.fn((input: ResumeClaimCheckInput) => {
      expect(input.resumeLines).toContainEqual({
        section: "summary",
        text: original,
      });
      return Promise.resolve(
        input.claims.map((claim) => ({
          id: claim.id,
          verdict: "supported" as const,
          reason: "Already stated in the earlier line.",
          evidenceIds: [],
          style: "Repeats the earlier achievement.",
          fix: "",
        })),
      );
    });
    const base = {
      aiClient: { checkResumeClaims: checker },
      profile: seed.profile,
      job: seed.savedJobs[0]!,
    };
    const checked = await withResumeClaimChecks({ ...base, draft });
    const fixed = await withResumeClaimFixes({
      ...base,
      draft: checked,
      stretchesAreThePersons: false,
    });
    // Removing the generated summary restores saved wording (ADR 0051),
    // while the person's earlier achievement remains exactly as written.
    expect(
      fixed.sections
        .filter((section) => section.included)
        .map((section) => section.text),
    ).toEqual([original, seed.profile.summary]);
  });

  test("R3-015/R3-097 preserves omitted source achievements, skill limits, qualifications and dates", () => {
    const seed = createSeed();
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      skills: ["Articulate Rise (learning)", "Workday (basic)"],
      education: [
        {
          id: "ihk",
          schoolName: "Example College",
          degree: "Fachkraft für Lagerlogistik (IHK)",
          endDate: "2013",
        },
      ],
      certifications: [
        { id: "cert", name: "Example Certification", issueDate: "2017" },
        { id: "ils", name: "ILS renewed", issueDate: "2025" },
        { id: "course", name: "Clinical training", issueDate: "2019" },
      ],
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          startDate: "2024",
          endDate: "2025",
          isCurrent: false,
          achievements: ["Designed the evaluation rubric for 120 learners."],
        },
      ],
    });
    // The recorded writer omitted all background and source achievement fields.
    const tailored = completeTailoredResumeDraft(
      {
        summary: {
          text: "Supported summary.",
          evidenceRefs: ["profile:summary"],
        },
        experienceEntries: [],
        educationEntries: [],
        certificationEntries: [],
      },
      {
        profile,
        job: seed.savedJobs[0]!,
        searchPreferences: {
          ...seed.searchPreferences,
          tailoringMode: "conservative",
        },
        settings: seed.settings,
        resumeText: profile.baseResume.textContent,
      },
    );
    const draft = buildResumeDraftFromTailoredDraft({
      job: seed.savedJobs[0]!,
      profile,
      draft: tailored,
      templateId: seed.settings.resumeTemplateId,
      createdAt: at,
      generationMethod: "ai",
    });
    const page = draft.sections
      .filter((section) => section.included)
      .flatMap((section) => [
        section.text,
        ...section.bullets
          .filter((bullet) => bullet.included)
          .map((bullet) => bullet.text),
        ...section.entries
          .filter((entry) => entry.included)
          .flatMap((entry) => [
            entry.title,
            entry.subtitle,
            entry.dateRange,
            entry.summary,
            ...entry.bullets
              .filter((bullet) => bullet.included)
              .map((bullet) => bullet.text),
          ]),
      ])
      .join("\n");
    for (const fact of [
      "Articulate Rise (learning)",
      "Workday (basic)",
      "Fachkraft für Lagerlogistik (IHK)",
      "2013",
      "2017",
      "2025",
      "2019",
      "120 learners",
    ])
      expect(page).toContain(fact);
  });
});
