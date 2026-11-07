import { describe, expect, test } from "vitest";
import { ResumeImportStageUnreadError } from "@nestor/ai-providers";
import type { ResumeImportFieldCandidate } from "@nestor/contracts";

import {
  createAiClient,
  createFreshStartSeedProfile,
  createSeed,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";

const TEXT = [
  "Robin Example",
  "robin@example.test",
  "Experience",
  "Analyst — Example Labs",
  "2021 - Present",
  "- Built a fictional dashboard.",
  "Work preferences",
  "Full-time, EUR 50,000 minimum",
  "Authorized to work in the European Union. No visa sponsorship required.",
].join("\n");

type StageName =
  | "identity_summary"
  | "experience"
  | "background"
  | "shared_memory";

/**
 * A model client: each stage returns what the model read, with the block it
 * read it from. A stage given an Error throws it, as an unread section does.
 */
function modelClient(
  reads: Partial<
    Record<
      StageName,
      | Array<{ section: string; key: string; value: unknown; line: string }>
      | Error
    >
  >,
) {
  const base = createAiClient();
  return {
    ...base,
    getStatus: () => ({
      ...base.getStatus(),
      kind: "openai_compatible" as const,
      label: "Test model",
    }),
    extractResumeImportStage(
      input: Parameters<typeof base.extractResumeImportStage>[0],
    ) {
      const read = reads[input.stage as StageName] ?? [];
      if (read instanceof Error) return Promise.reject(read);
      return Promise.resolve({
        stage: input.stage,
        analysisProviderKind: "openai_compatible" as const,
        analysisProviderLabel: "Test model",
        notes: [],
        candidates: read.map((entry, index) =>
          createStageCandidate({
            target: {
              section:
                entry.section as ResumeImportFieldCandidate["target"]["section"],
              key: entry.key,
              recordId:
                entry.key === "record" ? `${entry.section}_${index + 1}` : null,
            },
            label: entry.key,
            value: entry.value as ResumeImportFieldCandidate["value"],
            confidence: 0.95,
            overall: 0.95,
            sourceBlockIds: input.documentBundle.blocks
              .filter((block) => block.text.includes(entry.line))
              .map((block) => block.id),
          }),
        ),
      });
    },
  };
}

function freshSeed() {
  const seed = createSeed();
  seed.profile = {
    ...createFreshStartSeedProfile(),
    experiences: [],
    education: [],
    skills: [],
  };
  return seed;
}

function importInput(
  seed: ReturnType<typeof createSeed>,
  text = TEXT,
  id = "resume_model_path",
) {
  return {
    baseResume: {
      ...seed.profile.baseResume,
      id,
      fileName: `${id}.txt`,
      textContent: text,
    },
    documentBundle: createTestBundle({ fullText: text }),
  };
}

const IDENTITY = [
  {
    section: "identity",
    key: "fullName",
    value: "Robin Example",
    line: "Robin Example",
  },
  {
    section: "contact",
    key: "email",
    value: "robin@example.test",
    line: "robin@example.test",
  },
];
const ROLE = {
  section: "experience",
  key: "record",
  value: {
    companyName: "Example Labs",
    title: "Analyst",
    startDate: "2021",
    endDate: null,
    isCurrent: true,
    achievements: ["Built a fictional dashboard."],
  },
  line: "Analyst — Example Labs",
};

describe("resume import with a model (ADR 0041)", () => {
  test("keeps a language when the model calls its fields name and level", async () => {
    const seed = freshSeed();
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: modelClient({
        identity_summary: IDENTITY,
        background: [
          {
            section: "language",
            key: "record",
            value: { name: "French", level: "B2" },
            line: "French (B2)",
          },
        ],
      }),
    });
    const result = await profileWork.runResumeImport(
      importInput(seed, `${TEXT}\nSkills\nFrench (B2)`),
    );
    expect(result.profile.spokenLanguages).toEqual([
      expect.objectContaining({ language: "French", proficiency: "B2" }),
    ]);
  });

  test("the model's reading is the import; no rule reader adds candidates", async () => {
    const seed = freshSeed();
    const { profileWork, repository } = createProfileServiceHarness({
      seed,
      aiClient: modelClient({ identity_summary: IDENTITY, experience: [ROLE] }),
    });

    const snapshot = await profileWork.runResumeImport(importInput(seed));

    expect(snapshot.profile.fullName).toBe("Robin Example");
    expect(snapshot.profile.email).toBe("robin@example.test");
    const candidates = await repository.listResumeImportFieldCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.some((candidate) => candidate.sourceKind === "parser_literal"),
    ).toBe(false);
  });

  test("stated eligibility and work preferences the model read fill empty answers", async () => {
    const seed = freshSeed();
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: modelClient({
        identity_summary: [
          ...IDENTITY,
          {
            section: "work_eligibility",
            key: "authorizedWorkCountries",
            value: ["European Union"],
            line: "Authorized to work",
          },
          {
            section: "work_eligibility",
            key: "requiresVisaSponsorship",
            value: false,
            line: "Authorized to work",
          },
          {
            section: "search_preferences",
            key: "employmentTypes",
            value: ["Full-time"],
            line: "Full-time",
          },
        ],
        experience: [ROLE],
      }),
    });

    const snapshot = await profileWork.runResumeImport(importInput(seed));

    expect(snapshot.profile.workEligibility.authorizedWorkCountries).toEqual([
      "European Union",
    ]);
    expect(snapshot.profile.workEligibility.requiresVisaSponsorship).toBe(
      false,
    );
    expect(snapshot.searchPreferences.employmentTypes).toEqual(["Full-time"]);
  });

  test("a section the model could not read is named, and nothing is guessed for it", async () => {
    const seed = freshSeed();
    const unread = new ResumeImportStageUnreadError(
      "experience",
      "The backend is temporarily overloaded.",
    );
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: modelClient({ identity_summary: IDENTITY, experience: unread }),
    });

    const snapshot = await profileWork.runResumeImport(importInput(seed));

    expect(snapshot.profile.fullName).toBe("Robin Example");
    expect(snapshot.profile.experiences).toEqual([]);
    expect(snapshot.latestResumeImportRun?.warnings).toContain(unread.message);
  });

  test("a resume naming someone else adds nothing until the person reviews it", async () => {
    const seed = freshSeed();
    let reads: Parameters<typeof modelClient>[0] = {
      identity_summary: IDENTITY,
      experience: [ROLE],
    };
    const base = modelClient({});
    const client = {
      ...base,
      extractResumeImportStage(
        input: Parameters<typeof base.extractResumeImportStage>[0],
      ) {
        return modelClient(reads).extractResumeImportStage(input);
      },
    };
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: client,
    });
    await profileWork.runResumeImport(importInput(seed));

    reads = {
      identity_summary: [
        {
          section: "identity",
          key: "fullName",
          value: "Dev Other",
          line: "Dev Other",
        },
        {
          section: "contact",
          key: "email",
          value: "dev@example.test",
          line: "dev@example.test",
        },
      ],
      experience: [
        {
          ...ROLE,
          line: "Engineer — Other Corp",
          value: {
            ...ROLE.value,
            companyName: "Other Corp",
            title: "Engineer",
          },
        },
      ],
    };
    const snapshot = await profileWork.runResumeImport(
      importInput(
        seed,
        "Dev Other\ndev@example.test\nExperience\nEngineer — Other Corp\n2020 - Present\n- Built a fictional service.",
        "resume_other_person",
      ),
    );

    // Robin's profile keeps Robin's name and only Robin's job.
    expect(snapshot.profile.fullName).toBe("Robin Example");
    expect(
      snapshot.profile.experiences.map((entry) => entry.companyName),
    ).toEqual(["Example Labs"]);
    const held = snapshot.latestResumeImportReviewCandidates.filter(
      (candidate) =>
        (candidate.resolutionReason ?? "").startsWith(
          "identity_mismatch_requires_review",
        ),
    );
    expect(held.map((candidate) => candidate.target.section)).toEqual(
      expect.arrayContaining(["identity", "experience"]),
    );
  });
});

test("refresh reimports each complete accomplishment once and keeps saved answers", async () => {
  const seed = freshSeed();
  const accomplishment =
    "Lowered hosting costs by 18%. Moved idle workers to on-demand instances. Kept availability unchanged.";
  const source = `${TEXT}\n- ${accomplishment}`;
  const reader = modelClient({
    identity_summary: IDENTITY,
    experience: [
      { ...ROLE, value: { ...ROLE.value, achievements: [accomplishment] } },
    ],
  });
  const client = {
    ...reader,
    async extractResumeImportStage(
      input: Parameters<typeof reader.extractResumeImportStage>[0],
    ) {
      const result = await reader.extractResumeImportStage(input);
      return {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          ...candidate,
          target: {
            ...candidate.target,
            recordId:
              candidate.target.section === "experience"
                ? (input.existingProfile.experiences[0]?.id ??
                  candidate.target.recordId)
                : candidate.target.recordId,
          },
        })),
      };
    },
  };
  const { profileWork, repository, savedAnswers, readSavedAnswerRows } =
    createProfileServiceHarness({ seed, aiClient: client });
  const first = await profileWork.runResumeImport(importInput(seed, source));
  expect(first.profile.experiences[0]?.achievements).toEqual([accomplishment]);
  const role = first.profile.experiences[0]!;
  await repository.commitProfileUpdate((profile) => ({
    ...profile,
    experiences: [
      {
        ...role,
        achievements: [
          "Lowered hosting costs by 18%.",
          "Moved idle workers to on-demand instances.",
          "Kept availability unchanged.",
        ],
      },
    ],
  }));
  savedAnswers.upsert({
    key: "notice_period",
    kind: "other",
    prompt: "When can you start?",
    answer: "In three weeks",
  });
  const beforeAnswers = readSavedAnswerRows();
  const refreshed = await profileWork.analyzeProfileFromResume();
  const review = refreshed.profileSetupState.reviewItems.find(
    (item) => item.status === "pending" && item.target.domain === "experience",
  );
  expect(review).toBeDefined();
  await profileWork.applyProfileSetupReviewAction(review!.id, "confirm");
  const after = await repository.getProfile();
  expect(after.experiences).toHaveLength(1);
  expect(after.experiences[0]?.id).toBe(role.id);
  expect(after.experiences[0]?.achievements).toEqual([accomplishment]);
  expect(readSavedAnswerRows()).toEqual(beforeAnswers);
});
