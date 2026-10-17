import { expect, test, vi } from "vitest";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import { ResumeProposalValidationError } from "@nestor/ai-providers";
import {
  createSeed,
  createAiClient,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  seedResumeDraft,
  buildResumeRenderDocument,
} from "./resume-workspace-structure";
import {
  buildResumeCoverageComparison,
  validateResumeDraft,
} from "./resume-workspace-helpers";
import {
  applyResumeLanguage,
  collectResumeLanguageFields,
  writeResumeLanguage,
} from "./resume-workspace-language";

function context() {
  const seed = createSeed();
  const job = {
    ...seed.savedJobs[0]!,
    description:
      "DISPONENT / SPEDITIONSKAUFMANN in Hamburg. Lagerlogistik und Schichtplanung.",
  };
  const draft = seedResumeDraft({
    profile: seed.profile,
    job,
    templateId: seed.settings.resumeTemplateId,
  });
  return { ...seed, job, draft };
}

test("unknown and repeated writer fields return typed repair feedback without changing the source", () => {
  const { draft } = context();
  const original = structuredClone(draft);
  const fields = collectResumeLanguageFields(draft);
  const field = fields[0]!;
  let failure: unknown;
  try {
    applyResumeLanguage(draft, {
      language: "English",
      translations: [
        { id: field.id, text: "First translation" },
        { id: field.id, text: "Conflicting repeated translation" },
        { id: "unknown_model_field", text: "Unknown translation" },
      ],
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ResumeProposalValidationError);
  if (!(failure instanceof ResumeProposalValidationError))
    throw new Error("Expected typed repair feedback");
  expect(failure.issues.map((issue) => issue.code)).toEqual([
    "resume_translation_repeated_field",
    "resume_translation_unknown_field",
  ]);
  expect(failure.issues.map((issue) => issue.path)).toEqual([
    ["languagePresentation", "translations", 1, "id"],
    ["languagePresentation", "translations", 2, "id"],
  ]);
  expect(failure.languageFields).toEqual(fields);
  expect(draft).toEqual(original);
  const corrected = applyResumeLanguage(draft, {
    language: "English",
    translations: [{ id: field.id, text: "Corrected translation" }],
  });
  expect(
    collectResumeLanguageFields(corrected).find(
      (candidate) => candidate.id === field.id,
    )?.text,
  ).toBe("Corrected translation");
  expect(
    collectResumeLanguageFields(corrected).filter(
      (candidate) => candidate.id !== field.id,
    ),
  ).toEqual(fields.filter((candidate) => candidate.id !== field.id));
});

test("translates every field together in one model call and keeps source structure", async () => {
  const { draft, job, profile } = context();
  const chatWithTools = vi.fn<NonNullable<JobFinderAiClient["chatWithTools"]>>(
    (messages) => {
      const payload = JSON.parse(messages[1]!.content) as {
        language: string | null;
        fields: Array<{ id: string; text: string }>;
      };
      expect(payload.language).toBeNull();
      expect(messages[0]!.content).toContain(
        "generic credential descriptions such as First aid",
      );
      return Promise.resolve({
        content: JSON.stringify({
          language: "German",
          listingLanguage: "German",
          translations: payload.fields.map((field) => ({
            id: field.id,
            text: field.id.endsWith(":label")
              ? "Berufserfahrung"
              : field.id.endsWith(":dateRange")
                ? "Januar 2020 – heute"
                : field.text,
          })),
        }),
      });
    },
  );
  const result = await writeResumeLanguage({
    aiClient: { chatWithTools },
    draft,
    job,
  });
  expect(chatWithTools).toHaveBeenCalledTimes(1);
  expect(result.writtenLanguage).toBe("German");
  expect(result.listingLanguage).toBe("German");
  const role = result.sections.find((section) => section.kind === "experience")!
    .entries[0]!;
  expect(role.profileRecordId).toBe(
    draft.sections.find((section) => section.kind === "experience")!.entries[0]!
      .profileRecordId,
  );
  expect(
    buildResumeRenderDocument(profile, result).sections.find(
      (section) => section.kind === "experience",
    )?.entries[0]?.dateRange,
  ).toBe("Januar 2020 – heute");
});

test("a chosen language overrides the listing and rejects incomplete translation", async () => {
  const { draft, job } = context();
  const chatWithTools = vi.fn<NonNullable<JobFinderAiClient["chatWithTools"]>>(
    (messages) => {
      expect(messages[1]!.content).toContain('"language":"English"');
      return Promise.resolve({
        content: JSON.stringify({ language: "English", translations: [] }),
      });
    },
  );
  await expect(
    writeResumeLanguage({
      aiClient: { chatWithTools },
      draft: { ...draft, language: "English" },
      job,
    }),
  ).rejects.toThrow("did not cover the whole resume");
  expect(draft.language).toBeUndefined();
});

test("a language change without AI keeps the existing draft and reports failure", async () => {
  const { draft, job } = context();
  await expect(
    writeResumeLanguage({
      aiClient: {},
      draft: { ...draft, language: "German" },
      job,
    }),
  ).rejects.toThrow("previous resume was kept");
});

test.each([null, "German"])(
  "generation uses the writer language %s without a translation call",
  async (language) => {
    const seed = createSeed();
    const base = createAiClient();
    const chatWithTools =
      vi.fn<NonNullable<JobFinderAiClient["chatWithTools"]>>();
    const createResumeDraft = vi.fn<JobFinderAiClient["createResumeDraft"]>(
      async (input) => {
        expect(input.language).toBe(language);
        expect(input.languageFields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "section_experience:label" }),
          ]),
        );
        return {
          ...(await base.createResumeDraft(input)),
          languagePresentation: {
            language: language ?? "English",
            translations: language
              ? [{ id: "section_experience:label", text: "Berufserfahrung" }]
              : [],
          },
        };
      },
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      aiClient: { ...base, createResumeDraft, chatWithTools },
    });
    if (language)
      await workspaceService.generateResume("job_ready", { language });
    else await workspaceService.generateResume("job_ready");
    await workspaceService.regenerateResumeDraft("job_ready");
    expect(createResumeDraft).toHaveBeenCalledTimes(2);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(await repository.getResumeDraftByJobId("job_ready")).toMatchObject({
      language,
      writtenLanguage: language ?? "English",
    });
    if (language)
      expect(
        (await repository.getResumeDraftByJobId("job_ready"))?.sections.find(
          (section) => section.kind === "experience",
        )?.label,
      ).toBe("Berufserfahrung");
  },
);

test("changing an existing Light draft translates once, checks translated text and never regenerates", async () => {
  const seed = createSeed();
  seed.savedJobs = seed.savedJobs.map((job) =>
    job.id === "job_ready"
      ? { ...job, resumeTailoringMode: "conservative" }
      : job,
  );
  const base = createAiClient();
  const createResumeDraft = vi.fn<JobFinderAiClient["createResumeDraft"]>(
    (input) => base.createResumeDraft(input),
  );
  const checkResumeClaims = vi.fn<
    NonNullable<JobFinderAiClient["checkResumeClaims"]>
  >((input) =>
    Promise.resolve(
      input.claims.map((claim) => ({
        id: claim.id,
        verdict: "supported" as const,
        reason: "Supported translated source facts",
        evidenceIds: [],
        style: null,
        fix: null,
      })),
    ),
  );
  const chatWithTools = vi.fn<NonNullable<JobFinderAiClient["chatWithTools"]>>(
    (messages) => {
      const payload = JSON.parse(messages[1]!.content) as {
        fields: Array<{ id: string; text: string }>;
      };
      return Promise.resolve({
        content: JSON.stringify({
          language: "German",
          translations: payload.fields.map((field) => ({
            ...field,
            text:
              field.id === "section_summary:text"
                ? "Erfahrene Fachkraft mit belegten Ergebnissen im Betrieb."
                : field.text,
          })),
        }),
      });
    },
  );
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...base, createResumeDraft, chatWithTools, checkResumeClaims },
  });
  const workspace = await workspaceService.getResumeWorkspace("job_ready");
  await workspaceService.saveResumeDraft({
    ...workspace.draft,
    language: "German",
  });
  expect(chatWithTools).toHaveBeenCalledTimes(1);
  expect(createResumeDraft).not.toHaveBeenCalled();
  expect(
    checkResumeClaims.mock.calls
      .flatMap(([input]) => input.claims)
      .map((claim) => claim.text),
  ).toContain("Erfahrene Fachkraft mit belegten Ergebnissen im Betrieb.");
  expect(
    (await repository.listSavedJobs()).find((job) => job.id === "job_ready")
      ?.resumeTailoringMode,
  ).toBe("conservative");
  const saved = await repository.getResumeDraftByJobId("job_ready");
  expect(saved).toMatchObject({
    language: "German",
    writtenLanguage: "German",
  });
  await workspaceService.saveResumeDraft(saved!);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test("translated imported lines and keywords keep their original field sources", async () => {
  const seed = context();
  const profile = {
    ...seed.profile,
    skills: ["Warehouse planning", "Inventory control"],
    spokenLanguages: [
      {
        id: "german",
        language: "German",
        proficiency: "C1",
        interviewPreference: false,
        notes: null,
      },
      {
        id: "polish",
        language: "Polish",
        proficiency: "Native",
        interviewPreference: false,
        notes: null,
      },
      {
        id: "english",
        language: "English",
        proficiency: "B1",
        interviewPreference: false,
        notes: null,
      },
    ],
    certifications: [
      {
        id: "first_aid",
        name: "First aid",
        issuer: null,
        issueDate: null,
        expiryDate: null,
        credentialUrl: null,
        isDraft: false,
      },
    ],
  };
  const job = seed.job;
  const draft = seedResumeDraft({
    profile,
    job,
    templateId: seed.settings.resumeTemplateId,
  });
  const result = await writeResumeLanguage({
    draft,
    job,
    aiClient: {
      chatWithTools: (messages) => {
        const payload = JSON.parse(messages[1]!.content) as {
          fields: Array<{ id: string; text: string }>;
        };
        return Promise.resolve({
          content: JSON.stringify({
            language: "German",
            translations: payload.fields.map(({ id, text }) => ({
              id,
              text: `Übersetzt: ${text}`,
            })),
          }),
        });
      },
    },
  });
  // Restoring an older translated draft changes its draft id, while its
  // original field links still point at the draft that was translated.
  const olderTranslated = { ...result, id: "restored-translated-draft" };
  const comparison = buildResumeCoverageComparison({
    profile,
    draft: olderTranslated,
  });
  expect(comparison.addedKeywords).toEqual([]);
  expect(comparison.removedKeywords).toEqual(
    buildResumeCoverageComparison({ profile, draft }).removedKeywords,
  );
  for (const role of comparison.roles) {
    expect(role.status).toBe("rewritten");
    expect(role.retainedClaimCount).toBe(role.originalClaimCount);
    for (const original of role.removedClaims)
      expect(
        role.addedClaims.some((added) =>
          original.sourceAchievementIds?.some((id) =>
            added.sourceAchievementIds?.includes(id),
          ),
        ),
      ).toBe(true);
  }
  const again = await writeResumeLanguage({
    draft: result,
    job,
    aiClient: {
      chatWithTools: (messages) => {
        const payload = JSON.parse(messages[1]!.content) as {
          fields: Array<{ id: string; text: string }>;
        };
        return Promise.resolve({
          content: JSON.stringify({
            language: "French",
            translations: payload.fields.map(({ id, text }) => ({
              id,
              text: `Traduit: ${text}`,
            })),
          }),
        });
      },
    },
  });
  expect(
    buildResumeCoverageComparison({ profile, draft: again }).addedKeywords,
  ).toEqual([]);
});

test("R3-183 a continued generation reads its persisted language request", async () => {
  const seed = createSeed();
  const base = createAiClient();
  const createResumeDraft = vi.fn<JobFinderAiClient["createResumeDraft"]>(
    async (input) => {
      expect(input.language).toBe("German");
      return {
        ...(await base.createResumeDraft(input)),
        languagePresentation: { language: "German", translations: [] },
      };
    },
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...base, createResumeDraft },
  });
  await workspaceService.saveResumeBatchCheckpoint({
    id: "continued",
    jobIds: ["job_ready"],
    activeJobIds: [],
    completedJobIds: [],
    done: false,
    stopRequested: false,
    running: true,
    resumedBatchIds: ["interrupted"],
    requests: [{ jobId: "job_ready", language: "German", regenerate: true }],
  });
  await workspaceService.generateResume("job_ready");
  await workspaceService.regenerateResumeDraft("job_ready");
  expect(createResumeDraft).toHaveBeenCalledTimes(2);
});

test("stored older translated experience lines without source links retain their original positions", async () => {
  const seed = createSeed();
  const experience = seed.profile.experiences[0]!;
  seed.profile.experiences = [
    {
      ...experience,
      summary: "Coordinated the daily team schedule.",
      achievements: [
        "Managed customer orders.",
        "Organized warehouse deliveries.",
      ],
    },
  ];
  const draft = seedResumeDraft({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  draft.language = "German";
  draft.writtenLanguage = "German";
  const entry = draft.sections.find((section) => section.kind === "experience")!
    .entries[0]!;
  entry.summary = "Koordination des täglichen Schichtplans.";
  entry.sourceRefs = [];
  entry.bullets[0]!.text = "Bearbeitung von Kundenaufträgen.";
  entry.bullets[1]!.text = "Organisation der Lagerlieferungen.";
  for (const bullet of entry.bullets) bullet.sourceRefs = [];
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  await repository.upsertResumeDraft(draft);
  const legacyValidation = validateResumeDraft({
    draft,
    profile: seed.profile,
    job: seed.savedJobs[0]!,
  });
  // Old persisted comparisons have no links on their translated rows.
  for (const role of legacyValidation.coverageComparison!.roles) {
    role.retainedClaimCount = 0;
    for (const claim of role.addedClaims) delete claim.sourceAchievementIds;
  }
  await repository.upsertResumeValidationResult(legacyValidation);
  const workspace = await workspaceService.getResumeWorkspace(draft.jobId);
  const role = workspace.validation!.coverageComparison!.roles[0]!;
  expect(role.retainedClaimCount).toBe(3);
  expect(role.status).toBe("rewritten");
  for (const [index, added] of role.addedClaims.entries()) {
    expect(added.sourceAchievementIds).toEqual(
      role.removedClaims[index]!.sourceAchievementIds,
    );
  }
});

test.each([
  { differentLanguage: true, listingLanguage: null, failsFirstRead: false },
  { differentLanguage: false, listingLanguage: null, failsFirstRead: false },
  { differentLanguage: true, listingLanguage: "German", failsFirstRead: false },
  { differentLanguage: true, listingLanguage: null, failsFirstRead: true },
])(
  "legacy listing-linked draft uses language evidence ($differentLanguage, $listingLanguage) and prefers original-line evidence",
  async ({ differentLanguage, listingLanguage, failsFirstRead }) => {
    const seed = createSeed();
    const original = seed.profile.experiences[0]!;
    seed.profile.experiences = [
      {
        ...original,
        summary: null,
        achievements: [
          "Managed customer orders.",
          "Organized warehouse deliveries.",
          "Coordinated the daily team schedule.",
        ],
      },
    ];
    const draft = seedResumeDraft({
      profile: seed.profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });
    draft.listingLanguage = listingLanguage;
    const section = draft.sections.find(
      (section) => section.kind === "experience",
    )!;
    const entry = section.entries[0]!;
    for (const [index, text] of [
      "Bearbeitung von Kundenaufträgen.",
      "Organisation der Lagerlieferungen.",
      "Koordination des täglichen Schichtplans.",
    ].entries()) {
      const bullet = entry.bullets[index]!;
      bullet.text = text;
      bullet.sourceRefs = [
        {
          id: `listing-${index}`,
          sourceKind: "job",
          sourceId: draft.jobId,
          snippet: "The listing asks for operations experience.",
        },
        {
          id: `resume-${index}`,
          sourceKind: "resume",
          sourceId: seed.profile.baseResume.id,
          snippet: "The entire original resume.",
        },
      ];
    }
    const validation = validateResumeDraft({
      draft,
      profile: seed.profile,
      job: seed.savedJobs[0]!,
    });
    validation.coverageComparison!.roles[0]!.addedClaims[1]!.sourceAchievementIds =
      [`experience:${original.id}:achievement:0`];
    validation.claimAssessments.find(
      (a) => a.bulletId === entry.bullets[1]!.id,
    )!.evidenceRefs = [
      {
        id: `claim_evidence_profile_experience:${original.id}:achievement:2_1`,
        sourceKind: "profile",
        sourceId: `experience:${original.id}:achievement:2`,
        snippet: "Organized warehouse deliveries.",
      },
    ];
    const chatWithTools = vi.fn<
      NonNullable<JobFinderAiClient["chatWithTools"]>
    >(() =>
      Promise.resolve({
        content: JSON.stringify({
          roles: [{ profileRecordId: original.id, differentLanguage }],
        }),
      }),
    );
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: { ...createAiClient(), chatWithTools },
    });
    await repository.upsertResumeDraft(draft);
    await repository.upsertResumeValidationResult(validation);
    if (failsFirstRead) {
      chatWithTools.mockRejectedValueOnce(
        new Error("Temporary language read failure"),
      );
      const reads = await Promise.all([
        workspaceService.getResumeWorkspace(draft.jobId),
        workspaceService.getResumeWorkspace(draft.jobId),
      ]);
      for (const read of reads)
        expect(
          read.validation!.coverageComparison!.roles[0]!.retainedClaimCount,
        ).toBe(1);
    }
    const workspace = await workspaceService.getResumeWorkspace(draft.jobId);
    const role = workspace.validation!.coverageComparison!.roles[0]!;
    expect(role.addedClaims[1]!.sourceAchievementIds).toEqual([
      `experience:${original.id}:achievement:1`,
    ]);
    expect(role.retainedClaimCount).toBe(differentLanguage ? 3 : 1);
    if (differentLanguage) {
      expect(role.status).toBe("rewritten");
      expect(
        role.addedClaims.map((claim) => claim.sourceAchievementIds),
      ).toEqual(role.removedClaims.map((claim) => claim.sourceAchievementIds));
    } else {
      expect(role.addedClaims[0]!.sourceAchievementIds).toBeUndefined();
    }
    await workspaceService.getResumeWorkspace(draft.jobId);
    expect(chatWithTools).toHaveBeenCalledTimes(
      listingLanguage ? 0 : failsFirstRead ? 2 : 1,
    );
  },
);

test("legacy comparison converts evidence coordinates with translated and unchanged lines in one role", async () => {
  const seed = createSeed();
  const experience = seed.profile.experiences[0]!;
  seed.profile.experiences = [
    {
      ...experience,
      summary: null,
      achievements: [
        "Managed customer orders.",
        "Organized warehouse deliveries.",
      ],
    },
  ];
  const draft = seedResumeDraft({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  const section = draft.sections.find((s) => s.kind === "experience")!;
  const entry = section.entries[0]!;
  const originals = [...entry.bullets];
  entry.bullets[0]!.text = "Bearbeitung von Kundenaufträgen.";
  entry.bullets[1]!.text = "Organisation der Lagerlieferungen.";
  entry.bullets.push({
    ...originals[0]!,
    id: "unchanged-original",
    text: "Managed customer orders.",
  });
  for (const bullet of entry.bullets)
    bullet.sourceRefs = [
      {
        id: `listing:${bullet.id}`,
        sourceKind: "job",
        sourceId: draft.jobId,
        snippet: "Operations role.",
      },
    ];
  const validation = validateResumeDraft({
    profile: seed.profile,
    draft,
    job: seed.savedJobs[0]!,
  });
  for (const [index, bullet] of entry.bullets.slice(0, 2).entries()) {
    validation.claimAssessments.find(
      (a) => a.bulletId === bullet.id,
    )!.evidenceRefs = [
      {
        id: `claim_evidence_profile_experience:${experience.id}:achievement:${index + 1}_1`,
        sourceKind: "profile",
        sourceId: `experience:${experience.id}:achievement:${index + 1}`,
        snippet: index
          ? "Organized warehouse deliveries."
          : "Managed customer orders.",
      },
    ];
  }
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  await repository.upsertResumeDraft(draft);
  await repository.upsertResumeValidationResult(validation);
  const workspace = await workspaceService.getResumeWorkspace(draft.jobId);
  const role = workspace.validation!.coverageComparison!.roles[0]!;
  expect(role.retainedClaimCount).toBe(2);
  expect(role.addedClaims.map((claim) => claim.sourceAchievementIds)).toEqual([
    [`experience:${experience.id}:achievement:0`],
    [`experience:${experience.id}:achievement:1`],
  ]);
  expect(draft.language).toBeUndefined();
  expect(draft.writtenLanguage).toBeUndefined();
});
