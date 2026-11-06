import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { auditSelfLimits } from "./self-limits.ts";
import { markdown } from "./report.ts";
import type { Run } from "./types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function run(): Run {
  const output = mkdtempSync(path.join(os.tmpdir(), "nestor-self-limits-"));
  directories.push(output);
  mkdirSync(path.join(output, "steps"));
  return {
    version: 2,
    startedAt: "2026-11-06T00:00:00Z",
    source: { head: "abcd", dirty: null },
    ai: "scripted",
    driver: "test",
    persona: {},
    preconditions: [],
    output,
    results: [],
  };
}
test("passes zero events in run step logs", () => {
  const measured = run();
  writeFileSync(
    path.join(measured.output, "steps", "search.log"),
    "search finished\n",
  );
  expect(auditSelfLimits(measured).status).toBe("pass");
  expect(markdown(measured)).toContain("Our own limits | PASS");
});
test("fails one event in a nested process log and names the limit", () => {
  const measured = run();
  const logs = path.join(measured.output, "instance", "verify", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "app.log"),
    `[main] [self_limit_hit] ${JSON.stringify({ event: "self_limit_hit", limit: "max_pages", kind: "pages", value: 10, where: "search.ts" })}\n`,
  );
  expect(auditSelfLimits(measured).status).toBe("fail");
  expect(markdown(measured)).toContain("max_pages (pages=10) at search.ts");
  auditSelfLimits(measured);
  expect(measured.results).toHaveLength(1);
});
test("missing logs are unmeasured and malformed events fail visibly", () => {
  const measured = run();
  expect(auditSelfLimits(measured).status).toBe("not run");
  writeFileSync(
    path.join(measured.output, "steps", "search.log"),
    "[self_limit_hit] broken\n",
  );
  expect(auditSelfLimits(measured).status).toBe("fail");
});
