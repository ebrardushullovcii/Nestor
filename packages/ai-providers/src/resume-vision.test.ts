import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { createResumeImportFixtureBundle } from "./resume-import-fixtures";
import {
  createProfile,
  createPreferences,
  mockCapturingJsonFetch,
} from "./test-fixtures";
import {
  createOpenAiCompatibleResumeVisionProvider,
  createResumeVisionProviderFromEnvironment,
} from "./resume-vision";

function createVisionArtifactFixture() {
  return {
    id: "vision_artifact_1",
    runId: "run_1",
    sourceResumeId: "resume_1",
    sourceFileKind: "pdf" as const,
    createdAt: "2026-04-10T10:00:00.000Z",
    retained: "temporary" as const,
    pages: [
      {
        id: "vision_page_1",
        sourceResumeId: "resume_1",
        sourceFileKind: "pdf" as const,
        pageNumber: 1,
        renderKind: "pdf_page_image" as const,
        mimeType: "image/png",
        width: 1200,
        height: 1600,
        byteLength: 4,
        sha256: "abc123",
        dataUrl: "data:image/png;base64,AAAA",
        storagePath: null,
        retained: "temporary" as const,
        generatedAt: "2026-04-10T10:00:00.000Z",
        warnings: [],
      },
    ],
    warnings: [],
  };
}

describe("resume vision provider", () => {
  afterEach(() => {
    // Individual mocks restore fetch explicitly; this keeps tests isolated when assertions fail early.
    vi.restoreAllMocks();
    delete process.env.NESTOR_RESUME_VISION_API_KEY;
  });

  test("normalizes model candidates and preserves visual evidence", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  target: "identity.headline",
                  label: "Headline",
                  value: "Staff Platform Engineer",
                  confidence: "0.84",
                  notes: "visible near the top of the resume",
                  alternatives: "Senior Software Engineer",
                  evidenceText: "Staff Platform Engineer",
                  visualEvidence: [
                    {
                      pageNumber: 1,
                      regionHint: "top headline",
                      confidence: "0.86",
                    },
                  ],
                },
                {
                  target: { section: "unknown_section", key: "ignored" },
                  value: "ignore me",
                },
              ],
              notes: ["vision read completed"],
              warnings: ["low image contrast"],
            }),
          },
        },
      ],
    });
    const provider = createOpenAiCompatibleResumeVisionProvider({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-luna",
      maxPagesPerBatch: 1,
    });
    const bundle = createResumeImportFixtureBundle({
      id: "vision_test_bundle",
      pageTexts: ["Alex Vanguard\nSenior Software Engineer"],
      blocks: [
        {
          id: "block_1",
          pageNumber: 1,
          readingOrder: 0,
          text: "Alex Vanguard",
          kind: "heading",
          sectionHint: "identity",
          bbox: null,
          sourceParserKinds: ["local_pdf_layout"],
          sourceConfidence: 0.9,
        },
      ],
    });

    try {
      const result = await provider.extractResumeVision({
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: bundle,
        visionArtifact: {
          id: "vision_artifact_1",
          runId: "run_1",
          sourceResumeId: "resume_1",
          sourceFileKind: "pdf",
          createdAt: "2026-04-10T10:00:00.000Z",
          retained: "temporary",
          pages: [
            {
              id: "vision_page_1",
              sourceResumeId: "resume_1",
              sourceFileKind: "pdf",
              pageNumber: 1,
              renderKind: "pdf_page_image",
              mimeType: "image/png",
              width: 1200,
              height: 1600,
              byteLength: 4,
              sha256: "abc123",
              dataUrl: "data:image/png;base64,AAAA",
              storagePath: null,
              retained: "temporary",
              generatedAt: "2026-04-10T10:00:00.000Z",
              warnings: [],
            },
          ],
          warnings: [],
        },
      });

      const headline = result.candidates.find(
        (candidate) => candidate.target.key === "headline",
      );
      expect(result.analysisProviderKind).toBe("openai_compatible_vision");
      expect(headline?.confidence).toBe(0.84);
      expect(headline?.notes).toEqual(["visible near the top of the resume"]);
      expect(headline?.alternatives).toEqual(["Senior Software Engineer"]);
      expect(headline?.visualEvidence?.[0]).toMatchObject({
        branch: "vision",
        sourceFileKind: "pdf",
        pageNumber: 1,
        regionHint: "top headline",
        confidence: 0.86,
      });
      expect(
        result.candidates.some(
          (candidate) => candidate.target.key === "ignored",
        ),
      ).toBe(false);
      expect(fetchMock.getCapturedBody()).toContain("image_url");
      const request = z
        .object({
          messages: z.array(
            z.object({
              content: z.union([
                z.string(),
                z.array(z.object({ text: z.string().optional() })),
              ]),
            }),
          ),
        })
        .parse(JSON.parse(fetchMock.getCapturedBody()) as unknown);
      const userContent = request.messages[1]?.content;
      const instruction = z
        .object({
          targetContract: z.object({
            candidateExample: z.unknown(),
            recordTargets: z.array(z.string()),
          }),
        })
        .parse(
          JSON.parse(
            Array.isArray(userContent) ? (userContent[0]?.text ?? "{}") : "{}",
          ) as unknown,
        );
      expect(instruction.targetContract.candidateExample).toMatchObject({
        target: { section: "identity", key: "fullName", recordId: null },
        visualEvidence: [{ pageNumber: 1 }],
      });
      expect(instruction.targetContract.recordTargets).toContain(
        "experience.record",
      );
      expect(result.warnings).toContain(
        "1 resume visual candidate(s) were ignored because their targets did not match the required section and key format.",
      );
    } finally {
      fetchMock.restore();
    }
  });

  test("reports a malformed scan instead of crediting a model whose bare targets were all discarded", async () => {
    // Reproduces the live scanned-resume response: visible text was read,
    // but the model emitted bare keys rather than the canonical target shape.
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  target: "fullName",
                  value: "Alex Sample",
                  evidenceText: "Alex Sample",
                  confidence: 0.99,
                },
                {
                  target: "experience",
                  value: { companyName: "Sample Labs", title: "Engineer" },
                  confidence: 0.95,
                },
              ],
              notes: ["All values transcribed literally from the page image."],
            }),
          },
        },
      ],
    });
    const provider = createOpenAiCompatibleResumeVisionProvider({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "test-vision-model",
    });
    try {
      const result = await provider.extractResumeVision({
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: createResumeImportFixtureBundle({
          id: "image_only_bundle",
          pageTexts: [""],
          blocks: [],
        }),
        visionArtifact: createVisionArtifactFixture(),
      });
      expect(result.candidates).toEqual([]);
      expect(result.analysisProviderKind).toBe("deterministic");
      expect(result.fallbackUsed).toBe(true);
      expect(result.primaryErrorMessage).toMatch(
        /none had a valid target with a section and key/,
      );
      expect(result.fallback?.kind).toBe("provider_error");
    } finally {
      fetchMock.restore();
    }
  });

  test("reports an invalid response envelope instead of treating missing candidates as an empty scan", async () => {
    const fetchMock = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({ notes: ["The page was read."] }),
          },
        },
      ],
    });
    const provider = createOpenAiCompatibleResumeVisionProvider({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "test-vision-model",
    });
    try {
      const result = await provider.extractResumeVision({
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: createResumeImportFixtureBundle({
          id: "missing_candidates",
          pageTexts: [""],
          blocks: [],
        }),
        visionArtifact: createVisionArtifactFixture(),
      });
      expect(result.fallbackUsed).toBe(true);
      expect(result.primaryErrorMessage).toMatch(
        /did not return a candidates array/,
      );
    } finally {
      fetchMock.restore();
    }
  });

  test("reports the deterministic source and a structured fallback when the vision model call fails", async () => {
    const cases = [
      {
        name: "timeout",
        rejection: (() => {
          const abortError = new Error("This operation was aborted");
          abortError.name = "AbortError";
          return abortError;
        })(),
        expectedKind: "timeout" as const,
        expectedReason: /timed out after \d+s/i,
      },
      {
        name: "provider error",
        rejection: new Error("Vision endpoint returned 500"),
        expectedKind: "provider_error" as const,
        expectedReason: /returned 500/i,
      },
    ];

    for (const testCase of cases) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() =>
        Promise.reject(testCase.rejection),
      ) as unknown as typeof globalThis.fetch;

      try {
        const provider = createOpenAiCompatibleResumeVisionProvider({
          apiKey: "test-key",
          baseUrl: "https://example.com/v1",
          model: "gpt-5.6-luna",
          maxPagesPerBatch: 1,
        });
        const result = await provider.extractResumeVision({
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          documentBundle: createResumeImportFixtureBundle({
            id: "vision_fallback_bundle",
            pageTexts: ["Alex Vanguard\nSenior Software Engineer"],
            blocks: [
              {
                id: "block_1",
                pageNumber: 1,
                readingOrder: 0,
                text: "Alex Vanguard",
                kind: "heading",
                sectionHint: "identity",
                bbox: null,
                sourceParserKinds: ["local_pdf_layout"],
                sourceConfidence: 0.9,
              },
            ],
          }),
          visionArtifact: createVisionArtifactFixture(),
        });

        // Every candidate here comes from the deterministic reader, so the
        // run must not record the configured vision model as the source.
        expect(result.analysisProviderKind, testCase.name).toBe(
          "deterministic",
        );
        expect(result.analysisProviderLabel, testCase.name).toBe(
          "Deterministic resume vision fallback",
        );
        expect(result.fallbackUsed, testCase.name).toBe(true);
        expect(result.fallback?.kind, testCase.name).toBe(
          testCase.expectedKind,
        );
        expect(result.fallback?.reason ?? "", testCase.name).toMatch(
          testCase.expectedReason,
        );
        expect(result.primaryErrorMessage ?? "", testCase.name).toMatch(
          testCase.expectedReason,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("uses the shared AI provider config for vision when vision-specific config is absent", () => {
    const provider = createResumeVisionProviderFromEnvironment({
      NESTOR_AI_API_KEY: "shared-test-key",
      NESTOR_AI_BASE_URL: "https://shared.example.com/v1",
    });

    expect(provider.getStatus()).toMatchObject({
      kind: "openai_compatible_vision",
      role: "vision",
      ready: true,
      label: "Resume visual scan",
      model: "muse-spark-1.3-contributor",
      baseUrl: "https://shared.example.com/v1",
      modelContextWindowTokens: 139_000,
      reservedHeadroomTokens: 30_000,
      requestTimeoutMs: 600_000,
    });
  });

  test("sends shared AI credentials and Muse Spark xhigh to the Responses vision endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedAuthorization = "";
    let capturedBody: unknown = null;

    globalThis.fetch = ((url, init) => {
      capturedUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const headers = new Headers(init?.headers);
      capturedAuthorization = headers.get("Authorization") ?? "";
      capturedBody = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );

      return Promise.resolve(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ candidates: [], notes: [] }),
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      );
    }) as typeof fetch;

    const provider = createResumeVisionProviderFromEnvironment({
      NESTOR_AI_API_KEY: "shared-test-key",
      NESTOR_AI_BASE_URL: "https://shared.example.com/v1",
    });
    const bundle = createResumeImportFixtureBundle({
      id: "shared_vision_config_bundle",
      pageTexts: ["Alex Vanguard\nSenior Software Engineer"],
      blocks: [
        {
          id: "block_1",
          pageNumber: 1,
          readingOrder: 0,
          text: "Alex Vanguard",
          kind: "heading",
          sectionHint: "identity",
          bbox: null,
          sourceParserKinds: ["local_pdf_layout"],
          sourceConfidence: 0.9,
        },
      ],
    });

    try {
      await provider.extractResumeVision({
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: bundle,
        visionArtifact: {
          id: "vision_artifact_shared_config",
          runId: "run_1",
          sourceResumeId: "resume_1",
          sourceFileKind: "pdf",
          createdAt: "2026-04-10T10:00:00.000Z",
          retained: "temporary",
          pages: [
            {
              id: "vision_page_1",
              sourceResumeId: "resume_1",
              sourceFileKind: "pdf",
              pageNumber: 1,
              renderKind: "pdf_page_image",
              mimeType: "image/png",
              width: 1200,
              height: 1600,
              byteLength: 4,
              sha256: "abc123",
              dataUrl: "data:image/png;base64,AAAA",
              storagePath: null,
              retained: "temporary",
              generatedAt: "2026-04-10T10:00:00.000Z",
              warnings: [],
            },
          ],
          warnings: [],
        },
      });

      expect(capturedUrl).toBe("https://shared.example.com/v1/responses");
      expect(capturedAuthorization).toBe("Bearer shared-test-key");
      expect(capturedBody).toMatchObject({
        model: "muse-spark-1.3-contributor",
        store: false,
        reasoning: { effort: "xhigh" },
        text: { format: { type: "json_object" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deterministic visual fallback does not treat role headlines as names", async () => {
    const provider = createResumeVisionProviderFromEnvironment({});
    const bundle = createResumeImportFixtureBundle({
      id: "role_headline_vision_fallback_bundle",
      pageTexts: [
        "Senior Software Engineer\nTampa, FL\nowen.mercer@example.test",
      ],
      blocks: [
        {
          id: "block_1",
          pageNumber: 1,
          readingOrder: 0,
          text: "Senior Software Engineer",
          kind: "heading",
          sectionHint: "identity",
          bbox: null,
          sourceParserKinds: ["local_pdf_layout"],
          sourceConfidence: 0.9,
        },
        {
          id: "block_2",
          pageNumber: 1,
          readingOrder: 1,
          text: "owen.mercer@example.test",
          kind: "contact",
          sectionHint: "contact",
          bbox: null,
          sourceParserKinds: ["local_pdf_layout"],
          sourceConfidence: 0.9,
        },
      ],
    });

    const result = await provider.extractResumeVision({
      existingProfile: createProfile(),
      existingSearchPreferences: createPreferences(),
      documentBundle: bundle,
      visionArtifact: {
        id: "vision_artifact_role_headline",
        runId: "run_1",
        sourceResumeId: "resume_1",
        sourceFileKind: "pdf",
        createdAt: "2026-04-10T10:00:00.000Z",
        retained: "temporary",
        pages: [
          {
            id: "vision_page_1",
            sourceResumeId: "resume_1",
            sourceFileKind: "pdf",
            pageNumber: 1,
            renderKind: "pdf_page_image",
            mimeType: "image/png",
            width: 1200,
            height: 1600,
            byteLength: 4,
            sha256: "abc123",
            dataUrl: "data:image/png;base64,AAAA",
            storagePath: null,
            retained: "temporary",
            generatedAt: "2026-04-10T10:00:00.000Z",
            warnings: [],
          },
        ],
        warnings: [],
      },
    });

    expect(
      result.candidates.some(
        (candidate) =>
          candidate.target.section === "identity" &&
          candidate.target.key === "fullName" &&
          candidate.value === "Senior Software Engineer",
      ),
    ).toBe(false);
    expect(
      result.candidates.some(
        (candidate) =>
          candidate.target.section === "contact" &&
          candidate.target.key === "email" &&
          candidate.value === "owen.mercer@example.test",
      ),
    ).toBe(true);
  });

  test("prefers vision-specific config over the shared AI provider config", () => {
    const provider = createResumeVisionProviderFromEnvironment({
      NESTOR_AI_API_KEY: "shared-test-key",
      NESTOR_AI_BASE_URL: "https://shared.example.com/v1",
      NESTOR_AI_VISION_API_KEY: "vision-test-key",
      NESTOR_AI_VISION_BASE_URL: "https://vision.example.com/v1",
      NESTOR_AI_VISION_MODEL: "test-vision-model",
      NESTOR_RESUME_VISION_API_KEY: "resume-vision-test-key",
      NESTOR_RESUME_VISION_BASE_URL: "https://resume-vision.example.com/v1",
      NESTOR_RESUME_VISION_MODEL: "resume-vision-model",
    });

    expect(provider.getStatus()).toMatchObject({
      kind: "openai_compatible_vision",
      ready: true,
      model: "resume-vision-model",
      baseUrl: "https://resume-vision.example.com/v1",
    });
  });

  test("uses the shared AI vision model override with the shared API key", () => {
    const provider = createResumeVisionProviderFromEnvironment({
      NESTOR_AI_API_KEY: "shared-test-key",
      NESTOR_AI_BASE_URL: "https://shared.example.com/v1",
      NESTOR_AI_VISION_MODEL: "shared-vision-model",
    });

    expect(provider.getStatus()).toMatchObject({
      kind: "openai_compatible_vision",
      ready: true,
      model: "shared-vision-model",
      baseUrl: "https://shared.example.com/v1",
    });
  });

  test("keeps shared vision routing separate from a Chat Completions text provider", () => {
    const provider = createResumeVisionProviderFromEnvironment({
      NESTOR_AI_API_KEY: "go-test-key",
      NESTOR_AI_BASE_URL: "https://text.example.com/v1",
      NESTOR_AI_API_MODE: "chat_completions",
      NESTOR_AI_REASONING_EFFORT: "max",
      NESTOR_AI_VISION_BASE_URL: "https://vision.example.com/v1",
      NESTOR_AI_VISION_MODEL: "gpt-5.6-luna",
      NESTOR_AI_VISION_API_MODE: "responses",
      NESTOR_AI_VISION_REASONING_EFFORT: "high",
    });

    expect(provider.getStatus()).toMatchObject({
      kind: "openai_compatible_vision",
      ready: true,
      model: "gpt-5.6-luna",
      baseUrl: "https://vision.example.com/v1",
    });
  });

  test("falls back to deterministic vision without any configured API key", () => {
    const provider = createResumeVisionProviderFromEnvironment({});

    expect(provider.getStatus()).toMatchObject({
      kind: "deterministic",
      role: "vision",
      ready: true,
      model: null,
    });
  });
});
