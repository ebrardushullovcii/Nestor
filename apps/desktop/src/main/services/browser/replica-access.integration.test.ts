import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("shares a Workday session only after the person completes MFA, without logging credentials", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "nestor-access-fixture-"));
  const log = path.join(folder, "posts.jsonl");
  const server = spawn(
    process.execPath,
    [
      path.resolve(
        import.meta.dirname,
        "../../../../test-fixtures/job-sites/serve.mjs",
      ),
    ],
    {
      env: { ...process.env, PORT: "0", NESTOR_FIXTURE_SUBMISSIONS_LOG: log },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let output = "";
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fixture did not start")),
        10_000,
      );
      server.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      });
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
    const post = (route: string, fields: Record<string, string>, cookie = "") =>
      fetch(new URL(route, base), {
        method: "POST",
        body: new URLSearchParams(fields),
        headers: cookie ? { cookie } : {},
        redirect: "manual",
      });
    const registered = await post("/workday/account/register/3", {
      email: "mfa@example.test",
      password: "synthetic-only",
      verifyPassword: "synthetic-only",
      agree: "yes",
      enableMfa: "yes",
    });
    expect(registered.status).toBe(303);
    expect(registered.headers.get("location")).toBe("/workday/verify/3");
    expect(registered.headers.get("set-cookie")).toMatch(/^fixture_mfa=/u);
    expect(registered.headers.get("set-cookie")).not.toContain(
      "fixture_session=",
    );
    const cookie = registered.headers.get("set-cookie")?.split(";")[0] ?? "";
    const locked = await fetch(
      new URL("/workday/apply/4?stage=application", base),
      { headers: { cookie } },
    );
    expect(await locked.text()).toContain("Sign in / Create account");
    const wrong = await post("/workday/verify/3", { code: "wrong" }, cookie);
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const verified = await post(
      "/workday/verify/3",
      { code: "482917" },
      cookie,
    );
    expect(verified.status).toBe(303);
    expect(verified.headers.get("set-cookie")).toContain("Max-Age=86400");
    const session = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
    for (const id of [3, 4, 5]) {
      const application = await fetch(
        new URL(`/workday/apply/${id}?stage=application`, base),
        { headers: { cookie: session } },
      );
      expect(await application.text()).toContain("My Information");
    }
    await post(
      "/workday/api/save",
      { jobId: "3", firstName: "Synthetic" },
      session,
    );
    expect(await readFile(log, "utf8")).not.toMatch(
      /synthetic-only|482917|mfa@example.test/u,
    );
  } finally {
    server.kill();
    await new Promise<void>((resolve) =>
      server.exitCode !== null || server.signalCode !== null
        ? resolve()
        : server.once("exit", () => resolve()),
    );
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);
