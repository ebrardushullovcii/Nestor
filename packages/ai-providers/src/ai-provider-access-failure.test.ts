import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentTaskNonRetryableProviderError } from "@nestor/agent-runtime";
import {
  getAiProviderAccessFailure,
  isAiProviderRateLimited,
} from "./ai-provider-access-failure";
import {
  ModelRequestHttpError,
  ModelRequestTimeoutError,
  resetModelCredentialRejections,
} from "./model-request-transport";

beforeEach(() => {
  resetModelCredentialRejections();
});
import { createJobFinderAiClientFromEnvironment } from "./openai-compatible";
import {
  createEnvironment,
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
} from "./test-fixtures";

describe("AI provider access failures", () => {
  test.each([
    [402, "funding"],
    [401, "authentication"],
    [403, "permission"],
  ] as const)(
    "recognizes a structured AI provider %i without exposing its body",
    (status, reason) => {
      const failure = getAiProviderAccessFailure(
        new ModelRequestHttpError("PRIVATE_PROVIDER_BODY", status, null),
      );
      expect(failure?.reason).toBe(reason);
      expect(failure?.message).toContain("The AI service is unavailable");
      expect(failure?.message).toContain("Nothing was changed");
      expect(failure?.message).toContain("after the service is restored");
      expect(failure?.message).not.toMatch(
        /PRIVATE_PROVIDER_BODY|API key|model settings|billing settings/,
      );
    },
  );

  test("finds insufficient funds through the actual agent wrapper and resume cause chain", () => {
    const provider = new ModelRequestHttpError(
      "Insufficient account funds",
      402,
      null,
    );
    const agent = new AgentTaskNonRetryableProviderError(
      "Provider request failed",
      { cause: provider },
    );
    const resume = new Error("The AI could not write this resume", {
      cause: agent,
    });
    expect(getAiProviderAccessFailure(resume)).toMatchObject({
      reason: "funding",
    });
  });

  test("does not identify website failures or forged status/name/message fields as provider access failures", () => {
    const website = Object.assign(
      new Error("Employer website rejected access"),
      { status: 403 },
    );
    const forged = Object.assign(new Error("Insufficient account funds"), {
      status: 402,
      name: "ModelRequestHttpError",
    });
    for (const error of [
      website,
      forged,
      { status: 401 },
      "Insufficient account funds",
      new Error("Research fetch failed with403"),
      new Error("Wrapped site failure", { cause: website }),
    ]) {
      expect(getAiProviderAccessFailure(error)).toBeNull();
    }
  });

  test.each([400, 404, 408, 409, 425, 429, 500, 503])(
    "does not turn provider HTTP%i into an access failure",
    (status) => {
      expect(
        getAiProviderAccessFailure(
          new ModelRequestHttpError("Insufficient account funds", status, null),
        ),
      ).toBeNull();
    },
  );

  test("handles cyclic, overly deep and unreadable cause chains without throwing", () => {
    const cycle = new Error("Cycle");
    Object.defineProperty(cycle, "cause", { value: cycle });
    expect(getAiProviderAccessFailure(cycle)).toBeNull();
    let deep: Error = new ModelRequestHttpError(
      "Insufficient account funds",
      402,
      null,
    );
    for (let index = 0; index < 20; index += 1)
      deep = new Error("Wrapper", { cause: deep });
    expect(getAiProviderAccessFailure(deep)).toBeNull();
    const unreadable = new Error("Unreadable cause");
    Object.defineProperty(unreadable, "cause", {
      get() {
        throw new Error("Cannot read cause");
      },
    });
    expect(getAiProviderAccessFailure(unreadable)).toBeNull();
  });

  test("keeps timeouts separate from provider access failures", () => {
    const timeout = new ModelRequestTimeoutError("total", 600_000);
    expect(
      getAiProviderAccessFailure(
        new Error("Wrapped timeout", { cause: timeout }),
      ),
    ).toBeNull();
  });

  test("the configured resume path reports insufficient funds and preserves the structured provider cause", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Insufficient account funds" },
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const failure = await client
        .createResumeDraft({
          profile: createProfile(),
          searchPreferences: createPreferences(),
          settings: createSettings(),
          job: createJobPosting(),
          resumeText: "Synthetic selected base resume",
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error))
        throw new Error("Expected the resume request to fail");
      expect(failure.message).toBe(
        getAiProviderAccessFailure(failure)?.message,
      );
      expect(getAiProviderAccessFailure(failure)?.reason).toBe("funding");
      expect(failure.cause).toBeInstanceOf(AgentTaskNonRetryableProviderError);
      if (!(failure.cause instanceof Error))
        throw new Error("Expected the agent error cause");
      expect(failure.cause.cause).toBeInstanceOf(ModelRequestHttpError);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
      logging.mockRestore();
    }
  });

  test("the configured resume path retains its normal timeout message", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new ModelRequestTimeoutError("total", 600_000));
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const failure = await client
        .createResumeDraft({
          profile: createProfile(),
          searchPreferences: createPreferences(),
          settings: createSettings(),
          job: createJobPosting(),
          resumeText: "Synthetic selected base resume",
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error))
        throw new Error("Expected a timeout failure");
      expect(failure.message).toBe(
        "The AI could not write this resume in time, so nothing was changed. Try again.",
      );
      expect(getAiProviderAccessFailure(failure)).toBeNull();
      expect(failure.cause).toBeInstanceOf(AgentTaskNonRetryableProviderError);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
      logging.mockRestore();
    }
  });
});

describe("AI provider rate limits", () => {
  test("recognizes a 429 through wrapping errors and nothing else", () => {
    const limited = new ModelRequestHttpError("Too many requests", 429, 2_000);
    expect(isAiProviderRateLimited(limited)).toBe(true);
    expect(
      isAiProviderRateLimited(
        new Error("Resume writing failed", { cause: limited }),
      ),
    ).toBe(true);
    expect(
      isAiProviderRateLimited(new ModelRequestHttpError("Down", 503, null)),
    ).toBe(false);
    expect(isAiProviderRateLimited(new Error("429 Too Many Requests"))).toBe(
      false,
    );
    expect(isAiProviderRateLimited("429")).toBe(false);
  });
});

test("a request the service never finished answering counts as busy, not failed", async () => {
  const { ModelRequestTimeoutError } = await import("./model-request-transport");
  const { isAiServiceBusy } = await import("./ai-provider-access-failure");
  const wrapped = new Error("The AI could not write this resume in time.", {
    cause: new ModelRequestTimeoutError("total", 300_000),
  });
  expect(isAiServiceBusy(wrapped)).toBe(true);
  expect(isAiServiceBusy(new Error("Model returned a non-JSON response"))).toBe(
    false,
  );
});
