import { describe, expect, test, vi } from "vitest";
import {
  ResumeDraftSchema,
  ResumeImportFieldCandidateDraftSchema,
  CandidateExperienceSchema,
  CandidateProofBankEntrySchema,
  SourceIntelligenceArtifactSchema,
  type ResumeDraftPatch,
} from "@nestor/contracts";

import {
  buildWriterProfileOutline,
  leaveOffBulletsByPriority,
  mergeImportCandidateSets,
  runProfileCopilotAgentTask,
  runResumeEditAgentTask,
  runResumeGenerationAgentTask,
  runResumeImportStageAgentTask,
} from "./agent-capabilities";
import type {
  AgentCapableJobFinderAiClient,
  CreateResumeDraftInput,
} from "./shared";
import { ResumeProposalValidationError } from "./shared";
import {
  buildGroundedResumeRewriteModelPayload,
  buildResumeGenerationEvidenceCatalog,
} from "./resume-generation-grounding";
import { compactOpenAiCompatibleUserPayload } from "./openai-compatible-request-compaction";
import {
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
} from "./test-fixtures";
import { createDeterministicJobFinderAiClient } from "./deterministic";

function createToolClient(
  replies: Array<{
    content?: string;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>,
): AgentCapableJobFinderAiClient {
  const deterministic = createDeterministicJobFinderAiClient();
  let index = 0;
  return {
    ...deterministic,
    chatWithTools() {
      return Promise.resolve(replies[index++] ?? { toolCalls: [] });
    },
  };
}

describe("tool-using AI capabilities", () => {
  const composeCall = (
    id: string,
    args: Record<string, unknown> = { proposal: {} },
  ) => ({
    id,
    type: "function" as const,
    function: {
      name: "compose_resume_proposal",
      arguments: JSON.stringify(args),
    },
  });
  const cleanPreview = (templateId = "classic_ats") =>
    Promise.resolve({
      templateId,
      pageCount: 1,
      warnings: [],
      fileName: `preview-${templateId}.pdf`,
      requiredModelRepairs: [],
    });
  const flaggedSummaryRepair = {
    id: "issue_claim_grounding_summary",
    severity: "error" as const,
    category: "unsupported_claim" as const,
    sectionId: "summary",
    entryId: null,
    bulletId: null,
    message: "Saved evidence does not back this wording.",
    flaggedText: "Unsupported summary wording.",
  };
  const flaggedPreview = (personConfirmationCount = 0) =>
    Promise.resolve({
      templateId: "classic_ats",
      pageCount: 1,
      warnings: [],
      fileName: "preview.pdf",
      requiredModelRepairs: [flaggedSummaryRepair],
      personConfirmationCount,
    });
  const baseRequest = () => ({
    profile: createProfile(),
    searchPreferences: createPreferences(),
    settings: createSettings(),
    job: createJobPosting(),
    resumeText: "Saved base resume text",
  });

  test("a clean proposal is written, rendered and checked in one model call", async () => {
    let calls = 0;
    let offeredTools: string[] = [];
    let reasoningTask: string | undefined;
    const renderPreview = vi.fn(() => cleanPreview());
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools(_messages, tools, options) {
        calls += 1;
        offeredTools = tools.map((tool) => tool.function.name);
        reasoningTask = options?.reasoningTask;
        return Promise.resolve({
          toolCalls: [
            composeCall("compose", {
              proposal: {
                summary: {
                  text: "Builds reliable automation.",
                  evidenceRefs: ["profile:summary"],
                },
              },
            }),
          ],
        });
      },
    };

    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: { ...baseRequest(), renderPreview },
    });

    expect(calls).toBe(1);
    // Writing has its own effort, separate from the rest of the agent loop.
    expect(reasoningTask).toBe("resume_writer");
    expect(renderPreview).toHaveBeenCalledTimes(1);
    expect(offeredTools).not.toContain("read_resume_generation_context");
    expect(offeredTools).not.toContain("inspect_completed_resume");
    expect(result.summary).toContain("Builds reliable automation");
    expect(result.fullText).toContain("Builds reliable automation");
  });

  test.each([0, 1, 2])(
    "a JSON-encoded proposal with %s extra closing braces is decoded and checked without another writer call",
    async (extraBraces) => {
      const proposal = {
        summary: {
          text: "Builds reliable automation.",
          evidenceRefs: ["profile:summary"],
        },
      };
      const chatWithTools = vi.fn(() =>
        Promise.resolve({
          toolCalls: [
            composeCall("encoded_proposal", {
              proposal: JSON.stringify(proposal) + "}".repeat(extraBraces),
            }),
          ],
        }),
      );
      const renderPreview = vi.fn<
        NonNullable<CreateResumeDraftInput["renderPreview"]>
      >(() => cleanPreview());
      const result = await runResumeGenerationAgentTask({
        client: { ...createDeterministicJobFinderAiClient(), chatWithTools },
        substantivePrompt: "Write a grounded resume.",
        request: { ...baseRequest(), renderPreview },
      });
      expect(chatWithTools).toHaveBeenCalledOnce();
      expect(renderPreview).toHaveBeenCalledOnce();
      expect(renderPreview.mock.calls[0]?.[0]).toMatchObject({
        draft: { summary: proposal.summary.text },
      });
      expect(result.summary).toBe(proposal.summary.text);
    },
  );

  test.each(["not JSON", "[]", "null", "42"])(
    "an encoded proposal must still be a JSON object (%s)",
    async (proposal) => {
      const renderPreview = vi.fn(() => cleanPreview());
      const client: AgentCapableJobFinderAiClient = {
        ...createDeterministicJobFinderAiClient(),
        chatWithTools: () =>
          Promise.resolve({
            toolCalls: [composeCall("invalid_encoded_proposal", { proposal })],
          }),
      };
      await expect(
        runResumeGenerationAgentTask({
          client,
          substantivePrompt: "Write a grounded resume.",
          request: { ...baseRequest(), renderPreview },
        }),
      ).rejects.toThrow();
      expect(renderPreview).not.toHaveBeenCalled();
    },
  );

  test("forwards same-route reasoning continuation through the resume model adapter", async () => {
    const continuation = {
      kind: "reasoning_content" as const,
      route: "test-model",
      text: "private synthetic reasoning",
    };
    let turns = 0;
    let renders = 0;
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools(messages) {
        if (++turns === 2)
          expect(
            messages.find((message) => message.role === "assistant"),
          ).toMatchObject({ continuation });
        return Promise.resolve({
          ...(turns === 1 ? { continuation } : {}),
          toolCalls: [composeCall(`compose_${turns}`)],
        });
      },
    };
    await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Write a grounded resume.",
      request: {
        ...baseRequest(),
        // A refused proposal is the one case the writer is asked again.
        renderPreview: () => {
          if (++renders === 1)
            throw new ResumeProposalValidationError(
              "The synthetic render refused this proposal.",
              [],
            );
          return cleanPreview();
        },
      },
    });
    expect(turns).toBe(2);
  });

  test("invalid translation output returns current field IDs for repair", async () => {
    const oldFields = [{ id: "old_summary", text: "Saved summary" }];
    const freshFields = [
      { id: "current_summary", text: "Current assembled summary" },
    ];
    const renderedTranslations: unknown[] = [];
    let turn = 0;
    let repairFeedbackSeen = false;
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools(messages) {
        turn += 1;
        if (turn === 2) {
          const payload = JSON.parse(
            messages.find((message) => message.role === "user")!.content,
          ) as {
            languageFields: unknown;
            lastCheck: {
              renderedCleanly: boolean;
              validationIssues: Array<{ code: string }>;
            };
          };
          expect(payload.languageFields).toEqual(freshFields);
          expect(payload.lastCheck.renderedCleanly).toBe(false);
          expect(payload.lastCheck.validationIssues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "resume_translation_unknown_field",
              }),
            ]),
          );
          repairFeedbackSeen = true;
        }
        return Promise.resolve({
          toolCalls: [
            composeCall(`compose_${turn}`, {
              proposal: {
                languagePresentation: {
                  language: "English",
                  translations: [
                    {
                      id: turn === 1 ? "stale_field" : "current_summary",
                      text: "Supported final summary",
                    },
                  ],
                },
              },
            }),
          ],
        });
      },
    };
    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Write a grounded resume in the requested language.",
      request: {
        ...baseRequest(),
        resumeText: "Selected base resume",
        language: "English",
        languageFields: oldFields,
        renderPreview({ draft }) {
          const translations = draft.languagePresentation!.translations;
          renderedTranslations.push(translations);
          if (translations[0]?.id === "stale_field") {
            throw new ResumeProposalValidationError(
              "The resume writer returned an unknown or repeated field.",
              [
                {
                  code: "resume_translation_unknown_field",
                  message:
                    "Unknown translation field 'stale_field'. Use current_summary once.",
                  path: ["languagePresentation", "translations", 0, "id"],
                },
              ],
              freshFields,
            );
          }
          return Promise.resolve({
            templateId: "classic_ats",
            pageCount: 1,
            warnings: [],
            fileName: "synthetic.pdf",
            requiredModelRepairs: [],
            languageFields: freshFields,
          });
        },
      },
    });
    expect(turn).toBe(2);
    expect(repairFeedbackSeen).toBe(true);
    expect(renderedTranslations).toHaveLength(2);
    expect(result.languagePresentation?.translations).toEqual([
      { id: "current_summary", text: "Supported final summary" },
    ]);
  });

  test("missing language metadata is repaired with a precise proposal path", async () => {
    let turn = 0;
    let repairPath: unknown;
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools(messages) {
        turn += 1;
        if (turn === 2) {
          const payload = JSON.parse(
            messages.find((message) => message.role === "user")!.content,
          ) as { lastCheck: { validationIssues: Array<{ path: unknown }> } };
          repairPath = payload.lastCheck.validationIssues[0]?.path;
        }
        return Promise.resolve({
          toolCalls: [
            composeCall(`compose_${turn}`, {
              proposal:
                turn === 1
                  ? {}
                  : {
                      languagePresentation: {
                        language: "English",
                        translations: [],
                      },
                    },
            }),
          ],
        });
      },
    };
    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Write a grounded English resume.",
      request: {
        ...baseRequest(),
        resumeText: "Selected base resume",
        language: "English",
      },
    });
    expect(turn).toBe(2);
    expect(repairPath).toEqual(["proposal", "languagePresentation"]);
    expect(result.languagePresentation).toEqual({
      language: "English",
      translations: [],
    });
  });

  test("a local renderer failure remains terminal rather than being treated as repairable writing", async () => {
    const client = createToolClient([{ content: "{}" }]);
    await expect(
      runResumeGenerationAgentTask({
        client,
        substantivePrompt: "Write a grounded resume.",
        request: {
          ...baseRequest(),
          resumeText: "Selected base resume",
          renderPreview() {
            throw new Error("Local PDF renderer unavailable.");
          },
        },
      }),
    ).rejects.toThrow("permanent_failure");
  });

  test("resume context keeps all candidate facts and listing details without search diagnostics", async () => {
    const profile = createProfile();
    profile.experiences = Array.from({ length: 10 }, (_, index) =>
      CandidateExperienceSchema.parse({
        id: `experience_${index}`,
        companyName: `Synthetic company ${index}`,
        title: "Software engineer",
        workMode: ["remote"],
        summary: `Saved role summary ${index}`,
        achievements: Array.from(
          { length: 24 },
          (_, bullet) => `Saved achievement ${index}:${bullet}`,
        ),
      }),
    );
    profile.proofBank = Array.from({ length: 12 }, (_, index) =>
      CandidateProofBankEntrySchema.parse({
        id: `proof_${index}`,
        title: `Evidence ${index}`,
        claim: `Candidate proof ${index}`,
        heroMetric: `${index + 1} supported improvements`,
      }),
    );
    const preferences = createPreferences();
    const request: CreateResumeDraftInput = {
      profile,
      searchPreferences: preferences,
      settings: createSettings(),
      resumeText: "Complete selected base resume",
      language: "English",
      languageFields: [{ id: "header", text: "Current language field" }],
      researchContext: {
        companyNotes: ["Company product context"],
        domainVocabulary: ["Workflow automation"],
        priorityThemes: ["Accessibility"],
      },
      job: {
        ...createJobPosting(),
        description:
          "Full listing introduction.\n\n" +
          "Build accessible product workflows. ".repeat(400) +
          "\n\nMiddle requirement: Dutch C1.\n\n" +
          "Operate TypeScript services. ".repeat(400),
        minimumQualifications: Array.from(
          { length: 25 },
          (_, index) => `Full qualification ${index}`,
        ),
        benefits: ["Flexible work schedule"],
        sourceIntelligence: SourceIntelligenceArtifactSchema.parse({
          reliability: {
            failureFingerprints: ["DISCOVERY_DIAGNOSTIC_ONLY".repeat(1_000)],
          },
        }),
      },
    };
    const payloads: Record<string, unknown>[] = [];
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools(messages) {
        payloads.push(
          JSON.parse(
            messages.find((message) => message.role === "user")!.content,
          ) as Record<string, unknown>,
        );
        return Promise.resolve({
          toolCalls: [
            composeCall("compose", {
              proposal: {
                languagePresentation: {
                  language: "English",
                  translations: request.languageFields,
                },
              },
            }),
          ],
        });
      },
    };
    await runResumeGenerationAgentTask({
      client,
      request,
      substantivePrompt: "Write an evidence-grounded resume.",
    });

    expect(payloads).toHaveLength(1);
    const payload = payloads[0]!;
    // Records by id beside the evidence; their wording is evidence.
    expect(payload.candidateProfile).toEqual(
      // The selected base resume differs from the profile's, so both stay.
      buildWriterProfileOutline(profile, {
        textContent: profile.baseResume.textContent,
      }),
    );
    const evidenceTexts = new Set(
      buildResumeGenerationEvidenceCatalog(request).map((item) => item.text),
    );
    for (const experience of profile.experiences) {
      expect(evidenceTexts).toContain(experience.summary);
      for (const achievement of experience.achievements)
        expect(evidenceTexts).toContain(achievement);
    }
    for (const proof of profile.proofBank)
      expect(evidenceTexts).toContain(proof.claim);
    expect(payload.targetJob).toMatchObject({
      description: request.job.description,
      minimumQualifications: request.job.minimumQualifications,
      screeningHints: request.job.screeningHints,
      benefits: request.job.benefits,
    });
    expect(payload.groundingEvidence).toEqual({
      version: 1,
      items: buildResumeGenerationEvidenceCatalog(request),
    });
    expect(payload.baseResumeEvidenceRef).toBe("baseResume:text");
    expect(payload).not.toHaveProperty("baseResumeText");
    expect(payload.targetLanguage).toBe("English");
    expect(payload.languageFields).toEqual(request.languageFields);
    expect(payload.researchContext).toEqual(request.researchContext);
    expect(JSON.stringify(payload)).not.toMatch(
      /DISCOVERY_ONLY|DISCOVERY_DIAGNOSTIC_ONLY/,
    );
    expect(payload).not.toHaveProperty("fullTargetJob");
    expect(payload).not.toHaveProperty("selectedBaseResumeText");
    expect(payload).not.toHaveProperty("workingProposal");
    const grounded = buildGroundedResumeRewriteModelPayload(request);
    const previousPayload = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 196_000,
      systemPrompt: "Write an evidence-grounded resume.",
      userPayload: {
        ...grounded,
        fullTargetJob: request.job,
        candidateProfile: request.profile,
        selectedBaseResumeText: request.resumeText,
        searchPreferences: request.searchPreferences,
        generationStrategy: null,
        settings: request.settings,
        workingProposal: {},
      },
    });
    // The old loop sent this payload and then a context read carrying the
    // whole request again; one call now carries it once.
    const previousPayloadAndReadChars =
      JSON.stringify(previousPayload).length +
      JSON.stringify({ ...request, ...grounded }).length;
    expect(JSON.stringify(payload).length).toBeLessThan(
      previousPayloadAndReadChars / 10,
    );
  });

  test.each([
    { previewMs: 100_000, expectedCalls: 2 },
    { previewMs: 500_000, expectedCalls: 1 },
  ])(
    "resume generation excludes PDF queue wait and still counts $previewMs ms of preview work",
    async ({ previewMs, expectedCalls }) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let excludedMs = 0;
      let calls = 0;
      let renders = 0;
      try {
        const client: AgentCapableJobFinderAiClient = {
          ...createDeterministicJobFinderAiClient(),
          chatWithTools() {
            calls += 1;
            vi.setSystemTime(Date.now() + 200_000);
            return Promise.resolve({
              toolCalls: [composeCall(`compose_${calls}`)],
            });
          },
        };
        const run = runResumeGenerationAgentTask({
          client,
          substantivePrompt: "Write an evidence-grounded resume.",
          request: {
            ...baseRequest(),
            resumeText: "Selected base resume",
            getExcludedElapsedMs: () => excludedMs,
            renderPreview() {
              vi.setSystemTime(Date.now() + 700_000);
              excludedMs += 700_000;
              vi.setSystemTime(Date.now() + previewMs);
              // The first proposal is refused, so a second call happens only
              // while the counted time is inside the budget.
              if (++renders === 1)
                throw new ResumeProposalValidationError(
                  "The synthetic render refused this proposal.",
                  [],
                );
              return cleanPreview();
            },
          },
        });
        if (expectedCalls === 2) await expect(run).resolves.toBeTruthy();
        else await expect(run).rejects.toThrow(/timed out/u);
        expect(calls).toBe(expectedCalls);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("resume generation exposes exact grounding ids and listing-requested skills to the model", async () => {
    const deterministic = createDeterministicJobFinderAiClient();
    let visiblePayload: Record<string, unknown> | null = null;
    const client: AgentCapableJobFinderAiClient = {
      ...deterministic,
      chatWithTools(messages) {
        const userMessage = messages.find((message) => message.role === "user");
        visiblePayload = JSON.parse(userMessage?.content ?? "{}") as Record<
          string,
          unknown
        >;
        const evidence = visiblePayload.groundingEvidence as {
          items: Array<{ id: string; text: string }>;
        };
        const summaryEvidence =
          evidence.items.find((item) =>
            item.id.startsWith("profile:summary"),
          ) ?? evidence.items[0]!;
        return Promise.resolve({
          toolCalls: [
            composeCall("compose", {
              proposal: {
                summary: {
                  text: summaryEvidence.text,
                  evidenceRefs: [summaryEvidence.id],
                },
              },
            }),
          ],
        });
      },
    };
    const job = {
      ...createJobPosting(),
      minimumQualifications: ["Hands-on Kubernetes experience"],
    };
    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Aggressive mode substantive resume instructions.",
      request: {
        ...baseRequest(),
        searchPreferences: {
          ...createPreferences(),
          tailoringMode: "aggressive",
        },
        job,
      },
    });

    const capturedPayload = visiblePayload as unknown as {
      groundingEvidence: { items: unknown[] };
      targetJob: { listingRequestedSkills: string[] };
    };
    expect(capturedPayload.groundingEvidence.items.length).toBeGreaterThan(0);
    expect(capturedPayload.targetJob.listingRequestedSkills).toContain(
      "Kubernetes",
    );
    expect(result.summary).toContain("Builds reliable automation");
  });

  test("resume generation renders legacy JSON content before finishing", async () => {
    const client = createToolClient([
      {
        content: JSON.stringify({
          summary: {
            text: "Builds reliable automation.",
            evidenceRefs: ["profile:summary"],
          },
        }),
      },
    ]);

    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: baseRequest(),
    });

    expect(result.summary).toContain("Builds reliable automation");
    expect(result.fullText).toContain("Builds reliable automation");
  });

  test("resume generation records a completed empty proposal as an unchanged AI review", async () => {
    const client = createToolClient([{ content: "{}" }]);

    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: baseRequest(),
    });

    expect(result.generationQuality).toEqual(
      expect.objectContaining({
        proposedRewriteCount: 0,
        acceptedRewriteCount: 0,
      }),
    );
    expect(result.generationProvenance).toEqual({
      method: "ai",
      reason: null,
      detail:
        "AI completed the review without proposing wording changes, so your wording stayed unchanged.",
    });
    expect(result.notes).not.toContain(
      "Used the built-in deterministic resume tailorer.",
    );
  });

  test("a flagged render ends the writer in one call and keeps the draft for the check's fixes", async () => {
    let turn = 0;
    const renderPreview = vi.fn(() => flaggedPreview(2));
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools() {
        turn += 1;
        return Promise.resolve({
          toolCalls: [
            composeCall(`compose_${turn}`, {
              proposal: {
                summary: {
                  text: `Builds reliable automation ${turn}.`,
                  evidenceRefs: ["profile:summary"],
                },
              },
            }),
          ],
        });
      },
    };

    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Aggressive mode substantive resume instructions.",
      request: { ...baseRequest(), renderPreview },
    });

    // The flagged lines are settled from the check's own fixes when the
    // resume is kept; the writer is not asked again.
    expect(turn).toBe(1);
    expect(renderPreview).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("Builds reliable automation 1.");
    expect(result.notes.join(" ")).not.toContain("review");
  });

  test("a clean draft over the page target leaves off its lowest-priority bullets without another call", async () => {
    const achievements = [
      "Led the synthetic billing migration for four teams.",
      "Cut synthetic report time from two days to one hour.",
      "Wrote the synthetic onboarding guide for new analysts.",
      "Organised the synthetic team offsite agenda.",
    ];
    const request = baseRequest();
    request.profile.experiences = [
      CandidateExperienceSchema.parse({
        id: "role_1",
        title: "Analyst",
        companyName: "Synthetic Co",
        workMode: ["remote"],
        achievements,
      }),
    ];
    let turn = 0;
    const payloads: Array<Record<string, unknown>> = [];
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools(messages) {
        turn += 1;
        payloads.push(
          JSON.parse(
            messages.find((message) => message.role === "user")!.content,
          ) as Record<string, unknown>,
        );
        return Promise.resolve({
          toolCalls: [
            composeCall(`compose_${turn}`, {
              proposal: {
                experienceEntries: [
                  {
                    profileRecordId: "role_1",
                    bullets: achievements.map((text, index) => ({
                      text,
                      evidenceRefs: [`experience:role_1:achievement:${index}`],
                      sourceAchievementIds: [
                        `experience:role_1:achievement:${index}`,
                      ],
                      priority: [1, 2, 3, 3][index],
                    })),
                  },
                ],
              },
            }),
          ],
        });
      },
    };
    const renderedBullets: number[] = [];
    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: {
        ...request,
        targetPageCount: 2,
        renderPreview: ({ draft }) => {
          const bullets = draft.experienceEntries[0]?.bullets.length ?? 0;
          renderedBullets.push(bullets);
          return Promise.resolve({
            templateId: "classic_ats",
            pageCount: bullets > 2 ? 3 : 2,
            targetPageCount: 2,
            warnings: [],
            fileName: "preview.pdf",
            requiredModelRepairs: [],
          });
        },
      },
    });
    // One writer call; the over-long render is shortened by its priorities.
    expect(turn).toBe(1);
    expect(payloads[0]?.lengthBudget).toEqual({
      targetPageCount: 2,
      approximateWords: 720,
      approximateBullets: 30,
    });
    expect(renderedBullets).toEqual([4, 2]);
    expect(result.experienceEntries[0]?.bullets).toEqual(
      achievements.slice(0, 2),
    );
  });

  test("bullets without a priority stay, and a role keeps its most important bullet", () => {
    const proposal = {
      experienceEntries: [
        {
          profileRecordId: "a",
          bullets: [
            { text: "x", evidenceRefs: [], priority: 3 },
            { text: "y", evidenceRefs: [], priority: 2 },
          ],
        },
        {
          profileRecordId: "b",
          bullets: [{ text: "z", evidenceRefs: [] }],
        },
      ],
    };
    expect(leaveOffBulletsByPriority(proposal, 2)).toEqual({
      experienceEntries: [
        {
          profileRecordId: "a",
          bullets: [{ text: "y", evidenceRefs: [], priority: 2 }],
        },
        { profileRecordId: "b", bullets: [{ text: "z", evidenceRefs: [] }] },
      ],
    });
    expect(leaveOffBulletsByPriority(proposal.experienceEntries[1]!, 2)).toBe(
      null,
    );
  });

  test("resume generation keeps the last cleanly rendered AI draft when the call budget ends mid-revision", async () => {
    let renders = 0;
    let turn = 0;
    const client: AgentCapableJobFinderAiClient = {
      ...createDeterministicJobFinderAiClient(),
      chatWithTools() {
        turn += 1;
        const proposal = (revision: number) => ({
          proposal: {
            summary: {
              text: "Builds reliable automation.",
              evidenceRefs: ["profile:summary"],
            },
            revision,
          },
        });
        // The model composes a clean draft and, in the same turn, a revision
        // the check flags; it keeps revising until the budget ends.
        return Promise.resolve({
          toolCalls:
            turn === 1
              ? [
                  composeCall("clean", proposal(1)),
                  composeCall("revise", proposal(2)),
                ]
              : [composeCall(`revise_${turn}`, proposal(turn + 1))],
        });
      },
    };

    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Aggressive mode substantive resume instructions.",
      request: {
        ...baseRequest(),
        searchPreferences: {
          ...createPreferences(),
          tailoringMode: "aggressive",
        },
        renderPreview: () =>
          ++renders === 1 ? cleanPreview() : flaggedPreview(),
      },
    });

    expect(result.summary).toContain("Builds reliable automation");
  });

  test("resume generation rejects an incomplete agent task instead of grading an empty draft", async () => {
    const client = createToolClient(
      Array.from({ length: 8 }, () => ({ toolCalls: [] })),
    );

    await expect(
      runResumeGenerationAgentTask({
        client,
        substantivePrompt: "Balanced mode substantive resume instructions.",
        request: baseRequest(),
      }),
    ).rejects.toThrow(
      "Resume generation agent stopped before completing (no_progress).",
    );
  });

  const templateRequest = (
    renderPreview: (input: {
      templateId: string;
    }) => ReturnType<typeof cleanPreview>,
    locked = false,
  ) => ({
    ...baseRequest(),
    selectedTemplateId: "classic_ats",
    templateSelectionLocked: locked,
    availableTemplates: [
      {
        id: "classic_ats" as const,
        label: "Chronology Classic",
        description: "General apply-safe layout.",
        bestFor: ["General applications"],
        density: "balanced" as const,
        applyEligible: true,
      },
      {
        id: "compact_exec" as const,
        label: "Senior Brief",
        description: "Compact apply-safe layout.",
        bestFor: ["Experienced candidates"],
        density: "compact" as const,
        applyEligible: true,
      },
    ],
    renderPreview,
  });

  test("resume generation can choose an unlocked template and renders with it", async () => {
    const renderPreview = vi.fn(({ templateId }: { templateId: string }) =>
      cleanPreview(templateId),
    );
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "select",
            type: "function",
            function: {
              name: "select_resume_template",
              arguments: JSON.stringify({ templateId: "compact_exec" }),
            },
          },
          composeCall("compose"),
        ],
      },
    ]);

    const result = await runResumeGenerationAgentTask({
      client,
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: templateRequest(renderPreview),
    });

    expect(result.recommendedTemplateId).toBe("compact_exec");
    expect(renderPreview).toHaveBeenCalledTimes(1);
    expect(renderPreview).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "compact_exec" }),
    );
  });

  test("the proposal call can pick the template itself, unless the person locked one", async () => {
    let offeredTemplates: unknown;
    const unlockedRender = vi.fn(({ templateId }: { templateId: string }) =>
      cleanPreview(templateId),
    );
    const unlocked = await runResumeGenerationAgentTask({
      client: {
        ...createDeterministicJobFinderAiClient(),
        chatWithTools(messages) {
          offeredTemplates = (
            JSON.parse(
              messages.find((message) => message.role === "user")!.content,
            ) as { templateSelection: { availableTemplates: unknown } }
          ).templateSelection.availableTemplates;
          return Promise.resolve({
            toolCalls: [
              composeCall("compose", {
                proposal: {},
                templateId: "compact_exec",
              }),
            ],
          });
        },
      },
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: templateRequest(unlockedRender),
    });
    expect(offeredTemplates).toEqual([
      { id: "classic_ats", label: "Chronology Classic" },
      { id: "compact_exec", label: "Senior Brief" },
    ]);
    expect(unlocked.recommendedTemplateId).toBe("compact_exec");
    expect(unlockedRender).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "compact_exec" }),
    );

    const lockedRender = vi.fn(({ templateId }: { templateId: string }) =>
      cleanPreview(templateId),
    );
    const locked = await runResumeGenerationAgentTask({
      client: createToolClient([
        {
          toolCalls: [
            composeCall("compose", {
              proposal: {},
              templateId: "compact_exec",
            }),
          ],
        },
      ]),
      substantivePrompt: "Balanced mode substantive resume instructions.",
      request: templateRequest(lockedRender, true),
    });
    expect(locked.recommendedTemplateId).toBe("classic_ats");
    expect(lockedRender).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "classic_ats" }),
    );
  });

  test.each(["identity_summary", "experience", "background"] as const)(
    "resume import exposes layout inspection and typed %s candidates",
    async (stage) => {
      const deterministic = createDeterministicJobFinderAiClient();
      let calls = 0;
      let toolNames: string[] = [];
      let sectionValues: string[] = [];
      let instructions = "";
      const client: AgentCapableJobFinderAiClient = {
        ...deterministic,
        chatWithTools(messages, tools) {
          instructions = JSON.stringify(messages);
          toolNames = tools.map((tool) => tool.function.name);
          const record = tools.find(
            (tool) => tool.function.name === "record_import_candidates",
          );
          const parameters = record?.function.parameters as unknown as {
            properties?: {
              candidates?: {
                items?: {
                  properties?: {
                    target?: { properties?: { section?: { enum?: string[] } } };
                  };
                };
              };
            };
          };
          sectionValues =
            parameters.properties?.candidates?.items?.properties?.target
              ?.properties?.section?.enum ?? [];
          calls += 1;
          return Promise.resolve({
            toolCalls: [
              {
                id: `import_${calls}`,
                type: "function" as const,
                function: {
                  name: calls === 1 ? "inspect_document_layout" : "finish_task",
                  arguments: "{}",
                },
              },
            ],
          });
        },
      };

      const result = await runResumeImportStageAgentTask({
        client,
        request: {
          stage,
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          documentBundle: {
            id: "bundle_1",
            runId: "run_1",
            sourceResumeId: "resume_1",
            sourceFileKind: "pdf",
            primaryParserKind: "pdfjs_text",
            parserKinds: ["pdfjs_text"],
            createdAt: "2026-09-14T10:00:00.000Z",
            languageHints: ["en"],
            warnings: [],
            pages: [],
            blocks: [],
            fullText: "Robin Ashford\nPlatform engineer",
          },
        },
      });

      expect(toolNames).toContain("inspect_document_layout");
      expect(sectionValues).toContain(
        stage === "identity_summary"
          ? "identity"
          : stage === "background"
            ? "education"
            : "experience",
      );
      if (stage === "experience") {
        expect(instructions).toContain("achievements (array of strings)");
        expect(instructions).toContain("each achievement under that role");
        expect(instructions).toContain("read_resume_document");
        expect(instructions).toContain("read_existing_profile");
      }
      if (stage === "background") {
        expect(instructions).toContain("complete skills array");
        expect(instructions).toContain("schoolName, degree, fieldOfStudy");
      }
      expect(result).toMatchObject({
        stage,
        candidates: [],
      });
    },
  );

  test("a partial candidate save keeps the fields recorded earlier", () => {
    const candidate = (section: string, key: string, value: string) =>
      ResumeImportFieldCandidateDraftSchema.parse({
        target: { section, key, recordId: null },
        label: key,
        value,
        sourceBlockIds: ["block_1"],
        confidence: 0.9,
      });
    const first = {
      candidates: [
        candidate("identity", "fullName", "Robin Ashford"),
        candidate("contact", "email", "robin@example.test"),
        candidate("location", "region", "Greater Manchester"),
      ],
      notes: ["header read"],
    };
    // The model corrects only the region on its next turn.
    const merged = mergeImportCandidateSets(first, {
      candidates: [candidate("location", "region", "Manchester")],
      notes: ["header read", "region corrected"],
    });

    expect(
      merged.candidates.map((entry) => [entry.target.key, entry.value]),
    ).toEqual([
      ["fullName", "Robin Ashford"],
      ["email", "robin@example.test"],
      ["region", "Manchester"],
    ]);
    expect(merged.notes).toEqual(["header read", "region corrected"]);
  });

  test("Profile Copilot repairs an invalid patch group before finishing", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "invalid",
            type: "function",
            function: {
              name: "propose_profile_operations",
              arguments: JSON.stringify({
                summary: "Update headline",
                operations: [{ operation: "replace_identity_fields" }],
              }),
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content: "I prepared a grounded headline update for review.",
              }),
            },
          },
          {
            id: "patch",
            type: "function",
            function: {
              name: "propose_profile_operations",
              arguments: JSON.stringify({
                summary: "Update headline",
                operations: [
                  {
                    operation: "replace_identity_fields",
                    value: { headline: "Product-focused software engineer" },
                  },
                ],
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: {
        profile: createProfile(),
        searchPreferences: createPreferences(),
        context: { surface: "profile", section: "basics" },
        relevantReviewItems: [],
        request: "Make my headline clearer",
      },
    });

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]?.operations).toEqual([
      {
        operation: "replace_identity_fields",
        value: { headline: "Product-focused software engineer" },
      },
    ]);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.executionReceipt?.repairAttempts).toBe(1);
  });

  test("Profile Copilot strips model-supplied proposal metadata on the set_* path so id, apply mode, and timestamp stay runtime-owned", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content: "I prepared the requested headline for review.",
              }),
            },
          },
          {
            id: "headline",
            type: "function",
            function: {
              name: "set_identity_fields",
              arguments: JSON.stringify({
                summary: "Update headline",
                id: "model_group_id",
                applyMode: "applied",
                createdAt: "1999-01-01T00:00:00.000Z",
                fields: {
                  headline: "Product-minded Frontend Engineer",
                  id: "model_field_id",
                  applyMode: "rejected",
                  createdAt: "1999-01-01T00:00:00.000Z",
                },
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: {
        profile: createProfile(),
        searchPreferences: createPreferences(),
        context: { surface: "profile", section: "basics" },
        relevantReviewItems: [],
        request: "Set my headline to Product-minded Frontend Engineer.",
      },
    });

    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.patchGroups).toHaveLength(1);
    const group = reply.patchGroups[0];
    expect(group?.id).toMatch(/^profile_proposal_/);
    expect(group?.applyMode).toBe("needs_review");
    expect(group?.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(group?.createdAt ?? ""))).toBe(false);
    expect(group?.operations).toEqual([
      {
        operation: "replace_identity_fields",
        value: { headline: "Product-minded Frontend Engineer" },
      },
    ]);
  });

  test("Profile Copilot lets the model set simple fields without manufacturing contract metadata", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content: "I prepared the requested headline for review.",
              }),
            },
          },
          {
            id: "headline",
            type: "function",
            function: {
              name: "set_identity_fields",
              arguments: JSON.stringify({
                summary: "Update headline",
                fields: { headline: "Product-minded Frontend Engineer" },
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: {
        profile: createProfile(),
        searchPreferences: createPreferences(),
        context: { surface: "profile", section: "basics" },
        relevantReviewItems: [],
        request: "Set my headline to Product-minded Frontend Engineer.",
      },
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update headline",
        applyMode: "needs_review",
        operations: [
          {
            operation: "replace_identity_fields",
            value: { headline: "Product-minded Frontend Engineer" },
          },
        ],
      }),
    );
    expect(reply.patchGroups[0]?.id).toMatch(/^profile_proposal_/);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
  });

  test("Guided Edits creates a validated temporary proposal", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content:
                  "The current draft is already grounded, so I recommend no edit.",
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);
    const draft = ResumeDraftSchema.parse({
      id: "draft_1",
      jobId: "job_1",
      templateId: "classic_ats",
      status: "draft",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
    });

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft,
        job: createJobPosting(),
        request: "Improve the summary without adding facts",
      },
    });

    expect(reply.patches).toEqual([]);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
  });

  test("Guided Edits lets the model replace section text without manufacturing patch metadata", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content:
                  "I tightened the summary using only its saved evidence.",
              }),
            },
          },
          {
            id: "summary",
            type: "function",
            function: {
              name: "replace_resume_section_text",
              arguments: JSON.stringify({
                sectionId: "summary",
                newText:
                  "Builds accessible React workflows for internal teams.",
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);
    const draft = ResumeDraftSchema.parse({
      id: "draft_1",
      jobId: "job_1",
      templateId: "classic_ats",
      status: "draft",
      identity: null,
      sections: [
        {
          id: "summary",
          kind: "summary",
          label: "Summary",
          text: "Built accessible React workflows for internal teams.",
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 0,
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
      targetPageCount: 2,
      generationMethod: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
    });

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft,
        job: createJobPosting(),
        request: "Make the summary sharper without new facts.",
      },
    });

    expect(reply.patches[0]).toEqual(
      expect.objectContaining({
        draftId: "draft_1",
        operation: "replace_section_text",
        targetSectionId: "summary",
        newText: "Builds accessible React workflows for internal teams.",
        origin: "assistant",
      }),
    );
    expect(reply.executionReceipt?.stopReason).toBe("completed");
  });

  test("Guided Edits can show an existing hidden skill without creating a new fact", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content: "I restored the existing saved Design Systems skill.",
              }),
            },
          },
          {
            id: "show-skill",
            type: "function",
            function: {
              name: "set_resume_bullet_included",
              arguments: JSON.stringify({
                sectionId: "skills",
                bulletId: "design-systems",
                included: true,
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);
    const draft = ResumeDraftSchema.parse({
      id: "draft_1",
      jobId: "job_1",
      templateId: "classic_ats",
      status: "draft",
      identity: null,
      sections: [
        {
          id: "skills",
          kind: "skills",
          label: "Core Skills",
          bullets: [
            {
              id: "design-systems",
              text: "Design Systems",
              origin: "user_edited",
              locked: false,
              included: false,
              updatedAt: "2026-08-12T12:00:00.000Z",
            },
          ],
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 0,
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
      targetPageCount: 2,
      generationMethod: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
    });

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft,
        job: createJobPosting(),
        request: "Add Design Systems to the skills line.",
      },
    });

    expect(reply.patches[0]).toEqual(
      expect.objectContaining({
        draftId: "draft_1",
        operation: "toggle_include",
        targetSectionId: "skills",
        targetBulletId: "design-systems",
        newIncluded: true,
        origin: "assistant",
      }),
    );
    expect(reply.executionReceipt?.stopReason).toBe("completed");
  });

  test("Guided Edits refuses locked and unknown top-level bullet targets", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          {
            id: "locked-skill",
            type: "function",
            function: {
              name: "set_resume_bullet_included",
              arguments: JSON.stringify({
                sectionId: "skills",
                bulletId: "locked-skill",
                included: true,
              }),
            },
          },
          {
            id: "unknown-keyword",
            type: "function",
            function: {
              name: "set_resume_bullet_included",
              arguments: JSON.stringify({
                sectionId: "keywords",
                bulletId: "missing-keyword",
                included: true,
              }),
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "content",
            type: "function",
            function: {
              name: "set_response_content",
              arguments: JSON.stringify({
                content: "I could not change the locked or missing items.",
              }),
            },
          },
          {
            id: "finish",
            type: "function",
            function: { name: "finish_task", arguments: "{}" },
          },
        ],
      },
    ]);
    const draft = ResumeDraftSchema.parse({
      id: "draft_1",
      jobId: "job_1",
      templateId: "classic_ats",
      status: "draft",
      identity: null,
      sections: [
        {
          id: "skills",
          kind: "skills",
          label: "Core Skills",
          bullets: [
            {
              id: "locked-skill",
              text: "Design Systems",
              origin: "user_edited",
              locked: true,
              included: false,
              updatedAt: "2026-08-12T12:00:00.000Z",
            },
          ],
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 0,
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
        {
          id: "keywords",
          kind: "keywords",
          label: "Keywords",
          bullets: [],
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 1,
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
      targetPageCount: 2,
      generationMethod: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
    });

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft,
        job: createJobPosting(),
        request: "Show both items.",
      },
    });

    // A locked or unknown target is refused without a patch, and the run
    // continues so the model can say so instead of ending with nothing.
    expect(reply.patches).toEqual([]);
    expect(reply.content).toBe(
      "I could not change the locked or missing items.",
    );
    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(
      reply.executionReceipt?.toolReceipts
        .filter((receipt) => receipt.toolName === "set_resume_bullet_included")
        .map((receipt) => receipt.failureKind),
    ).toEqual(["validation", "validation"]);
  });

  function createSummaryDraft() {
    return ResumeDraftSchema.parse({
      id: "draft_1",
      jobId: "job_1",
      templateId: "classic_ats",
      status: "draft",
      identity: null,
      sections: [
        {
          id: "summary",
          kind: "summary",
          label: "Summary",
          text: "Frontend engineer building React design systems.",
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 0,
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
      targetPageCount: 1,
      generationMethod: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
    });
  }

  function toolCall(id: string, name: string, args: unknown = {}) {
    return {
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  test("Guided Edits refuses to finish on a change the approval check flags until the model has seen the verdict", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          toolCall("summary", "replace_resume_section_text", {
            sectionId: "summary",
            newText: "Frontend engineer who cut costs by 60% with AWS.",
          }),
          toolCall("finish", "finish_task"),
        ],
      },
      {
        toolCalls: [
          toolCall("reword", "replace_resume_section_text", {
            sectionId: "summary",
            newText: "Frontend engineer who builds React design systems.",
          }),
          toolCall("content", "set_response_content", {
            content:
              "I tightened the summary. Your saved evidence has no AWS cost saving, so I left that out.",
          }),
          toolCall("finish-again", "finish_task"),
        ],
      },
    ]);
    const checked: string[][] = [];

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "Say I cut costs by 60% with AWS.",
        tailoringStrength: "conservative",
        checkProposal(patches) {
          checked.push(patches.map((patch) => patch.newText ?? ""));
          const flagged = patches.find((patch) =>
            patch.newText?.includes("60%"),
          );
          return {
            applyError: null,
            findings: flagged
              ? [
                  {
                    patchId: flagged.id,
                    sectionId: "summary",
                    entryId: null,
                    bulletId: null,
                    flaggedText: flagged.newText,
                    message: "Your saved evidence does not back this claim.",
                    kind: "unsupported" as const,
                  },
                ]
              : [],
          };
        },
      },
    });

    expect(checked[0]).toEqual([
      "Frontend engineer who cut costs by 60% with AWS.",
    ]);
    const finishReceipts = reply.executionReceipt?.toolReceipts.filter(
      (receipt) => receipt.toolName === "finish_task",
    );
    expect(finishReceipts?.[0]?.validationIssues[0]?.code).toBe(
      "unsupported_by_saved_evidence",
    );
    // The second change to the same section replaced the flagged one.
    expect(reply.patches).toHaveLength(1);
    expect(reply.patches[0]?.newText).toBe(
      "Frontend engineer who builds React design systems.",
    );
    expect(reply.executionReceipt?.stopReason).toBe("completed");
  });

  function flagSixtyPercent(patches: readonly ResumeDraftPatch[]) {
    const flagged = patches.find((patch) => patch.newText?.includes("60%"));
    return {
      applyError: null,
      findings: flagged
        ? [
            {
              patchId: flagged.id,
              sectionId: "summary",
              entryId: null,
              bulletId: null,
              flaggedText: flagged.newText,
              message: "Your saved evidence does not back this claim.",
              kind: "unsupported" as const,
            },
          ]
        : [],
    };
  }

  test("Guided Edits tells the model to stop rewording from the third flagged check", async () => {
    const rewordTurns = [1, 2, 3, 4].map((turn) => ({
      toolCalls: [
        toolCall(`summary_${turn}`, "replace_resume_section_text", {
          sectionId: "summary",
          newText: `Frontend engineer who cut costs by 60% with AWS (${turn}).`,
        }),
        toolCall(`check_${turn}`, "validate_resume_draft"),
      ],
    }));
    const client = createToolClient([
      ...rewordTurns,
      {
        toolCalls: [
          toolCall("content", "set_response_content", {
            content: "Your saved evidence has no AWS cost saving.",
          }),
          toolCall("finish", "finish_task"),
        ],
      },
    ]);

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "Say I cut costs by 60% with AWS.",
        tailoringStrength: "balanced",
        checkProposal: flagSixtyPercent,
      },
    });

    const checks =
      reply.executionReceipt?.toolReceipts.filter(
        (receipt) => receipt.toolName === "validate_resume_draft",
      ) ?? [];
    const warned = checks.map((receipt) =>
      receipt.validationIssues.some((issue) => issue.code === "stop_rewording"),
    );
    expect(warned).toEqual([false, false, true, true]);
    expect(
      checks[2]?.validationIssues.find(
        (issue) => issue.code === "stop_rewording",
      )?.message,
    ).toContain("This is flagged check 3");
  });

  test("Guided Edits does not report an empty check as a clean verdict on existing lines", async () => {
    let turn = 0;
    const toolResults: string[] = [];
    const deterministic = createDeterministicJobFinderAiClient();
    const client: AgentCapableJobFinderAiClient = {
      ...deterministic,
      chatWithTools(messages) {
        turn += 1;
        for (const message of messages) {
          if (message.role === "tool") toolResults.push(message.content);
        }
        return Promise.resolve({
          toolCalls:
            turn === 1
              ? [toolCall("check", "validate_resume_draft")]
              : [
                  toolCall("content", "set_response_content", {
                    content: "All four changes were already accepted.",
                  }),
                  toolCall("finish", "finish_task"),
                ],
        });
      },
    };

    await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "the second one",
        tailoringStrength: "aggressive",
        checkProposal: () => ({ applyError: null, findings: [] }),
      },
    });

    expect(
      toolResults.some((content) =>
        content.includes("No proposed changes, so nothing was checked."),
      ),
    ).toBe(true);
    expect(
      toolResults.some((content) =>
        content.includes("passes the approval check"),
      ),
    ).toBe(false);
  });

  test("Guided Edits keeps the newest changes that passed when a run stops mid-rewording", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          toolCall("clean", "replace_resume_section_text", {
            sectionId: "summary",
            newText: "Frontend engineer who builds React design systems.",
          }),
          toolCall("check_clean", "validate_resume_draft"),
        ],
      },
      {
        toolCalls: [
          toolCall("flagged", "replace_resume_section_text", {
            sectionId: "summary",
            newText: "Frontend engineer who cut costs by 60% with AWS.",
          }),
          toolCall("check_flagged", "validate_resume_draft"),
        ],
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        toolCalls: [toolCall(`read_${index}`, "read_resume_context")],
      })),
    ]);

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "Make the summary fit this job better.",
        tailoringStrength: "balanced",
        checkProposal: flagSixtyPercent,
      },
    });

    expect(reply.executionReceipt?.stopReason).not.toBe("completed");
    expect(reply.patches.map((patch) => patch.newText)).toEqual([
      "Frontend engineer who builds React design systems.",
    ]);
    expect(reply.content).toContain("passed the approval check");
  });

  test("Guided Edits keeps a flagged change the model finishes on after seeing the verdict", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          toolCall("summary", "replace_resume_section_text", {
            sectionId: "summary",
            newText:
              "Frontend engineer building React design systems with an accessibility focus.",
          }),
          toolCall("check", "validate_resume_draft"),
        ],
      },
      {
        toolCalls: [
          toolCall("content", "set_response_content", {
            content:
              "Accessibility is not in your saved profile; you said it is your focus, so you confirm it after accepting.",
          }),
          toolCall("finish", "finish_task"),
        ],
      },
    ]);

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "End the summary with my accessibility focus.",
        tailoringStrength: "conservative",
        checkProposal: (patches) => ({
          applyError: null,
          findings: patches.map((patch) => ({
            patchId: patch.id,
            sectionId: "summary",
            entryId: null,
            bulletId: null,
            flaggedText: patch.newText,
            message: "Your saved evidence does not back this claim.",
            kind: "unsupported" as const,
          })),
        }),
      },
    });

    expect(reply.patches).toHaveLength(1);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(
      reply.executionReceipt?.toolReceipts.find(
        (receipt) => receipt.toolName === "finish_task",
      )?.validationIssues,
    ).toEqual([]);
  });

  test("Guided Edits on Aggressive finishes on a stretch that goes to Lines to confirm", async () => {
    const client = createToolClient([
      {
        toolCalls: [
          toolCall("summary", "replace_resume_section_text", {
            sectionId: "summary",
            newText: "Frontend engineer building React and GraphQL systems.",
          }),
          toolCall("finish", "finish_task"),
        ],
      },
    ]);

    const reply = await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "Mention GraphQL from the posting.",
        tailoringStrength: "aggressive",
        checkProposal: (patches) => ({
          applyError: null,
          findings: patches.map((patch) => ({
            patchId: patch.id,
            sectionId: "summary",
            entryId: null,
            bulletId: null,
            flaggedText: patch.newText,
            message: "This wording stretches past your saved evidence.",
            kind: "needs_confirmation" as const,
          })),
        }),
      },
    });

    expect(reply.patches).toHaveLength(1);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.executionReceipt?.providerCalls).toBe(1);
  });

  test("Guided Edits shows the model the recent conversation with each proposal's status", async () => {
    const deterministic = createDeterministicJobFinderAiClient();
    const captured: { payload: Record<string, unknown> | null } = {
      payload: null,
    };
    const client: AgentCapableJobFinderAiClient = {
      ...deterministic,
      chatWithTools(messages) {
        captured.payload = JSON.parse(
          messages.find((message) => message.role === "user")?.content ?? "{}",
        ) as Record<string, unknown>;
        return Promise.resolve({
          toolCalls: [
            toolCall("content", "set_response_content", {
              content: "Nothing to change.",
            }),
            toolCall("finish", "finish_task"),
          ],
        });
      },
    };
    const recentConversation = [
      {
        role: "user" as const,
        content: "What would you change to fit this job better?",
        proposal: null,
      },
      {
        role: "assistant" as const,
        content: "I would lead with TypeScript and hide Design Systems.",
        proposal: {
          status: "waiting_for_review" as const,
          changes: [
            {
              patchId: "resume_patch_1",
              operation: "replace_section_text",
              sectionId: "summary",
              entryId: null,
              bulletId: null,
              newText: "TypeScript frontend engineer.",
              applied: null,
            },
          ],
        },
      },
    ];

    await runResumeEditAgentTask({
      client,
      request: {
        draft: createSummaryDraft(),
        job: createJobPosting(),
        request: "the second one",
        recentConversation,
        currentPageCount: 1,
        availableTemplates: [
          {
            id: "classic_ats",
            label: "Chronology Classic",
            density: "balanced",
          },
        ],
        linesToConfirm: [
          { text: "SQL", sectionId: "skills", entryId: null, bulletId: "b1" },
        ],
      },
    });

    expect(captured.payload?.recentConversation).toEqual(recentConversation);
    expect(captured.payload?.request).toBe("the second one");
    expect(captured.payload?.currentPageCount).toBe(1);
    expect(captured.payload?.resumeLevel).toBeNull();
    expect(captured.payload?.currentTemplateLabel).toBe("Chronology Classic");
    expect(captured.payload?.linesToConfirm).toEqual([
      { text: "SQL", sectionId: "skills", entryId: null, bulletId: "b1" },
    ]);
  });
});
