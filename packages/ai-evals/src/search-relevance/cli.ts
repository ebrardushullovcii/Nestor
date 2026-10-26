import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createJobFinderAiClientFromEnvironment } from "@nestor/ai-providers";
import { digest, loadCorpus } from "./corpus";
import { runSearchRelevance, type ModelTape } from "./run";

export async function runSearchRelevanceCli(args: string[], root: string) {
  if (args.includes("--help")) {
    console.log(
      "pnpm search:eval [--live --tape <new.json> [--resume] [--max-calls 40]] [--out <report.json>]\nDefault: exact offline replay of the committed baseline. No job-site or model network calls.\n--live: recorded job pages only; configured NESTOR_AI_* model, default budget 40 logical calls per tape (maximum 100). Existing tapes require --resume, which replays completed judgments.",
    );
    return;
  }
  const value = (flag: string, fallback: string) =>
    args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? fallback) : fallback;
  const directory = path.join(root, "fixtures/search-relevance");
  const corpus = await loadCorpus(directory),
    live = args.includes("--live");
  if (args.includes("--resume") && !live)
    throw new Error("--resume requires --live.");
  const providerFiles = [
    "openai-compatible.ts",
    "openai-compatible-transport.ts",
  ];
  const providerCodeDigest = digest(
    (
      await Promise.all(
        providerFiles.map((file) =>
          readFile(
            path.resolve(root, "../ai-providers/src", file),
            "utf8",
          ).then((text) => text.replace(/\r\n/gu, "\n")),
        ),
      )
    ).join("\n"),
  );
  const tapePath = path.resolve(
    value("--tape", path.join(directory, "baseline-tape.json.gz")),
  );
  let pendingWrite = Promise.resolve();
  const saveJson = (file: string, data: unknown) => {
    const json = JSON.stringify(data, null, 2) + "\n";
    pendingWrite = pendingWrite.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, file.endsWith(".gz") ? gzipSync(json) : json);
      await rename(temporary, file);
    });
    return pendingWrite;
  };
  let tape: ModelTape;
  if (live && !args.includes("--resume")) {
    try {
      await access(tapePath);
      throw new Error(
        `Refusing to overwrite model tape ${tapePath}. Choose a new --tape path.`,
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (!process.env.NESTOR_AI_API_KEY)
      throw new Error(
        "--live needs NESTOR_AI_API_KEY; no deterministic fallback is accepted.",
      );
    const route: Record<string, string> = {
      providerCodeDigest,
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^NESTOR_AI_(?:[A-Z_]+_)?(?:MODEL|API_MODE|REASONING_EFFORT)$/u.test(
            key,
          ),
        ),
      ),
    };
    tape = { corpusDigest: corpus.digest, route, turns: [] };
  } else {
    const bytes = await readFile(tapePath);
    tape = JSON.parse(
      (tapePath.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"),
    ) as ModelTape;
    if (tape.corpusDigest !== corpus.digest)
      throw new Error("Corpus changed; record a new explicit live baseline.");
    if (live && tape.route.providerCodeDigest !== providerCodeDigest)
      throw new Error(
        "Provider implementation changed; record a new explicit live baseline.",
      );
  }
  if (live && !process.env.NESTOR_AI_API_KEY)
    throw new Error("--live requires a configured model key.");
  const maxCalls = Number(value("--max-calls", "40"));
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
    throw new Error("--max-calls must be between 1 and 100.");
  const client = live
    ? createJobFinderAiClientFromEnvironment(process.env)
    : null;
  if (client) {
    const model = client.getStatus().model ?? "unknown";
    if (args.includes("--resume")) {
      if (model !== tape.route.primaryModel)
        throw new Error("Resume needs the same model route.");
      const keys = new Set([
        ...Object.keys(tape.route),
        ...Object.keys(process.env),
      ]);
      for (const key of keys) {
        if (
          /^NESTOR_AI_(?:[A-Z_]+_)?(?:MODEL|API_MODE|REASONING_EFFORT)$/u.test(
            key,
          ) &&
          tape.route[key] !== process.env[key]
        )
          throw new Error(`Resume configuration changed: ${key}`);
      }
    } else tape.route.primaryModel = model;
  }
  if (live && !client?.chatWithTools)
    throw new Error("Configured model has no chatWithTools.");
  const originalFetch = globalThis.fetch;
  if (!live)
    globalThis.fetch = () =>
      Promise.reject(new Error("Search relevance replay is offline."));
  try {
    const report = await runSearchRelevance({
      boards: corpus.boards,
      labels: corpus.manifest.listings,
      tape,
      maxCalls,
      ...(client?.chatWithTools
        ? { live: { chatWithTools: client.chatWithTools } }
        : {}),
      onTurn: () => saveJson(tapePath, tape),
    });
    if (live) {
      (tape.runs ??= []).push({
        durationMs: report.durationMs,
        freshCalls: report.freshCalls,
      });
      await saveJson(tapePath, tape);
    }
    const output = {
      recordedAt: new Date().toISOString(),
      repositoryHead: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      corpusDigest: corpus.digest,
      selection: corpus.manifest.selection,
      targets: { recall: 0.9, relevantInTop10: 8 },
      route: tape.route,
      baselineProviderCalls: tape.turns.length,
      baselineActiveDurationMs:
        tape.runs?.reduce((sum, run) => sum + run.durationMs, 0) ?? null,
      ...report,
    };
    const out = path.resolve(
      value(
        "--out",
        path.join(root, "../../.tmp/search-relevance-report.json"),
      ),
    );
    await saveJson(out, output);
    for (const persona of report.personas)
      console.log(
        `${persona.persona}: screening/fit recall ${persona.found}/${persona.relevant} (${(persona.recall * 100).toFixed(1)}%); top 10 ${persona.relevantInTop10}/10 relevant. Including collection: ${persona.endToEnd.found}/${persona.endToEnd.relevant} (${(persona.endToEnd.recall * 100).toFixed(1)}%), top 10 ${persona.endToEnd.relevantInTop10}/10.`,
      );
    console.log(
      `Coverage honesty: ${report.coverage.filter((entry) => entry.honest).length}/${report.coverage.length}; ${report.freshCalls} fresh / ${report.replayedCalls} replayed calls; ${(report.durationMs / 1000).toFixed(2)}s. Report: ${out}`,
    );
    if (output.baselineActiveDurationMs !== null)
      console.log(
        `Recorded baseline active engine time: ${(output.baselineActiveDurationMs / 1000).toFixed(2)}s across ${tape.turns.length} provider calls; CLI startup is excluded.`,
      );
    if (!report.passed) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
