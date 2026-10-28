import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ASSISTANT_LANE_CASES, uncoveredInventoryEntries } from "./cases";
import { formatAssistantLaneReport, runAssistantLane } from "./run";
import type { AssistantLaneModel } from "./world";

/**
 * `pnpm --filter @nestor/ai-evals assistant-lane -- --model live`
 *
 * Options: `--model scripted|live` (default scripted), `--case <id prefix>`
 * (repeatable), `--repeat <n>` to run each case n times (live models vary),
 * `--out <dir>` for the Markdown and JSON report. Live runs
 * read the assistant route from `.env.local` (`NESTOR_AI_ASSISTANT_*`).
 */
export async function runAssistantLaneCli(
  argv: readonly string[],
): Promise<void> {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let model: AssistantLaneModel = "scripted";
  const prefixes: string[] = [];
  let outDir: string | null = null;
  let repeat = 1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--model" && (value === "scripted" || value === "live")) {
      model = value;
      index += 1;
    } else if (arg === "--case" && value) {
      prefixes.push(value);
      index += 1;
    } else if (arg === "--repeat" && Number(value) >= 1) {
      repeat = Math.floor(Number(value));
      index += 1;
    } else if (arg === "--out" && value) {
      outDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }
  const cases = ASSISTANT_LANE_CASES.filter(
    (evalCase) =>
      (model === "live" || evalCase.scripted) &&
      (prefixes.length === 0 ||
        prefixes.some((prefix) => evalCase.id.startsWith(prefix))),
  ).flatMap((evalCase) => Array.from({ length: repeat }, () => evalCase));
  const label =
    model === "live"
      ? (process.env.NESTOR_AI_ASSISTANT_MODEL ?? "default assistant model")
      : "scripted";
  console.log(
    `Running ${cases.length} assistant cases on ${label}, one at a time.`,
  );
  const results = await runAssistantLane(cases, model, (result) => {
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${result.id}${result.error ? ` (${result.error})` : ""}`,
    );
  });
  const report = formatAssistantLaneReport(label, results, repeat);
  const uncovered = uncoveredInventoryEntries();
  const full = uncovered.length
    ? `${report}\n\nInventory entries with no case: ${uncovered.join(", ")}`
    : report;
  console.log(`\n${full}`);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "assistant-lane.md"), `${full}\n`);
    await writeFile(
      path.join(outDir, "assistant-lane.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
