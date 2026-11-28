import { describe, expect, test, vi } from "vitest";
import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";
import {
  buildModelRequestBody,
  buildModelUrl,
  DEFAULT_OPENCODE_GO_BASE_URL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TEXT_MODEL_API_MODE,
  DEFAULT_TEXT_MODEL_REASONING_EFFORT,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_MODEL_API_MODE,
  DEFAULT_VISION_MODEL_REASONING_EFFORT,
  parseModelJsonResponse,
  parseResponsePayload,
} from "./openai-compatible-transport";

describe("Responses API transport", () => {
  test.each([
    {
      endpoint: "api.openai.com",
      model: "gpt-6.2-sol",
      apiMode: "responses",
      explicit: true,
    },
    {
      endpoint: "api.openai.com",
      model: "gpt-5.4",
      apiMode: "responses",
      explicit: false,
    },
    {
      endpoint: "opencode.ai",
      model: "gpt-6.2-sol",
      apiMode: "responses",
      explicit: false,
    },
    {
      endpoint: "opencode.ai",
      model: "deepseek-v4.1-flash",
      apiMode: "chat_completions",
      explicit: false,
    },
  ] as const)(
    "$endpoint $model keeps shared application requests on the same cache route",
    async ({ endpoint, model, apiMode, explicit }) => {
      const reply =
        apiMode === "responses"
          ? { status: "completed" }
          : { choices: [{ message: { content: "done" } }] };
      const stableLeadBreakpoints = [
        "Applicant facts",
        "Completed history block",
        "Saved answers",
      ];
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(() => Promise.resolve(Response.json(reply)));
      try {
        const request = async (
          profileId: string,
          job: string,
          includesReply = false,
        ) => {
          const client = createOpenAiCompatibleJobFinderAiClient({
            baseUrl: `https://${endpoint}/v1`,
            apiKey: "synthetic",
            apiMode,
            model,
          });
          await client.chatWithTools(
            [
              { role: "system", content: "Application instructions" },
              ...stableLeadBreakpoints.map((content) => ({
                role: "user" as const,
                content,
              })),
              { role: "user", content: job },
              ...(includesReply
                ? [
                    { role: "assistant" as const, content: "Page inspected" },
                    { role: "user" as const, content: "Saved answers" },
                  ]
                : []),
            ],
            [],
            {
              conversationKey: `apply:${profileId}`,
              stableLeadBreakpoints,
            },
          );
          const init = fetch.mock.calls.at(-1)?.[1];
          const serialized = init?.body;
          if (typeof serialized !== "string")
            throw new Error("Expected a JSON request body");
          const body = JSON.parse(serialized) as {
            prompt_cache_key?: string;
            prompt_cache_options?: { mode: string };
            input?: Array<{ role: string; content: unknown }>;
            messages?: Array<{ role: string; content: unknown }>;
          };
          const headers = new Headers(init?.headers);
          const session = headers.get("x-opencode-session");
          if (endpoint === "opencode.ai")
            expect(body.prompt_cache_key).toBeUndefined();
          else expect(session).toBeNull();
          return {
            key: body.prompt_cache_key ?? session,
            options: body.prompt_cache_options,
            input: body.input ?? body.messages ?? [],
          };
        };
        const first = await request("test-person", "First job");
        const next = await request("test-person", "Second job");
        const other = await request("other-person", "Another job");
        const laterTurn = await request("test-person", "First job", true);
        expect(first.key).toMatch(/^ses_[a-z0-9]+$/);
        expect(first.key).toBe(next.key);
        expect(first.key).toBe(laterTurn.key);
        expect(first.key).not.toBe(other.key);
        expect(first.options).toEqual(
          explicit ? { mode: "implicit" } : undefined,
        );
        expect(first.input).toEqual([
          { role: "system", content: "Application instructions" },
          ...stableLeadBreakpoints.map((text) => ({
            role: "user",
            content: explicit
              ? [
                  {
                    type: "input_text",
                    text,
                    prompt_cache_breakpoint: { mode: "explicit" },
                  },
                ]
              : text,
          })),
          { role: "user", content: "First job" },
        ]);
        expect(next.input.slice(0, -1)).toEqual(first.input.slice(0, -1));
        expect(laterTurn.input.slice(0, first.input.length)).toEqual(
          first.input,
        );
        expect(laterTurn.input.at(-1)).toEqual({
          role: "user",
          content: "Saved answers",
        });
      } finally {
        fetch.mockRestore();
      }
    },
  );

  test("a Responses tool reply asks the runtime to keep history append-only", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "observe",
            arguments: "{}",
          },
        ],
      }),
    );
    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        baseUrl: "https://provider.example/v1",
        apiKey: "synthetic",
        model: "gpt-6.2-sol",
        apiMode: "responses",
      });
      const reply = await client.chatWithTools(
        [{ role: "user", content: "Read the current application page." }],
        [
          {
            type: "function",
            function: {
              name: "observe",
              description: "Read the page.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      );
      expect(reply.toolCalls?.[0]?.function.name).toBe("observe");
      expect(reply.appendOnlyHistory).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  test.each(["chat_completions", "responses"] as const)(
    "%s attaches tool images after all tool replies without losing their text",
    (apiMode) => {
      const image = {
        dataUrl: "data:image/png;base64,AAAA",
        label: "Puzzle at viewport 100,200",
      };
      const body = buildModelRequestBody({
        apiMode,
        model: "vision",
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: ["a", "b"].map((id) => ({
              id,
              type: "function",
              function: { name: "screenshot", arguments: "{}" },
            })),
          },
          {
            role: "tool",
            tool_call_id: "a",
            content: "Whole page geometry",
            images: [image],
          },
          {
            role: "tool",
            tool_call_id: "b",
            content: "Named frame geometry",
            images: [image],
          },
        ],
      });
      const wire = JSON.stringify(body);
      expect(wire).toContain(image.dataUrl);
      expect(wire).toContain(image.label);
      expect(wire).toContain("Whole page geometry");
      expect(wire).toContain("Named frame geometry");
      const items = (body.messages ?? body.input) as Array<{
        role?: string;
        content?: unknown;
      }>;
      expect(items.at(-1)?.role).toBe("user");
      expect(JSON.stringify(items.slice(0, -1))).not.toContain(image.dataUrl);
      expect(wire).not.toContain('"images":');
    },
  );
  test("sends an explicitly requested strict response schema", () => {
    const jsonSchema = {
      name: "judgments",
      schema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    expect(
      buildModelRequestBody({
        apiMode: "responses",
        model: "verified-model",
        messages: [],
        jsonOutput: true,
        jsonSchema,
      }),
    ).toHaveProperty("text.format", {
      type: "json_schema",
      strict: true,
      ...jsonSchema,
    });
  });

  test("only adds a sampling control when the caller requested one", () => {
    const input = {
      apiMode: "responses" as const,
      model: "muse-spark-1.3-contributor",
      reasoningEffort: "medium" as const,
      messages: [{ role: "user" as const, content: "Judge these facts." }],
    };
    expect(buildModelRequestBody(input)).not.toHaveProperty("temperature");
    expect(buildModelRequestBody({ ...input, temperature: 0 })).toMatchObject({
      temperature: 0,
      reasoning: { effort: "medium" },
    });
    expect(
      buildModelRequestBody({ ...input, apiMode: "chat_completions" }),
    ).not.toHaveProperty("temperature");
    expect(
      buildModelRequestBody({
        ...input,
        apiMode: "chat_completions",
        reasoningEffort: undefined,
      }),
    ).toHaveProperty("temperature", 0.2);
  });

  test("keeps ordinary text and image-only defaults on separate OpenCode Go routes", () => {
    expect(DEFAULT_OPENCODE_GO_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
    expect({
      model: DEFAULT_TEXT_MODEL,
      apiMode: DEFAULT_TEXT_MODEL_API_MODE,
      reasoningEffort: DEFAULT_TEXT_MODEL_REASONING_EFFORT,
    }).toEqual({
      model: "deepseek-v4.1-flash",
      apiMode: "chat_completions",
      reasoningEffort: "low",
    });
    expect({
      model: DEFAULT_VISION_MODEL,
      apiMode: DEFAULT_VISION_MODEL_API_MODE,
      reasoningEffort: DEFAULT_VISION_MODEL_REASONING_EFFORT,
    }).toEqual({
      model: "deepseek-v4.1-flash",
      apiMode: "chat_completions",
      reasoningEffort: "low",
    });
  });

  test("preserves max reasoning for Chat Completions tool requests", () => {
    const body = buildModelRequestBody({
      apiMode: "chat_completions",
      model: "deepseek-v4-flash",
      reasoningEffort: "max",
      messages: [{ role: "user", content: "Inspect the saved profile." }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_profile",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      tool_choice: "auto",
    });
  });

  test("builds a private Luna high structured request with vision input", () => {
    const body = buildModelRequestBody({
      apiMode: "responses",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      jsonOutput: true,
      messages: [
        { role: "system", content: "Return grounded JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: '{"candidate":"Casey"}' },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,AAAA",
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    expect(buildModelUrl("http://127.0.0.1:8080/v1", "responses")).toBe(
      "http://127.0.0.1:8080/v1/responses",
    );
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      reasoning: { effort: "high" },
      text: { format: { type: "json_object" } },
      input: [
        { role: "system", content: "Return grounded JSON." },
        {
          role: "user",
          content: [
            { type: "input_text", text: '{"candidate":"Casey"}' },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
              detail: "high",
            },
          ],
        },
      ],
    });
  });

  test("maps function tools and prior tool results to Responses items", () => {
    const body = buildModelRequestBody({
      apiMode: "responses",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      messages: [
        { role: "user", content: "Check the source." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "inspect_source", arguments: '{"id":1}' },
            },
          ],
        },
        {
          role: "tool",
          content: '{"status":"ready"}',
          tool_call_id: "call_1",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "inspect_source",
            description: "Inspect one source.",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        },
      ],
    });

    expect(body).toMatchObject({
      input: [
        { role: "user", content: "Check the source." },
        {
          type: "function_call",
          call_id: "call_1",
          name: "inspect_source",
          arguments: '{"id":1}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"status":"ready"}',
        },
      ],
      tools: [
        {
          type: "function",
          name: "inspect_source",
          description: "Inspect one source.",
        },
      ],
    });
  });

  test("normalizes Responses text and function calls for existing clients", async () => {
    const jsonResponse = new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ score: 92 }),
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );

    await expect(
      parseModelJsonResponse(jsonResponse, "responses"),
    ).resolves.toEqual({ score: 92 });

    const toolResponse = new Response(
      JSON.stringify({
        output: [
          {
            type: "function_call",
            call_id: "call_2",
            name: "prepare_application",
            arguments: '{"jobId":"job_1"}',
          },
        ],
      }),
      { status: 200 },
    );
    const payload = await parseResponsePayload(toolResponse, "responses");

    expect(payload.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: "call_2",
        type: "function",
        function: {
          name: "prepare_application",
          arguments: '{"jobId":"job_1"}',
        },
      },
    ]);
  });
});

test.each(["chat_completions", "responses"] as const)(
  "%s explicitly allows multiple ordered tool proposals",
  (apiMode) => {
    const body = buildModelRequestBody({
      apiMode,
      model: "synthetic-model",
      messages: [],
      parallelToolCalls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "fill_fields",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(body.parallel_tool_calls).toBe(true);
    expect(
      buildModelRequestBody({
        apiMode,
        model: "synthetic-model",
        messages: [],
        parallelToolCalls: true,
      }).parallel_tool_calls,
    ).toBeUndefined();
  },
);

test("uses the final assistant message instead of joining separate JSON drafts", async () => {
  const result = await parseResponsePayload(
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            phase: "commentary",
            content: [{ type: "output_text", text: '{"draft":true}' }],
          },
          {
            type: "message",
            phase: "final_answer",
            content: [{ type: "output_text", text: '{"keep":{"0":1}}' }],
          },
        ],
        output_text: '{"draft":true}\n{"keep":{"0":1}}',
      }),
    ),
    "responses",
  );
  expect(result.choices?.[0]?.message?.content).toBe('{"keep":{"0":1}}');
});
