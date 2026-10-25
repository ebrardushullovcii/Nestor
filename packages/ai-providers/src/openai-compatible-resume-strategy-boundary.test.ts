import { describe, expect, test } from "vitest";

import {
  createJobFinderAiClientFromEnvironment,
  createOpenAiCompatibleJobFinderAiClient,
} from "./openai-compatible";
import {
  ResumeGenerationStrategyPolicySchema,
  type ResumeGenerationStrategyPolicy,
} from "./shared";
import {
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
  mockCapturingJsonFetch,
} from "./test-fixtures";

function createStrategy(
  evidenceBoundaries: Partial<
    ResumeGenerationStrategyPolicy["evidenceBoundaries"]
  > = {},
): ResumeGenerationStrategyPolicy {
  return ResumeGenerationStrategyPolicySchema.parse({
    strategyId: "strategy_frontend_platform",
    strategyName: "Frontend platform",
    roleFamily: "Frontend Platform Engineering",
    baseResumeDocumentId: "resume_strategy_1",
    templateId: "classic_ats",
    headlinePolicy: "per_job_tailored",
    skillsPolicy: "role_family_expanded",
    coveragePolicy: "full_tailoring",
    tailoringStrength: "aggressive",
    evidenceBoundaries,
    effectiveSource: "recommendation",
    effectiveReason: "The target role matches the selected family.",
    recommendationSource: "role_family",
    recommendationReason:
      "The role family has the strongest supported overlap.",
    selectionSource: "rule_match",
    selectionReason: "The saved role-family rule selected this strategy.",
  });
}

describe("configured resume strategy request boundary", () => {
  test("sends strategy policy, base resume text, and evidence limits to the provider", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({}),
          },
        },
      ],
    });
    const strategy = createStrategy({
      allowExactClaims: false,
      allowParaphrasedClaims: true,
      maxEvidenceRefsPerBullet: 2,
      requireVerifierPass: true,
    });
    const baseResumeText =
      "Alex Vanguard\nFrontend platform engineer\nVerified base resume text.";

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });

      await client.createResumeDraft({
        profile: createProfile(),
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: baseResumeText,
        strategy,
        evidence: {
          summary: ["Built reliable workflow tools."],
          candidateSummary: [],
          experience: ["Built reliable workflow tools for operations teams."],
          skills: ["TypeScript"],
          keywords: ["workflow"],
        },
        researchContext: {
          companyNotes: [],
          domainVocabulary: [],
          priorityThemes: [],
        },
      });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        messages?: Array<{ content?: string }>;
      };
      const systemPrompt = body.messages?.[0]?.content ?? "";
      const userPayload = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
        strategy?: ResumeGenerationStrategyPolicy;
        baseResumeText?: string;
        groundingEvidence?: {
          items?: Array<{ id?: string; text?: string }>;
        };
      };

      expect(userPayload.strategy).toEqual(strategy);
      expect(userPayload.baseResumeText).toBe(baseResumeText);
      expect(userPayload.groundingEvidence?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "baseResume:text",
            text: baseResumeText,
          }),
        ]),
      );
      for (const rule of [
        "every stated skill level and limit",
        "basic or still learning",
        "seasonal or partial dates",
        "credential years and renewal dates",
        "quantified results",
        "Each achievement and qualification appears once",
        "Summaries lead with supported results",
      ])
        expect(systemPrompt).toContain(rule);
      for (const personaFact of [
        "Workday",
        "Excel (advanced)",
        "Articulate Rise",
        "IFRS",
        "CFO",
        "Mentored 5 engineers",
        "Mentored 4 SDRs",
        "Fachkraft",
        "ILS renewed 2025",
      ])
        expect(systemPrompt).not.toContain(personaFact);
      // The instructions point at the payload's strategy; its values stay in
      // the payload so every job's instructions are the same text.
      expect(systemPrompt).toContain(
        "Apply the resume strategy in the payload's strategy",
      );
      for (const strategyValue of [
        "Frontend platform",
        "Frontend Platform Engineering",
        "resume_strategy_1",
      ])
        expect(systemPrompt).not.toContain(strategyValue);
    } finally {
      fetchMock.restore();
    }
  });

  test("routes a strategy-selected aggressive draft to the aggressive model", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({}),
          },
        },
      ],
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
      });

      await client.createResumeDraft({
        profile: createProfile(),
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...createJobPosting(),
          responsibilities: ["Own the design system roadmap."],
        },
        resumeText: "Resume text",
        strategy: createStrategy(),
      });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        model?: string;
      };
      expect(body.model).toBe("deepseek-v4.1-flash");
    } finally {
      fetchMock.restore();
    }
  });

  test("tells chat-completions providers to return JSON when requesting json_object", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [{ message: { content: "{}" } }],
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "deepseek-v4.1-flash",
        apiMode: "chat_completions",
      });
      const searchPreferences = createPreferences();
      searchPreferences.tailoringMode = "aggressive";

      await client.createResumeDraft({
        profile: createProfile(),
        searchPreferences,
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
      });

      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        response_format?: { type?: string };
        messages?: Array<{ content?: string }>;
      };
      expect(body.response_format?.type).toBe("json_object");
      expect(body.messages?.[0]?.content).toMatch(/\bJSON\b/i);
    } finally {
      fetchMock.restore();
    }
  });
});

test.each([null, "German"])(
  "writer receives target language %s and returns the language in the same response",
  async (language) => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              languagePresentation: {
                language: "German",
                translations: [
                  { id: "section_experience:label", text: "Berufserfahrung" },
                ],
              },
            }),
          },
        },
      ],
    });
    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const draft = await client.createResumeDraft({
        profile: createProfile(),
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
        language,
        languageFields: [
          { id: "section_experience:label", text: "Experience" },
        ],
      });
      const body = JSON.parse(fetchMock.getCapturedBody()) as {
        messages: Array<{ content: string }>;
      };
      const payload = JSON.parse(body.messages[1]!.content) as {
        targetLanguage: string;
        languageFields: Array<{ id: string; text: string }>;
      };
      expect(payload.targetLanguage).toBe(
        language ?? "the language the listing is written in",
      );
      expect(payload.languageFields).toEqual([
        { id: "section_experience:label", text: "Experience" },
      ]);
      expect(body.messages[0]!.content).toContain(
        "write the resume in that language in this writing pass",
      );
      expect(body.messages[0]!.content).toContain(
        "When all displayed fields already use the target language, return an empty translations array",
      );
      expect(draft.languagePresentation?.language).toBe("German");
    } finally {
      fetchMock.restore();
    }
  },
);
