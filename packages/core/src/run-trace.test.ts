import { afterEach, expect, test, vi } from "vitest";
import { traceSafe, traceEvent } from "./run-trace";
import { randomBytes } from "node:crypto";
import {
  withVerificationPrivacy,
  markVerificationPrivate,
  rememberVerificationSecret,
  redactVerificationData,
} from "./run-trace";
afterEach(() => vi.unstubAllEnvs());

test("mailbox privacy omits model payloads before a code field is known, leaves execution intact and isolates concurrent runs", async () => {
  const code = randomBytes(5).toString("hex");
  await Promise.all([
    withVerificationPrivacy(async () => {
      markVerificationPrivate();
      await Promise.resolve();
      const request = { messages: [{ content: `Mailbox message: ${code}` }] };
      const response = {
        toolCalls: [
          {
            function: {
              name: "type",
              arguments: JSON.stringify({ ref: "c1", text: code }),
            },
          },
        ],
      };
      expect(
        JSON.stringify(traceSafe({ request, response })).includes(code),
      ).toBe(false);
      expect(request.messages[0]?.content.includes(code)).toBe(true);
      const dataUrl = `data:image/png;base64,${Buffer.from(code).toString("base64")}`;
      expect(
        traceSafe({ images: [{ dataUrl, label: "Mailbox viewport" }] }),
      ).toEqual({
        images: [{ dataUrl: "[secret omitted]", label: "Mailbox viewport" }],
      });
      rememberVerificationSecret(code);
      expect(
        JSON.stringify(
          redactVerificationData({ reason: `Entered ${code}` }),
        ).includes(code),
      ).toBe(false);
    }),
    withVerificationPrivacy(async () => {
      await Promise.resolve();
      expect(traceSafe({ request: "Other task facts" })).toEqual({
        request: "Other task facts",
      });
    }),
  ]);
});
test("trace omits credentials, MFA answers and private reasoning but retains the person's facts", () => {
  vi.stubEnv("NESTOR_TEST_API_KEY", "test-api-secret");
  const text = JSON.stringify(
    traceSafe({
      model: "deepseek",
      reasoning: { effort: "high" },
      reasoning_content: "PRIVATE",
      continuation: { kind: "reasoning_content", text: "PRIVATE" },
      headers: {
        Authorization: "Bearer test-api-secret",
        Cookie: "cookie-secret",
      },
      body: "My experience",
      tool: JSON.stringify({
        password: "password-secret",
        label: "MFA code",
        value: "123456",
      }),
      url: "https://example.test/?code=oauth-secret",
      output: [
        { type: "reasoning", text: "PRIVATE" },
        { type: "message", text: "Visible answer" },
      ],
    }),
  );
  for (const secret of [
    "PRIVATE",
    "test-api-secret",
    "password-secret",
    "cookie-secret",
    "123456",
    "oauth-secret",
  ])
    expect(text).not.toContain(secret);
  for (const fact of ["My experience", "Visible answer", "high"])
    expect(text).toContain(fact);
});
test("unwritable evidence cannot change execution", () => {
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", "\0");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(() => traceEvent("test", { value: 1 })).not.toThrow();
  warn.mockRestore();
});

test("ordinary JSON message formatting and credential tool schemas remain exact", () => {
  const content = '{\n  "ordinary": "profile facts"\n}';
  expect(traceSafe(content)).toBe(content);
  const tools = {
    properties: {
      password: { type: "string", description: "A schema, not a secret value" },
    },
  };
  expect(traceSafe(tools)).toEqual(tools);
  const applicationState = {
    continuation: {
      url: "https://example.test/step-2",
      completedFields: ["name"],
    },
  };
  expect(traceSafe(applicationState)).toEqual(applicationState);
});
