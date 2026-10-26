import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESUME_LANE_CASES } from "./cases";
import { formatResumeLaneReport, runResumeLane } from "./run";

/**
 * `pnpm --filter @nestor/ai-evals resume-lane -- --out <dir>`
 *
 * Writes each case at Original, Light, Tailored and Aggressive with the
 * model configured in `.env.local` (`NESTOR_AI_*`), the same writer the app
 * runs, and reports invented facts, whether each level behaves as named,
 * flags left after the self-fix, time and tokens. Options: `--case <id
 * prefix>` (repeatable), `--out <dir>` for the Markdown report and the
 * drafts as JSON. Not part of CI: it calls the model.
 */
export async function runResumeLaneCli(argv: readonly string[]): Promise<void> {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const prefixes: string[] = [];
  let outDir: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--case" && value) {
      prefixes.push(value);
      index += 1;
    } else if (arg === "--out" && value) {
      outDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }
  const cases = RESUME_LANE_CASES.filter(
    (evalCase) =>
      prefixes.length === 0 ||
      prefixes.some((prefix) => evalCase.id.startsWith(prefix)),
  );
  const model = process.env.NESTOR_AI_MODEL ?? "configured model";
  console.log(`Writing ${cases.length} cases at 4 levels on ${model}.`);
  const results = await runResumeLane(cases, (result) => {
    console.log(
      `${result.caseId} ${result.level}: ${result.error ? `failed (${result.error})` : `${result.inventedFacts.length} invented, ${result.levelProblem ?? "as named"}, ${result.flagsLeft.length} flags, ${result.seconds.toFixed(1)}s`}`,
    );
  });
  const report = formatResumeLaneReport(model, results);
  console.log(`\n${report}`);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "resume-lane.md"), `${report}\n`);
    await writeFile(
      path.join(outDir, "resume-lane.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }
}
