import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { OBSERVED_SECONDS, scenarioTimeoutSeconds } from "./deadlines.ts";
import { replicaUrl } from "./replicas.ts";
import { applicationSiteKey } from "@nestor/browser-runtime";

test("the unchanged isolated send guard permits replica aliases and blocks external writes", () => {
  const patch = readFileSync(
    "packages/ai-evals/scripts/isolated-app/instance-patch.cjs",
    "utf8",
  );
  const start = patch.indexOf("const LOOPBACK ="),
    end = patch.indexOf('app.on("session-created", guard);', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  type Handler = (
    request: { url: string; method: string; resourceType: string },
    callback: (result: { cancel?: boolean }) => void,
  ) => void;
  let handler: Handler | undefined;
  const session = {
    webRequest: {
      onBeforeRequest: (read: Handler) => {
        handler = read;
      },
    },
  };
  const sandbox = {
    URL,
    providerFixture: null,
    netMode: "replica",
    log: () => {},
    installGuard: undefined as ((target: typeof session) => void) | undefined,
  };
  runInNewContext(
    patch.slice(start, end) + "\nglobalThis.installGuard = guard;",
    sandbox,
  );
  sandbox.installGuard!(session);
  for (const host of ["127.0.0.2", "127.0.0.3", "127.0.0.12", "example.com"]) {
    let cancelled = false;
    handler!(
      {
        url: `http://${host}:47950/apply`,
        method: "POST",
        resourceType: "xhr",
      },
      (result) => {
        cancelled = result.cancel === true;
      },
    );
    expect(cancelled, host).toBe(host === "example.com");
  }
});

test("every measured scenario has at least 75% headroom and no shared 240s default", () => {
  for (const [id, seconds] of Object.entries(OBSERVED_SECONDS))
    expect(scenarioTimeoutSeconds(id)).toBeGreaterThan(seconds * 1.75);
  expect(scenarioTimeoutSeconds("standard")).toBe(720);
  expect(scenarioTimeoutSeconds("batch")).toBe(780);
  expect(scenarioTimeoutSeconds("google")).toBe(
    scenarioTimeoutSeconds("multistep"),
  );
  expect(scenarioTimeoutSeconds("standard", 150)).toBe(150);
});
test("replicas are distinct scheduler sites and listing/apply origins agree", () => {
  const base = "http://127.0.0.1:47950/";
  const paths = [
    "board",
    "greenhouse",
    "lever",
    "workday",
    "gatekeeper",
    "atlas",
    "ripple",
  ];
  const urls = paths.map((site) => replicaUrl(base, `${site}/jobs/1`));
  expect(new Set(urls.map(applicationSiteKey)).size).toBe(paths.length);
  expect(new URL(replicaUrl(base, "employer-a/apply/1")).origin).toBe(
    new URL(urls[0]).origin,
  );
  expect(
    urls.every((url) => /^127\.0\.0\.\d+$/u.test(new URL(url).hostname)),
  ).toBe(true);
  expect(() => replicaUrl("https://example.com/", "board/")).toThrow();
});
