import { describe, expect, test } from "vitest";
import {
  ResumeImportFieldCandidateSchema,
  type CandidateProfile,
} from "@nestor/contracts";
import { createResumeExtraction, createSeed } from "../test-fixtures";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./resume-import-apply";
import { mergeResumeExtractionIntoWorkspace } from "./profile-merge";

function savedProfile(): CandidateProfile {
  const profile = createSeed().profile;
  return {
    ...profile,
    professionalSummary: {
      ...profile.professionalSummary,
      strengths: [
        "systems thinking",
        "mentoring",
        "TypeScript",
        "delivery",
        "design",
        "communication",
        "curiosity",
      ],
      careerThemes: ["Building teams"],
    },
    skills: ["TypeScript", "systems thinking", "SQL"],
    skillGroups: {
      coreSkills: ["SQL"],
      tools: ["Git"],
      languagesAndFrameworks: ["TypeScript"],
      softSkills: ["mentoring"],
      highlightedSkills: ["delivery"],
    },
    proofBank: [
      {
        id: "saved-proof",
        title: "Delivery",
        claim: "Shipped the platform",
        heroMetric: "10 teams",
        supportingContext: "Led delivery",
        roleFamilies: ["engineering"],
        projectIds: ["project-one"],
        linkIds: ["link-one"],
      },
      {
        id: "other-proof",
        title: "Mentoring",
        claim: "Coached engineers",
        heroMetric: null,
        supportingContext: null,
        roleFamilies: [],
        projectIds: [],
        linkIds: [],
      },
    ],
  };
}

const at = "2026-11-06T06:00:00.000Z";
function candidate(section: string, key: string, value: unknown) {
  return ResumeImportFieldCandidateSchema.parse({
    id: `${section}-${key}`,
    runId: "reimport",
    target: { section, key, recordId: null },
    label: key,
    sourceKind: "parser_literal",
    value,
    valuePreview: key,
    evidenceText: key,
    sourceBlockIds: ["block"],
    confidence: 0.99,
    resolution: "auto_applied",
    resolutionReason: "high_confidence_literal_with_direct_evidence",
    createdAt: at,
    resolvedAt: at,
  });
}

function expectSavedFacts(result: CandidateProfile, saved: CandidateProfile) {
  expect(result.professionalSummary.strengths).toEqual(
    saved.professionalSummary.strengths,
  );
  expect(result.skills).toEqual(expect.arrayContaining(saved.skills));
  for (const key of Object.keys(saved.skillGroups) as Array<
    keyof CandidateProfile["skillGroups"]
  >) {
    expect(result.skillGroups[key]).toEqual(
      expect.arrayContaining(saved.skillGroups[key]),
    );
  }
  expect(result.proofBank).toEqual(saved.proofBank);
  for (const key of [
    "email",
    "phone",
    "portfolioUrl",
    "linkedinUrl",
  ] as const) {
    expect(result[key]).toBe(saved[key]);
  }
}

describe("resume import preserves saved facts", () => {
  test("an empty or unchanged read cannot repartition saved strengths", () => {
    const saved = savedProfile();
    const result = applyResolvedResumeImportCandidatesToWorkspace({
      profile: saved,
      searchPreferences: createSeed().searchPreferences,
      candidates: [],
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Test",
      analysisWarnings: [],
    });
    expectSavedFacts(result.profile, saved);
  });

  test("a partial repeated read unions skills and preserves all proof and its references", () => {
    const saved = savedProfile();
    const candidates = [
      candidate("skill", "skills", ["TypeScript", "Rust"]),
      candidate("skill", "skillGroups.coreSkills", ["TypeScript"]),
      candidate("skill", "skillGroups.highlightedSkills", [
        "mentoring",
        "TypeScript",
      ]),
      candidate("proof_point", "record", {
        ...saved.proofBank[0],
        heroMetric: null,
        supportingContext: null,
        roleFamilies: [],
        projectIds: [],
        linkIds: [],
      }),
    ];
    const apply = (profile: CandidateProfile) =>
      applyResolvedResumeImportCandidatesToWorkspace({
        profile,
        searchPreferences: createSeed().searchPreferences,
        candidates,
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        analysisWarnings: [],
      }).profile;
    const result = apply(saved);
    expectSavedFacts(result, saved);
    expect(result.skills).toContain("Rust");
    const repeated = apply(result);
    expectSavedFacts(repeated, saved);
    expect(repeated.skills).toEqual(result.skills);
    expect(repeated.skillGroups).toEqual(result.skillGroups);
  });

  test("the direct extraction path preserves contacts and saved lists too", () => {
    const saved = savedProfile();
    const extraction = createResumeExtraction({
      skills: ["TypeScript", "Rust"],
      skillGroups: {
        coreSkills: ["Rust"],
        tools: [],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
      },
      professionalSummary: {
        ...createResumeExtraction().professionalSummary,
        strengths: ["mentoring", "TypeScript"],
        careerThemes: ["Product delivery"],
      },
    });
    const result = mergeResumeExtractionIntoWorkspace(
      saved,
      createSeed().searchPreferences,
      extraction,
    ).profile;
    expectSavedFacts(result, saved);
    expect(result.skills).toContain("Rust");
    expect(result.professionalSummary.careerThemes).toEqual([
      "Building teams",
      "Product delivery",
    ]);
  });
});
