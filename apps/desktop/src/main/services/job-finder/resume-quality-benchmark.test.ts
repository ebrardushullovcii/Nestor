import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type {
  ResumeQualityBenchmarkMetrics,
  ResumeTemplateDefinition,
} from "@nestor/contracts";
import {
  deriveResumeCoveragePlan,
  type TailoredResumeDraft,
} from "@nestor/ai-providers";

import {
  applyFixtureDraftOverride,
  calculateFragmentFreeExperienceBulletRate,
  calculateGroundedVisibleSkillRate,
  calculateKeywordCoverageRate,
  calculatePageTargetPassRate,
  calculateProfessionalExperienceSummaryRate,
  calculateVisibleWorkHistoryCoverageRate,
  calculateWorkHistoryRepresentationRate,
  defaultResumeQualityBenchmarkCases,
  isProfessionalExperienceSummary,
  isSuspiciousExperienceBulletFragment,
  looksAtsSafeFromStructure,
  passesResumeQualityAcceptance,
  runDesktopResumeQualityBenchmark,
  selectBenchmarkTemplateIds,
} from "./resume-quality-benchmark";

const pageTargetUnevaluatedNote =
  "Page target unevaluated: no measured page count for the rendered artifact, so the page-target gate cannot pass.";

function buildCompleteMetrics(): ResumeQualityBenchmarkMetrics {
  return {
    groundedVisibleSkillRate: 1,
    workHistoryRepresentationRate: 1,
    visibleWorkHistoryCoverageRate: 1,
    fragmentFreeExperienceBulletRate: 1,
    professionalExperienceSummaryRate: 1,
    bleedFreeCaseRate: 1,
    keywordCoverageRate: 1,
    duplicateIssueFreeRate: 1,
    thinOutputFreeRate: 1,
    pageTargetPassRate: 1,
    atsRenderPassRate: 1,
    issueFreeCaseRate: 1,
  };
}

describe("desktop resume quality benchmark", () => {
  test("requires every acceptance gate to clear with evidence, including page and ATS gates", () => {
    const metrics = buildCompleteMetrics();

    expect(passesResumeQualityAcceptance(metrics)).toBe(true);

    const metricKeys = Object.keys(
      metrics,
    ) as (keyof ResumeQualityBenchmarkMetrics)[];
    expect(metricKeys).toHaveLength(12);

    for (const metric of metricKeys) {
      expect(
        passesResumeQualityAcceptance({
          ...metrics,
          [metric]: metrics[metric] === 1 ? 0 : metrics[metric],
        }),
      ).toBe(false);
    }
  });

  test("fails the ATS render gate unless measurable structural criteria hold", () => {
    expect(looksAtsSafeFromStructure("")).toBe(false);

    const markerOnlyHtml =
      '<!doctype html><article data-ats-safe="true"><table><tr><td>Targeted Keywords</td></tr></table></article>';
    expect(markerOnlyHtml).toContain('data-ats-safe="true"');
    expect(looksAtsSafeFromStructure(markerOnlyHtml)).toBe(false);

    expect(
      looksAtsSafeFromStructure("<style>@page { size: Letter; }</style>"),
    ).toBe(false);
    expect(
      looksAtsSafeFromStructure(
        "<style>.body-grid { display: grid; grid-template-columns: 1fr; }</style>",
      ),
    ).toBe(false);
    expect(
      looksAtsSafeFromStructure(
        "<style>@page {} .a { grid-template-columns: 1fr; }</style>Targeted Keywords",
      ),
    ).toBe(false);
    expect(
      looksAtsSafeFromStructure(
        "@page {} grid-template-columns: 1fr; <table></table>",
      ),
    ).toBe(false);

    const structuralHtml =
      '<!doctype html><style>@page { size: Letter; margin: 0; } .body-grid { display: grid; grid-template-columns: 1fr; }</style><article data-ats-safe="true"></article>';
    expect(looksAtsSafeFromStructure(structuralHtml)).toBe(true);
  });

  test("a thin profile passes when its resume is flagged thin instead of padded", () => {
    const thin = {
      ...buildCompleteMetrics(),
      thinOutputFreeRate: 0,
      keywordCoverageRate: 0.5,
      issueFreeCaseRate: 0,
    };

    expect(passesResumeQualityAcceptance(thin)).toBe(false);
    expect(
      passesResumeQualityAcceptance(thin, { expectsThinOutput: true }),
    ).toBe(true);
    // Padding a thin profile out to a full resume fails the case.
    expect(
      passesResumeQualityAcceptance(buildCompleteMetrics(), {
        expectsThinOutput: true,
      }),
    ).toBe(false);
    expect(
      passesResumeQualityAcceptance(
        { ...thin, groundedVisibleSkillRate: 0 },
        { expectsThinOutput: true },
      ),
    ).toBe(false);
  });

  test("computes supported keyword coverage as a ratio instead of an existential match", () => {
    const job = {
      keySkills: ["Figma", "Design Systems"],
      keywordSignals: [
        {
          id: "signal_figma",
          label: "Figma",
          kind: "skill" as const,
          weight: 5,
        },
        {
          id: "signal_platform",
          label: "Workflow platform",
          kind: "domain" as const,
          weight: 4,
        },
      ],
    };

    // Distinct targets after dedupe: Figma, Design Systems, Workflow platform.
    expect(
      calculateKeywordCoverageRate("Ships design systems in Figma daily.", job),
    ).toBe(2 / 3);
    expect(
      calculateKeywordCoverageRate(
        "Owns the workflow platform with Figma and Design Systems expertise.",
        job,
      ),
    ).toBe(1);
    // A plural covers the keyword.
    expect(
      calculateKeywordCoverageRate(
        "Builds workflow platforms and design systems in Figma.",
        job,
      ),
    ).toBe(1);
    expect(calculateKeywordCoverageRate("Unrelated content only.", job)).toBe(
      0,
    );
    expect(calculateKeywordCoverageRate("", job)).toBe(0);

    const keywordLessJob = { keySkills: [], keywordSignals: [] };
    expect(
      calculateKeywordCoverageRate("Anything at all.", keywordLessJob),
    ).toBe(0);
    expect(
      passesResumeQualityAcceptance({
        ...buildCompleteMetrics(),
        keywordCoverageRate: 0.5,
      }),
    ).toBe(false);
  });

  test("fails skill grounding when visible skills are absent or unsupported", () => {
    const profile = {
      skills: ["Figma"],
      skillGroups: {
        coreSkills: [],
        tools: [],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
      },
      experiences: [],
      projects: [],
    };
    const job = {
      keySkills: ["Figma"],
      keywordSignals: [
        {
          id: "signal_figma",
          label: "Figma",
          kind: "skill" as const,
          weight: 5,
        },
      ],
    };

    expect(
      calculateGroundedVisibleSkillRate({ visibleSkills: [], job, profile }),
    ).toBe(0);
    expect(
      calculateGroundedVisibleSkillRate({
        visibleSkills: ["Figma"],
        job,
        profile,
      }),
    ).toBe(1);
    expect(
      calculateGroundedVisibleSkillRate({
        visibleSkills: ["Figma", "Invented Tooling"],
        job,
        profile,
      }),
    ).toBe(0);
    expect(
      passesResumeQualityAcceptance({
        ...buildCompleteMetrics(),
        groundedVisibleSkillRate: 0,
      }),
    ).toBe(false);
  });

  test("fails the page-target gate when the page count was never measured", () => {
    expect(
      calculatePageTargetPassRate({
        measuredPageCount: null,
        hasPageOverflowIssue: false,
      }),
    ).toBe(0);
    expect(
      calculatePageTargetPassRate({
        measuredPageCount: undefined,
        hasPageOverflowIssue: false,
      }),
    ).toBe(0);
    expect(
      calculatePageTargetPassRate({
        measuredPageCount: 0,
        hasPageOverflowIssue: false,
      }),
    ).toBe(0);
    expect(
      calculatePageTargetPassRate({
        measuredPageCount: 4,
        hasPageOverflowIssue: true,
      }),
    ).toBe(0);
    expect(
      calculatePageTargetPassRate({
        measuredPageCount: 1,
        hasPageOverflowIssue: false,
      }),
    ).toBe(1);
    expect(
      passesResumeQualityAcceptance({
        ...buildCompleteMetrics(),
        pageTargetPassRate: 0,
      }),
    ).toBe(false);
  });

  test("applies controlled fixture overrides regardless of provider lane", () => {
    const baseDraft: TailoredResumeDraft = {
      label: "Base draft",
      summary: "Base summary.",
      experienceHighlights: [],
      coreSkills: ["Figma"],
      targetedKeywords: [],
      experienceEntries: [],
      projectEntries: [],
      educationEntries: [],
      certificationEntries: [],
      additionalSkills: [],
      languages: [],
      coverageMetadata: [],
      fullText: "Base summary.",
      compatibilityScore: 50,
      notes: [],
    };

    const overridden = applyFixtureDraftOverride({
      overrideDraft: ({ baseDraft: draft, job }) => ({
        ...draft,
        coreSkills: [job.company],
      }),
      baseDraft,
      job: { company: "Signal Systems" },
    });
    expect(overridden.coreSkills).toEqual(["Signal Systems"]);
    expect(overridden.summary).toBe("Base summary.");

    expect(
      applyFixtureDraftOverride({
        baseDraft,
        job: { company: "Signal Systems" },
      }),
    ).toEqual(baseDraft);
  });

  test("requires visible canonical work history outside conservative tailoring mode", () => {
    expect(
      calculateWorkHistoryRepresentationRate({
        profileExperienceIds: ["experience_current", "experience_hidden"],
        draftExperienceEntries: [
          { included: true, profileRecordId: "experience_current" },
          { included: true, profileRecordId: "experience_hidden" },
        ],
        tailoringMode: "balanced",
      }),
    ).toBe(1);
    expect(
      calculateWorkHistoryRepresentationRate({
        profileExperienceIds: ["experience_current", "experience_missing"],
        draftExperienceEntries: [
          { included: true, profileRecordId: "experience_current" },
        ],
        tailoringMode: "balanced",
      }),
    ).toBe(0.5);
    expect(
      calculateWorkHistoryRepresentationRate({
        profileExperienceIds: ["experience_current", "experience_hidden"],
        draftExperienceEntries: [
          { included: true, profileRecordId: "experience_current" },
          { included: false, profileRecordId: "experience_hidden" },
        ],
        tailoringMode: "balanced",
      }),
    ).toBe(0.5);
  });

  test("allows conservative visibility choices only when every canonical role remains represented for review", () => {
    expect(
      calculateWorkHistoryRepresentationRate({
        profileExperienceIds: ["experience_current", "experience_hidden"],
        draftExperienceEntries: [
          { included: true, profileRecordId: "experience_current" },
          { included: false, profileRecordId: "experience_hidden" },
        ],
        tailoringMode: "conservative",
      }),
    ).toBe(1);
    expect(
      calculateWorkHistoryRepresentationRate({
        profileExperienceIds: ["experience_current", "experience_missing"],
        draftExperienceEntries: [
          { included: true, profileRecordId: "experience_current" },
        ],
        tailoringMode: "conservative",
      }),
    ).toBe(0.5);
  });

  test("reports visible work-history coverage separately from draft representation", () => {
    const draftExperienceEntries = [
      { included: true, profileRecordId: "experience_current" },
      { included: false, profileRecordId: "experience_hidden" },
      { included: true, profileRecordId: "experience_unmatched" },
      { included: true, profileRecordId: null },
    ];

    expect(
      calculateWorkHistoryRepresentationRate({
        profileExperienceIds: ["experience_current", "experience_hidden"],
        draftExperienceEntries,
        tailoringMode: "conservative",
      }),
    ).toBe(1);
    expect(
      calculateVisibleWorkHistoryCoverageRate({
        profileExperienceIds: ["experience_current", "experience_hidden"],
        draftExperienceEntries,
      }),
    ).toBe(0.5);
    expect(
      calculateVisibleWorkHistoryCoverageRate({
        profileExperienceIds: [],
        draftExperienceEntries: [],
      }),
    ).toBe(1);
  });

  test("flags short comma-split fragments without rejecting concise achievements", () => {
    expect(isSuspiciousExperienceBulletFragment("Next.js")).toBe(true);
    expect(
      isSuspiciousExperienceBulletFragment("TailwindCSS & WebSockets."),
    ).toBe(true);
    expect(
      isSuspiciousExperienceBulletFragment("synchronizing UI state."),
    ).toBe(true);
    expect(
      isSuspiciousExperienceBulletFragment(
        "Built release tools. Built release tools.",
      ),
    ).toBe(true);
    expect(isSuspiciousExperienceBulletFragment("Led QA.")).toBe(false);
    expect(
      isSuspiciousExperienceBulletFragment("Basic collaboration support."),
    ).toBe(false);
    expect(
      calculateFragmentFreeExperienceBulletRate([
        "Led QA.",
        "TailwindCSS & WebSockets.",
      ]),
    ).toBe(0.5);
    expect(
      calculateFragmentFreeExperienceBulletRate([
        "Led design-system rollout across core surfaces.",
        "Led the design system rollout across core product surfaces.",
      ]),
    ).toBe(0.5);
  });

  test("rejects first-person career-change and location-only experience summaries", () => {
    expect(
      isProfessionalExperienceSummary(
        "Built resilient workflow tools for release teams.",
        {
          location: "Remote",
        },
      ),
    ).toBe(true);
    expect(
      isProfessionalExperienceSummary(
        "After deciding to return to my passion, I moved back into engineering.",
        {
          location: "Remote",
        },
      ),
    ).toBe(false);
    expect(
      isProfessionalExperienceSummary(
        "Worked on various things and helped with lots of stuff.",
        {
          location: "Remote",
        },
      ),
    ).toBe(false);
    expect(
      isProfessionalExperienceSummary(
        "Built resilient tools. Built resilient tools.",
        { location: "Remote" },
      ),
    ).toBe(false);
    expect(
      isProfessionalExperienceSummary("REMOTE, KOSOVO", { location: "Kosovo" }),
    ).toBe(false);
    expect(
      calculateProfessionalExperienceSummaryRate([
        {
          summary: "Built resilient workflow tools for release teams.",
          location: "Remote",
        },
        { summary: "Pristina, Kosovo", location: null },
      ]),
    ).toBe(0.5);
  });

  test("selects only benchmark-eligible templates for benchmark runs", () => {
    const templates: ResumeTemplateDefinition[] = [
      {
        id: "classic_ats",
        label: "Chronology Classic",
        description: "Apply-safe baseline.",
        bestFor: ["General applications"],
        density: "balanced",
        deliveryLane: "apply_safe",
        benchmarkEligible: true,
      },
      {
        id: "modern_split",
        label: "Modern Editorial",
        description: "Polished variant.",
        bestFor: ["Product roles"],
        density: "balanced",
        deliveryLane: "share_ready",
        benchmarkEligible: false,
      },
      {
        id: "compact_exec",
        label: "Senior Brief",
        description: "Dense ATS-safe variant.",
        bestFor: ["Leadership screens"],
        density: "compact",
        deliveryLane: "apply_safe",
      },
    ];

    expect(selectBenchmarkTemplateIds(templates)).toEqual([
      "classic_ats",
      "compact_exec",
    ]);
  });

  test("runs canary corpus cases across shipped ATS templates", async () => {
    const report = await runDesktopResumeQualityBenchmark({
      benchmarkVersion: "023-test-benchmark-v1",
      canaryOnly: true,
    });

    expect(report.templates).toEqual([
      "classic_ats",
      "compact_exec",
      "modern_split",
      "technical_matrix",
      "project_showcase",
      "credentials_focus",
      "timeline_longform",
      "career_pivot",
    ]);
    expect(report.cases.length).toBe(
      defaultResumeQualityBenchmarkCases.filter(
        (entry) => entry.definition.canary,
      ).length * 8,
    );
    // The contamination case injects skills the person does not have; no
    // rule strips them any more (ADR 0041), so only the other cases are fully
    // grounded.
    for (const result of report.cases) {
      if (result.caseId !== "contamination_guard") {
        expect(result.metrics.groundedVisibleSkillRate).toBe(1);
      }
    }
    expect(report.aggregate.workHistoryRepresentationRate).toBe(1);
    expect(report.aggregate.visibleWorkHistoryCoverageRate).toBe(1);
    expect(report.aggregate.fragmentFreeExperienceBulletRate).toBe(1);
    expect(report.aggregate.professionalExperienceSummaryRate).toBe(1);
    expect(report.aggregate.atsRenderPassRate).toBe(1);
    expect(report.aggregate.keywordCoverageRate).toBeGreaterThan(0);
    expect(report.providerMode).toBe("deterministic");
    // HTML benchmark renders carry no measured page count, so acceptance honestly
    // reports failure instead of passing the page gate on missing evidence.
    for (const result of report.cases) {
      expect(result.passed).toBe(false);
      expect(result.metrics.pageTargetPassRate).toBe(0);
      expect(result.notes).toContain(pageTargetUnevaluatedNote);
    }
    expect(report.cases.every((entry) => entry.generationDurationMs >= 0)).toBe(
      true,
    );
    expect(
      report.cases.every((entry) => entry.generationDiagnostics === null),
    ).toBe(true);
    expect(report.notes).toEqual([]);
  }, 10_000);

  test("keeps thin profile cases ATS-safe while retaining the thin-output fail-closed gate", async () => {
    const report = await runDesktopResumeQualityBenchmark({
      benchmarkVersion: "023-test-benchmark-v1",
      caseIds: ["thin_profile"],
    });

    expect(report.cases).toHaveLength(8);
    for (const result of report.cases) {
      // A profile with no canonical work history is intentionally still thin.
      // Search metadata must not be injected as candidate evidence just to
      // make the benchmark appear submission-ready.
      expect(result.issueCategories).toContain("thin_output");
      expect(result.metrics.thinOutputFreeRate).toBe(0);
      expect(result.metrics.atsRenderPassRate).toBe(1);
      // Acceptance stays honest: the page gate has no measured page count in HTML renders.
      expect(result.metrics.pageTargetPassRate).toBe(0);
      expect(result.notes).toContain(pageTargetUnevaluatedNote);
      expect(result.passed).toBe(false);
    }
  }, 10_000);

  test("persists HTML artifacts when a target directory is provided", async () => {
    const persistArtifactsDirectory = await mkdtemp(
      path.join(os.tmpdir(), "resume-quality-report-artifacts-"),
    );

    try {
      const report = await runDesktopResumeQualityBenchmark({
        benchmarkVersion: "023-test-benchmark-v1",
        caseIds: ["grounded_baseline"],
        persistArtifactsDirectory,
      });

      expect(report.persistedArtifactsDirectory).toBe(
        persistArtifactsDirectory,
      );
      expect(report.cases).toHaveLength(8);

      for (const result of report.cases) {
        expect(result.htmlArtifactRelativePath).toBeTruthy();
        const htmlPath = path.join(
          persistArtifactsDirectory,
          result.htmlArtifactRelativePath ?? "",
        );
        const html = await readFile(htmlPath, "utf8");

        expect(html).toContain("<!doctype html>");
        expect(html).toContain("Alex Vanguard Resume");
      }
    } finally {
      await rm(persistArtifactsDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  test("renders broader archetype cases with grounded ATS-safe output", async () => {
    const report = await runDesktopResumeQualityBenchmark({
      benchmarkVersion: "023-test-benchmark-v1",
      caseIds: ["frontend_platform", "analytics_lead"],
    });

    expect(report.cases).toHaveLength(16);

    // Without a model in this run, composed lines are not fact-checked and
    // wait for the person (ADR 0041), so issue-free is not asserted here.
    for (const result of report.cases) {
      expect(result.metrics.atsRenderPassRate).toBe(1);
      expect(result.metrics.groundedVisibleSkillRate).toBe(1);
      expect(result.visibleSkills.length).toBeGreaterThan(0);
      // Acceptance stays honest: the page gate has no measured page count in HTML renders.
      expect(result.metrics.pageTargetPassRate).toBe(0);
      expect(result.notes).toContain(pageTargetUnevaluatedNote);
      expect(result.passed).toBe(false);
    }
  }, 20_000);

  test("includes real imported resume fixtures in the full quality corpus", () => {
    const realCaseIds = defaultResumeQualityBenchmarkCases
      .map((entry) => entry.definition.id)
      .filter((id) => id.startsWith("real_"));

    expect(realCaseIds).toEqual([
      "real_resume_import_comprehensive_txt",
      "real_persona_lina_txt",
      "real_persona_priya",
      "real_persona_dev",
      "real_persona_maya_docx",
      "real_persona_roberto_md",
    ]);
  });

  test("keeps every usable work-history record of an imported career changer visible in balanced tailoring", async () => {
    const report = await runDesktopResumeQualityBenchmark({
      benchmarkVersion: "030-test-real-fixture-v1",
      caseIds: ["real_persona_maya_docx"],
      templateIds: ["classic_ats"],
    });

    expect(report.cases).toHaveLength(1);
    for (const result of report.cases) {
      expect(result.metrics.workHistoryRepresentationRate).toBe(1);
      expect(result.metrics.visibleWorkHistoryCoverageRate).toBe(1);
      // Acceptance stays honest: the page gate has no measured page count in HTML renders.
      expect(result.metrics.pageTargetPassRate).toBe(0);
      expect(result.notes).toContain(pageTargetUnevaluatedNote);
      expect(result.passed).toBe(false);
      expect(result.metrics.fragmentFreeExperienceBulletRate).toBe(1);
      expect(result.metrics.professionalExperienceSummaryRate).toBe(1);
      expect(result.metrics.atsRenderPassRate).toBe(1);
      expect(result.issueCategories).not.toContain("thin_output");
    }

    const fixture = defaultResumeQualityBenchmarkCases.find(
      (entry) => entry.definition.id === "real_persona_maya_docx",
    );
    expect(fixture).toBeDefined();
    const state = await fixture!.buildState("classic_ats");
    const summerCampRole = state.profile.experiences.find(
      (experience) =>
        experience.title === "Summer Program Coordinator" &&
        experience.companyName === "Ohio STEM Camps",
    );
    expect(summerCampRole).toBeDefined();
    const coverage = deriveResumeCoveragePlan({
      profile: state.profile,
      searchPreferences: state.searchPreferences,
      job: state.savedJobs[0]!,
    });

    expect(
      coverage.find((entry) => entry.profileRecordId === summerCampRole!.id),
    ).toMatchObject({
      classification: "compact",
      careerFamilyFit: "weak",
    });
  }, 20_000);
});
