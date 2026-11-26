import { afterEach, expect, test, vi } from "vitest";
import { traceSafe, traceEvent, traceArtifact } from "./run-trace";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  withVerificationPrivacy,
  markVerificationPrivate,
  rememberVerificationSecret,
  redactVerificationData,
} from "./run-trace";
afterEach(() => vi.unstubAllEnvs());

const traceLines = (dir: string): Record<string, unknown>[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );

test("a mailbox window's evidence is written when the run ends with only the code it used masked, and other runs write at once", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-mailbox-trace-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  const code = randomBytes(5).toString("hex");
  const image = `data:image/png;base64,${Buffer.from(code).toString("base64")}`;
  try {
    await Promise.all([
      withVerificationPrivacy(async () => {
        markVerificationPrivate();
        await Promise.resolve();
        const request = {
          model: "deepseek-v4.1-flash",
          messages: [{ content: `Mailbox message: your code is ${code}` }],
          images: [{ dataUrl: image, label: "Mailbox viewport" }],
        };
        traceEvent("provider_request", { request });
        const shot = traceArtifact("shots", Buffer.from(code), "png", {
          mailboxPage: true,
        });
        traceEvent("page_snapshot", {
          shot,
          visibleText: `Inbox: ${code}`,
          mailboxPage: true,
        });
        // The live payload is untouched; nothing is on disk yet.
        expect(request.messages[0]?.content).toContain(code);
        expect(
          traceLines(dir).filter((line) => line.event === "provider_request"),
        ).toEqual([]);
        rememberVerificationSecret(code);
        expect(
          JSON.stringify(
            redactVerificationData({ reason: `Entered ${code}` }),
          ).includes(code),
        ).toBe(false);
      }),
      withVerificationPrivacy(async () => {
        await Promise.resolve();
        traceEvent("other_run", { request: "Other task facts" });
        expect(
          traceLines(dir).find((line) => line.event === "other_run"),
        ).toMatchObject({ request: "Other task facts" });
      }),
    ]);
    const lines = traceLines(dir);
    const raw = JSON.stringify(lines);
    expect(raw.includes(code)).toBe(false);
    expect(lines.find((line) => line.event === "provider_request")).toEqual(
      expect.objectContaining({
        request: {
          model: "deepseek-v4.1-flash",
          messages: [
            { content: "Mailbox message: your code is [code omitted]" },
          ],
          images: [
            {
              dataUrl: "[image omitted: code used]",
              label: "Mailbox viewport",
            },
          ],
        },
      }),
    );
    expect(lines.find((line) => line.event === "page_snapshot")).toMatchObject({
      shot: null,
      omitted: "verification privacy",
    });
    expect(existsSync(path.join(dir, "shots"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mailbox window without a code keeps its requests, tool payloads and images", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-mailbox-send-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  const image = `data:image/png;base64,${Buffer.from("compose").toString("base64")}`;
  try {
    await withVerificationPrivacy(async () => {
      markVerificationPrivate();
      await Promise.resolve();
      traceEvent("provider_request", {
        request: { model: "deepseek-v4.1-flash", images: [{ dataUrl: image }] },
      });
      traceEvent("tool_call", {
        name: "submit_application",
        arguments: JSON.stringify({ ref: "send" }),
        result: "Send ledger: sendCallId=send-1",
      });
      const shot = traceArtifact("shots", Buffer.from("png"), "png", {
        mailboxPage: true,
      });
      traceEvent("page_snapshot", {
        shot,
        url: "https://mail.google.com/mail/u/0/#inbox?compose=new",
        visibleText: "Message sent",
        mailboxPage: true,
      });
    });
    const lines = traceLines(dir);
    expect(lines.map((line) => line.event)).toEqual([
      "provider_request",
      "tool_call",
      "page_snapshot",
    ]);
    expect(lines[0]).toMatchObject({
      request: { model: "deepseek-v4.1-flash", images: [{ dataUrl: image }] },
    });
    expect(lines[1]).toMatchObject({
      name: "submit_application",
      arguments: '{"ref":"send"}',
      result: "Send ledger: sendCallId=send-1",
    });
    expect(lines[2]).toMatchObject({ visibleText: "Message sent" });
    expect(lines[2]).not.toHaveProperty("mailboxPage");
    expect(existsSync(path.join(dir, String(lines[2]!.shot)))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a code typed one box at a time is masked as the joined code", async () => {
  await withVerificationPrivacy(async () => {
    markVerificationPrivate();
    await Promise.resolve();
    for (const digit of "481516") rememberVerificationSecret(digit);
    expect(
      redactVerificationData({ text: "Your code is 481516 (sent 2026-11-07)" }),
    ).toEqual({ text: "Your code is [code omitted] (sent 2026-11-07)" });
  });
});

test("URL credentials are masked without consuming neighbouring JSON fields", () => {
  expect(
    traceSafe(
      '{"origin":"https://wd103.myworkdayjobs.com","username":"person@gmail.com"}',
    ),
  ).toBe(
    '{"origin":"https://wd103.myworkdayjobs.com","username":"person@gmail.com"}',
  );
  expect(traceSafe("https://user:pass@example.test/path")).toBe(
    "https://[secret omitted]@example.test/path",
  );
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
test("an environment secret is masked as its own token, never inside another word", () => {
  // Windows CI images set PGPASSWORD=root machine-wide.
  vi.stubEnv("PGPASSWORD", "root");
  vi.stubEnv("NESTOR_TEST_API_KEY", "sk-test.key+1");
  expect(
    traceSafe({
      description: "a button, link, custom element, shadow-root control",
      path: "/srv/rootfs/app",
      login: "user root on db",
      header: "key=sk-test.key+1&x=1",
      quoted: '{"note":"sk-test.key+1"}',
      longer: "sk-test.key+12",
    }),
  ).toEqual({
    description: "a button, link, custom element, shadow-root control",
    path: "/srv/rootfs/app",
    login: "user [secret omitted] on db",
    header: "key=[secret omitted]&x=1",
    quoted: '{"note":"[secret omitted]"}',
    longer: "sk-test.key+12",
  });
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
