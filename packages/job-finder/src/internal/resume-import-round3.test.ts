import {
  describeResumeIdentityOwnershipChoice,
  resolveResumeIdentity,
} from "./resume-identity";
import {
  toReviewDraft,
  shouldIncludeCandidateInSetupReview,
} from "./profile-setup-review-mapping";
import { describe, expect, test, vi } from "vitest";
import {
  ResumeImportFieldCandidateSchema,
  type ResumeImportFieldCandidate,
  type CandidateProfile,
} from "@nestor/contracts";
import {
  createAiClient,
  createFreshStartSeedProfile,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "../workspace-service.resume-analysis.shared";
import { reconcileCandidates } from "./resume-import-reconciliation";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./resume-import-apply";
import { promoteGroundedSharedMemoryCandidates } from "./resume-import-shared-memory-candidates";
import {
  RESUME_IMPORT_AI_UNAVAILABLE_MESSAGE,
  RESUME_IMPORT_CANCELLED_MESSAGE,
} from "./resume-import-workflow";

const seed = createSeed();
const text =
  "Fatima Noor\nfatima@example.test\nCopperline Studio\nDigital Marketing Intern\nJune 2025 - August 2025";
const bundle = createTestBundle({ fullText: text });
const fresh = (): CandidateProfile => ({
  ...createFreshStartSeedProfile(),
  experiences: [],
  projects: [],
  links: [],
  education: [],
  certifications: [],
  proofBank: [],
  applicationIdentity: {
    ...createFreshStartSeedProfile().applicationIdentity,
    preferredLinkIds: [],
  },
});
function candidate(
  section: ResumeImportFieldCandidate["target"]["section"],
  key: string,
  value: ResumeImportFieldCandidate["value"],
  recordId: string | null = null,
) {
  return ResumeImportFieldCandidateSchema.parse({
    ...createStageCandidate({
      target: { section, key, recordId },
      label: key,
      value,
      confidence: 0.95,
      overall: 0.95,
      sourceBlockIds: [bundle.blocks[0]!.id],
    }),
    id: `${section}_${key}_${recordId ?? "scalar"}`,
    runId: "round3",
    sourceKind: "model_background",
    resolution: "needs_review",
    createdAt: "2026-10-04T10:00:00.000Z",
  });
}
function apply(
  candidates: ResumeImportFieldCandidate[],
  profile = fresh(),
  confirmedCandidateId: string | null = null,
) {
  return applyResolvedResumeImportCandidatesToWorkspace({
    profile,
    searchPreferences: {
      ...seed.searchPreferences,
      workModes: [],
      targetRoles: [],
    },
    candidates,
    confirmedCandidateId,
    analysisProviderKind: "openai_compatible",
    analysisProviderLabel: "Test model",
    analysisWarnings: [],
  });
}

describe("round-three resume import regressions", () => {
  test("R3-041 reports an AI outage even if the context-only stage succeeds, and keeps the selected file", async () => {
    const ai = createAiClient();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      aiClient: {
        ...ai,
        getStatus: () => ({ ...ai.getStatus(), kind: "openai_compatible" }),
        extractResumeImportStage: (input) => {
          if (input.stage !== "shared_memory")
            return Promise.reject(new Error("connection refused"));
          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Context",
            candidates: [],
            notes: [],
          });
        },
      },
    });
    const baseResume = {
      ...seed.profile.baseResume,
      id: "resume_123",
      fileName: "fatima-noor.md",
      textContent: text,
    };
    await expect(
      workspaceService.runResumeImport({ baseResume, documentBundle: bundle }),
    ).rejects.toThrow(RESUME_IMPORT_AI_UNAVAILABLE_MESSAGE);
    expect((await repository.getProfile()).baseResume).toMatchObject({
      id: "resume_123",
      fileName: "fatima-noor.md",
      extractionStatus: "failed",
    });
    expect((await repository.getLatestResumeImportRun())?.errorMessage).toBe(
      RESUME_IMPORT_AI_UNAVAILABLE_MESSAGE,
    );
  });

  test("R3-163 cancels a pending read immediately and never applies its late result", async () => {
    const ai = createAiClient();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      aiClient: {
        ...ai,
        getStatus: () => ({ ...ai.getStatus(), kind: "openai_compatible" }),
        extractResumeImportStage: async (input) => {
          entered();
          await waiting;
          return {
            stage: input.stage,
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Model",
            candidates: [],
            notes: [],
          };
        },
      },
    });
    const controller = new AbortController();
    const result = workspaceService.runResumeImport({
      signal: controller.signal,
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_cancelled",
        textContent: text,
      },
      documentBundle: bundle,
    });
    const rejected = expect(result).rejects.toThrow(
      RESUME_IMPORT_CANCELLED_MESSAGE,
    );
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(
      (await repository.getLatestResumeImportRun())?.modelRoles?.text.status,
    ).toBe("failed");
    expect((await repository.getProfile()).baseResume.id).toBe(
      "resume_cancelled",
    );
    const before = await repository.getProfile();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await repository.getProfile()).toEqual(before);
  });

  test.each([
    ["workModes", ["onsite", "remote"]],
    ["targetRoles", ["Illustrator", "Visual Designer"]],
  ])(
    "R3-053/R3-086 imported %s fill the empty preference, but never replace a saved one",
    (key, values) => {
      const proposed = candidate("search_preferences", key, values);
      const emptyPreferences = {
        ...seed.searchPreferences,
        workModes: [],
        targetRoles: [],
      };
      const reconciled = reconcileCandidates(
        fresh(),
        emptyPreferences,
        [proposed],
        bundle,
        { readByModel: true },
      );
      expect(reconciled[0]?.resolution).toBe("auto_applied");
      expect(
        apply(reconciled, fresh()).searchPreferences[
          key as "workModes" | "targetRoles"
        ],
      ).toEqual(values);

      const saved = reconcileCandidates(
        seed.profile,
        seed.searchPreferences,
        [proposed],
        bundle,
        { readByModel: true },
      );
      expect(saved[0]?.resolution).toBe("needs_review");
    },
  );

  test("R3-028 preserves training project research, prototype and testing details", () => {
    const projects = [
      {
        name: "Pantry app",
        projectType: "training",
        role: "UX design student",
        summary: "Researched with eight users and built a Figma prototype.",
        skills: ["User research", "Figma"],
        outcome: "Tested with five participants.",
      },
      {
        name: "Library holds redesign",
        projectType: "volunteer",
        summary: "Researched the holds flow and built a prototype.",
        skills: ["User research"],
        outcome: "Tested the revised flow with participants.",
      },
    ].map((value, index) => ({
      ...candidate("project", "record", value, `project_${index}`),
      resolution: "auto_applied" as const,
    }));
    const result = apply(projects);
    expect(result.profile.projects[0]).toMatchObject(
      projects[0]!.value as object,
    );
    expect(result.profile.projects[1]).toMatchObject(
      projects[1]!.value as object,
    );
    expect(result.profile.experiences).toEqual([]);
  });

  test("R3-028 maps equivalent project field names without losing model-read evidence", () => {
    const project = candidate(
      "project",
      "record",
      {
        name: "Pantry app",
        type: "training",
        description: "Research with eight users and a Figma prototype.",
        technologies: ["Figma"],
        impact: "Tested with five participants.",
      },
      "pantry",
    );
    const reconciled = reconcileCandidates(
      fresh(),
      seed.searchPreferences,
      [project],
      bundle,
      { readByModel: true },
    );
    expect(apply(reconciled).profile.projects[0]).toMatchObject({
      projectType: "training",
      summary: "Research with eight users and a Figma prototype.",
      skills: ["Figma"],
      outcome: "Tested with five participants.",
    });
  });

  test("R3-054 retains a contact Website as one selectable public link", () => {
    const website = {
      ...candidate(
        "contact",
        "personalWebsiteUrl",
        "https://example.test/folio",
      ),
      resolution: "auto_applied" as const,
    };
    const first = apply([website]);
    const second = apply([website], first.profile);
    expect(second.profile.links).toHaveLength(1);
    expect(second.profile.links[0]).toMatchObject({
      label: "Website",
      url: "https://example.test/folio",
    });
    expect(second.profile.applicationIdentity.preferredLinkIds).toContain(
      second.profile.links[0]!.id,
    );
  });

  test("R3-055 completes a model-matched partial internship and retains all achievements", () => {
    const saved = {
      ...fresh(),
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          id: "partial_internship",
          companyName: "Copperline Studio",
          title: null,
          startDate: null,
          endDate: null,
          isCurrent: false,
          achievements: ["Wrote social captions.", "Created Canva assets."],
        },
      ],
    };
    const incoming = {
      ...candidate(
        "experience",
        "record",
        {
          companyName: "Copperline Studio",
          title: "Digital Marketing Intern",
          startDate: "2025-06",
          endDate: "2025-08",
          isCurrent: false,
          achievements: ["Improved campaign engagement."],
        },
        "partial_internship",
      ),
      resolution: "auto_applied" as const,
    };
    const result = apply([incoming], saved, incoming.id);
    expect(result.profile.experiences).toHaveLength(1);
    expect(result.profile.experiences[0]).toMatchObject({
      id: "partial_internship",
      title: "Digital Marketing Intern",
      startDate: "2025-06",
      endDate: "2025-08",
      achievements: [
        "Wrote social captions.",
        "Created Canva assets.",
        "Improved campaign engagement.",
      ],
    });
  });

  test.each([
    ["Copenhagen", "Denmark"],
    ["Hamburg", "Germany"],
  ])(
    "R3-096 preserves model-separated city and country for %s",
    (city, country) => {
      const proposed = [
        candidate("location", "currentLocation", `${city}, ${country}`),
        candidate("location", "currentCity", city),
        candidate("location", "currentCountry", country),
        candidate("location", "currentRegion", null),
      ];
      const reconciled = reconcileCandidates(
        fresh(),
        seed.searchPreferences,
        proposed,
        bundle,
        { readByModel: true },
      );
      const result = apply(reconciled);
      expect(result.profile).toMatchObject({
        currentCity: city,
        currentCountry: country,
        currentRegion: null,
      });
    },
  );

  test("R3-140 retains a labelled Dribbble public link", () => {
    const link = {
      ...candidate(
        "link",
        "record",
        {
          label: "Dribbble",
          kind: "other",
          url: "https://dribbble.com/synthetic-example",
        },
        "dribbble",
      ),
      resolution: "auto_applied" as const,
    };
    expect(apply([link]).profile.links[0]).toMatchObject({
      label: "Dribbble",
      url: "https://dribbble.com/synthetic-example",
    });
  });

  test("R3-223 imported evidence repeating a role achievement verbatim is dropped as a duplicate", () => {
    const proof = candidate(
      "proof_point",
      "record",
      {
        title: "Account Executive",
        claim: "Exceeded the sales target by 20%.",
      },
      "proof_sales",
    );
    const experience = {
      ...candidate(
        "experience",
        "record",
        {
          title: "Account Executive",
          companyName: "Example Sales",
          achievements: ["Exceeded the sales target by 20%."],
        },
        "sales",
      ),
      resolution: "auto_applied" as const,
    };
    expect(
      promoteGroundedSharedMemoryCandidates([experience, proof])[1],
    ).toMatchObject({
      resolution: "rejected",
      resolutionReason: "redundant_with_work_history",
    });
  });
});

test.each(["Hannah Berg", "Omar Farouk", "Fatima Noor"])(
  "uses the saved model-read identity for a # %s Markdown header",
  (name) => {
    const imported = {
      ...candidate("identity", "fullName", name),
      sourceKind: "model_identity_summary" as const,
      resolution: "auto_applied" as const,
    };
    const profile = apply([imported], {
      ...fresh(),
      baseResume: {
        ...fresh().baseResume,
        textContent: `# ${name}\nBA Visual\nMSc Business\nSocial Media Volunteer`,
      },
    }).profile;
    expect(profile.baseResume.sourceIdentity?.fullName).toBe(name);
    expect(describeResumeIdentityOwnershipChoice(profile).sourceFullName).toBe(
      name,
    );
    expect(resolveResumeIdentity(profile).mismatchReasons).toEqual([]);
  },
);
test("work modes produce a pending visible review draft", () => {
  const imported = candidate("search_preferences", "workModes", [
    "onsite",
    "remote",
  ]);
  expect(shouldIncludeCandidateInSetupReview(imported)).toBe(true);
  expect(toReviewDraft(imported, bundle)).toMatchObject({
    step: "targeting",
    proposedValue: "onsite, remote",
    sourceCandidateId: imported.id,
  });
});
test("retains the exact scheme-less Dribbble and portfolio links", () => {
  const links = [
    "dribbble.com/hannah-berg-example",
    "hannahberg.example.com",
  ].map((url, index) => ({
    ...candidate(
      "link",
      "record",
      { label: index ? "Portfolio" : "Dribbble", url },
      `link_${index}`,
    ),
    resolution: "auto_applied" as const,
  }));
  expect(apply(links).profile.links.map((link) => link.url)).toEqual([
    "https://dribbble.com/hannah-berg-example",
    "https://hannahberg.example.com/",
  ]);
});
test("proof review gives a plain achievement summary and its own reason", () => {
  const draft = toReviewDraft(
    candidate("proof_point", "record", {
      title: "Ledger rewrite",
      claim: "Reduced latency from 420ms to 85ms",
      heroMetric: "85ms",
      supportingContext: "Ledger rewrite",
      roleFamilies: ["Engineering"],
    }),
    bundle,
  );
  expect(draft?.proposedValue).toBe(
    "Reduced latency from 420ms to 85ms · 85ms · Ledger rewrite",
  );
  expect(draft?.reason).toBe(
    "Check this achievement before saving it for future applications.",
  );
  expect(draft?.proposedValue).not.toMatch(
    /Title:|Claim:|Hero Metric:|Role Families:/,
  );
});
test.each([22000, 33000, 32000])(
  "core profile finishes at %i ms while evidence takes 93000 ms",
  async (coreMs) => {
    vi.useFakeTimers();
    try {
      const ai = createAiClient();
      let evidenceCalls = 0;
      const evidenceFinished = vi.fn();
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        onResumeEvidenceFinished: evidenceFinished,
        aiClient: {
          ...ai,
          getStatus: () => ({ ...ai.getStatus(), kind: "openai_compatible" }),
          extractResumeImportStage: async (input) => {
            if (input.stage === "shared_memory") {
              evidenceCalls += 1;
              await new Promise((resolve) =>
                setTimeout(resolve, evidenceCalls === 1 ? 93000 : 1),
              );
              return {
                stage: input.stage,
                analysisProviderKind: "openai_compatible",
                analysisProviderLabel: "Test",
                candidates:
                  evidenceCalls === 1
                    ? []
                    : [
                        createStageCandidate({
                          target: {
                            section: "proof_point",
                            key: "record",
                            recordId: "proof_delayed",
                          },
                          label: "Achievement",
                          value: {
                            title: "Delivered work",
                            claim: "Delivered work on time",
                          },
                          confidence: 0.95,
                          overall: 0.95,
                          sourceBlockIds: [bundle.blocks[0]!.id],
                        }),
                      ],
                notes: [],
              };
            }
            await new Promise((resolve) => setTimeout(resolve, coreMs));
            return {
              stage: input.stage,
              analysisProviderKind: "openai_compatible",
              analysisProviderLabel: "Test",
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
                        value: seed.profile.fullName,
                        confidence: 0.95,
                        overall: 0.95,
                        sourceBlockIds: [bundle.blocks[0]!.id],
                      }),
                    ]
                  : [],
              notes: [],
            };
          },
        },
      });
      let finished = false;
      const result = workspaceService
        .runResumeImport({
          baseResume: {
            ...seed.profile.baseResume,
            textContent: seed.profile.fullName,
          },
          documentBundle: { ...bundle, fullText: seed.profile.fullName },
        })
        .then((result) => {
          finished = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(coreMs - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const core = await result;
      expect(core.latestResumeImportRun?.timing?.totalMs).toBeLessThanOrEqual(
        coreMs,
      );
      expect(
        core.latestResumeImportReviewCandidates.some(
          (candidate) => candidate.target.section === "proof_point",
        ),
      ).toBe(false);
      const savedProfile = await repository.getProfile();
      await vi.advanceTimersByTimeAsync(93001 - coreMs);
      await vi.advanceTimersByTimeAsync(0);
      expect(evidenceCalls).toBe(2);
      expect(
        (
          await repository.listResumeImportFieldCandidates({
            runId: core.latestResumeImportRun!.id,
          })
        ).some(
          (candidate) =>
            candidate.target.section === "proof_point" &&
            candidate.resolution === "needs_review",
        ),
      ).toBe(true);
      expect(await repository.getProfile()).toEqual(savedProfile);
      expect(evidenceFinished).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);
test("an empty evidence stage is retried once and then reported as failed", async () => {
  const ai = createAiClient();
  let evidenceCalls = 0;
  const { workspaceService } = createWorkspaceServiceHarness({
    aiClient: {
      ...ai,
      getStatus: () => ({ ...ai.getStatus(), kind: "openai_compatible" }),
      extractResumeImportStage: (input) => {
        if (input.stage === "shared_memory") evidenceCalls += 1;
        return Promise.resolve({
          stage: input.stage,
          analysisProviderKind: "openai_compatible",
          analysisProviderLabel: "Test",
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
                    value: seed.profile.fullName,
                    confidence: 0.95,
                    overall: 0.95,
                    sourceBlockIds: [bundle.blocks[0]!.id],
                  }),
                ]
              : [],
          notes: [],
        });
      },
    },
  });
  const result = await workspaceService.runResumeImport({
    baseResume: {
      ...seed.profile.baseResume,
      textContent: seed.profile.fullName,
    },
    documentBundle: { ...bundle, fullText: seed.profile.fullName },
  });
  expect(evidenceCalls).toBe(2);
  expect(
    result.latestResumeImportRun?.timing?.textStages.find(
      (stage) => stage.stage === "shared_memory",
    )?.status,
  ).toBe("failed");
});

test("evidence appears before a slow visual scan and survives its later save", async () => {
  const ai = createAiClient();
  let releaseEvidence!: () => void;
  let releaseVision!: () => void;
  const evidenceWait = new Promise<void>((resolve) => {
    releaseEvidence = resolve;
  });
  const visionWait = new Promise<void>((resolve) => {
    releaseVision = resolve;
  });
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    aiClient: {
      ...ai,
      getStatus: () => ({ ...ai.getStatus(), kind: "openai_compatible" }),
      extractResumeImportStage: async (input) => {
        if (input.stage === "shared_memory") await evidenceWait;
        return {
          stage: input.stage,
          analysisProviderKind: "openai_compatible",
          analysisProviderLabel: "Test",
          candidates:
            input.stage === "shared_memory"
              ? [
                  createStageCandidate({
                    target: {
                      section: "proof_point",
                      key: "record",
                      recordId: "proof_before_vision",
                    },
                    label: "Delivered work",
                    value: {
                      title: "Delivered work",
                      claim: "Delivered work on time",
                    },
                    sourceBlockIds: [bundle.blocks[0]!.id],
                    confidence: 0.95,
                    overall: 0.95,
                  }),
                ]
              : input.stage === "identity_summary"
                ? [
                    createStageCandidate({
                      target: {
                        section: "identity",
                        key: "fullName",
                        recordId: null,
                      },
                      label: "Name",
                      value: seed.profile.fullName,
                      sourceBlockIds: [bundle.blocks[0]!.id],
                      confidence: 0.95,
                      overall: 0.95,
                    }),
                  ]
                : [],
          notes: [],
        };
      },
    },
    visionProvider: {
      getStatus: () => ({
        ...ai.getStatus(),
        role: "vision",
        kind: "openai_compatible_vision",
      }),
      extractResumeVision: async () => {
        await visionWait;
        return {
          analysisProviderKind: "openai_compatible_vision",
          analysisProviderLabel: "Slow scan",
          primaryErrorMessage: null,
          candidates: [],
          notes: [],
          warnings: [],
        };
      },
    },
  });
  const sourceResumeId = seed.profile.baseResume.id;
  const result = await workspaceService.runResumeImport({
    baseResume: {
      ...seed.profile.baseResume,
      textContent: seed.profile.fullName,
    },
    documentBundle: { ...bundle, fullText: seed.profile.fullName },
    visionArtifact: {
      id: "slow_visual_scan",
      runId: "seed_run",
      sourceResumeId,
      sourceFileKind: "pdf",
      createdAt: "2026-10-04T00:00:00.000Z",
      retained: "temporary",
      warnings: [],
      pages: [
        {
          id: "page_1",
          sourceResumeId,
          sourceFileKind: "pdf",
          pageNumber: 1,
          renderKind: "pdf_page_image",
          mimeType: "image/png",
          width: 100,
          height: 100,
          byteLength: 4,
          sha256: "abc123",
          dataUrl: "data:image/png;base64,AAAA",
          storagePath: null,
          retained: "temporary",
          generatedAt: "2026-10-04T00:00:00.000Z",
          warnings: [],
        },
      ],
    },
  });
  const runId = result.latestResumeImportRun!.id;
  releaseEvidence();
  await vi.waitFor(async () =>
    expect(
      (await repository.listResumeImportFieldCandidates({ runId })).some(
        (candidate) =>
          candidate.target.recordId === "proof_before_vision" &&
          candidate.resolution === "needs_review",
      ),
    ).toBe(true),
  );
  expect(
    (await repository.getLatestResumeImportRun())?.modelRoles?.vision.status,
  ).toBe("running");
  releaseVision();
  await vi.waitFor(async () =>
    expect(
      (await repository.getLatestResumeImportRun())?.modelRoles?.vision.status,
    ).toBe("completed"),
  );
  expect(
    (await repository.listResumeImportFieldCandidates({ runId })).some(
      (candidate) => candidate.target.recordId === "proof_before_vision",
    ),
  ).toBe(true);
  expect(
    (await repository.getLatestResumeImportRun())?.timing?.textStages.some(
      (stage) =>
        stage.stage === "shared_memory" && stage.status === "completed",
    ),
  ).toBe(true);
});
