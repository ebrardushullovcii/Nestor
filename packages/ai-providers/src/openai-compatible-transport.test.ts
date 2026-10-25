import { describe, expect, test } from "vitest";
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
      model: "muse-spark-1.3-contributor",
      apiMode: "responses",
      reasoningEffort: "xhigh",
    });
    expect({
      model: DEFAULT_VISION_MODEL,
      apiMode: DEFAULT_VISION_MODEL_API_MODE,
      reasoningEffort: DEFAULT_VISION_MODEL_REASONING_EFFORT,
    }).toEqual({
      model: "muse-spark-1.3-contributor",
      apiMode: "responses",
      reasoningEffort: "xhigh",
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
      maxOutputTokens: 2_000,
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
      max_output_tokens: 2_000,
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
