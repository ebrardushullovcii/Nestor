import { performance } from "node:perf_hooks";
import {
  collectSource,
  screenCards,
  readListings,
  fitJobs,
  type LLMClient,
} from "@nestor/browser-agent";
import {
  DiscoveryPageReadError,
  JobDetailSchema,
  type ReadDiscoveryPostingPage,
  type ModelTokenUsage,
  type JobFitUpdate,
} from "@nestor/contracts";
import { digest, type RecordedBoard, type LabelledListing } from "./corpus";
import { searchPersonas } from "./personas";

type Request = Parameters<LLMClient["chatWithTools"]>;
export interface ModelTurn {
  key: string;
  stage: string;
  durationMs: number;
  response: Awaited<ReturnType<LLMClient["chatWithTools"]>>;
}
export interface ModelTape {
  corpusDigest: string;
  route: Record<string, string>;
  turns: ModelTurn[];
}
const zeroUsage = (): ModelTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});
const addUsage = (sum: ModelTokenUsage, usage: ModelTokenUsage) => {
  for (const field of Object.keys(sum) as Array<keyof ModelTokenUsage>)
    sum[field] += usage[field];
};
export function turnKey(
  [messages, tools, options]: Request,
  route: ModelTape["route"],
) {
  const stableOptions = { ...options };
  delete stableOptions.signal;
  return digest(
    JSON.stringify({ route, messages, tools, options: stableOptions }),
  );
}

export function recordedReader(board: RecordedBoard) {
  const reads: string[] = [],
    missing: string[] = [];
  const normalize = (url: string) => {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.href;
  };
  const readPage: ReadDiscoveryPostingPage = (url, options) =>
    Promise.resolve().then(() => {
      // New provider readers may supply a read-only JSON query. Old readers use GET.
      const body = "jsonQuery" in options ? options.jsonQuery : undefined;
      const page = board.responses.find(
        (page) =>
          normalize(page.url) === normalize(url) &&
          page.method === (body === undefined ? "GET" : "POST") &&
          (body === undefined ||
            JSON.stringify(body) === JSON.stringify(page.body)),
      );
      if (!page) {
        missing.push(url);
        throw new Error(
          `No recorded response for ${url}; network is disabled.`,
        );
      }
      reads.push(url);
      if (page.status >= 400) throw new DiscoveryPageReadError(page.status);
      return { html: page.html, finalUrl: page.finalUrl };
    });
  return { readPage, reads, missing };
}

export function gradeRanking(
  labels: readonly LabelledListing[],
  persona: string,
  rankedUrls: readonly string[],
  foundUrls: ReadonlySet<string>,
) {
  const relevant = labels.filter((entry) => entry.labels[persona]?.relevant);
  const found = relevant.filter((entry) => foundUrls.has(entry.url));
  const top = rankedUrls
    .slice(0, 10)
    .map((url) => labels.find((entry) => entry.url === url));
  const relevantInTop10 = top.filter(
    (entry) => entry?.labels[persona]?.relevant,
  ).length;
  const recall = relevant.length ? found.length / relevant.length : 0;
  return {
    relevant: relevant.length,
    found: found.length,
    recall,
    relevantInTop10,
    targetsMet: recall >= 0.9 && relevantInTop10 >= 8,
    missed: relevant
      .filter((entry) => !foundUrls.has(entry.url))
      .map((entry) => ({
        url: entry.url,
        title: entry.title,
        reason: entry.labels[persona]!.reason,
      })),
  };
}

/** Complete with no inventory reads or no observed vacancies is never silently green. */
export function coverageHonest(
  complete: boolean,
  reads: number,
  cards: number,
) {
  return !complete || (reads > 0 && cards > 0);
}

export async function runSearchRelevance(input: {
  boards: RecordedBoard[];
  labels: LabelledListing[];
  tape: ModelTape;
  live?: LLMClient;
  onTurn?: () => Promise<void>;
  maxCalls?: number;
}) {
  const start = performance.now(),
    errors: string[] = [];
  let freshCalls = 0,
    replayedCalls = 0;
  const coverage = [];
  const collectedUrls = new Set<string>();
  for (const board of input.boards) {
    const reader = recordedReader(board);
    const inventory = await collectSource({
      source: board.source,
      readPage: reader.readPage,
    });
    for (const card of inventory.cards) collectedUrls.add(card.url);
    coverage.push({
      board: board.source.id,
      complete: inventory.complete,
      cards: inventory.cards.length,
      reportedPagesRead: inventory.pagesRead,
      recordedReads: reader.reads.length,
      honest: coverageHonest(
        inventory.complete,
        Math.min(inventory.pagesRead, reader.reads.length),
        inventory.cards.length,
      ),
      missingRecordings: reader.missing,
      notes: inventory.notes,
    });
  }
  const personas = [];
  for (const persona of searchPersonas) {
    const personaStart = performance.now(),
      boards = [];
    const ranked: Array<{
      url: string;
      board: string;
      score: number;
      title: string;
      relevant: boolean;
      reason: string;
      fit: JobFitUpdate;
    }> = [];
    const foundUrls = new Set<string>();
    for (const board of input.boards) {
      const boardStart = performance.now(),
        usage = zeroUsage();
      const stages: Record<
        string,
        { calls: number; durationMs: number; usage: ModelTokenUsage }
      > = {};
      const client: LLMClient = {
        chatWithTools: async (...args) => {
          const key = turnKey(args, input.tape.route),
            stage = args[2]?.reasoningTask ?? "unknown";
          let turn: ModelTurn | undefined;
          if (input.live) {
            if (freshCalls >= (input.maxCalls ?? 40)) {
              errors.push("Live model call budget exceeded.");
              throw new Error(errors.at(-1));
            }
            freshCalls++;
            const turnStart = performance.now();
            const response = await input.live.chatWithTools(...args);
            if (!response.usage)
              errors.push(
                `Missing provider token usage: ${board.source.id}/${stage}`,
              );
            turn = {
              key,
              stage,
              durationMs: performance.now() - turnStart,
              response,
            };
            input.tape.turns.push(turn);
            await input.onTurn?.();
          } else {
            turn = input.tape.turns.find((entry) => entry.key === key);
            replayedCalls++;
          }
          if (!turn) {
            errors.push(
              `No exact model recording: ${persona.id}/${board.source.id}/${stage} (${key}). Run an explicit new --live baseline after reviewing prompt changes.`,
            );
            throw new Error(errors.at(-1));
          }
          const measured = (stages[stage] ??= {
            calls: 0,
            durationMs: 0,
            usage: zeroUsage(),
          });
          measured.calls++;
          measured.durationMs += turn.durationMs;
          if (turn.response.usage) {
            addUsage(usage, turn.response.usage);
            addUsage(measured.usage, turn.response.usage);
          }
          return turn.response;
        },
      };
      const labels = input.labels.filter(
        (entry) => entry.board === board.source.id,
      );
      for (const label of labels)
        if (!label.labels[persona.id])
          throw new Error(`Unlabelled ${persona.id}/${label.url}`);
      const cards = labels.map(
        (label) => board.cards.find((card) => card.url === label.url)!,
      );
      const screened = await screenCards({
        client,
        cards,
        goals: persona.screen,
      });
      const reader = recordedReader(board);
      const read = await readListings({
        client,
        cards: screened.related,
        readPage: reader.readPage,
      }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push(`${persona.id}/${board.source.id}/read: ${reason}`);
        return {
          jobs: [],
          failures: screened.related.map((card) => ({ url: card.url, reason })),
        };
      });
      const jobs = read.jobs.map((job, index) =>
        JobDetailSchema.parse({
          ...job,
          id: index + 1,
          stage: job.hiddenReason ? "hidden" : "found",
          stageNote: job.hiddenReason ?? null,
          stageChangedAt: "2026-10-26T00:00:00.000Z",
          foundAt: "2026-10-26T00:00:00.000Z",
          seenAt: "2026-10-26T00:00:00.000Z",
          fitScore: null,
          fitSummary: null,
          searchId: null,
          sourceCount: 1,
          salary: null,
          facts: job.facts ?? {},
          fit: null,
          sightings: [],
        }),
      );
      const fits = await fitJobs({
        client,
        jobs,
        profile: persona.profile,
        goals: persona.goals,
        request: persona.request,
      });
      const rows = labels.map((label) => {
        const job = jobs.find((job) => job.url === label.url),
          fit = fits.find((fit) => fit.id === job?.id);
        const status = !screened.related.some((card) => card.url === label.url)
          ? "screened_out"
          : !job
            ? "read_failed"
            : job.stage === "hidden"
              ? "hidden"
              : !fit
                ? "unscored"
                : "scored";
        if (status === "scored" && fit) {
          foundUrls.add(label.url);
          ranked.push({
            url: label.url,
            board: board.source.id,
            score: fit.score,
            title: label.title,
            relevant: label.labels[persona.id]!.relevant,
            reason: label.labels[persona.id]!.reason,
            fit,
          });
        }
        return {
          url: label.url,
          title: label.title,
          relevant: label.labels[persona.id]!.relevant,
          labelReason: label.labels[persona.id]!.reason,
          status,
          fit: fit ?? null,
          readFailure:
            read.failures.find((failure) => failure.url === label.url)
              ?.reason ?? null,
        };
      });
      boards.push({
        board: board.source.id,
        sample: cards.length,
        screened: screened.related.length,
        read: jobs.length,
        scored: fits.length,
        durationMs: performance.now() - boardStart,
        usage,
        stages,
        rows,
      });
      console.log(
        `${persona.id}/${board.source.id}: ${cards.length} sampled, ${fits.length} scored, ${usage.inputTokens + usage.outputTokens} tokens`,
      );
    }
    ranked.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    const grade = gradeRanking(
      input.labels,
      persona.id,
      ranked.map((entry) => entry.url),
      foundUrls,
    );
    const endToEnd = gradeRanking(
      input.labels,
      persona.id,
      ranked
        .filter((entry) => collectedUrls.has(entry.url))
        .map((entry) => entry.url),
      new Set([...foundUrls].filter((url) => collectedUrls.has(url))),
    );
    personas.push({
      persona: persona.id,
      description: persona.description,
      durationMs: performance.now() - personaStart,
      ...grade,
      endToEnd,
      top10: ranked.slice(0, 10),
      boards,
    });
  }
  return {
    mode: input.live ? "live" : "offline_replay",
    freshCalls,
    replayedCalls,
    durationMs: performance.now() - start,
    coverage,
    personas,
    errors,
    passed:
      errors.length === 0 &&
      coverage.every(
        (entry) => entry.honest && entry.missingRecordings.length === 0,
      ) &&
      personas.every((entry) => entry.targetsMet && entry.endToEnd.targetsMet),
  };
}
