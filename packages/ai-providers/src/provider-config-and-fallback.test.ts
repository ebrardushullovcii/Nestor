import { describe, expect, test, vi } from "vitest";
import { ResumeDraftSchema } from "@nestor/contracts";
import type { ResumeDocumentBundle } from "@nestor/contracts";
import {
  createJobFinderAiClientFromEnvironment,
  createOpenAiCompatibleJobFinderAiClient,
} from "./index";
import { NO_AI_PROVIDER_REASON } from "./openai-compatible";
import {
  createEnvironment,
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
  mockCapturingJsonFetch,
  mockJsonFetch,
  mockRejectedFetch,
  mockTextFetch,
} from "./test-fixtures";

function createFastPathResumeBundle(): ResumeDocumentBundle {
  const lines = [
    "CASEY ROWAN",
    "casey.rowan@example.test | Portland, Oregon",
    "SUMMARY",
    "Frontend engineer with eight years of experience building accessible products.",
    "EXPERIENCE",
    "Senior Frontend Engineer — Northstar Parcel Software",
    "March 2021–Present | Portland, Oregon",
    "Reduced median page-load time from 4.2 seconds to 1.9 seconds.",
  ];

  return {
    id: "fast_path_bundle",
    runId: "fast_path_run",
    sourceResumeId: "fast_path_resume",
    sourceFileKind: "plain_text",
    primaryParserKind: "plain_text",
    parserKinds: ["plain_text"],
    createdAt: "2026-07-31T00:00:00.000Z",
    warnings: [],
    languageHints: ["en"],
    pages: [],
    blocks: lines.map((text, index) => ({
      id: `fast_path_block_${index + 1}`,
      pageNumber: 1,
      readingOrder: index,
      text,
      kind: ["SUMMARY", "EXPERIENCE"].includes(text)
        ? ("heading" as const)
        : ("paragraph" as const),
      sectionHint:
        index < 2
          ? ("identity" as const)
          : index < 4
            ? ("summary" as const)
            : ("experience" as const),
      bbox: null,
      sourceParserKinds: ["plain_text" as const],
      sourceConfidence: 0.98,
    })),
    fullText: lines.join("\n"),
  };
}

describe("ai provider config and fallback behavior", () => {
  test("surfaces non-json provider errors without raw response details", async () => {
    const restoreFetch = mockTextFetch("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        label: "AI resume agent",
        // A 502 is retried in production; one attempt keeps this test fast.
        maxAttempts: 1,
      });

      await expect(
        client.tailorResume({
          profile: createProfile(),
          searchPreferences: createPreferences(),
          settings: createSettings(),
          job: createJobPosting(),
          resumeText: "Resume text",
        }),
      ).rejects.toThrow("Model request failed with status 502");
    } finally {
      restoreFetch();
    }
  });

  test("falls back to deterministic mode without an API key", () => {
    const client = createJobFinderAiClientFromEnvironment(
      createEnvironment({
        NESTOR_AI_API_KEY: undefined,
      }),
    );

    expect(client.getStatus().kind).toBe("deterministic");
  });

  test("reports every model stage and the Assistant as an outage when no model is configured", async () => {
    // The model ships with the product. With no key the built-in reader and
    // editor still answer, but they must say the AI was never asked: an
    // import used to finish "Ready" and the Assistant replied as if it were
    // the model.
    const client = createJobFinderAiClientFromEnvironment(
      createEnvironment({ NESTOR_AI_API_KEY: undefined }),
    );

    const stage = await client.extractResumeImportStage({
      stage: "experience",
      existingProfile: createProfile(),
      existingSearchPreferences: createPreferences(),
      documentBundle: createFastPathResumeBundle(),
    });
    expect(stage.fallback).toEqual({
      kind: "provider_error",
      reason: NO_AI_PROVIDER_REASON,
    });

    const sharedMemory = await client.extractResumeImportStage({
      stage: "shared_memory",
      existingProfile: createProfile(),
      existingSearchPreferences: createPreferences(),
      documentBundle: createFastPathResumeBundle(),
    });
    // Deterministic by design; it never had a model call to lose.
    expect(sharedMemory.fallback ?? null).toBeNull();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "basics" },
      relevantReviewItems: [],
      request: "What is weak in my profile?",
    });
    expect(reply.executionReceipt).toMatchObject({
      fallbackUsed: true,
      stopReason: "permanent_failure",
      providerCalls: 0,
    });
  });

  test("configures the AI provider when the API key is present", () => {
    const client = createJobFinderAiClientFromEnvironment(createEnvironment());

    expect(client.getStatus()).toMatchObject({
      kind: "openai_compatible",
      model: "test-model",
      label: "AI resume agent",
      modelContextWindowTokens: 196_000,
    });
  });

  test("routes aggressive resume tailoring to DeepSeek V4.1 Flash with the configured reasoning effort", async () => {
    const balancedCapture = mockCapturingJsonFetch({
      choices: [{ message: { content: JSON.stringify({}) } }],
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
      });

      // The canned reply is no usable draft; this test reads only the request.
      await client
        .tailorResume({
          profile: createProfile(),
          searchPreferences: createPreferences(),
          settings: createSettings(),
          job: createJobPosting(),
          resumeText: "Resume text",
        })
        .catch(() => undefined);

      const balancedBody = JSON.parse(balancedCapture.getCapturedBody()) as {
        model?: string;
      };
      expect(balancedBody.model).toBe("ordinary-model");
    } finally {
      balancedCapture.restore();
    }

    const aggressiveCapture = mockCapturingJsonFetch({
      choices: [{ message: { content: JSON.stringify({}) } }],
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
        NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "high",
      });

      await client
        .tailorResume({
          profile: createProfile(),
          searchPreferences: {
            ...createPreferences(),
            tailoringMode: "aggressive",
          },
          settings: createSettings(),
          job: createJobPosting(),
          resumeText: "Resume text",
        })
        .catch(() => undefined);

      const aggressiveBody = JSON.parse(
        aggressiveCapture.getCapturedBody(),
      ) as {
        model?: string;
        reasoning_effort?: string;
        messages?: { role?: string; content?: string }[];
      };
      expect(aggressiveBody.model).toBe("deepseek-v4.1-flash");
      // The reasoning effort comes from its own env var and is applied.
      expect(aggressiveBody.reasoning_effort).toBe("high");
      const prompt = (aggressiveBody.messages ?? [])
        .map((message) => message.content ?? "")
        .join("\n");
      expect(prompt).toContain("Do not compose {}");
      expect(prompt).toContain("listingRequestedSkills");
      expect(prompt).not.toContain(
        "Return {} when the cited evidence is already",
      );
    } finally {
      aggressiveCapture.restore();
    }
  });

  test("applies the configured aggressive reasoning effort even for an overridden model", async () => {
    const capture = mockCapturingJsonFetch({
      choices: [{ message: { content: JSON.stringify({}) } }],
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
        NESTOR_AI_AGGRESSIVE_MODEL: "custom-aggressive-model",
        NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "high",
      });

      await client.tailorResume({
        profile: createProfile(),
        searchPreferences: {
          ...createPreferences(),
          tailoringMode: "aggressive",
        },
        settings: createSettings(),
        job: createJobPosting(),
        resumeText: "Resume text",
      });

      const body = JSON.parse(capture.getCapturedBody()) as {
        model?: string;
        reasoning_effort?: string;
      };
      expect(body.model).toBe("custom-aggressive-model");
      expect(body.reasoning_effort).toBe("high");
    } finally {
      capture.restore();
    }
  });

  test("routes model-backed review of an aggressive draft to the aggressive model", async () => {
    const ordinaryCapture = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "finish",
                type: "function",
                function: { name: "finish_task", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
        NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "high",
      });

      await client.reviseResumeDraft({
        draft: ResumeDraftSchema.parse({
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
        }),
        job: createJobPosting(),
        request: "Improve the summary without adding facts",
      });

      const ordinaryBody = JSON.parse(ordinaryCapture.getCapturedBody()) as {
        model?: string;
      };
      expect(ordinaryBody.model).toBe("ordinary-model");
    } finally {
      ordinaryCapture.restore();
    }

    const aggressiveCapture = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "finish",
                type: "function",
                function: { name: "finish_task", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
        NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "high",
      });

      await client.reviseResumeDraft({
        draft: ResumeDraftSchema.parse({
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
        }),
        job: createJobPosting(),
        request: "Improve the summary without adding facts",
        tailoringStrength: "aggressive",
      });

      const aggressiveBody = JSON.parse(
        aggressiveCapture.getCapturedBody(),
      ) as {
        model?: string;
        reasoning_effort?: string;
      };
      expect(aggressiveBody.model).toBe("deepseek-v4.1-flash");
      expect(aggressiveBody.reasoning_effort).toBe("high");
    } finally {
      aggressiveCapture.restore();
    }
  });

  test("defaults ordinary text work to Muse Spark 1.3 on OpenCode Go", () => {
    const client = createJobFinderAiClientFromEnvironment({
      NESTOR_AI_API_KEY: "go-test-key",
    });

    expect(client.getStatus()).toMatchObject({
      kind: "openai_compatible",
      model: "muse-spark-1.3-contributor",
      label: "AI resume agent",
    });
  });

  test("allows a direct OpenAI-compatible client to override the model context window", () => {
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "test-model",
      label: "AI resume agent",
      contextWindowTokens: 128_000,
    });

    expect(client.getStatus()).toMatchObject({
      kind: "openai_compatible",
      model: "test-model",
      label: "AI resume agent",
      ready: true,
      modelContextWindowTokens: 128_000,
    });
  });

  test("R3-095/R3-223 reads reusable evidence with the model instead of a local rule reader", async () => {
    const capture = mockCapturingJsonFetch({
      choices: [
        { message: { content: JSON.stringify({ candidates: [], notes: [] }) } },
      ],
    });
    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const result = await client.extractResumeImportStage({
        stage: "shared_memory",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: createFastPathResumeBundle(),
      });
      expect(capture.getCapturedBody()).toContain(
        "never in employer proof points",
      );
      expect(result.analysisProviderKind).toBe("openai_compatible");
      expect(result.timing?.primaryProviderMs).toEqual(expect.any(Number));
      expect(result.timing?.deterministicFallbackMs).toBeNull();
    } finally {
      capture.restore();
    }
  });

  test("bounds default remote core-stage latency and reports the section unread instead of guessing", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchSpy = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              reject(
                new DOMException("This operation was aborted", "AbortError"),
              );
            },
            { once: true },
          );
        }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      let settled = false;
      const resultPromise = client
        .extractResumeImportStage({
          stage: "identity_summary",
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          documentBundle: createFastPathResumeBundle(),
        })
        .finally(() => {
          settled = true;
        });
      const outcome = resultPromise.then(
        () => null,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(299_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      // Silent attempts are retried inside the 300s budget (idle clock 120s);
      // a timeout is not asked again after that, and nothing is guessed.
      const error = await outcome;
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "could not read your name, contact details and summary",
      );
      expect((error as Error).message).toContain("Nothing was guessed");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("300s"));
    } finally {
      globalThis.fetch = originalFetch;
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("asks the model again after a provider error, then reports the section unread", async () => {
    vi.useFakeTimers();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const restoreFetch = mockRejectedFetch(new Error("upstream stage failure"));

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const outcome = client
        .extractResumeImportStage({
          stage: "experience",
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          documentBundle: createFastPathResumeBundle(),
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await outcome;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "could not read your work history",
      );
      expect((error as Error).message).toContain("upstream stage failure");
      expect(
        errorSpy.mock.calls.filter((call) =>
          String(call[0]).includes("extractResumeImportStage"),
        ).length,
      ).toBe(3);
    } finally {
      restoreFetch();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("leaves the fallback reason unset when a stage reaches the model", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        { message: { content: JSON.stringify({ candidates: [], notes: [] }) } },
      ],
    });
    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const result = await client.extractResumeImportStage({
        stage: "shared_memory",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: createFastPathResumeBundle(),
      });
      expect(result.fallback ?? null).toBeNull();
    } finally {
      restoreFetch();
    }
  });

  test("marks the OpenAI-compatible client as not ready when config is invalid", () => {
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "test-key",
      baseUrl: "not-a-url",
      model: "",
      label: "AI resume agent",
    });

    expect(client.getStatus()).toMatchObject({
      kind: "openai_compatible",
      ready: false,
      model: null,
      baseUrl: null,
      label: "AI resume agent",
    });
  });

  test("reports a failed profile extraction instead of parsing the resume by rules", async () => {
    const restoreFetch = mockRejectedFetch(
      new Error("upstream extraction failure"),
    );

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      await expect(
        client.extractProfileFromResume({
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          resumeText: "Alex Vanguard\nLondon, UK\nReact engineer",
        }),
      ).rejects.toThrow("upstream extraction failure");
    } finally {
      restoreFetch();
    }
  });

  test("reports deterministic provenance when the model returns valid JSON that is not an extraction object", async () => {
    // Valid JSON that is not a plain object parses cleanly, so the primary
    // client never threw and never reached the catch that records a fallback.
    for (const content of ["[]", '"just a sentence"', "null"]) {
      const restoreFetch = mockJsonFetch({
        choices: [{ message: { content } }],
      });

      try {
        const client =
          createJobFinderAiClientFromEnvironment(createEnvironment());

        const result = await client.extractProfileFromResume({
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          resumeText: "Alex Vanguard\nLondon, UK\nReact engineer",
        });

        expect(result.analysisProviderKind, content).toBe("deterministic");
        expect(result.notes, content).toContain(
          "Fell back to the deterministic resume parser after the model call failed.",
        );
        expect(result.notes, content).toContain(
          "Primary AI extraction failed: the model returned a response that was not a resume extraction object.",
        );
      } finally {
        restoreFetch();
      }
    }
  });

  test("keeps model provenance when the model returns a usable extraction object", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              fullName: "Alex Vanguard",
              headline: "React engineer",
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const result = await client.extractProfileFromResume({
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        resumeText: "Alex Vanguard\nLondon, UK\nReact engineer",
      });

      expect(result.analysisProviderKind).toBe("openai_compatible");
      expect(result.fullName).toBe("Alex Vanguard");
      expect(result.notes).not.toContain(
        "Fell back to the deterministic resume parser after the model call failed.",
      );
    } finally {
      restoreFetch();
    }
  });

  test("uses the configured resume extraction timeout when normalizing abort-like provider failures", async () => {
    const restoreFetch = mockRejectedFetch(
      new DOMException("This operation was aborted", "AbortError"),
    );

    try {
      const client = createJobFinderAiClientFromEnvironment(
        createEnvironment({
          NESTOR_AI_RESUME_TIMEOUT_MS: "90000",
        }),
      );

      await expect(
        client.extractProfileFromResume({
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          resumeText: "Alex Vanguard\nLondon, UK\nReact engineer",
        }),
      ).rejects.toThrow("Model request timed out after 90s");
    } finally {
      restoreFetch();
    }
  });

  test("a timed-out draft call says so and writes nothing (ADR 0041)", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const restoreFetch = mockRejectedFetch(
      new Error("Model request timed out after 60s"),
    );

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      await expect(
        client.createResumeDraft({
          profile: createProfile(),
          searchPreferences: createPreferences(),
          settings: createSettings(),
          // A real listing body: card-only postings skip the model on purpose
          // (see the card-only test), so the timeout path needs text to tailor.
          job: {
            ...createJobPosting(),
            description: [
              "Own the payments reconciliation service end to end.",
              "Design ledger invariants, instrument settlement dashboards,",
              "run incident response, and mentor two backend engineers.",
              Array.from({ length: 40 }, (_, index) => `duty ${index}`).join(
                " ",
              ),
            ].join(" "),
          },
          resumeText: "Resume text",
        }),
      ).rejects.toThrow(
        "The AI could not write this resume in time, so nothing was changed. Try again.",
      );
    } finally {
      restoreFetch();
      errorSpy.mockRestore();
    }
  });

  test("never asks the model to tailor toward a card-only posting", async () => {
    const restoreFetch = mockRejectedFetch(
      new Error("the model must not be called for a card-only posting"),
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const posting = createJobPosting();

      const result = await client.createResumeDraft({
        profile: createProfile(),
        searchPreferences: createPreferences(),
        settings: createSettings(),
        job: {
          ...posting,
          // A compact-scan capture: the title stands in for the body and
          // nothing structured was read.
          description: posting.title,
          keySkills: [],
          responsibilities: [],
          minimumQualifications: [],
          preferredQualifications: [],
          benefits: [],
        },
        resumeText: "Resume text",
      });

      expect(result.generationProvenance).toEqual({
        method: "deterministic",
        reason: "listing_text_missing",
        detail:
          "The listing text was not captured, so there was nothing to tailor the resume toward; your original wording was kept.",
      });
      // No request went out, so nothing was logged as a fallback.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(result.notes).not.toContain(
        "Fell back to the deterministic resume draft creator after the model call failed.",
      );
    } finally {
      restoreFetch();
      errorSpy.mockRestore();
    }
  });

  test("records no_provider_configured when no API key is present", async () => {
    const client = createJobFinderAiClientFromEnvironment({});

    const result = await client.createResumeDraft({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      settings: createSettings(),
      job: createJobPosting(),
      resumeText: "Resume text",
    });

    expect(result.generationProvenance).toMatchObject({
      method: "deterministic",
      reason: "no_provider_configured",
    });
  });

  test("a failed tailoring call says so, logs why and writes nothing (ADR 0041)", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const restoreFetch = mockRejectedFetch(
      new Error("upstream tailoring failure"),
    );

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      await expect(
        client.tailorResume({
          profile: createProfile(),
          searchPreferences: createPreferences(),
          settings: createSettings(),
          job: createJobPosting(),
          resumeText: "Resume text",
        }),
      ).rejects.toThrow(
        "The AI could not write this resume, so nothing was changed. Try again.",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[AI Provider] tailorResume failed. upstream tailoring failure",
      );
    } finally {
      restoreFetch();
      errorSpy.mockRestore();
    }
  });

  test("a run that prepares no edit and never finishes keeps the question for Ask again", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              content:
                "Which number should it be? Your resume shows six years of work.",
              patchGroups: [],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      // No rule-made edit stands in for the model's answer (ADR 0041).
      await expect(
        client.reviseCandidateProfile({
          profile: {
            ...createProfile(),
            yearsExperience: 6,
          },
          searchPreferences: createPreferences(),
          context: { surface: "setup", step: "essentials" },
          relevantReviewItems: [],
          request: "change my experience",
        }),
      ).rejects.toThrow("nothing was changed");
    } finally {
      restoreFetch();
    }
  });

  test("reports the outage for very large profile copilot requests when the primary model call fails", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const restoreFetch = mockRejectedFetch(
      new Error("upstream profile failure"),
    );
    const longRequest = `change my experience to only 5 years ${"background detail ".repeat(5000)}`;

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const reply = await client.reviseCandidateProfile({
        profile: {
          ...createProfile(),
          yearsExperience: 6,
        },
        searchPreferences: createPreferences(),
        context: { surface: "setup", step: "essentials" },
        relevantReviewItems: [],
        request: longRequest,
      });

      expect(reply.content.trim().length).toBeGreaterThan(0);
      expect(reply.patchGroups).toHaveLength(0);
      expect(reply.executionReceipt?.stopReason).toBe("permanent_failure");
      expect(errorSpy).toHaveBeenCalledWith(
        "[AI Provider] reviseCandidateProfile failed. upstream profile failure",
      );
    } finally {
      restoreFetch();
      errorSpy.mockRestore();
    }
  });

  test("returns the model's experience records as it read them, with no rule-read records beside them", async () => {
    const resumeLines = [
      "CASEY ROWAN",
      "Senior Frontend Engineer",
      "casey.rowan@example.test | +1 555 010 2401 | Portland, Oregon",
      "SUMMARY",
      "Frontend engineer with eight years of experience building accessible web applications and design systems. Strong in React, TypeScript, testing, performance, and mentoring.",
      "EXPERIENCE",
      "Senior Frontend Engineer — Northstar Parcel Software",
      "March 2021–Present | Portland, Oregon",
      "- Led a React and TypeScript shipment-tracking redesign used by 18 internal operations teams.",
      "- Reduced median page-load time from 4.2 seconds to 1.9 seconds by splitting bundles and removing duplicate requests.",
      "- Built an accessible component library with Storybook and automated axe checks.",
      "- Mentored four engineers and introduced Vitest integration tests for critical workflows.",
      "Frontend Engineer — Cedar Ledger",
      "June 2018–February 2021 | Remote",
      "- Built account-management workflows with React, GraphQL, and Node.js.",
      "- Partnered with product designers to improve form completion and error recovery.",
      "EDUCATION",
      "Bachelor of Science in Computer Science — Oregon State University, 2018",
      "SKILLS",
      "React, TypeScript, JavaScript, HTML, CSS, GraphQL, Node.js, Vitest, Playwright, Storybook, accessibility, performance optimization",
    ];
    const blocks = resumeLines.map((text, index) => ({
      id: `casey_block_${index + 1}`,
      pageNumber: 1,
      readingOrder: index,
      text,
      kind: ["SUMMARY", "EXPERIENCE", "EDUCATION", "SKILLS"].includes(text)
        ? ("heading" as const)
        : ("paragraph" as const),
      sectionHint:
        index < 3
          ? ("identity" as const)
          : index < 5
            ? ("summary" as const)
            : index < 16
              ? ("experience" as const)
              : index < 18
                ? ("education" as const)
                : ("skills" as const),
      bbox: null,
      sourceParserKinds: ["plain_text" as const],
      sourceConfidence: 0.98,
    }));
    const documentBundle: ResumeDocumentBundle = {
      id: "casey_bundle",
      runId: "casey_run",
      sourceResumeId: "casey_resume",
      sourceFileKind: "plain_text",
      primaryParserKind: "plain_text",
      parserKinds: ["plain_text"],
      createdAt: "2026-07-31T00:00:00.000Z",
      warnings: [],
      languageHints: ["en"],
      pages: [],
      blocks,
      fullText: resumeLines.join("\n"),
    };
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  target: {
                    section: "experience",
                    key: "record",
                    recordId: "experience_1",
                  },
                  label:
                    "Senior Frontend Engineer at Northstar Parcel Software",
                  value: {
                    companyName: "Northstar Parcel Software",
                    companyUrl: null,
                    title: "Senior Frontend Engineer",
                    employmentType: null,
                    location: "Portland, Oregon",
                    workMode: [],
                    startDate: "March 2021",
                    endDate: null,
                    isCurrent: true,
                    summary: null,
                    achievements: resumeLines
                      .slice(8, 12)
                      .map((line) => line.replace(/^- /, "")),
                    skills: ["React", "TypeScript"],
                    domainTags: [],
                    peopleManagementScope: null,
                    ownershipScope: null,
                  },
                  evidenceText: resumeLines.slice(6, 12).join(" "),
                  sourceBlockIds: blocks.slice(6, 12).map((block) => block.id),
                  confidence: 0.94,
                  notes: [],
                  alternatives: [],
                },
                {
                  target: {
                    section: "experience",
                    key: "record",
                    recordId: "experience_2",
                  },
                  label: "Frontend Engineer at Cedar Ledger",
                  value: {
                    companyName: "Cedar Ledger",
                    companyUrl: null,
                    title: "Frontend Engineer",
                    employmentType: null,
                    location: "Remote",
                    workMode: [],
                    startDate: "June 2018",
                    endDate: "February 2021",
                    isCurrent: false,
                    summary: null,
                    achievements: resumeLines
                      .slice(14, 16)
                      .map((line) => line.replace(/^- /, "")),
                    skills: ["React", "GraphQL", "Node.js"],
                    domainTags: [],
                    peopleManagementScope: null,
                    ownershipScope: null,
                  },
                  evidenceText: resumeLines.slice(12, 16).join(" "),
                  sourceBlockIds: blocks.slice(12, 16).map((block) => block.id),
                  confidence: 0.94,
                  notes: [],
                  alternatives: [],
                },
              ],
              notes: [],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const result = await client.extractResumeImportStage({
        stage: "experience",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      });
      expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timing?.primaryProviderMs).toBeGreaterThanOrEqual(0);
      expect(result.timing?.deterministicFallbackMs).toBeNull();
      expect(
        result.candidates.map((candidate) => candidate.target.recordId),
      ).toEqual(["experience_1", "experience_2"]);
      expect(
        result.candidates.some((candidate) =>
          candidate.notes.includes("deterministic_stage_fallback"),
        ),
      ).toBe(false);
      const cedar = result.candidates.find(
        (candidate) => candidate.target.recordId === "experience_2",
      );
      expect(cedar?.value).toMatchObject({
        workMode: [],
        skills: ["React", "GraphQL", "Node.js"],
      });
    } finally {
      restoreFetch();
    }
  });
  test("compacts oversized resume import stage payloads before sending them to the model", async () => {
    const capture = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [],
              notes: [],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      await client.extractResumeImportStage({
        stage: "experience",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          id: "bundle_1",
          runId: "run_1",
          sourceResumeId: "resume_1",
          sourceFileKind: "pdf",
          primaryParserKind: "pdfjs_text",
          parserKinds: ["pdfjs_text"],
          createdAt: "2026-03-20T10:00:00.000Z",
          languageHints: [],
          warnings: Array.from(
            { length: 20 },
            (_, index) => `Warning ${index + 1} ${"detail ".repeat(40)}`,
          ),
          pages: [],
          blocks: Array.from({ length: 80 }, (_, index) => ({
            id: `block_${index + 1}`,
            pageNumber: 1 + Math.floor(index / 20),
            readingOrder: index,
            text: `Experience block ${index + 1} ${"resume evidence ".repeat(200)}`,
            kind: "paragraph",
            sectionHint: "experience",
            bbox: {
              left: 0,
              top: index * 10,
              width: 100,
              height: 10,
            },
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 0.9,
          })),
          fullText: null,
        },
      });

      const body = JSON.parse(capture.getCapturedBody()) as {
        messages?: Array<{ content?: string }>;
      };
      const userPayload = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
        documentBundle?: { blocks?: Array<{ text?: string }> };
      };

      expect(userPayload.documentBundle?.blocks).toBeDefined();
      expect(Array.isArray(userPayload.documentBundle?.blocks)).toBe(true);
      expect(
        userPayload.documentBundle?.blocks?.length ?? 0,
      ).toBeLessThanOrEqual(32);
      expect(userPayload.documentBundle?.blocks?.[0]?.text).toContain(
        "[truncated",
      );
    } finally {
      capture.restore();
    }
  });

  test("says the Assistant ran out of time instead of blaming the request", async () => {
    const capture = mockCapturingJsonFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "read",
                type: "function",
                function: { name: "read_resume_context", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });
    // Every clock read is a minute later: the 180 s budget runs out while
    // the model is still reading, as a slow provider did live.
    let now = Date.parse("2026-09-24T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 60_000;
      return now;
    });

    try {
      const client = createJobFinderAiClientFromEnvironment({
        NESTOR_AI_API_KEY: "test-key",
        NESTOR_AI_MODEL: "ordinary-model",
      });

      const reply = await client.reviseResumeDraft({
        draft: ResumeDraftSchema.parse({
          id: "draft_1",
          jobId: "job_1",
          templateId: "classic_ats",
          status: "draft",
          identity: null,
          sections: [],
          targetPageCount: 1,
          generationMethod: null,
          createdAt: "2026-08-12T12:00:00.000Z",
          updatedAt: "2026-08-12T12:00:00.000Z",
          approvedAt: null,
          approvedExportId: null,
          staleReason: null,
        }),
        job: createJobPosting(),
        request: "the second one",
      });

      expect(reply.patches).toEqual([]);
      expect(reply.content).toBe(
        "The AI took too long to answer this time, so nothing was changed. Send the request again.",
      );
    } finally {
      clock.mockRestore();
      capture.restore();
    }
  });
});
