import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AI_ACCESS_MESSAGES,
  aiAccessBlocks,
  aiAccessStatus,
  checkAiAccessAgain,
  getAiProviderAccessFailure,
  isAiProviderAccessMessage,
  isAiServiceBusy,
  onAiAccessChange,
  onAiAccessRecheck,
  onAiAccessRefused,
  resetAiAccessForTests,
} from "./ai-provider-access-failure";
import {
  ModelRequestHttpError,
  ModelRequestTimeoutError,
  performModelRequest,
} from "./model-request-transport";

// A scripted provider: no real service or account is ever called.
const URL = "https://model.example.test/v1/chat/completions";
const TOP_UP =
  "https://model.example.test/console/account-test/billing?credits=1";
const OUT_OF_CREDIT = `Insufficient balance. Top up at ${TOP_UP}.`;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const answered = () =>
  reply(200, {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  });

function call(fetchImpl: typeof fetch, key = "scripted-key") {
  return performModelRequest({
    url: URL,
    headers: { Authorization: `Bearer ${key}` },
    body: { model: "scripted", messages: [] },
    apiMode: "chat_completions",
    streaming: false,
    fetchImpl,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
  });
}

beforeEach(() => resetAiAccessForTests());
afterEach(() => {
  resetAiAccessForTests();
  vi.useRealTimers();
});

describe("an AI account that refuses calls", () => {
  test("a 402 with the provider's words reaches the person once, with its top-up link, and clears when a call goes through", async () => {
    const changes: string[] = [];
    const refusals: string[] = [];
    onAiAccessChange((status) => changes.push(status));
    onAiAccessRefused((block) => refusals.push(block.reason));
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(reply(402, { error: { message: OUT_OF_CREDIT } })),
    );

    const failure = await call(fetchImpl).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelRequestHttpError);
    expect(getAiProviderAccessFailure(failure)).toEqual({
      reason: "funding",
      message: AI_ACCESS_MESSAGES.funding,
      providerMessage: OUT_OF_CREDIT,
      actionUrl: TOP_UP,
    });
    expect(aiAccessStatus()).toBe("blocked");
    expect(aiAccessBlocks()).toEqual([
      expect.objectContaining({
        provider: "https://model.example.test",
        reason: "funding",
        providerMessage: OUT_OF_CREDIT,
        actionUrl: TOP_UP,
      }),
    ]);
    // The key never appears in what the person or the renderer sees.
    expect(JSON.stringify(aiAccessBlocks())).not.toContain("scripted-key");

    // Later calls in the transport's pause are refused without reaching the
    // service, and the person's item is not raised again.
    await expect(call(fetchImpl)).rejects.toThrow(OUT_OF_CREDIT);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(aiAccessBlocks()).toHaveLength(1);
    expect(changes).toEqual(["blocked"]);
    expect(refusals).toEqual(["funding", "funding"]);

    // The person topped up and says so: the waiting work's check goes now.
    fetchImpl.mockImplementation(() => Promise.resolve(answered()));
    const check = vi.fn(() => {
      void call(fetchImpl);
      return true;
    });
    onAiAccessRecheck(check);
    expect(checkAiAccessAgain()).toBe(true);
    await vi.waitFor(() => expect(aiAccessStatus()).toBe("available"));
    expect(aiAccessBlocks()).toEqual([]);
    expect(changes).toEqual(["blocked", "available"]);
  });

  test.each([
    [401, "authentication", "Invalid API key."],
    [403, "permission", "This key has no access to model scripted."],
  ] as const)(
    "a %i says its own plain step and keeps the provider's words",
    async (status, reason, words) => {
      const fetchImpl = vi.fn<typeof fetch>(() =>
        Promise.resolve(reply(status, { error: { message: words } })),
      );
      const failure = await call(fetchImpl).catch((error: unknown) => error);
      expect(getAiProviderAccessFailure(failure)).toEqual({
        reason,
        message: AI_ACCESS_MESSAGES[reason],
        providerMessage: words,
        actionUrl: null,
      });
      expect(AI_ACCESS_MESSAGES[reason]).not.toBe(AI_ACCESS_MESSAGES.funding);
      expect(aiAccessBlocks()).toEqual([
        expect.objectContaining({ reason, providerMessage: words }),
      ]);
    },
  );

  test("an ordinary outage or timeout stays a retry and never becomes an account step", async () => {
    const refusals = vi.fn();
    onAiAccessRefused(refusals);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(503, { error: { message: "Overloaded" } }))
      .mockResolvedValueOnce(answered());
    await expect(call(fetchImpl)).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refusals).not.toHaveBeenCalled();
    expect(aiAccessBlocks()).toEqual([]);
    expect(aiAccessStatus()).toBe("available");

    for (const error of [
      new ModelRequestHttpError("Overloaded", 503, null),
      new ModelRequestHttpError("Too many requests", 429, 1_000),
      new ModelRequestTimeoutError("idle", 180_000),
    ]) {
      expect(getAiProviderAccessFailure(error)).toBeNull();
      expect(isAiServiceBusy(error)).toBe(true);
    }
  });

  test("an OpenAI-style quota refusal sent as 429 is out of credit, not a busy service", () => {
    const quota = new ModelRequestHttpError(
      "[insufficient_quota] You exceeded your current quota.",
      429,
      null,
    );
    expect(getAiProviderAccessFailure(quota)).toMatchObject({
      reason: "funding",
      providerMessage: "You exceeded your current quota.",
    });
    expect(isAiServiceBusy(quota)).toBe(false);
  });

  test("an empty balance sent as 401 is the top-up, not a key to fix", () => {
    expect(
      getAiProviderAccessFailure(
        new ModelRequestHttpError(OUT_OF_CREDIT, 401, null),
      ),
    ).toMatchObject({ reason: "funding", actionUrl: TOP_UP });
  });

  test("a service that sent no words gives the plain step alone", () => {
    expect(
      getAiProviderAccessFailure(
        new ModelRequestHttpError(
          "Model request failed with status 402",
          402,
          null,
        ),
      ),
    ).toMatchObject({ providerMessage: null, actionUrl: null });
  });

  test("while it refuses, the waiting work is checked once the transport's pause ends", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(reply(402, { error: { message: OUT_OF_CREDIT } })),
    );
    await call(fetchImpl).catch(() => undefined);
    const check = vi.fn(() => true);
    const second = vi.fn(() => true);
    onAiAccessRecheck(check);
    onAiAccessRecheck(second);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    // One item of waiting work is the check; the next waits for its answer.
    expect(check).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  test("work recorded with this or the earlier refusal sentence is recognized as waiting on the account", () => {
    for (const message of Object.values(AI_ACCESS_MESSAGES))
      expect(isAiProviderAccessMessage(message)).toBe(true);
    expect(
      isAiProviderAccessMessage(
        "The AI service is unavailable right now. Nothing was changed. Try again after the service is restored.",
      ),
    ).toBe(true);
    expect(isAiProviderAccessMessage("The model returned nothing.")).toBe(
      false,
    );
    expect(isAiProviderAccessMessage(null)).toBe(false);
  });
});
