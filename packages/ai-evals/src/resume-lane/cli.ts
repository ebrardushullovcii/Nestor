import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ResumeLevel } from "@nestor/contracts";

import { RESUME_LANE_CASES } from "./cases";
import {
  formatResumeLaneReport,
  rescoreResumeLane,
  runResumeLane,
  type ResumeLaneResult,
  RESUME_LEVELS,
} from "./run";

const HELP = `Resume lane: the resume writer at every level on recorded listings.

Usage: pnpm --filter @nestor/ai-evals resume-lane -- [options]

Writes each case (a synthetic resume and a recorded job listing) at Original,
Light, Tailored and Aggressive with the model in .env.local (NESTOR_AI_*),
through the same writer the app runs. Calls the model; not part of CI.

Per level it reports:
  invented facts   hard limits: employers, titles, dates, degrees, credentials,
                   certifications, team size/leadership, unevidenced numbers,
                   technologies absent from evidence AND listing, hiring-domain bleed
  stretches        Aggressive listing technologies and listed years rounded up by
                   one are separate (ADR 0018/0041/0051); choosing the level accepts them
  as named         Original unchanged; Light keeps the headline and edits at most
                   25% of words; Tailored edits more than Light; Aggressive edits at
                   least as much as Tailored and leads with the role
  stretch handling per case: sanctioned inferred lines the unchanged checker flags
                   or removes; saved model traces permit an audit without more calls
  flags left       problems the writer flagged and did not fix
  edit size, time (median per resume, and over all written resumes), model
  calls and tokens in/out

Options:
  --level <level>     only this level (repeatable); default all four
  --case <prefix>     only cases whose id starts with this (repeatable)
  --out <dir>         also write resume-lane.md and the drafts as resume-lane.json;
                      keep baselines outside the repository
  --rescore <file>    score a saved resume-lane.json again without the model
  --help              show this text
`;

export async function runResumeLaneCli(argv: readonly string[]): Promise<void> {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const prefixes: string[] = [];
  const levels: ResumeLevel[] = [];
  let outDir: string | null = null;
  let rescore: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      return;
    }
    if (
      arg === "--level" &&
      value &&
      RESUME_LEVELS.includes(value as ResumeLevel)
    ) {
      levels.push(value as ResumeLevel);
      index += 1;
    } else if (arg === "--case" && value) {
      prefixes.push(value);
      index += 1;
    } else if (arg === "--rescore" && value) {
      rescore = path.resolve(value);
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
  if (rescore) {
    const saved = JSON.parse(
      await readFile(rescore, "utf8"),
    ) as ResumeLaneResult[];
    const results = rescoreResumeLane(saved);
    const report = formatResumeLaneReport(`${model} (rescored)`, results);
    console.log(report);
    if (outDir) await writeReport(outDir, report, results);
    return;
  }
  console.log(
    `Writing ${cases.length} cases at ${levels.length || 4} levels on ${model}.`,
  );
  const results = await runResumeLane(
    cases,
    (result) => {
      console.log(
        `${result.caseId} ${result.level}: ${result.error ? `failed (${result.error})` : `${result.inventedFacts.length} invented, ${result.stretches.length} stretches, ${result.levelProblem ?? "as named"}, ${result.flagsLeft.length} flags, ${result.seconds.toFixed(1)}s`}`,
      );
    },
    levels.length ? levels : RESUME_LEVELS,
  );
  const report = formatResumeLaneReport(model, results);
  console.log(`\n${report}`);
  if (outDir) await writeReport(outDir, report, results);
}

async function writeReport(
  outDir: string,
  report: string,
  results: readonly ResumeLaneResult[],
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "resume-lane.md"), `${report}\n`);
  await writeFile(
    path.join(outDir, "resume-lane.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}
