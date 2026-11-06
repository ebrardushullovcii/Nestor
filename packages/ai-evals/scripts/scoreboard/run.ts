#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  appendFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  auditQuestions,
  markdown,
  PERSONA,
  save,
  SCENARIOS,
} from "./report.ts";
import { startProvider } from "./provider.ts";
import type { Run } from "./types.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const heavy = path.join(os.homedir(), "Projects/nestor-agent-work/bin/heavy");
// Driver migration is confined to this constant. No journey imports the skill.
const DRIVER_PATHS = [
  "packages/ai-evals/scripts/isolated-app/cli.mjs",
  "packages/ai-evals/scripts/isolated-app/lib/cli.mjs",
  ".claude/skills/verify-nestor/bin/lib/cli.mjs",
];
const args = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    list: { type: "boolean" },
    scenario: { type: "string" },
    out: { type: "string" },
    "no-build": { type: "boolean" },
    timeout: { type: "string", default: "240" },
  },
}).values;
if (args.help || args.list) {
  console.log(
    `Job Finder scenario scoreboard (Node 24+).\n\n${heavy} --cool node packages/ai-evals/scripts/scoreboard/run.ts [--scenario ID] [--no-build] [--out PATH] [--timeout SECONDS]\n\nOn macOS sessions wait for cooling with heavy --cool; builds alone take the shared heavy slot. Runs fresh isolated live-AI apps one at a time on local replicas and stops its processes. --no-build still requires a matching stamped build. Results default to ~/Projects/nestor-agent-work/functionality-hill-climb/scoreboard/YYYYMMDD-HHMM/.\n\n${SCENARIOS.map(([id, name]) => `${id.padEnd(12)} ${name}`).join("\n")}\n\nExit 0: all requested scenarios pass. Exit 1: scenario failures. Exit 2: runner/setup/cleanup failure.`,
  );
} else {
  if (args.scenario && !SCENARIOS.some(([id]) => id === args.scenario))
    throw Error(`Unknown scenario: ${args.scenario}`);
  const timeout = Number(args.timeout);
  if (!Number.isFinite(timeout) || timeout < 15 || timeout > 1800)
    throw Error("--timeout must be 15–1800 seconds");
  // Refuse the former invocation: otherwise an internal build could wait on
  // the slot held by its own parent for the entire scoreboard session.
  if (process.platform === "darwin") {
    let ancestor = process.ppid;
    const lockFile = "/tmp/nestor-heavy-1.lock/owner";
    if (existsSync(lockFile)) {
      const owner = Number(readFileSync(lockFile, "utf8").split(" ")[0]);
      for (let n = 0; n < 16 && ancestor > 1; n++) {
        if (ancestor === owner)
          throw Error(
            `Use ${heavy} --cool node packages/ai-evals/scripts/scoreboard/run.ts; app sessions must not hold the build slot`,
          );
        try {
          ancestor = Number(
            execFileSync("ps", ["-p", String(ancestor), "-o", "ppid="], {
              encoding: "utf8",
            }).trim(),
          );
        } catch {
          break;
        }
      }
    }
  }
  // --cool execs the command, so it leaves no ancestor to inspect. Re-enter
  // through it ourselves once. Never keep the build slot during app sessions.
  if (process.platform === "darwin" && !process.env.NESTOR_SCOREBOARD_COOLED) {
    const cooled = spawnSync(
      heavy,
      ["--cool", process.execPath, ...process.argv.slice(1)],
      {
        cwd: root,
        env: { ...process.env, NESTOR_SCOREBOARD_COOLED: "1" },
        stdio: "inherit",
      },
    );
    process.exit(cooled.status ?? 2);
  }
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 13);
  const output = path.resolve(
    args.out ??
      path.join(
        os.homedir(),
        "Projects/nestor-agent-work/functionality-hill-climb/scoreboard",
        timestamp,
      ),
  );
  mkdirSync(output, { recursive: true });
  const relative = path.relative(realpathSync(root), realpathSync(output));
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    throw Error("Results must be outside the repository");
  if (existsSync(path.join(output, "scoreboard.json")))
    throw Error(`Refusing to replace an existing run: ${output}`);
  const driver = DRIVER_PATHS.find((candidate) =>
    existsSync(path.join(root, candidate)),
  );
  if (!driver)
    throw Error(
      `Isolated-app driver not found; checked ${DRIVER_PATHS.join(", ")}`,
    );
  const label = `scoreboard-${Date.now()}`;
  const env = {
    ...process.env,
    NESTOR_SCOREBOARD_HOLD_SETUP_READS: "1",
    NESTOR_VERIFY_LABEL: label,
    NESTOR_VERIFY_WORK: output,
  };
  const run: Run = {
    version: 2,
    startedAt: new Date().toISOString(),
    source: {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty: null,
    },
    ai: "live",
    driver,
    persona: PERSONA,
    output,
    preconditions: [
      "Applications use fixed synthetic listings inserted into this isolated job store; Original resumes are then approved through the visible app. Search does not use those seeded rows.",
      "Resume writing, fit quality and account creation are outside the measured rows. A person may create a made-up Workday account and answer synthetic job-source/address/postcode/start-month gaps; ordinary Save/Continue handoffs fail.",
      "The setup-triggered search is stopped, retaining any rows it produced; its count is separate from measured search results. AI timings and questions may vary between runs.",
    ],
    results: SCENARIOS.map(([id, name]) => ({
      id,
      name,
      status: "not run",
      seconds: 0,
      questions: [],
      metrics: { summary: "not run" },
    })),
  };
  save(run);
  mkdirSync(path.join(output, "steps"), { recursive: true });
  for (const result of run.results)
    appendFileSync(
      path.join(output, "steps", `${result.id}.log`),
      `${new Date().toISOString()} ${result.status}: ${result.metrics.summary ?? ""}\n`,
    );
  let interrupted = false;
  let current: ReturnType<typeof spawn> | undefined;
  const onSignal = () => {
    interrupted = true;
    current?.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const command = (program: string, params: string[]) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(program, params, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      current = child;
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk: Buffer) => {
          process.stdout.write(chunk);
          appendFileSync(path.join(output, "runner.log"), chunk);
        });
      child.once("error", reject);
      child.once("exit", (code) => {
        current = undefined;
        resolve(code ?? 2);
      });
    });
  const cli = (...params: string[]) =>
    command(process.execPath, [path.join(root, driver), ...params]);
  let launched = false;
  let fatal: string | null = null;
  const labels: string[] = [];
  const cleanupCodes: number[] = [];
  try {
    if (!args["no-build"]) {
      if (
        await command(
          process.platform === "darwin" ? heavy : process.execPath,
          process.platform === "darwin"
            ? [process.execPath, path.join(root, driver), "build"]
            : [path.join(root, driver), "build"],
        )
      )
        throw Error("Desktop build failed");
    }
    const stamp = JSON.parse(
      readFileSync(
        path.join(root, "apps/desktop/out/.verify-build.json"),
        "utf8",
      ),
    ) as Run["source"];
    run.source = stamp;
    save(run);
    if (interrupted) throw Error("Interrupted before launch");
    const requested =
      args.scenario && args.scenario !== "needs-you"
        ? [args.scenario]
        : [
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
    for (const scenario of requested) {
      if (interrupted) throw Error("Interrupted");
      env.NESTOR_VERIFY_LABEL = `${label}-${scenario}`;
      labels.push(env.NESTOR_VERIFY_LABEL);
      console.log(
        `\n[scoreboard] starting ${scenario} in a fresh isolated app`,
      );
      launched = true;
      let instanceCleanup = 0;
      let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
      try {
        if (scenario === "google") {
          provider = await startProvider(root, output, env.NESTOR_VERIFY_LABEL);
          Object.assign(env, {
            NESTOR_VERIFY_PROVIDER_FIXTURE: provider.configPath,
          });
        }
        if (await cli("up", "--ai", "live"))
          throw Error("Isolated app launch failed");
        if (await cli("doctor"))
          throw Error("Doctor failed; refusing to drive the instance");
        if (interrupted) throw Error("Interrupted");
        const options = JSON.stringify({
          output,
          scenario,
          timeout,
          driver,
          provider: provider && {
            configPath: provider.configPath,
            employerOrigin: provider.employerOrigin,
          },
        });
        if (
          await cli(
            "drive",
            "run",
            path.join(import.meta.dirname, "journey.ts"),
            options,
          )
        )
          throw Error("Journey driver failed; see runner.log");
      } finally {
        instanceCleanup = await cli("down");
        provider?.stop();
        Reflect.deleteProperty(env, "NESTOR_VERIFY_PROVIDER_FIXTURE");
        cleanupCodes.push(instanceCleanup);
        launched = false;
      }
      if (instanceCleanup)
        throw Error(
          `Owned instance cleanup failed: ${env.NESTOR_VERIFY_LABEL}`,
        );
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
    console.error(fatal);
  } finally {
    const latest = JSON.parse(
      readFileSync(path.join(output, "scoreboard.json"), "utf8"),
    ) as Run;
    if (fatal)
      for (const r of latest.results.filter(
        (r) =>
          r.status === "not run" &&
          (!args.scenario || r.id === args.scenario || r.id === "needs-you"),
      )) {
        r.status = "fail";
        r.failure = {
          step: "runner",
          happened: fatal,
          likelyPackage:
            "scoreboard runner or isolated-app driver (not a measured product failure)",
        };
        r.metrics.summary = fatal;
      }
    if (launched) cleanupCodes.push(await cli("down"));
    const cleanupCode = cleanupCodes.some((code) => code !== 0) ? 2 : 0;
    latest.cleanup = {
      ok: cleanupCode === 0,
      detail: `${labels.length} owned isolated instances stopped, one at a time; cleanup exit ${cleanupCode}.`,
    };
    latest.finishedAt = new Date().toISOString();
    // Retain only model/provider identifiers, never environment values or keys.
    const models = new Set<string>();
    for (const instanceLabel of labels) {
      const appLog = path.join(output, instanceLabel, "verify/logs/app.log");
      if (!existsSync(appLog)) continue;
      for (const line of readFileSync(appLog, "utf8").split("\n")) {
        const at = line.indexOf("[AI usage] ");
        if (at < 0) continue;
        try {
          const usage = JSON.parse(line.slice(at + 11)) as {
            model?: string;
            provider?: string;
          };
          models.add(
            `${usage.provider ?? "unknown"} / ${usage.model ?? "unknown"}`,
          );
        } catch {
          /* non-usage log line */
        }
      }
    }
    latest.ai = `live: ${[...models].join(", ") || "no completed model call recorded"}`;
    auditQuestions(latest);
    save(latest);
    console.log(
      "\n" + markdown(latest).split("## Every Needs you question")[0],
    );
    console.log(`Results: ${output}`);
    process.exitCode =
      fatal ||
      cleanupCode ||
      latest.results.some((r) => r.failure?.step.startsWith("setup /"))
        ? 2
        : latest.results.some((r) => r.status === "fail")
          ? 1
          : 0;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
