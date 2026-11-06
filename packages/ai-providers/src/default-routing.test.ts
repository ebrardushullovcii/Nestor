import { afterEach, expect, test, vi } from "vitest";
import { createJobFinderAiClientFromEnvironment } from "./openai-compatible";
import { createResumeVisionProviderFromEnvironment } from "./resume-vision";
import { createBrowserVisualAnalysisProviderFromEnvironment } from "./browser-visual-analysis";
import { createLiveAssistantProvidersFromEnvironment } from "./live-assistant";
import { resolveAssistantModelCapabilities } from "./assistant-model";

afterEach(() => vi.unstubAllGlobals());

test("key-only product routes all select DeepSeek; search efforts stay independent", async () => {
  const requests: { url: string; model: string; reasoning_effort: string }[] =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as {
        model: string;
        reasoning_effort: string;
      };
      requests.push({
        url,
        model: body.model,
        reasoning_effort: body.reasoning_effort,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "{}" },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }),
  );
  const env = {
    NESTOR_AI_API_KEY: "synthetic-key",
    NESTOR_AI_STREAMING: "false",
  };
  const client = createJobFinderAiClientFromEnvironment(env);
  expect(client.getStatus()).toMatchObject({
    model: "deepseek-v4.1-flash",
    modelContextWindowTokens: 128000,
  });
  expect(createResumeVisionProviderFromEnvironment(env).getStatus().model).toBe(
    "deepseek-v4.1-flash",
  );
  expect(
    createBrowserVisualAnalysisProviderFromEnvironment(env).getStatus().model,
  ).toBe("deepseek-v4.1-flash");
  const live = createLiveAssistantProvidersFromEnvironment(env);
  expect(live.cueCardProvider.getStatus().detail).toContain(
    "deepseek-v4.1-flash",
  );
  expect(live.screenshotVisionProvider.getStatus().detail).toContain(
    "deepseek-v4.1-flash",
  );
  expect(
    resolveAssistantModelCapabilities({ model: "deepseek-v4.1-flash" }),
  ).toMatchObject({ images: true, continuation: "reasoning_content" });
  for (const reasoningTask of [
    "fit_batch",
    "listing_screen",
    "apply",
    "claim_check",
    "listing_read",
  ] as const)
    await client.chatWithTools!([], [], { reasoningTask, jsonOutput: true });
  expect(requests.map((r) => r.model)).toEqual(
    Array(5).fill("deepseek-v4.1-flash"),
  );
  expect(requests.every((r) => r.url.endsWith("/chat/completions"))).toBe(true);
  expect(requests.map((r) => r.reasoning_effort)).toEqual([
    "low",
    "low",
    "low",
    "low",
    "low",
  ]);
  const override = createJobFinderAiClientFromEnvironment({
    ...env,
    NESTOR_AI_FIT_REASONING_EFFORT: "high",
  });
  await override.chatWithTools!([], [], { reasoningTask: "fit_batch" });
  expect(requests.at(-1)?.reasoning_effort).toBe("high");
});
