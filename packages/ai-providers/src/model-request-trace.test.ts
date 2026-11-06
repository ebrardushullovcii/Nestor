import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performModelRequest } from "./model-request-transport";
afterEach(() => vi.unstubAllEnvs());
test("transport records the effective streamed request and reported model without credentials or reasoning", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-provider-trace-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  try {
    let sent = "";
    const payload = {
      model: "reported-model",
      choices: [
        {
          delta: { content: "visible", reasoning_content: "PRIVATE_THOUGHT" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    };
    const response = await performModelRequest({
      url: "https://provider.invalid/v1/chat/completions",
      apiMode: "chat_completions",
      headers: { Authorization: "Bearer SECRET_KEY" },
      body: {
        model: "requested-model",
        reasoning_effort: "high",
        messages: [{ role: "system", content: "exact system" }],
        tools: [],
      },
      totalTimeoutMs: 5000,
      fetchImpl: vi.fn(
        (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          sent = typeof init?.body === "string" ? init.body : "";
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        },
      ),
    });
    expect(response.choices?.[0]?.message?.content).toBe("visible");
    const raw = readdirSync(dir)
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("");
    type Recorded = {
      event: string;
      request?: unknown;
      model?: string;
      response?: { choices?: { message?: { content?: string } }[] };
    };
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Recorded);
    expect(events.find((e) => e.event === "provider_request")?.request).toEqual(
      JSON.parse(sent) as unknown,
    );
    expect(events.find((e) => e.event === "provider_reported")?.model).toBe(
      "reported-model",
    );
    expect(
      events.find((e) => e.event === "provider_response")?.response
        ?.choices?.[0]?.message?.content,
    ).toBe("visible");
    expect(raw).not.toContain("SECRET_KEY");
    expect(raw).not.toContain("PRIVATE_THOUGHT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
