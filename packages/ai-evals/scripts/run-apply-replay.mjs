import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const groups = {
  facts: [
    "packages/browser-agent/src/apply/answer-gate-regressions.test.ts",
    "packages/browser-agent/src/apply/answer-source-catalog.test.ts",
    "packages/browser-agent/src/apply/classified-answer-check.test.ts",
    "packages/browser-agent/src/apply/written-answer-grounding.apply-replay.test.ts",
    "packages/browser-agent/src/apply/submit-preflight.test.ts",
  ],
  formats: [
    "packages/browser-agent/src/apply/application-facts.test.ts",
    "packages/browser-agent/src/apply/policy-executor.test.ts",
    "packages/browser-runtime/src/choose-page-option.apply-replay.test.ts",
    "packages/contracts/src/technology-text.test.ts",
  ],
  uploads: [
    "packages/browser-runtime/src/application-attachment-upload.apply-replay.test.ts",
    "packages/browser-runtime/src/application-intermediate-mutation-policy.test.ts",
    "packages/browser-runtime/src/application-fill-request-policy.test.ts",
    "packages/browser-runtime/src/mutation-response.test.ts",
    "packages/browser-runtime/src/mutation-response-body.test.ts",
    "packages/browser-runtime/src/attachment-upload-ledger.test.ts",
    "packages/browser-runtime/src/playwright-application-flow.prepare-only-guard.test.ts",
    "packages/browser-runtime/src/playwright-application-flow.strict-fill.test.ts",
  ],
  "needs-you": [
    "packages/browser-agent/src/apply/question-occurrences.apply-replay.test.ts",
    "packages/job-finder/src/applications/questions.test.ts",
    "packages/browser-agent/src/apply/apply-agent.test.ts",
  ],
  restart: [
    "packages/db/src/job-store/applications.test.ts",
    "packages/db/src/job-store/stored-json.test.ts",
    "packages/contracts/src/question-stored-json.test.ts",
    "packages/contracts/src/stored-json.test.ts",
    "packages/job-finder/src/applications/application-service.test.ts",
  ],
  cost: [
    "packages/browser-agent/src/apply/page-history.apply-replay.test.ts",
    "packages/browser-agent/src/apply/real-shape-cost.apply-replay.test.ts",
    "packages/ai-providers/src/model-usage-scope.test.ts",
    "packages/job-finder/src/applications/apply-usage.test.ts",
    "packages/contracts/src/apply-usage-stored-json.test.ts",
    "packages/browser-agent/src/apply/apply-timing.test.ts",
    "packages/browser-agent/src/apply/question-classification.test.ts",
    "packages/browser-agent/src/apply/answer-gate-regressions.test.ts",
    "packages/browser-agent/src/apply/apply-agent.stored-facts.test.ts",
    "packages/browser-runtime/src/application-preparation-scheduler.test.ts",
  ],
  blocked: [
    "packages/browser-agent/src/apply/blockers.test.ts",
    "packages/job-finder/src/applications/application-service.test.ts",
    "apps/desktop/src/renderer/src/features/needs-you/needs-you-screen.test.tsx",
  ],
};

const help = `Usage: pnpm apply:eval [--group <name[,name...]>] [--output <directory>] [--list]

Run synthetic Apply replays offline. No provider credentials or live employer sites.
Groups: ${Object.keys(groups).join(", ")} (all by default).
--list    Show selected replay files without running them.
--output  Write reports outside the checkout (a temporary directory by default).
--help    Show this help.

Missing files, missing results, empty groups, skipped tests and failures fail the eval.
The cost group checks call bounds and token accounting with scripted usage. Live
token/call benchmarks and the 15-job/17-job baselines stay outside the repository;
this offline run does not measure provider cost or read those baselines.
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { process.stdout.write(help); return; }
  let selected = Object.keys(groups), output, list = false;
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (option === "--list") { list = true; continue; }
    if (option !== "--group" && option !== "--output") throw new Error(`Unknown option: ${option}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    if (option === "--group") selected = [...new Set(value.split(","))];
    else output = path.resolve(value);
  }
  if (!selected.length || selected.some((name) => !Object.hasOwn(groups, name)))
    throw new Error(`Choose groups from: ${Object.keys(groups).join(", ")}.`);
  const root = realpathSync(process.cwd());
  const replayDirectory = "packages/browser-agent/src/apply";
  const knownFiles = new Set(Object.values(groups).flat());
  for (const name of readdirSync(path.join(root, replayDirectory)).sort()) {
    if (!name.endsWith(".apply-replay.test.ts")) continue;
    const file = `${replayDirectory}/${name}`;
    if (!knownFiles.has(file)) groups[/github|format|picker/iu.test(name) ? "formats" : "facts"].push(file);
  }
  const files = [...new Set(selected.flatMap((name) => groups[name]))];
  const missing = files.filter((file) => !existsSync(path.join(root, file)));
  if (missing.length) throw new Error(`Required replay files are missing:\n${missing.join("\n")}`);
  if (list) { process.stdout.write(files.join("\n") + "\n"); return; }
  if (output) {
    // Resolve an existing ancestor first, so an in-checkout symlink cannot
    // redirect reports into the repository.
    let ancestor = output;
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const resolved = path.join(realpathSync(ancestor), path.relative(ancestor, output));
    const relative = path.relative(root, resolved);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
      throw new Error("--output must be outside the checkout.");
    output = resolved;
    mkdirSync(output, { recursive: true });
    output = mkdtempSync(path.join(output, "run-"));
  } else output = mkdtempSync(path.join(tmpdir(), "nestor-apply-eval-"));
  const rawReport = path.join(output, "vitest.json"), summaryPath = path.join(output, "apply-eval.json");
  const env = { ...process.env, NESTOR_APPLY_EVAL_OFFLINE: "1" };
  for (const key of Object.keys(env))
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PROVIDER_TOKEN)$/u.test(key)) delete env[key];
  const started = Date.now();
  const run = spawnSync(process.execPath, [
    path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...files,
    "--maxWorkers=2", "--minWorkers=2", "--reporter=json", `--outputFile=${rawReport}`,
  ], { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (!existsSync(rawReport)) throw new Error(`Vitest produced no report. ${run.stderr || run.stdout}`);
  const result = JSON.parse(readFileSync(rawReport, "utf8"));
  const suites = Array.isArray(result.testResults) ? result.testResults : [];
  const byFile = new Map(suites.map((suite) => [suite.name.replaceAll("\\", "/"), suite]));
  const findSuite = (file) => [...byFile].find(([name]) => name.endsWith("/" + file))?.[1];
  const missingResults = files.filter((file) => !findSuite(file));
  const failedSuites = suites.filter((suite) => suite.status === "failed").map((suite) => ({
    file: path.relative(root, suite.name).replaceAll("\\", "/"), message: suite.message,
  }));
  const summaries = Object.fromEntries(selected.map((name) => {
    const assertions = groups[name].flatMap((file) => findSuite(file)?.assertionResults ?? []);
    return [name, {
      passed: assertions.filter((test) => test.status === "passed").length,
      failed: assertions.filter((test) => test.status === "failed").length,
      skipped: assertions.filter((test) => test.status !== "passed" && test.status !== "failed").length,
      total: assertions.length,
    }];
  }));
  const success = run.status === 0 && result.success === true && !missingResults.length &&
    Object.values(summaries).every((group) => group.total > 0 && group.failed === 0 && group.skipped === 0);
  const summary = {
    offline: true, success, durationMs: Date.now() - started, groups: summaries, missingResults, failedSuites,
    cost: { inputTokenTarget: 100_000, callTarget: 8, measurement: "Scripted accounting and call bounds only; live baselines are external." },
    rawReport,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ...summary, report: summaryPath }, null, 2) + "\n");
  if (!success) {
    if (run.stderr) process.stderr.write(run.stderr);
    process.exitCode = 1;
  }
}
try { main(); } catch (error) { process.stderr.write(`Apply eval: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
