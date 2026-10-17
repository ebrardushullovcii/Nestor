import { afterEach, expect, test, vi } from "vitest";
import {
  createJobFinderAiClientFromEnvironment,
  createOpenAiCompatibleJobFinderAiClient,
} from "./openai-compatible";
import {
  createEnvironment,
  createProfile,
  createPreferences,
  createJobPosting,
} from "./test-fixtures";

const extraction = {
  pageText: "Frontend Engineer at Fern Research",
  pageUrl: "https://jobs.example.test/search",
  pageType: "search_results" as const,
  maxJobs: 5,
};

function pendingFetch() {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each(["429", "timeout"] as const)(
  "does not multiply Profile Assistant transport retries after %s",
  async (failure) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock =
      failure === "timeout"
        ? pendingFetch()
        : vi.fn(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({ error: { message: "Synthetic rate limit" } }),
                {
                  status: 429,
                  headers: { "content-type": "application/json" },
                },
              ),
            ),
          );
    vi.stubGlobal("fetch", fetchMock);
    const client = createJobFinderAiClientFromEnvironment(
      createEnvironment({
        NESTOR_AI_MAX_ATTEMPTS: "3",
        NESTOR_AI_TIMEOUT_MS: "5000",
        NESTOR_AI_IDLE_TIMEOUT_MS: "1000",
        NESTOR_AI_RETRY_BASE_DELAY_MS: "1",
      }),
    );
    const reply = client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "basics" },
      relevantReviewItems: [],
      request: "What does amber-review mean?",
    });
    await vi.runAllTimersAsync();
    expect((await reply).executionReceipt).toMatchObject({
      fallbackUsed: true,
      stopReason: "permanent_failure",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  },
);

test.each(["responses", "chat_completions"] as const)(
  "honors the configured model and separate agent effort on %s",
  async (apiMode) => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url:
            typeof url === "string"
              ? url
              : url instanceof URL
                ? url.href
                : url.url,
          body: JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as Record<string, unknown>,
        });
        const content = JSON.stringify({
          jobs: [],
          score: 5,
          reasons: [],
          gaps: [],
          requirements: [
            {
              id: "language",
              category: "skill",
              label: "German B2",
              importance: "required",
              status: "missing",
              jobEvidence: "German B2",
              resumeEvidence: [],
              explanation: "No German language evidence in the profile.",
            },
          ],
        });
        return Promise.resolve(
          new Response(
            JSON.stringify(
              apiMode === "responses"
                ? { output_text: content }
                : { choices: [{ message: { content } }] },
            ),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const client = createJobFinderAiClientFromEnvironment(
      createEnvironment({
        NESTOR_AI_MODEL: "configured-route",
        NESTOR_AI_API_MODE: apiMode,
        NESTOR_AI_REASONING_EFFORT: "high",
        NESTOR_AI_AGENT_REASONING_EFFORT: "low",
      }),
    );
    await client.extractJobsFromPage(extraction);
    await client.chatWithTools!(
      [{ role: "user", content: "Synthetic test" }],
      [],
    );
    const assessment = await client.assessJobFit({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      job: createJobPosting(),
    });
    expect(assessment?.requirements?.[0]).toMatchObject({
      label: "German B2",
      status: "missing",
    });
    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      expect(request.url).toBe(
        `https://example.com/v1/${apiMode === "responses" ? "responses" : "chat/completions"}`,
      );
      expect(request.body.model).toBe("configured-route");
      expect(
        apiMode === "responses"
          ? request.body.reasoning
          : request.body.reasoning_effort,
      ).toEqual(
        apiMode === "responses"
          ? { effort: index < 2 ? "low" : "high", summary: "auto" }
          : index < 2
            ? "low"
            : "high",
      );
    }
  },
);

test("caller cancellation is preserved instead of becoming a successful extraction fallback", async () => {
  const fetchMock = pendingFetch();
  vi.stubGlobal("fetch", fetchMock);
  const client = createJobFinderAiClientFromEnvironment(createEnvironment());
  const controller = new AbortController();
  const result = client.extractJobsFromPage({
    ...extraction,
    signal: controller.signal,
  });
  const rejection = expect(result).rejects.toMatchObject({
    name: "AbortError",
    message: "Aborted",
  });
  controller.abort();
  await rejection;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(["search_results", "job_detail"] as const)(
  "honors configured timeout for %s extraction",
  async (pageType) => {
    vi.useFakeTimers();
    const fetchMock = pendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "configured-model",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
    });
    const result = client.extractJobsFromPage({ ...extraction, pageType });
    const rejection = expect(result).rejects.toThrow(
      "Model request timed out after 1s",
    );
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test("fit assessment cancellation does not call the fallback model", async () => {
  const fetchMock = pendingFetch();
  vi.stubGlobal("fetch", fetchMock);
  const client = createJobFinderAiClientFromEnvironment(createEnvironment());
  const controller = new AbortController();
  const result = client.assessJobFit({
    profile: createProfile(),
    searchPreferences: createPreferences(),
    job: createJobPosting(),
    signal: controller.signal,
  });
  const rejection = expect(result).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejection;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("an oversized full read reports its input limit through the configured client without sending an excerpt", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const client = createJobFinderAiClientFromEnvironment(createEnvironment());
  await expect(
    client.assessJobFit({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      job: {
        ...createJobPosting(),
        description: "Full listing evidence ".repeat(100000),
      },
    }),
  ).rejects.toThrow("exceed the model's input limit");
  expect(fetchMock).not.toHaveBeenCalled();
});
