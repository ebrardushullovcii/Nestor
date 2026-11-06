import { expect, test, vi } from "vitest";
import { resolveAssistantModelRouteFromEnvironment } from "@nestor/ai-providers";
import { createAssistantModelHandle } from "./model-handle";

test("assistant replies and compaction summaries leave the output allowance to the model route", async () => {
  const resolved = resolveAssistantModelRouteFromEnvironment({
    NESTOR_AI_API_KEY: "synthetic-key",
  });
  if (!resolved.available) throw new Error("Synthetic route unavailable");
  const chat = vi
    .spyOn(resolved.route.client, "chatWithTools")
    .mockResolvedValue({ content: "Done" });
  const handle = createAssistantModelHandle(resolved.route);
  await handle.createModel("conversation").chatWithTools([], []);
  await handle.summarize!("conversation", "Summarize");
  expect(chat).toHaveBeenCalledTimes(2);
  for (const [, , options] of chat.mock.calls)
    expect(options).not.toHaveProperty("maxOutputTokens");
  expect(handle.capabilities.reservedOutputTokens).toBe(8000);
  expect(resolved.route.capabilities).not.toHaveProperty("maxOutputTokens");
});
