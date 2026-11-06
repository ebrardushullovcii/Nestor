import { expect, test } from "vitest";
import { buildModelRequestBody } from "./openai-compatible-transport";
import { modelOutputLimit } from "./model-output-limit";

test.each([
  ["deepseek-v4.1-flash", 384_000],
  ["muse-spark-1.3-contributor", 131_072],
  ["gpt-5.6-luna", 128_000],
] as const)(
  "%s uses its published output maximum in both API modes",
  (model, maximum) => {
    expect(modelOutputLimit(model)).toBe(maximum);
    for (const apiMode of ["chat_completions", "responses"] as const) {
      const body = buildModelRequestBody({ apiMode, model, messages: [] });
      expect(
        body[apiMode === "responses" ? "max_output_tokens" : "max_tokens"],
      ).toBe(maximum);
    }
  },
);

test("unknown routes omit output caps instead of inventing a model limit", () => {
  for (const apiMode of ["chat_completions", "responses"] as const) {
    const body = buildModelRequestBody({
      apiMode,
      model: "custom-route",
      messages: [],
    });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_output_tokens");
  }
});
