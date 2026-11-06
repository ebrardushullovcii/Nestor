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
    email: "synthetic@example.test",
    phone: "+49 555 0100",
    portfolioUrl: "https://portfolio.example.test",
    linkedinUrl: "https://linkedin.example.test/synthetic",
    githubUrl: "https://github.example.test/synthetic",
    personalWebsiteUrl: "https://synthetic.example.test",
    applicationIdentity: {
      ...profile.applicationIdentity,
      preferredEmail: "applications@example.test",
      preferredPhone: "+49 555 0101",
    },
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
    expect.arrayContaining(saved.professionalSummary.strengths),
  );
  expect(result.skills).toEqual(expect.arrayContaining(saved.skills));
  for (const key of Object.keys(saved.skillGroups) as Array<
    keyof CandidateProfile["skillGroups"]
  >) {
    expect(result.skillGroups[key]).toEqual(
      expect.arrayContaining(saved.skillGroups[key]),
    );
  }
  for (const savedEntry of saved.proofBank) {
    const entry = result.proofBank.find((entry) => entry.id === savedEntry.id);
    const { roleFamilies, projectIds, linkIds, ...savedFields } = savedEntry;
    expect(entry).toMatchObject(savedFields);
    expect(entry?.roleFamilies).toEqual(expect.arrayContaining(roleFamilies));
    expect(entry?.projectIds).toEqual(expect.arrayContaining(projectIds));
    expect(entry?.linkIds).toEqual(expect.arrayContaining(linkIds));
  }
  for (const key of [
    "email",
    "phone",
    "portfolioUrl",
    "linkedinUrl",
    "githubUrl",
    "personalWebsiteUrl",
  ] as const) {
    expect(result[key]).toBe(saved[key]);
  }
  expect(result.applicationIdentity.preferredEmail).toBe(
    saved.applicationIdentity.preferredEmail,
  );
  expect(result.applicationIdentity.preferredPhone).toBe(
    saved.applicationIdentity.preferredPhone,
  );
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
      candidate("skill", "skillGroups.tools", ["Docker"]),
      candidate("skill", "skillGroups.languagesAndFrameworks", ["Rust"]),
      candidate("skill", "skillGroups.softSkills", ["Collaboration"]),
      candidate("skill", "skillGroups.highlightedSkills", [
        "mentoring",
        "TypeScript",
        "Calm under pressure",
      ]),
      candidate("proof_point", "record", {
        ...saved.proofBank[0],
        heroMetric: null,
        supportingContext: null,
        roleFamilies: [],
        projectIds: [],
        linkIds: [],
      }),
      candidate("proof_point", "record", {
        title: "Reliability",
        claim: "Improved service uptime",
        roleFamilies: ["operations"],
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
    expect(result.skillGroups).toMatchObject({
      coreSkills: ["SQL", "TypeScript"],
      tools: ["Git", "Docker"],
      languagesAndFrameworks: ["TypeScript", "Rust"],
      softSkills: ["mentoring", "Collaboration"],
      highlightedSkills: [
        "delivery",
        "mentoring",
        "TypeScript",
        "Calm under pressure",
      ],
    });
    expect(result.proofBank).toHaveLength(3);
    expect(result.proofBank[2]).toMatchObject({
      title: "Reliability",
      claim: "Improved service uptime",
    });
    const repeated = apply(result);
    expectSavedFacts(repeated, saved);
    expect(repeated.skills).toEqual(result.skills);
    expect(repeated.skillGroups).toEqual(result.skillGroups);
    expect(repeated.proofBank).toEqual(result.proofBank);
  });

  test("the direct extraction path preserves contacts and saved lists too", () => {
    const saved = savedProfile();
    const extraction = createResumeExtraction({
      skills: ["TypeScript", "Rust"],
      skillGroups: {
        coreSkills: ["Rust"],
        tools: ["Docker"],
        languagesAndFrameworks: ["Rust"],
        softSkills: ["Collaboration"],
        highlightedSkills: ["Product delivery"],
      },
      professionalSummary: {
        ...createResumeExtraction().professionalSummary,
        strengths: ["mentoring", "TypeScript", "Calm under pressure"],
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
    expect(result.professionalSummary.strengths).toContain(
      "Calm under pressure",
    );
    expect(result.professionalSummary.careerThemes).toEqual([
      "Building teams",
      "Product delivery",
    ]);
  });

  test("null contact candidates cannot clear saved contacts", () => {
    const saved = savedProfile();
    const result = applyResolvedResumeImportCandidatesToWorkspace({
      profile: saved,
      searchPreferences: createSeed().searchPreferences,
      candidates: [
        ...[
          "email",
          "phone",
          "portfolioUrl",
          "linkedinUrl",
          "githubUrl",
          "personalWebsiteUrl",
        ].map((key) => candidate("contact", key, null)),
        candidate("application_identity", "preferredEmail", null),
        candidate("application_identity", "preferredPhone", null),
      ],
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Test",
      analysisWarnings: [],
    });
    expectSavedFacts(result.profile, saved);
  });

  test("new proof entries retain distinct IDs across repeated imports with the same title", () => {
    const apply = (profile: CandidateProfile, claim: string) =>
      applyResolvedResumeImportCandidatesToWorkspace({
        profile,
        searchPreferences: createSeed().searchPreferences,
        candidates: [
          candidate("proof_point", "record", { title: "Delivery", claim }),
        ],
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        analysisWarnings: [],
      }).profile;
    const first = apply(savedProfile(), "Released a new service");
    const second = apply(first, "Delivered a migration");
    const repeated = apply(second, "Delivered a migration");
    expectSavedFacts(repeated, savedProfile());
    expect(repeated.proofBank).toEqual(second.proofBank);
    expect(repeated.proofBank).toHaveLength(4);
    expect(new Set(repeated.proofBank.map((entry) => entry.id)).size).toBe(4);
  });

  test("a repeated LinkedIn website candidate cannot erase a saved website", () => {
    const saved = savedProfile();
    const result = applyResolvedResumeImportCandidatesToWorkspace({
      profile: saved,
      searchPreferences: createSeed().searchPreferences,
      candidates: [candidate("contact", "personalWebsiteUrl", saved.linkedinUrl)],
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Test",
      analysisWarnings: [],
    });
    expectSavedFacts(result.profile, saved);
  });
});
