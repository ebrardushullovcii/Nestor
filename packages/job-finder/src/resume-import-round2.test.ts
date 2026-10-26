import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type ResumeImportFieldCandidate } from "@nestor/contracts";
import { extractLiteralCandidates } from "./internal/resume-import-literal-extraction";
import { reconcileCandidates } from "./internal/resume-import-reconciliation";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./internal/resume-import-apply";
import { toCandidate } from "./internal/resume-import-candidate-utils";
import {
  createFreshStartSeedProfile,
  createSeed,
} from "./test-fixtures";
import {
  createAiClient,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";

const now = "2026-10-02T10:00:00.000Z";
function fixture(name: string, extension = "txt") {
  return createTestBundle({
    fullText: readFileSync(
      new URL(
        `../test-fixtures/resume-import-round2-${name}.${extension}`,
        import.meta.url,
      ),
      "utf8",
    ),
  });
}
const profile = () => ({
  ...createFreshStartSeedProfile(),
  yearsExperience: null,
  experiences: [],
  education: [],
  skills: [],
  targetRoles: [],
  locations: [],
});
const preferences = () => ({
  ...createSeed().searchPreferences,
  targetRoles: [],
  locations: [],
});
function candidate(
  section: ResumeImportFieldCandidate["target"]["section"],
  key: string,
  value: ResumeImportFieldCandidate["value"],
  source = fixture("priya"),
  index = 0,
) {
  return toCandidate(
    source,
    "round2",
    "model_experience",
    now,
    createStageCandidate({
      target: { section, key, recordId: null },
      label: key,
      value,
      confidence: 0.95,
      overall: 0.95,
      sourceBlockIds: source.blocks.map((block) => block.id),
    }),
    index,
  );
}
function imported(
  candidates: ResumeImportFieldCandidate[],
  source: ReturnType<typeof fixture>,
) {
  const resolved = reconcileCandidates(
    profile(),
    preferences(),
    candidates,
    source,
  );
  return {
    resolved,
    ...applyResolvedResumeImportCandidatesToWorkspace({
      profile: profile(),
      searchPreferences: preferences(),
      candidates: resolved,
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Test",
      analysisWarnings: [],
    }),
  };
}
async function fallback(source: ReturnType<typeof fixture>) {
  const client = createAiClient();
  const candidates = extractLiteralCandidates("round2", source, now);
  for (const stage of [
    "identity_summary",
    "experience",
    "background",
    "shared_memory",
  ] as const) {
    const result = await client.extractResumeImportStage({
      stage,
      existingProfile: profile(),
      existingSearchPreferences: preferences(),
      documentBundle: source,
    });
    candidates.push(
      ...result.candidates.map((draft, index) =>
        toCandidate(
          source,
          "round2",
          `model_${stage === "identity_summary" ? "identity_summary" : stage}`,
          now,
          draft,
          index + candidates.length,
        ),
      ),
    );
  }
  return candidates;
}

describe("Round 2 resume import accuracy", () => {
  test.each([
    ["priya", "txt", 3, 0],
    ["maya", "txt", 1, 0],
    ["lina", "txt", 2, 2],
    ["dev", "txt", 2, 0],
    ["roberto", "md", 1, 1],
  ] as const)(
    "fallback imports each source record once for %s",
    async (name, extension, jobs, degrees) => {
      const source = fixture(name, extension);
      const result = imported(await fallback(source), source);
      expect(result.profile.experiences).toHaveLength(jobs);
      expect(result.profile.education).toHaveLength(degrees);
    },
  );
  test("R2-012/029/032 merges dual reads and preserves years and the header title", async () => {
    const source = fixture("priya");
    const candidates = await fallback(source);
    for (const [index, [companyName, title, startDate, endDate]] of [
      ["Raman Studio", "Freelance Product Designer", "2023-01", null],
      ["Penny Bank", "Product Designer", "2019-01", "2023-12"],
      ["CareLoop Health", "Product Designer", "2016-01", "2019-12"],
    ].entries())
      candidates.push(
        candidate(
          "experience",
          "record",
          {
            companyName: companyName ?? null,
            title: title ?? null,
            startDate: startDate ?? null,
            endDate: endDate ?? null,
            isCurrent: !endDate,
          },
          source,
          100 + index,
        ),
      );
    candidates.push(
      candidate(
        "identity",
        "headline",
        "Freelance Product Designer",
        source,
        105,
      ),
    );
    candidates.push(
      candidate(
        "search_preferences",
        "targetRoles",
        ["Senior Product Designer", "Freelance Product Designer"],
        source,
        106,
      ),
    );
    const result = imported(candidates, source);
    expect(result.profile.experiences).toHaveLength(3);
    expect(
      result.profile.experiences.find(
        (role) => role.companyName === "Penny Bank",
      ),
    ).toMatchObject({ startDate: "2019", endDate: "2023" });
    expect(
      result.profile.experiences.find(
        (role) => role.companyName === "CareLoop Health",
      ),
    ).toMatchObject({ startDate: "2016", endDate: "2019" });
    expect(result.profile.headline).toBe("Senior Product Designer");
    expect(result.searchPreferences.targetRoles).toEqual([
      "Senior Product Designer",
    ]);
  });
  test("keeps two separately dated roles with the same employer and title", async () => {
    const source = createTestBundle({
      fullText:
        "Sam Example\nsam@example.test\nExperience\nProduct Designer\nExample Studio\n2016 - 2018\n- Designed fictional tools.\nProduct Designer\nExample Studio\n2021 - 2023\n- Designed synthetic workflows.",
    });
    const result = imported(await fallback(source), source);
    expect(
      result.profile.experiences.map((role) => role.startDate).sort(),
    ).toEqual(["2016", "2021"]);
  });
  test("R2-012/031 splits the employer location and removes the home-city twin", async () => {
    const source = fixture("maya");
    const result = imported(
      [
        ...(await fallback(source)),
        candidate(
          "experience",
          "record",
          {
            title: "Student Teacher",
            companyName: "Lincoln Elementary, Dayton, OH",
            location: "Columbus, OH",
            startDate: "2015-01",
            endDate: "2015-05",
          },
          source,
          100,
        ),
      ],
      source,
    );
    expect(result.profile.experiences).toHaveLength(1);
    expect(result.profile.experiences[0]).toMatchObject({
      title: "Student Teacher",
      companyName: "Lincoln Elementary",
      location: "Dayton, OH",
      startDate: "2015-01",
      endDate: "2015-05",
    });
  });
  test("R2-034/069 rejects slash records and old targets and repairs wrapped skills", async () => {
    const source = fixture("dev");
    const result = imported(
      [
        ...(await fallback(source)),
        candidate(
          "experience",
          "record",
          {
            title: "/",
            companyName: null,
            startDate: "2022-01",
            isCurrent: true,
          },
          source,
          100,
        ),
        candidate(
          "search_preferences",
          "targetRoles",
          [
            "Senior Backend Engineer",
            "Staff Backend Engineer",
            "/",
            "Software Engineer II",
          ],
          source,
          101,
        ),
        candidate(
          "skill",
          "skills",
          ["Kubernetes", "Kubern", "etes"],
          source,
          102,
        ),
      ],
      source,
    );
    expect(result.profile.experiences).toHaveLength(2);
    expect(result.searchPreferences.targetRoles).toEqual([
      "Senior Backend Engineer",
      "Staff Backend Engineer",
    ]);
    expect(result.profile.skills).toContain("Kubernetes");
    expect(result.profile.skills).not.toEqual(
      expect.arrayContaining(["Kubern", "etes"]),
    );
  });
  test("keeps short skills that are also substrings of other source skills", async () => {
    const source = createTestBundle({
      fullText:
        "Sam Example\nsam@example.test\nSkills\nSQL, PostgreSQL, Go, Django",
    });
    const result = imported(
      [
        ...(await fallback(source)),
        candidate("skill", "skills", ["SQL", "Go"], source, 100),
      ],
      source,
    );
    expect(result.profile.skills).toEqual(
      expect.arrayContaining(["SQL", "Go"]),
    );
  });
  test("R2-033/068/069 retains two degrees, unknown starts and intact skills", async () => {
    const source = fixture("lina");
    const result = imported(
      [
        ...(await fallback(source)),
        candidate(
          "education",
          "record",
          {
            degree: "B.Sc. in Statistics",
            schoolName: "University of Beirut, Beirut, Lebanon",
            fieldOfStudy: "American",
            startDate: "2020-01",
            endDate: "2024-12",
          },
          source,
          100,
        ),
        candidate(
          "skill",
          "skills",
          ["Python (pandas", "scikit-learn)", "English (fluent)"],
          source,
          101,
        ),
        candidate("identity", "yearsExperience", 0, source, 102),
        candidate("identity", "headline", "Research Assistant", source, 103),
      ],
      source,
    );
    expect(result.profile.education).toHaveLength(2);
    expect(
      result.profile.education.every((degree) => degree.startDate === null),
    ).toBe(true);
    expect(
      result.profile.education.find(
        (degree) => degree.schoolName === "American University of Beirut",
      ),
    ).toMatchObject({
      degree: "B.Sc.",
      fieldOfStudy: "Statistics",
      endDate: "2024",
    });
    expect(result.profile.headline).toBe("Data Analyst");
    expect(result.profile.yearsExperience).not.toBe(0);
    expect(result.profile.skills).toEqual(
      expect.arrayContaining(["Python", "pandas", "scikit-learn"]),
    );
    expect(result.profile.skills.some((skill) => /[()]/.test(skill))).toBe(
      false,
    );
  });
  test("R2-034/035 keeps the source qualification and strips Markdown from all fields", async () => {
    const source = fixture("roberto", "md");
    const result = imported(
      [
        ...(await fallback(source)),
        candidate(
          "search_preferences",
          "targetRoles",
          [
            "operations manager",
            "supply chain manager",
            "**Operations Manager**",
          ],
          source,
          100,
        ),
      ],
      source,
    );
    expect(result.profile.education).toHaveLength(1);
    expect(result.profile.education[0]).toMatchObject({
      degree: "Licenciatura",
      schoolName: "Universidade do Porto",
      fieldOfStudy: "Management",
      startDate: null,
      endDate: "2010",
    });
    expect(result.searchPreferences.targetRoles).toEqual([
      "operations manager",
      "supply chain manager",
    ]);
    expect(JSON.stringify(result.profile)).not.toContain("**synthetic**");
    expect(result.profile.headline).toBe("Operations Manager");
  });
  test.each(["profile_and_preferences", "preferences_only"] as const)(
    "R2-009 preserves targets edited during %s import",
    async (editKind) => {
      const source = fixture("maya");
      const seed = createSeed();
      seed.profile = profile();
      seed.searchPreferences = preferences();
      const client = createAiClient();
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { repository, profileWork } = createProfileServiceHarness({
        seed,
        aiClient: {
          ...client,
          async extractResumeImportStage(input) {
            if (input.stage === "identity_summary") {
              entered();
              await gate;
            }
            return client.extractResumeImportStage(input);
          },
        },
      });
      const pending = profileWork.runResumeImport({
        baseResume: {
          ...seed.profile.baseResume,
          id: "maya",
          fileName: "maya.txt",
          textContent: source.fullText,
        },
        documentBundle: source,
      });
      await started;
      const targets = ["Learning Experience Designer", "Training Specialist"];
      const locations = ["Remote, US", "Columbus, OH"];
      const latestPreferences = {
        ...(await repository.getSearchPreferences()),
        targetRoles: targets,
        locations,
      };
      if (editKind === "profile_and_preferences")
        await repository.saveProfileAndSearchPreferences(
          {
            ...(await repository.getProfile()),
            targetRoles: targets,
            locations,
          },
          latestPreferences,
        );
      else await repository.saveSearchPreferences(latestPreferences);
      release();
      const result = await pending;
      expect(result.searchPreferences.targetRoles).toEqual(targets);
      expect(result.searchPreferences.locations).toEqual(locations);
      const candidates = await repository.listResumeImportFieldCandidates({
        runId: result.latestResumeImportRun?.id ?? "missing",
      });
      expect(
        candidates.some(
          (candidate) =>
            candidate.target.key === "targetRoles" &&
            candidate.resolution === "needs_review",
        ),
      ).toBe(true);
    },
  );
  test("R2-033 preserves a student's stated header identity", () => {
    const source = createTestBundle({
      fullText:
        "Sam Example\nData Science Student\nsam@example.test\nExperience\nResearch Assistant at Example Lab\n2023 - 2024",
    });
    const result = imported(
      [candidate("identity", "headline", "Research Assistant", source)],
      source,
    );
    expect(result.profile.headline).toBe("Data Science Student");
  });
  test("R2-033 keeps an unknown total empty instead of importing a model's default zero", () => {
    const source = createTestBundle({
      fullText:
        "Sam Example\nsam@example.test\nExperience\nData Analyst at Example Lab\n- Analyzed fictional data.",
    });
    const result = imported(
      [candidate("identity", "yearsExperience", 0, source)],
      source,
    );
    expect(result.profile.yearsExperience).toBeNull();
    expect(result.resolved[0]).toMatchObject({
      value: null,
      resolution: "needs_review",
    });
  });
  test.each([false, true])(
    "R2-082 rejects notes despite hallucinated model records: %s",
    async (hallucinate) => {
      const source = fixture("notes");
      const seed = createSeed();
      const { repository, profileWork } = createProfileServiceHarness({
        seed,
        aiClient: hallucinate
          ? {
              ...createAiClient(),
              extractResumeImportStage(input) {
                return Promise.resolve({
                  stage: input.stage,
                  analysisProviderKind: "deterministic" as const,
                  analysisProviderLabel: "Synthetic model output",
                  candidates:
                    input.stage === "identity_summary"
                      ? [
                          createStageCandidate({
                            target: {
                              section: "identity",
                              key: "fullName",
                              recordId: null,
                            },
                            label: "Name",
                            value: "Imaginary Example",
                            sourceBlockIds: [source.blocks[0]?.id ?? "notes"],
                            confidence: 0.95,
                            overall: 0.95,
                          }),
                        ]
                      : [],
                  notes: [],
                });
              },
            }
          : createAiClient(),
      });
      const before = await repository.getProfile();
      await expect(
        profileWork.runResumeImport({
          baseResume: {
            ...seed.profile.baseResume,
            id: "notes",
            fileName: "notes.txt",
            textContent: source.fullText,
          },
          documentBundle: source,
        }),
      ).rejects.toThrow(
        "No resume details were found in this file. Choose another file.",
      );
      expect(await repository.getProfile()).toEqual(before);
      expect((await repository.getLatestResumeImportRun())?.status).toBe(
        "failed",
      );
    },
  );
});
