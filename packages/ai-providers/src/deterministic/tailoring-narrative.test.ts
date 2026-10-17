import { describe, expect, test } from "vitest";
import type { CandidateProfile } from "@nestor/contracts";
import {
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
} from "../test-fixtures";
import {
  buildDeterministicTailoredResume,
  buildDeterministicStructuredResumeDraft,
  VISIBLE_ADDITIONAL_SKILL_LIMIT,
  VISIBLE_CORE_SKILL_LIMIT,
} from "./tailoring";

type Experience = CandidateProfile["experiences"][number];

function createExperience(overrides: Partial<Experience>): Experience {
  return {
    id: "experience_1",
    companyName: "Signal Systems",
    companyUrl: null,
    title: "Software Engineer",
    employmentType: "Full-time",
    location: "Remote",
    workMode: ["remote" as const],
    startDate: "2023-01",
    endDate: null,
    isCurrent: true,
    isDraft: false,
    summary: null,
    achievements: [],
    skills: ["C#", ".NET"],
    domainTags: [],
    peopleManagementScope: null,
    ownershipScope: null,
    ...overrides,
  };
}

function buildInput(profile: CandidateProfile) {
  return {
    profile,
    searchPreferences: createPreferences(),
    settings: createSettings(),
    job: {
      ...createJobPosting(),
      title: ".NET Software Engineer",
      keySkills: ["C#", ".NET", "Docker", "Kubernetes", "Azure", "xUnit"],
      responsibilities: ["Build and deploy .NET services on Azure and AWS."],
      minimumQualifications: ["Experience with xUnit and Git."],
    },
    resumeText: profile.baseResume.textContent,
  };
}

describe("deterministic tailoring narrative presentation", () => {
  test("compacts an older role summary to whole sentences instead of clipped fragments", () => {
    const baseProfile = createProfile();
    const profile: CandidateProfile = {
      ...baseProfile,
      experiences: [
        createExperience({
          id: "experience_current",
          title: ".NET Software Engineer",
          summary:
            "Builds .NET services for the payments platform. Owns the deployment pipeline.",
          achievements: [
            "Migrated the payments API to .NET 8 with zero downtime.",
          ],
        }),
        createExperience({
          id: "experience_older",
          companyName: "Portal Works",
          title: ".NET Software Engineer",
          startDate: "2019-01",
          endDate: "2022-12",
          isCurrent: false,
          summary:
            "Built full-stack features for a customer portal, connecting modern UIs to secure APIs that handle payments and identity. Partnered with product on release planning.",
          achievements: [
            "Shipped internal tooling for the support team while learning testing, Git, and continuous delivery practices in a fast-moving squad.",
          ],
        }),
      ],
    };

    const draft = buildDeterministicTailoredResume(buildInput(profile));
    const olderEntry = draft.experienceEntries.find(
      (entry) => entry.profileRecordId === "experience_older",
    );

    expect(olderEntry).toBeDefined();
    for (const line of [
      olderEntry?.summary ?? "",
      ...(olderEntry?.bullets ?? []),
    ]) {
      expect(line).not.toMatch(/\bthat\.$/);
      expect(line).not.toMatch(/Git\.$/);
    }
    if (olderEntry?.summary) {
      expect(olderEntry.summary).toBe(
        "Built full-stack features for a customer portal, connecting modern UIs to secure APIs that handle payments and identity.",
      );
    }
    expect(olderEntry?.bullets).toContain(
      "Shipped internal tooling for the support team while learning testing, Git, and continuous delivery practices in a fast-moving squad.",
    );
  });

  test("presents an inline glyph list from a legacy summary as glyph-free bullets", () => {
    const baseProfile = createProfile();
    const profile: CandidateProfile = {
      ...baseProfile,
      experiences: [
        createExperience({
          id: "experience_current",
          title: ".NET Software Engineer",
          summary:
            "Owns the checkout platform. ● Cut p95 latency by 40% ● Introduced contract tests with xUnit ● Mentored two junior engineers",
          achievements: [],
        }),
      ],
    };

    const draft = buildDeterministicTailoredResume(buildInput(profile));
    const entry = draft.experienceEntries[0];

    expect(entry?.summary ?? "").not.toMatch(/[●•▪◦‣]/);
    expect(entry?.bullets.length).toBeGreaterThan(0);
    for (const bullet of entry?.bullets ?? []) {
      expect(bullet).not.toMatch(/[●•▪◦‣]/);
    }
    expect(entry?.bullets).toContain("Introduced contract tests with xUnit.");
    expect(draft.fullText).not.toMatch(/[●•▪◦‣]/);
  });

  test("keeps grounded job-named skills visible instead of dropping them for profile order", () => {
    const baseProfile = createProfile();
    const profile: CandidateProfile = {
      ...baseProfile,
      skills: [
        "Figma",
        "Notion",
        "Jira",
        "Confluence",
        "Miro",
        "Trello",
        "Slack",
        "Asana",
        "C#",
        ".NET",
        "Docker",
        "Kubernetes",
        "Azure",
        "AWS",
        "xUnit",
        "Git",
      ],
      skillGroups: {
        ...baseProfile.skillGroups,
        coreSkills: [],
        tools: [],
        languagesAndFrameworks: [],
        highlightedSkills: [],
      },
      experiences: [
        createExperience({
          id: "experience_current",
          title: ".NET Software Engineer",
          summary: "Builds .NET services on Azure.",
          achievements: [
            "Deployed containerised services with Docker and Kubernetes.",
          ],
          skills: [
            "C#",
            ".NET",
            "Docker",
            "Kubernetes",
            "Azure",
            "AWS",
            "xUnit",
          ],
        }),
      ],
    };

    const draft = buildDeterministicTailoredResume(buildInput(profile));
    const visibleSkills = [...draft.coreSkills, ...draft.additionalSkills];

    expect(draft.coreSkills.length).toBeLessThanOrEqual(
      VISIBLE_CORE_SKILL_LIMIT,
    );
    expect(draft.additionalSkills.length).toBeLessThanOrEqual(
      VISIBLE_ADDITIONAL_SKILL_LIMIT,
    );
    for (const skill of [
      "C#",
      "Docker",
      "Kubernetes",
      "Azure",
      "AWS",
      "xUnit",
    ]) {
      expect(visibleSkills).toContain(skill);
    }
    expect(draft.coreSkills.slice(0, 6)).toEqual(
      expect.arrayContaining(["C#", ".NET", "Docker"]),
    );
  });
});

test("fallback summary ignores listing/form evidence and omits absent candidate summaries", () => {
  const profile = createProfile();
  const candidate = {
    ...profile,
    summary: null,
    professionalSummary: {
      ...profile.professionalSummary,
      fullSummary: null,
      shortValueProposition: null,
    },
  };
  const input = {
    ...buildInput(candidate),
    evidence: {
      summary: ["Employer workshop. Apply now. Contact details."],
      candidateSummary: ["Employer workshop"],
      skills: [],
      keywords: [],
      experience: [],
    },
    availableTemplates: [],
    selectedTemplateId: "classic_ats" as const,
  };
  const fallback = buildDeterministicStructuredResumeDraft(input);
  expect(fallback.summary).toBe("");
  expect(fallback.fullText).not.toContain("Contact details");
  expect(
    buildDeterministicStructuredResumeDraft({
      ...input,
      profile: {
        ...candidate,
        summary: "Analyst with saved research experience.",
      },
    }).summary,
  ).toBe("Analyst with saved research experience.");
});
