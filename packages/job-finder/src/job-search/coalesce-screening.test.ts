import { expect, test, vi } from "vitest";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import { coalesceScreening } from "./coalesce-screening";

type Chat = NonNullable<JobFinderAiClient["chatWithTools"]>;
const messages: Parameters<Chat>[0] = [
  { role: "user", content: "Screen the supplied titles" },
];
const options = () => ({
  signal: new AbortController().signal,
  reasoningTask: "listing_screen" as const,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("identical simultaneous questions share one turn and one usage report", async () => {
  const turn = deferred<Awaited<ReturnType<Chat>>>();
  const chat = vi.fn<Chat>(() => turn.promise);
  const shared = coalesceScreening(chat),
    input = options();
  const first = shared(messages, [], input),
    second = shared(messages, [], input);
  expect(chat).toHaveBeenCalledTimes(1);
  const usage = {
    inputTokens: 100,
    outputTokens: 1000,
    reasoningTokens: 900,
    cachedInputTokens: 0,
  };
  turn.resolve({ content: '{"keep":{"0":1}}', usage });
  expect((await first).usage).toEqual(usage);
  expect(await second).toEqual({ content: '{"keep":{"0":1}}' });
  await shared(messages, [], input);
  expect(chat).toHaveBeenCalledTimes(2);
});

test("different evidence, options, searches and purposes remain independent", async () => {
  const chat = vi.fn<Chat>(() => Promise.resolve({ content: "{}" }));
  const shared = coalesceScreening(chat),
    input = options();
  await Promise.all([
    shared(messages, [], input),
    shared([{ role: "user", content: "Different duties" }], [], input),
    shared(messages, [], { ...input, parallelToolCalls: false }),
    shared(messages, [], options()),
    shared(messages, [], { ...input, reasoningTask: "page_read" }),
  ]);
  expect(chat).toHaveBeenCalledTimes(5);
});

test("a failed shared turn is discarded so a new request can succeed", async () => {
  const turn = deferred<Awaited<ReturnType<Chat>>>();
  const chat = vi
    .fn<Chat>()
    .mockReturnValueOnce(turn.promise)
    .mockResolvedValue({ content: "{}" });
  const shared = coalesceScreening(chat),
    input = options();
  const first = shared(messages, [], input),
    second = shared(messages, [], input);
  const failed = Promise.allSettled([first, second]);
  turn.reject(
    new Error(
      "The AI service returned an incomplete response: max_output_tokens",
    ),
  );
  expect((await failed).map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  await shared(messages, [], { ...input, parallelToolCalls: false });
  expect(chat).toHaveBeenCalledTimes(2);
});
