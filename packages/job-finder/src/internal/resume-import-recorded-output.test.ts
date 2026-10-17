import { applyResolvedResumeImportCandidatesToWorkspace } from "./resume-import-apply";
import { describe, expect, test } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import type { ResumeImportTextStage } from "@nestor/contracts";
import {
  createAiClient,
  createSeed,
  createFreshStartSeedProfile,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "../workspace-service.resume-analysis.shared";

// Synthetic source and recorded section responses exercise the model path,
// including the field names that previously lost or misattributed these facts.
const source = [
  "Fatima Noor",
  "fatima@example.test",
  "Copenhagen, Denmark",
  "Digital Marketing Intern — Copperline Studio — June–August 2025",
  "Wrote captions and created Canva assets.",
  "Social Media Volunteer",
  "Education: MSc Business, 2026",
  "Certification: PGCE, 2026",
  "Goal: Illustrator or Visual Designer",
  "Skills: Excel (advanced), Workday (basic), Articulate Rise (learning)",
  "Pantry app — training UX project: research with eight users; Figma prototype; tested with five participants.",
  "Dribbble: https://dribbble.com/synthetic-example",
  "Ledger rewrite reduced latency from 420 ms to 85 ms.",
  "Languages: English native; French intermediate",
].join("\n");
const documentBundle = createTestBundle({ fullText: source });
const recorded = (
  section: Parameters<typeof createStageCandidate>[0]["target"]["section"],
  key: string,
  value: Parameters<typeof createStageCandidate>[0]["value"],
  recordId: string | null = null,
) =>
  createStageCandidate({
    target: { section, key, recordId },
    label: key,
    value,
    confidence: 0.99,
    overall: 0.99,
    sourceBlockIds: [documentBundle.blocks[0]!.id],
  });
const outputs: Record<ResumeImportTextStage, ReturnType<typeof recorded>[]> = {
  identity_summary: [
    recorded("identity", "fullName", "Fatima Noor"),
    recorded("contact", "email", "fatima@example.test"),
    recorded("location", "currentLocation", "Copenhagen, Denmark"),
    recorded("location", "currentCity", "Copenhagen"),
    recorded("location", "currentRegion", null),
    recorded("location", "currentCountry", "Denmark"),
    recorded("search_preferences", "targetRoles", [
      "Illustrator",
      "Visual Designer",
    ]),
  ],
  experience: [
    recorded(
      "experience",
      "record",
      {
        companyName: "Copperline Studio",
        title: "Digital Marketing Intern",
        startDate: "2025-06",
        endDate: "2025-08",
        isCurrent: false,
        achievements: ["Wrote captions and created Canva assets."],
        skills: ["Canva"],
      },
      "partial",
    ),
  ],
  background: [
    recorded("skill", "skills", [
      "Excel (advanced)",
      "Workday (basic)",
      "Articulate Rise (learning)",
    ]),
    recorded(
      "education",
      "record",
      {
        schoolName: "Example College",
        degree: "MSc Business",
        endDate: "2026",
      },
      "degree",
    ),
    recorded(
      "certification",
      "record",
      { name: "PGCE", issueDate: "2026" },
      "pgce",
    ),
    recorded(
      "project",
      "record",
      {
        name: "Pantry app",
        projectType: "training",
        role: "UX student",
        summary: "Research with eight users; Figma prototype.",
        skills: ["Figma"],
        outcome: "Tested with five participants.",
      },
      "pantry",
    ),
    recorded(
      "link",
      "record",
      {
        label: "Dribbble",
        kind: "other",
        url: "https://dribbble.com/synthetic-example",
      },
      "dribbble",
    ),
    recorded(
      "language",
      "record",
      { language: "English", proficiency: "native" },
      "english",
    ),
    recorded(
      "language",
      "record",
      { language: "French", proficiency: "intermediate" },
      "french",
    ),
  ],
  shared_memory: [
    recorded(
      "proof_point",
      "record",
      {
        title: "Ledger rewrite",
        claim: "Reduced latency from 420 ms to 85 ms.",
        heroMetric: "85 ms",
      },
      "ledger",
    ),
    recorded(
      "proof_point",
      "record",
      { title: "Sales target", claim: "Exceeded target by 20%." },
      "sales",
    ),
  ],
};

async function replay(refresh = false) {
  const seed = createSeed();
  seed.profile = CandidateProfileSchema.parse({
    ...createFreshStartSeedProfile(),
    fullName: "Fatima Noor",
    education: [],
    certifications: [],
    projects: [],
    links: [],
    spokenLanguages: [],
    skills: [],
    experiences: [
      {
        id: "partial",
        companyName: "Copperline Studio",
        title: null,
        achievements: ["Created Canva assets."],
      },
    ],
    baseResume: { ...seed.profile.baseResume, textContent: source },
  });
  const base = createAiClient();
  const seen: string[] = [];
  const harness = createWorkspaceServiceHarness({
    seed,
    aiClient: {
      ...base,
      getStatus: () => ({ ...base.getStatus(), kind: "openai_compatible" }),
      extractResumeImportStage: (input) => {
        seen.push(input.documentBundle.fullText ?? "");
        return Promise.resolve({
          stage: input.stage,
          analysisProviderKind: "openai_compatible",
          analysisProviderLabel: "Recorded synthetic model",
          candidates: outputs[input.stage],
          notes: [],
        });
      },
    },
  });
  if (refresh) await harness.workspaceService.analyzeProfileFromResume();
  else
    await harness.workspaceService.runResumeImport({
      baseResume: seed.profile.baseResume,
      documentBundle,
    });
  return {
    ...harness,
    before: seed.profile,
    seen,
    profile: await harness.repository.getProfile(),
    run: await harness.repository.getLatestResumeImportRun(),
  };
}

describe("recorded synthetic import responses", () => {
  test("R3-020 uses the model-read header instead of later roles and degrees", async () => {
    const result = await replay();
    expect(result.seen.length).toBeGreaterThanOrEqual(3);
    expect(
      result.seen.every(
        (text) =>
          text.includes("Fatima Noor") &&
          text.includes("Social Media Volunteer") &&
          text.includes("MSc Business"),
      ),
    ).toBe(true);
    expect(result.profile.fullName).toBe("Fatima Noor");
    const candidates = await result.repository.listResumeImportFieldCandidates({
      runId: result.run!.id,
    });
    expect(
      candidates
        .filter((candidate) => candidate.target.key === "fullName")
        .map((candidate) => candidate.value),
    ).toEqual(["Fatima Noor"]);
  });
  test("R3-028/R3-140 retains project evidence and labelled public links", async () => {
    const { profile } = await replay();
    expect(profile.projects[0]).toMatchObject({
      projectType: "training",
      summary: "Research with eight users; Figma prototype.",
      skills: ["Figma"],
      outcome: "Tested with five participants.",
    });
    expect(profile.links).toContainEqual(
      expect.objectContaining({
        label: "Dribbble",
        url: "https://dribbble.com/synthetic-example",
      }),
    );
  });
  test("R3-055 completes a model-matched role, preserving the person's achievements", async () => {
    const result = await replay();
    const candidates = await result.repository.listResumeImportFieldCandidates({
      runId: result.run!.id,
    });
    const role = candidates.find(
      (candidate) => candidate.target.section === "experience",
    )!;
    const profile = applyResolvedResumeImportCandidatesToWorkspace({
      profile: result.profile,
      searchPreferences: createSeed().searchPreferences,
      candidates: [{ ...role, resolution: "auto_applied" }],
      confirmedCandidateId: role.id,
      analysisProviderKind: "openai_compatible",
      analysisProviderLabel: "Recorded",
      analysisWarnings: [],
    }).profile;
    expect(profile.experiences).toHaveLength(1);
    expect(profile.experiences[0]).toMatchObject({
      id: "partial",
      title: "Digital Marketing Intern",
      startDate: "2025-06",
      endDate: "2025-08",
    });
    expect(profile.experiences[0]!.achievements).toContain(
      "Created Canva assets.",
    );
  });
  test("R3-086/R3-095/R3-096 keeps goals reviewable, credentials separate, and city/country structured", async () => {
    const result = await replay();
    expect(result.profile).toMatchObject({
      currentCity: "Copenhagen",
      currentRegion: null,
      currentCountry: "Denmark",
    });
    expect(
      result.profile.experiences.flatMap((role) => role.achievements),
    ).not.toContain("PGCE");
    expect(result.profile.education).toContainEqual(
      expect.objectContaining({ degree: "MSc Business", endDate: "2026" }),
    );
    expect(result.profile.certifications).toContainEqual(
      expect.objectContaining({ name: "PGCE", issueDate: "2026" }),
    );
    const candidates = await result.repository.listResumeImportFieldCandidates({
      runId: result.run!.id,
    });
    expect(
      candidates.find((candidate) => candidate.target.key === "targetRoles"),
    ).toMatchObject({
      resolution: "needs_review",
      value: ["Illustrator", "Visual Designer"],
    });
  });
  test("R3-151/R3-152 imports language records and preserves software qualifiers", async () => {
    const { profile } = await replay();
    expect(profile.spokenLanguages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ language: "English", proficiency: "native" }),
        expect.objectContaining({
          language: "French",
          proficiency: "intermediate",
        }),
      ]),
    );
    expect(profile.skills).toEqual(
      expect.arrayContaining([
        "Excel (advanced)",
        "Workday (basic)",
        "Articulate Rise (learning)",
      ]),
    );
  });
  test("R3-153/R3-223 keeps meaningful proof titles and exact metrics available for review", async () => {
    const result = await replay();
    const candidates = await result.repository.listResumeImportFieldCandidates({
      runId: result.run!.id,
    });
    expect(
      candidates.filter(
        (candidate) => candidate.target.section === "proof_point",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resolution: "needs_review",
          value: expect.objectContaining({
            title: "Ledger rewrite",
            heroMetric: "85 ms",
          }) as unknown,
        }),
        expect.objectContaining({
          resolution: "needs_review",
          value: expect.objectContaining({
            title: "Sales target",
            claim: "Exceeded target by 20%.",
          }) as unknown,
        }),
      ]),
    );
  });
  test("reading an older import again refreshes suggestions without replacing confirmed fields", async () => {
    const result = await replay(true);
    expect(result.profile.fullName).toBe(result.before.fullName);
    expect(result.profile.experiences).toEqual(result.before.experiences);
    expect(result.profile.projects).toEqual(result.before.projects);
    const candidates = await result.repository.listResumeImportFieldCandidates({
      runId: result.run!.id,
    });
    expect(
      candidates.some((candidate) => candidate.resolution === "needs_review"),
    ).toBe(true);
    expect(
      candidates.some((candidate) => candidate.resolution === "auto_applied"),
    ).toBe(false);
    expect(
      result.run?.timing?.textStages.find(
        (stage) => stage.stage === "identity_summary",
      ),
    ).toMatchObject({ status: "completed", providerKind: "openai_compatible" });
  });
});
