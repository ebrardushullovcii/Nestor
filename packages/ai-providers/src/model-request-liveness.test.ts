import { afterEach, expect, test, vi } from "vitest";
import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";
import { createPreferences, createProfile } from "./test-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each([120_000, 720_000])(
  "extractResumeImportStage completes a working stream after %i ms",
  async (duration) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const request = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal;
      expect(typeof init?.body).toBe("string");
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request");
      expect(JSON.parse(init.body)).toMatchObject({ stream: true });
      const encoder = new TextEncoder();
      let interval: ReturnType<typeof setInterval>;
      let elapsed = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (event: unknown) =>
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
              interval = setInterval(() => {
                elapsed += 10_000;
                send({
                  choices: [{ delta: { reasoning_content: "Working" } }],
                });
                if (elapsed === duration) {
                  clearInterval(interval);
                  send({
                    choices: [
                      {
                        delta: { content: '{"candidates":[],"notes":[]}' },
                        finish_reason: "stop",
                      },
                    ],
                  });
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                }
              }, 10_000);
            },
            cancel() {
              clearInterval(interval);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "synthetic-key",
      baseUrl: "https://model.example.test/v1",
      model: "deepseek-v4.1-flash",
      label: "Synthetic live-shape replay",
    });
    let completed = false;
    const result = client
      .extractResumeImportStage({
        stage: "experience",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          id: "synthetic-bundle",
          runId: "synthetic-run",
          sourceResumeId: "synthetic-resume",
          sourceFileKind: "plain_text",
          primaryParserKind: "plain_text",
          parserKinds: ["plain_text"],
          createdAt: "2026-11-06T00:00:00.000Z",
          warnings: [],
          languageHints: [],
          pages: [],
          fullText: "Synthetic resume",
          blocks: [
            {
              id: "block-1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Synthetic resume",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
            },
          ],
        },
      })
      .then((value) => {
        completed = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(completed).toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(duration - 61_000);
    expect((await result).analysisProviderKind).toBe("openai_compatible");
    expect(request).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("Stop reaches an active resume extraction and starts no retry", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const request = vi.fn<typeof fetch>((_url, init) => {
    requestSignal = init?.signal;
    return new Promise((_resolve, reject) => {
      requestSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("Stopped", "AbortError")),
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", request);
  const client = createOpenAiCompatibleJobFinderAiClient({
    apiKey: "synthetic-key",
    baseUrl: "https://model.example.test/v1",
    model: "deepseek-v4.1-flash",
    label: "Synthetic Stop replay",
  });
  const pending = client.extractResumeImportStage({
    signal: controller.signal,
    stage: "experience",
    existingProfile: createProfile(),
    existingSearchPreferences: createPreferences(),
    documentBundle: {
      id: "synthetic-bundle",
      runId: "synthetic-run",
      sourceResumeId: "synthetic-resume",
      sourceFileKind: "plain_text",
      primaryParserKind: "plain_text",
      parserKinds: ["plain_text"],
      createdAt: "2026-11-06T00:00:00.000Z",
      warnings: [],
      languageHints: [],
      pages: [],
      fullText: "Synthetic resume",
      blocks: [],
    },
  });
  const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await stopped;
  expect(requestSignal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});
