import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { App } from "./app.ts";
import { google, savedSignIn, browserImport } from "./sign-in.ts";
import * as applications from "./applications.ts";
import { setup } from "./profile.ts";
import { search } from "./search.ts";
import { auditQuestions, PERSONA, save, SCENARIOS } from "./report.ts";
import type { Context, Result, Run } from "./types.ts";

const handlers: Record<string, (app: App, result: Result) => Promise<void>> = {
  search,
  google,
  "saved-sign-in": savedSignIn,
  "browser-import": browserImport,
  ...applications,
};
const likely: Record<string, string> = {
  google:
    "packages/browser-agent/src/google-sign-in* and apply/policy-executor.ts",
  "saved-sign-in":
    "apps/desktop/src/main/services/browser/embedded-browser-runtime* or packages/browser-agent/src/apply",
  "browser-import":
    "apps/desktop/src/main/services/browser/browser-profile-import.ts or browser-passwords routes",
  standard:
    "packages/browser-agent/src/apply (profile answer selection/checking)",
  multistep:
    "packages/browser-agent/src/apply (sign-in or ordinary step handling)",
  captcha:
    "packages/job-finder/src/applications and apps/desktop/src/main/services/browser (handoff/recovery)",
  security: "packages/browser-agent/src/apply (security wait handling)",
  restart:
    "apps/desktop/src/main/services/browser and packages/job-finder/src/applications (retained form restoration)",
  batch:
    "packages/job-finder/src/applications and packages/browser-agent/src/apply (queue/preparation)",
  send: "packages/browser-agent/src/apply and packages/job-finder/src/applications (send outcome)",
  search:
    "packages/job-finder/src/search* and packages/browser-agent/src/search (source discovery/recovery)",
};

export default async function journey(ctx: Context) {
  const config = JSON.parse(ctx.args[0]) as {
    output: string;
    scenario?: string;
    timeout: number;
    driver: string;
    provider?: { configPath: string; employerOrigin: string };
  };
  const run = JSON.parse(
    readFileSync(path.join(config.output, "scoreboard.json"), "utf8"),
  ) as Run;
  const app = new App(ctx, config.output, config.timeout);
  app.provider = config.provider;
  const setupStarted = Date.now();
  if (ctx.ai !== "live") throw Error("Scoreboard requires --ai live");
  try {
    await setup(app);
    run.setupSeconds =
      (run.setupSeconds ?? 0) + (Date.now() - setupStarted) / 1000;
    run.persona = PERSONA;
    run.instances ??= [];
    run.instances.push({
      scenario: config.scenario ?? "all",
      label: path.basename(path.dirname(ctx.evidenceDir)),
      replicaOrigin: ctx.sites.url,
      evidenceDir: ctx.evidenceDir,
    });
    save(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const r of run.results.filter(
      (r) =>
        config.scenario === undefined ||
        r.id === config.scenario ||
        r.id === "needs-you",
    )) {
      r.status = "fail";
      r.failure = {
        step: `setup / ${app.step}`,
        happened: `Setup blocked this scenario: ${message}`,
        likelyPackage: "scoreboard/profile.ts or profile import/setup",
      };
    }
    run.setupSeconds =
      (run.setupSeconds ?? 0) + (Date.now() - setupStarted) / 1000;
    await ctx.shot("scoreboard-setup-failed").catch(() => {});
    auditQuestions(run);
    save(run);
    return { setupFailed: message };
  }
  // Search first so seeded application fixtures cannot inflate listing counts.
  const order = [
    "search",
    "standard",
    "multistep",
    "captcha",
    "security",
    "restart",
    "batch",
    "send",
    "google",
    "saved-sign-in",
    "browser-import",
  ];
  for (const id of order) {
    if (
      config.scenario &&
      config.scenario !== id &&
      config.scenario !== "needs-you"
    )
      continue;
    const r = run.results.find((r) => r.id === id)!;
    app.begin(r);
    const started = Date.now();
    try {
      await handlers[id](app, r);
      app.capture();
      if (r.questions.some((q) => q.profileAnswers || q.duplicate))
        throw Error("Needs you asked known facts or repeated a question");
      r.status = "pass";
    } catch (error) {
      r.status = "fail";
      const message = error instanceof Error ? error.message : String(error);
      r.failure = {
        step: app.step,
        happened: message,
        likelyPackage:
          /strict mode violation|locator\.(click|fill|waitFor)|No application row opens/.test(
            message,
          )
            ? "scoreboard/app.ts or the product UI (the driver could not complete this step)"
            : likely[id],
      };
      app.log("FAIL", { message });
      if (!r.metrics.summary || r.metrics.summary === "not run")
        r.metrics.summary = message.split("\n")[0];
      await ctx.shot(`scoreboard-${id}-failed`).catch(() => {});
      writeFileSync(
        path.join(config.output, "steps", `${id}-screen.txt`),
        await ctx.see().catch(() => "Screen unavailable"),
      );
    } finally {
      app.capture();
      r.metrics.observedApplications = app.jobIds.map(
        (jobId) =>
          app.read(
            "SELECT id,job_id,state,mode,error,attempt,submitted_at FROM applications WHERE job_id=?",
            jobId,
          )[0] ?? { jobId, state: "not queued" },
      );
      r.seconds = (Date.now() - started) / 1000;
      save(run);
      console.log(
        `[scoreboard] ${id} ${r.status.toUpperCase()} ${r.seconds.toFixed(1)}s ${r.metrics.summary ?? ""}`,
      );
    }
  }
  auditQuestions(run);
  const quality = run.results.find((r) => r.id === "needs-you")!;
  writeFileSync(
    path.join(config.output, "steps", "needs-you.log"),
    `${new Date().toISOString()} ${quality.status}: ${quality.metrics.summary}\n`,
  );
  save(run);
  return {
    results: run.results
      .filter((r) => r.id === config.scenario)
      .map((r) => ({
        id: r.id,
        status: r.status,
        seconds: r.seconds,
      })),
  };
}

export { SCENARIOS };
