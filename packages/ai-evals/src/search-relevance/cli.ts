import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createJobFinderAiClientFromEnvironment } from "@nestor/ai-providers";
import { digest, loadCorpus } from "./corpus";
import { runSearchRelevance, type ModelTape } from "./run";

export async function runSearchRelevanceCli(args: string[], root: string) {
  if (args.includes("--help")) {
    console.log(
      "pnpm search:eval [--live --tape <new.json>] [--out <report.json>]\nDefault: exact offline replay of the committed baseline. No job-site or model network calls.\n--live: recorded job pages only; configured NESTOR_AI_* model, at most 40 logical calls. Never overwrites a tape.",
    );
    return;
  }
  const value = (flag: string, fallback: string) =>
    args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? fallback) : fallback;
  const directory = path.join(root, "fixtures/search-relevance");
  const corpus = await loadCorpus(directory),
    live = args.includes("--live");
  const providerFiles = [
    "openai-compatible.ts",
    "openai-compatible-transport.ts",
  ];
  const providerCodeDigest = digest(
    (
      await Promise.all(
        providerFiles.map((file) =>
          readFile(path.resolve(root, "../ai-providers/src", file), "utf8"),
        ),
      )
    ).join("\n"),
  );
  const tapePath = path.resolve(
    value("--tape", path.join(directory, "baseline-tape.json")),
  );
  let tape: ModelTape;
  if (live) {
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
    tape = JSON.parse(await readFile(tapePath, "utf8")) as ModelTape;
    if (tape.corpusDigest !== corpus.digest)
      throw new Error("Corpus changed; record a new explicit live baseline.");
    if (tape.route.providerCodeDigest !== providerCodeDigest)
      throw new Error(
        "Provider implementation changed; record a new explicit live baseline.",
      );
  }
  const client = live
    ? createJobFinderAiClientFromEnvironment(process.env)
    : null;
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
      ...(client?.chatWithTools
        ? { live: { chatWithTools: client.chatWithTools } }
        : {}),
      onTurn: async () => {
        await mkdir(path.dirname(tapePath), { recursive: true });
        await writeFile(tapePath, JSON.stringify(tape, null, 2) + "\n");
      },
    });
    const output = {
      recordedAt: new Date().toISOString(),
      repositoryHead: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      corpusDigest: corpus.digest,
      selection: corpus.manifest.selection,
      targets: { recall: 0.9, relevantInTop10: 8 },
      route: tape.route,
      ...report,
    };
    const out = path.resolve(
      value(
        "--out",
        path.join(root, "../../.tmp/search-relevance-report.json"),
      ),
    );
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(output, null, 2) + "\n");
    for (const persona of report.personas)
      console.log(
        `${persona.persona}: screening/fit recall ${persona.found}/${persona.relevant} (${(persona.recall * 100).toFixed(1)}%); top 10 ${persona.relevantInTop10}/10 relevant. Including collection: ${persona.endToEnd.found}/${persona.endToEnd.relevant} (${(persona.endToEnd.recall * 100).toFixed(1)}%), top 10 ${persona.endToEnd.relevantInTop10}/10.`,
      );
    console.log(
      `Coverage honesty: ${report.coverage.filter((entry) => entry.honest).length}/${report.coverage.length}; ${report.freshCalls} fresh / ${report.replayedCalls} replayed calls; ${(report.durationMs / 1000).toFixed(2)}s. Report: ${out}`,
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
