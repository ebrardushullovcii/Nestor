import { describe, expect, test } from "vitest";
import finalMutationReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/intermediate-final-mutations.json";
import {
  classifyIntermediateMutationRequest,
  type IntermediateMutationRequestInput,
} from "./application-intermediate-mutation-policy";

function classify(overrides: Partial<IntermediateMutationRequestInput> = {}) {
  return classifyIntermediateMutationRequest({
    authorized: true,
    bodyText: null,
    method: "PATCH",
    nowMs: 1_000,
    resourceKind: "fetch",
    url: "https://apply.example.com/api/application/draft",
    window: {
      expectedOrigin: "https://apply.example.com",
      expiresAtMs: 2_000,
      remainingRequests: 2,
    },
    ...overrides,
  });
}

describe("intermediate application mutation policy", () => {
  test.each(finalMutationReplay.denied)(
    "save-window send attack is refused: $path $body",
    ({ path, body }) => {
      expect(
        classify({
          method: "POST",
          url: `https://apply.example.com${path}`,
          bodyText: body,
        }),
      ).toEqual({ allowed: false, reason: "final_action_signal" });
    },
  );
  test.each(finalMutationReplay.allowed)(
    "non-final step save remains allowed: $path $body",
    ({ path, body }) => {
      expect(
        classify({
          method: "POST",
          url: `https://apply.example.com${path}`,
          bodyText: body,
        }),
      ).toEqual({ allowed: true, reason: "allowed_intermediate_mutation" });
    },
  );
  test.each([
    {
      url: "https://apply.example.com/api/applications",
      bodyText: '{"name":"Synthetic Candidate"}',
    },
    {
      url: "https://apply.example.com/api/users",
      bodyText: '{"email":"candidate@example.test"}',
    },
    {
      url: "https://apply.example.com/graphql",
      bodyText: '{"operationName":"CreateApplication"}',
    },
    {
      url: "https://apply.example.com/graphql",
      bodyText: '{"operationName":"ApplyToJob"}',
    },
    {
      url: "https://unrelated.example.net/api/autosave",
      bodyText: '{"answer":"private"}',
    },
    {
      url: "https://apply.example.com/api/application/draft",
      bodyText: " ".repeat(9000) + '{"operationName":"SubmitApplication"}',
    },
  ])(
    "denies ambiguous, outside-origin and final operations: $url",
    (request) => {
      expect(classify(request).allowed).toBe(false);
      expect(classify({ ...request, authorized: false }).allowed).toBe(false);
    },
  );
  test("a wildcard never opens an origin or ambiguity exemption", () => {
    expect(
      classify({
        window: {
          expectedOrigin: "*",
          expiresAtMs: 2000,
          remainingRequests: 2,
        },
      }).allowed,
    ).toBe(false);
  });
  test("allows an exact same-origin autosave only inside an active bounded window", () => {
    expect(classify()).toEqual({
      allowed: true,
      reason: "allowed_intermediate_mutation",
    });
    expect(
      classify({
        bodyText: JSON.stringify({
          operationName: "UpdateApplicationFormAnswer",
        }),
        url: "https://apply.example.com/graphql",
      }),
    ).toEqual({
      allowed: true,
      reason: "allowed_intermediate_mutation",
    });
  });

  test("denies requests without authority or outside the exact window", () => {
    expect(classify({ authorized: false }).reason).toBe("not_authorized");
    expect(classify({ window: null }).reason).toBe("window_closed");
    expect(classify({ nowMs: 2_001 }).reason).toBe("window_expired");
    expect(
      classify({
        window: {
          expectedOrigin: "https://apply.example.com",
          expiresAtMs: 2_000,
          remainingRequests: 0,
        },
      }).reason,
    ).toBe("window_exhausted");
  });

  test("denies final-submit semantics even when the endpoint also says update", () => {
    expect(
      classify({
        bodyText: JSON.stringify({
          operationName: "UpdateAndSubmitApplication",
        }),
        url: "https://apply.example.com/graphql",
      }),
    ).toEqual({ allowed: false, reason: "final_action_signal" });
    expect(
      classify({
        url: "https://apply.example.com/api/application/submit",
      }).reason,
    ).toBe("final_action_signal");
  });

  test("denies cross-origin, ambiguous, read-like, destructive, and long-lived transports", () => {
    expect(
      classify({ url: "https://tracker.example.net/api/draft" }).reason,
    ).toBe("cross_origin");
    expect(classify({ url: "https://apply.example.com/graphql" }).reason).toBe(
      "ambiguous_mutation",
    );
    expect(classify({ method: "GET" }).reason).toBe("unsafe_method");
    expect(classify({ method: "DELETE" }).reason).toBe("unsafe_method");
    expect(classify({ resourceKind: "send_beacon" }).reason).toBe(
      "unsupported_transport",
    );
    expect(classify({ resourceKind: "websocket" }).reason).toBe(
      "unsupported_transport",
    );
  });
});
