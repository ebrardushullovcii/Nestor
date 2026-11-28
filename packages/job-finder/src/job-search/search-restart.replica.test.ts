import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  createDeterministicJobFinderAiClient,
  createOpenAiCompatibleJobFinderAiClient,
  resetAiAccessForTests,
} from "@nestor/ai-providers";
import { createApplyPageHands, runJobSearchAgent } from "@nestor/browser-agent";
import {
  createPlaywrightApplyPageMechanics,
  type AgentDiscoveryOptions,
} from "@nestor/browser-runtime";
import {
  CandidateProfileSchema,
  DiscoveryRunResultSchema,
  JobDiscoveryTargetSchema,
  JobSearchPreferencesSchema,
  NESTOR_REQUEST_REJECTED_MESSAGE,
  toJobSearchGoals,
} from "@nestor/contracts";
import {
  createSearchSourcesStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createJobCommandRunner } from "../job-commands";
import { createListingSearchEngine, type JobSearchEngine } from "./engine";
import { createJobSearchRunner } from "./runner";
import type { JobSearchContext, JobSearchRunner } from "./types";

/**
 * Quitting mid-search on the local replica boards, with a scripted model:
 * the next process keeps every listing read and page collected before the
 * quit, and does not fetch an index page it had already read.
 */
let server: ChildProcess;
let base: string;
beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "../../../../apps/desktop/test-fixtures/job-sites/serve.mjs",
      ),
    ],
    {
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: join(
          mkdtempSync(join(tmpdir(), "nestor-search-restart-replica-")),
          "posts.log",
        ),
      },
    },
  );
  base = await new Promise<string>((resolve, reject) => {
    server.stderr!.on("data", (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
      if (url) resolve(url);
    });
    server.once("exit", () => reject(Error("Replica server exited")));
  });
}, 60_000);
afterAll(() => {
  server?.kill();
});

const now = "2026-11-27T08:00:00.000Z";
function searchContext(target: string): JobSearchContext {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      fullName: "Robin Ashford",
      headline: "Software engineer",
      currentLocation: "Berlin, Germany",
      yearsExperience: 6,
      baseResume: { id: "resume", fileName: "synthetic.txt", uploadedAt: now },
    }),
    searchPreferences: JobSearchPreferencesSchema.parse({
      targetRoles: ["Software Engineer"],
      locations: ["Remote"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    }),
    sources: [
      JobDiscoveryTargetSchema.parse({
        id: "1",
        label: "Longboard Jobs",
        startingUrl: target,
      }),
    ],
    sourceInstructionArtifacts: [],
  };
}

type ModelCall = { task: string; urls: string[]; cards?: string[] };
/**
 * Keeps every title unless `keep` says otherwise, and reads each page's
 * metadata from its own text. `holdReads` keeps page reads waiting until the
 * app quits.
 */
function scriptedModel(
  calls: ModelCall[],
  options: {
    keep?: (title: string) => 0 | 1;
    holdReads?: boolean;
    refuseScreen?: (signal?: AbortSignal) => Promise<unknown> | undefined;
  } = {},
) {
  return {
    ...createDeterministicJobFinderAiClient(),
    chatWithTools: vi.fn(
      (
        messages: readonly { role: string; content?: unknown }[],
        _tools: unknown,
        request?: { reasoningTask?: string; signal?: AbortSignal },
      ) => {
        const task = request?.reasoningTask ?? "";
        const content = messages[1]?.content;
        const data = JSON.parse(
          typeof content === "string" ? content : "{}",
        ) as {
          titles?: [number, string, number[] | null, unknown][];
          evidenceBlocks?: string[];
          listings?: { id: number; title: string; url: string }[];
        };
        if (task === "listing_screen") {
          const refused = options.refuseScreen?.(request?.signal);
          if (refused)
            return refused.then(() => {
              throw new Error("Expected a provider refusal");
            });
          const titles = data.titles ?? [];
          calls.push({
            task,
            urls: [],
            // Each card as the model sees it: its title and card evidence.
            cards: titles.map(
              ([, title, card]) =>
                `${title}\n${(card ?? []).map((id) => data.evidenceBlocks?.[id]).join("\n")}`,
            ),
          });
          return Promise.resolve({
            content: JSON.stringify({
              keep: Object.fromEntries(
                titles.map(([index, title]) => [
                  String(index),
                  options.keep?.(title) ?? 1,
                ]),
              ),
            }),
          });
        }
        if (task === "page_read" && options.holdReads) {
          calls.push({ task, urls: [] });
          return new Promise<{ content: string }>((_resolve, reject) => {
            const interrupted = () => reject(new Error("Search interrupted"));
            if (request?.signal?.aborted) interrupted();
            request?.signal?.addEventListener("abort", interrupted, {
              once: true,
            });
          });
        }
        if (task === "page_read") {
          calls.push({
            task,
            urls: (data.listings ?? []).map((listing) => listing.url),
          });
          return Promise.resolve({
            content: JSON.stringify({
              jobs: (data.listings ?? []).map(({ id, title }) => ({
                id,
                title,
                company: "Longboard Employer",
                location: "Remote",
                workModes: ["remote"],
                fullListingRead: true,
                sourceJobId: null,
                employmentType: null,
                seniority: null,
                salaryText: null,
                closed: false,
                applyUrl: null,
                isListing: true,
                index: false,
              })),
            }),
          });
        }
        return Promise.reject(new Error(`Unexpected model task ${task}`));
      },
    ),
  };
}

function engineFor(
  model: ReturnType<typeof scriptedModel>,
  browserRuntime: Parameters<
    typeof createListingSearchEngine
  >[0]["browserRuntime"] = {},
): JobSearchEngine {
  const engine = createListingSearchEngine({
    aiClient: model,
    browserRuntime,
  });
  // Fit is judged separately and is not what a restart must keep here.
  return {
    ...engine,
    fitJobs: ({ jobs }) =>
      Promise.resolve(
        jobs.map((job) => ({
          id: job.id,
          score: 70,
          summary: "Scripted fit.",
          reasons: [],
          gaps: [],
        })),
      ),
  };
}

/** Every saved posting's address, one per job. */
function savedUrls(store: JobStore): string[] {
  return store
    .listJobs({ stage: "found", limit: 200 })
    .rows.map((row) => store.getJob(row.id)!.url);
}

function finished(runner: JobSearchRunner, store: JobStore, id: string) {
  return vi.waitFor(
    () => {
      expect(store.searches.get(id)?.state).not.toBe("running");
      expect(runner.status().fitRunning).toBe(false);
    },
    { timeout: 60_000, interval: 50 },
  );
}

test("a Thorough search finishes both replica boards across a restart and Try again after a refused request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nestor-search-restart-"));
  const file = join(dir, "jobs.sqlite");
  const target = `${base}/longboard/jobs`;
  const secondBoard = `${base}/lever/`;
  const context = searchContext(target);
  context.sources = [
    ...context.sources,
    JobDiscoveryTargetSchema.parse({
      id: "2",
      label: "Copper Kite Careers",
      startingUrl: secondBoard,
    }),
  ];
  const modelBase = "https://search-model.example.test/v1";
  const rejectingModel = createOpenAiCompatibleJobFinderAiClient({
    baseUrl: modelBase,
    apiKey: "synthetic-search-refusal",
    model: "scripted",
  });
  let refuse = true;
  let refusedRequests = 0;
  const model = (calls: ModelCall[]) =>
    scriptedModel(calls, {
      refuseScreen: (signal) => {
        if (!refuse) return;
        refuse = false;
        return rejectingModel.chatWithTools(
          [{ role: "user", content: "Scripted screening request" }],
          [],
          signal ? { signal } : undefined,
        );
      },
    });
  const fetched: string[] = [];
  const answered = new Set<string>();
  const realFetch = globalThis.fetch;
  let beforeRestart = true;
  let runner: JobSearchRunner | null = null;
  // Requests leave this process like the app's own; the quit happens while
  // page 4 of 6 is being fetched.
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${modelBase}/`)) {
        refusedRequests++;
        return new Response(
          JSON.stringify({ error: { message: "Request schema rejected" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      expect(new URL(url).origin).toBe(base);
      fetched.push(url);
      if (beforeRestart && url === `${target}?page=4`) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const interrupted = () => reject(new Error("Search interrupted"));
          if (signal?.aborted) interrupted();
          signal?.addEventListener("abort", interrupted, { once: true });
        });
      }
      const response = await realFetch(input, init);
      if (response.ok) answered.add(url);
      return response;
    });
  let store = openJobStore(file);
  const calls: ModelCall[] = [];
  try {
    const first = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls)),
      readContext: () => Promise.resolve(context),
    });
    runner = first;
    const started = await first.start({
      depth: "thorough",
      postedWithin: "any",
    });
    await vi.waitFor(
      () => {
        expect(fetched).toContain(`${target}?page=4`);
        expect(first.status().search?.sourcesDone).toBe(1);
        expect(savedUrls(store)).toHaveLength(40);
      },
      { timeout: 30_000 },
    );
    first.suspend();
    beforeRestart = false;
    expect(store.searches.get(started.id)).toMatchObject({
      state: "running",
      sourcesDone: 1,
    });
    store.close();

    const indexFetches = (urls: string[]) =>
      urls.filter((url) => /\/longboard\/jobs(?:\?|$)/u.test(url));
    const indexesBefore = indexFetches(fetched);
    expect(indexesBefore).toContain(`${target}?page=3`);

    // The next process.
    store = openJobStore(file);
    const savedBefore = new Set(savedUrls(store));
    expect(savedBefore.size).toBe(40);
    const finishedReads = new Set(calls.flatMap((call) => call.urls));
    const completedCards = calls.flatMap((call) => call.cards ?? []);
    fetched.length = 0;
    calls.length = 0;
    const second = createJobSearchRunner({
      store,
      engine: engineFor(model(calls)),
      readContext: () => Promise.resolve(context),
    });
    runner = second;
    await vi.waitFor(() =>
      expect(second.status().parked).toMatchObject({ requestRejected: true }),
    );
    expect(refusedRequests).toBe(1);
    expect(store.searches.get(started.id)).toMatchObject({
      error: NESTOR_REQUEST_REJECTED_MESSAGE,
      state: "running",
      sourcesDone: 1,
    });
    const sources = createSearchSourcesStore(store);
    expect(sources.get(started.id, "1")).toMatchObject({ failedReads: 0 });
    expect(sources.cardUrls(started.id, "1").length).toBeGreaterThan(30);
    const commands = createJobCommandRunner({
      store,
      search: () => Promise.resolve(second),
    });
    await expect(commands("keep_reading", {})).resolves.toMatchObject({
      search: { id: started.id, state: "running", error: null },
      parked: null,
    });
    await finished(second, store, started.id);

    const after = indexFetches(fetched);
    // Pages 1 to 3 were collected before the quit: none is fetched again.
    for (const url of indexesBefore.filter((url) => !url.includes("page=4")))
      expect(after).not.toContain(url);
    expect(fetched).not.toContain(secondBoard);
    expect(after).toEqual([4, 5, 6].map((page) => `${target}?page=${page}`));
    // A listing whose read finished before the quit is not fetched or read
    // by the model again.
    for (const url of savedBefore) {
      expect(fetched).not.toContain(url);
      expect(calls.flatMap((call) => call.urls)).not.toContain(url);
    }
    // Compare persisted reads against a successful fetch and a model read of
    // that posting's address, independent of the fullListingRead flag.
    const reads = calls.flatMap((call) => call.urls);
    const screened = calls.flatMap((call) => call.cards ?? []);
    expect(completedCards).toHaveLength(40);
    expect(screened).toHaveLength(30);
    expect(new Set(reads).size).toBe(reads.length);
    const allRead = new Set([...finishedReads, ...reads]);
    const jobs = savedUrls(store);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect(new Set(jobs)).toEqual(
      new Set([
        ...Array.from(
          { length: 60 },
          (_, i) => `${base}/longboard/job/${i + 1}`,
        ),
        ...Array.from({ length: 10 }, (_, i) => `${base}/lever/jobs/${i + 1}`),
      ]),
    );
    expect(new Set(jobs)).toEqual(allRead);
    expect(jobs.every((url) => answered.has(url))).toBe(true);
    for (const row of store.listJobs({ stage: "found", limit: 100 }).rows) {
      const job = store.getJob(row.id)!;
      const detailText = job.url.includes("/longboard/job/")
        ? "Build and run TypeScript services and React interfaces"
        : "Build reliable software for a fictional collaborative planning product.";
      expect(job.description).toContain(detailText);
      expect(job).toMatchObject({
        facts: { fullListingRead: true },
        fitScore: 70,
      });
    }
    for (const [sourceId, cards] of [
      ["1", 60],
      ["2", 10],
    ] as const) {
      expect(sources.get(started.id, sourceId)).toMatchObject({
        state: "done",
        phase: null,
        cards,
        related: cards,
        found: cards,
        added: cards,
        failedReads: 0,
      });
      expect(sources.cardUrls(started.id, sourceId)).toEqual([]);
    }
    expect(sources.pending(started.id)).toEqual([]);
    expect(sources.unfinishedIds(started.id)).toEqual([]);
    expect(store.searches.get(started.id)).toMatchObject({
      state: "done",
      sourcesTotal: 2,
      sourcesDone: 2,
      found: 70,
      added: 70,
      scored: 70,
    });
    console.info(
      "[Thorough restart and refusal replica]",
      JSON.stringify({
        searchId: started.id,
        sources: sources.list({ searchId: started.id }).rows,
        indexBefore: indexesBefore,
        indexAfter: after,
        savedBeforeQuit: savedBefore.size,
        detailReadsAfter: reads.length,
        detailReadsTotal: allRead.size,
        screenedBefore: completedCards.length,
        screenedAfter: screened.length,
        refusedRequests,
        pendingSources: sources.pending(started.id).length,
      }),
    );
  } finally {
    runner?.suspend();
    resetAiAccessForTests();
    fetchSpy.mockRestore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

type Turn = { name: string; args: Record<string, unknown> };
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();
const headlessShell = existsSync(executablePath) ? executablePath : undefined;

/**
 * Stands in for the desktop browser runtime with the real search agent and a
 * scripted navigation model. A run whose script is { fail } ends the way the
 * desktop runtime reports an exception in the agent.
 */
function scriptedAgentRuntime(input: {
  context: () => BrowserContext;
  turnsFor: (run: number) => Turn[] | { fail: string };
  outOfTurns: (run: number) => void;
  loaded: string[];
  runs: AgentDiscoveryOptions[];
  prompts: string[];
}) {
  let current: Page | null = null;
  let run = 0;
  return {
    readRenderedPage: async (url: string) => {
      const page = await input.context().newPage();
      try {
        await page.goto(url);
        return { finalUrl: page.url(), html: await page.content() };
      } finally {
        await page.close();
      }
    },
    // Stands in for the desktop runtime: one tab, the real search agent.
    runAgentDiscovery: async (
      source: Parameters<typeof runJobSearchAgent>[0]["config"]["source"],
      options: AgentDiscoveryOptions,
    ) => {
      input.runs.push(options);
      const n = ++run;
      const turns = input.turnsFor(n);
      // The site's own failure, reported as the desktop runtime reports it.
      if (!Array.isArray(turns))
        return DiscoveryRunResultSchema.parse({
          source,
          startedAt: now,
          completedAt: now,
          querySummary: "Longboard Jobs",
          warning: `Agent discovery failed: ${turns.fail}`,
          inventoryCompleteness: "unknown",
          jobs: [],
          agentMetadata: null,
        });
      const page = await input.context().newPage();
      current = page;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame())
          input.loaded.push(`${n} ${frame.url()}`);
      });
      try {
        await page.goto(options.startingUrls[0]!);
        let turn = 0;
        const result = await runJobSearchAgent({
          page,
          hands: createApplyPageHands(createPlaywrightApplyPageMechanics(page)),
          config: {
            source,
            inventoryOnly: true,
            retainAllFound: true,
            maxSteps: options.maxSteps,
            targetJobCount: options.targetJobCount,
            userProfile: options.userProfile,
            searchPreferences: toJobSearchGoals(options.searchPreferences),
            startingUrls: options.startingUrls,
            navigationPolicy: {
              allowedHostnames: options.navigationHostnames,
              allowSubdomains: true,
            },
            promptContext: {
              siteLabel: options.siteLabel,
              ...(options.searchRequest
                ? { searchRequest: options.searchRequest }
                : {}),
            },
            ...(options.resumeCheckpoint
              ? { resumeCheckpoint: options.resumeCheckpoint }
              : {}),
            ...(options.onCheckpoint
              ? { onCheckpoint: options.onCheckpoint }
              : {}),
          },
          llmClient: {
            chatWithTools: (messages) => {
              if (turn === 0)
                input.prompts.push(
                  messages
                    .filter((message) => message.role === "user")
                    .map((message) => String(message.content))
                    .join("\n"),
                );
              const action = turns[turn++];
              // Out of turns: the test quits the app here.
              if (!action) {
                input.outOfTurns(n);
                return new Promise((_resolve, reject) =>
                  options.signal?.addEventListener(
                    "abort",
                    () => reject(new Error("Search interrupted")),
                    { once: true },
                  ),
                );
              }
              return Promise.resolve({
                toolCalls: [
                  {
                    id: `run-${n}-${turn}`,
                    type: "function" as const,
                    function: {
                      name: action.name,
                      arguments: JSON.stringify(action.args),
                    },
                  },
                ],
              });
            },
          },
          jobExtractor: {
            extractJobsFromPage: async () => {
              const links = await current!.$$eval(
                'a[href*="/longboard/job/"]',
                (anchors) =>
                  anchors.map((anchor) => ({
                    href: (anchor as HTMLAnchorElement).href,
                    title: anchor.textContent?.trim() ?? "",
                  })),
              );
              return links.map((link) => ({
                sourceJobId: link.href,
                canonicalUrl: link.href,
                title: link.title,
                company: "Longboard Employer",
                location: "Remote",
                description: link.title,
                salaryText: null,
                summary: null,
                postedAt: null,
                workMode: [],
                applyPath: "unknown" as const,
                easyApplyEligible: false,
                keySkills: [],
              }));
            },
          },
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return DiscoveryRunResultSchema.parse({
          source,
          startedAt: now,
          completedAt: now,
          querySummary: "Longboard Jobs",
          warning: result.warning ?? null,
          jobs: result.jobs,
          agentMetadata: {
            pagesCovered: result.pagesCovered ?? 0,
            steps: result.steps,
            incomplete: result.incomplete ?? false,
            phaseCompletionMode: result.phaseCompletionMode ?? null,
            phaseCompletionReason: result.phaseCompletionReason ?? null,
          },
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    },
  };
}

test("quitting while the browser walks a board continues at the page it reached, and keeps its cards", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(headlessShell ? { executablePath: headlessShell } : {}),
  });
  const dir = mkdtempSync(join(tmpdir(), "nestor-search-restart-browser-"));
  const file = join(dir, "jobs.sqlite");
  // The landing page is a search form with no cards: HTTP cannot read it,
  // so the browser agent navigates the board.
  const target = `${base}/longboard/`;
  const context = searchContext(target);
  const jobs = (n: number) =>
    `${base}/longboard/jobs${n > 1 ? `?page=${n}` : ""}`;
  let store = openJobStore(file);
  let browserContext: BrowserContext | null = null;
  try {
    const loaded: string[] = [];
    const runs: AgentDiscoveryOptions[] = [];
    let quit: (() => void) | null = null;
    /** The scripted navigation model; each run follows its own turns. */
    const turnsFor = (n: number): Turn[] =>
      n === 1
        ? [
            { name: "navigate", args: { url: jobs(1) } },
            { name: "extract_jobs", args: { pageType: "search_results" } },
            { name: "navigate", args: { url: jobs(2) } },
            {
              name: "extract_jobs",
              args: {
                pageType: "search_results",
                remainingWork: [`Continue with ${jobs(3)} after this batch.`],
              },
            },
          ]
        : [
            ...[3, 4, 5, 6].flatMap((page) => [
              { name: "navigate", args: { url: jobs(page) } },
              { name: "extract_jobs", args: { pageType: "search_results" } },
            ]),
            {
              name: "finish",
              args: {
                reason: "Read pages 1 to 6 of 6.",
                coverageComplete: true,
                remainingWork: [],
              },
            },
          ];
    const prompts: string[] = [];
    const runtime = scriptedAgentRuntime({
      context: () => browserContext!,
      turnsFor,
      outOfTurns: () => quit?.(),
      loaded,
      runs,
      prompts,
    });
    browserContext = await browser.newContext();
    const calls: ModelCall[] = [];
    const first = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls), runtime),
      readContext: () => Promise.resolve(context),
    });
    let stopped!: () => void;
    const quitting = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    quit = () => {
      quit = null;
      first.suspend();
      stopped();
    };
    const started = await first.start({
      depth: "thorough",
      postedWithin: "any",
    });
    await quitting;
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.close();
    await browserContext.close();
    const firstRun = loaded.splice(0);
    expect(firstRun).toContain(`1 ${jobs(2)}`);

    // The next process: a new browser session, the same saved search.
    store = openJobStore(file);
    browserContext = await browser.newContext();
    const second = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls), runtime),
      readContext: () => Promise.resolve(context),
    });
    await vi.waitFor(() =>
      expect(store.searches.get(started.id)?.state).toBe("running"),
    );
    await finished(second, store, started.id);
    expect(store.searches.get(started.id)?.state).toBe("done");

    // It starts at the page the first run had reached, never at page 1,
    // and the model is told where the interrupted run had got to.
    expect(runs[1]?.startingUrls[0]).toBe(jobs(2));
    expect(runs[1]?.resumeCheckpoint).toMatchObject({
      currentUrl: jobs(2),
      collectedEarlier: 20,
      remainingWork: [`Continue with ${jobs(3)} after this batch.`],
    });
    expect(loaded.filter((url) => url.startsWith("2 "))).not.toContain(
      `2 ${jobs(1)}`,
    );
    // The resumed model gets its saved next-page note on the first turn.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`Continue with ${jobs(3)} after this batch.`);
    // Every public posting is saved once.
    const saved = savedUrls(store);
    expect(new Set(saved).size).toBe(saved.length);
    expect(saved).toHaveLength(60);
    console.info(
      "[restart replica browser]",
      JSON.stringify({
        firstRunPages: firstRun,
        secondRunPages: loaded,
        modelTurnsSecondRun: prompts.length - 1,
        saved: saved.length,
      }),
    );
    second.suspend();
  } finally {
    store.close();
    await browserContext?.close().catch(() => undefined);
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

/** Opens a browser for one test; it closes with the test. */
async function launch() {
  return chromium.launch({
    headless: true,
    ...(headlessShell ? { executablePath: headlessShell } : {}),
  });
}

/** Walks the board's six public pages from page 1 and finishes. */
const walkBoard = (): Turn[] => [
  ...[1, 2, 3, 4, 5, 6].flatMap((page) => [
    {
      name: "navigate",
      args: {
        url: `${base}/longboard/jobs${page > 1 ? `?page=${page}` : ""}`,
      },
    },
    { name: "extract_jobs", args: { pageType: "search_results" } },
  ]),
  {
    name: "finish",
    args: {
      reason: "Read pages 1 to 6 of 6.",
      coverageComplete: true,
      remainingWork: [],
    },
  },
];

test("a restart screens no card the model already judged, related or unrelated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nestor-search-restart-verdicts-"));
  const file = join(dir, "jobs.sqlite");
  const context = searchContext(`${base}/longboard/jobs`);
  // Two of the board's eight titles are another profession.
  const keep = (title: string) =>
    /site reliability|typescript/iu.test(title) ? (0 as const) : (1 as const);
  let store = openJobStore(file);
  try {
    const first: ModelCall[] = [];
    const runner = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(first, { keep, holdReads: true })),
      readContext: () => Promise.resolve(context),
    });
    const started = await runner.start({
      depth: "thorough",
      postedWithin: "any",
    });
    // The app quits once every card is judged, while the related cards'
    // listing reads are still waiting.
    const judged = () => first.flatMap((call) => call.cards ?? []);
    await vi.waitFor(() => expect(judged()).toHaveLength(60), {
      timeout: 60_000,
      interval: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.suspend();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.searches.get(started.id)?.state).toBe("running");
    expect(new Set(judged()).size).toBe(60);
    expect(judged().filter((card) => keep(card) === 0)).toHaveLength(14);
    expect(savedUrls(store)).toHaveLength(0);
    store.close();

    // The next process.
    store = openJobStore(file);
    const second: ModelCall[] = [];
    const next = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(second, { keep })),
      readContext: () => Promise.resolve(context),
    });
    await vi.waitFor(() =>
      expect(store.searches.get(started.id)?.state).toBe("running"),
    );
    await finished(next, store, started.id);
    expect(store.searches.get(started.id)?.state).toBe("done");
    // No card is screened again: the related ones are read straight away.
    expect(second.filter((call) => call.task === "listing_screen")).toEqual([]);
    const saved = savedUrls(store);
    expect(new Set(saved).size).toBe(46);
    expect(saved).toHaveLength(46);
    const row = createSearchSourcesStore(store).get(started.id, "1");
    expect(row).toMatchObject({ state: "done", cards: 60, related: 46 });
    console.info(
      "[restart replica verdicts]",
      JSON.stringify({
        screenedBefore: judged().length,
        screeningCallsAfter: second.filter(
          (call) => call.task === "listing_screen",
        ).length,
        readCallsAfter: second.filter((call) => call.task === "page_read")
          .length,
        saved: saved.length,
        message: row?.message,
      }),
    );
    next.suspend();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("a site whose attempt failed is tried again on resume, and its row shows both outcomes", async () => {
  const browser = await launch();
  const dir = mkdtempSync(join(tmpdir(), "nestor-search-restart-retry-"));
  const file = join(dir, "jobs.sqlite");
  const failedSite = JobDiscoveryTargetSchema.parse({
    id: "1",
    label: "Longboard Jobs",
    startingUrl: `${base}/longboard/`,
  });
  // A second site keeps the search running until the app quits.
  const slowSite = JobDiscoveryTargetSchema.parse({
    id: "2",
    label: "Longboard search",
    startingUrl: `${base}/longboard/jobs?q=engineer`,
  });
  const context = {
    ...searchContext(failedSite.startingUrl),
    sources: [failedSite, slowSite],
  };
  const realFetch = globalThis.fetch;
  let hold = true;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (hold && url.includes("q=engineer"))
        return new Promise<Response>((_resolve, reject) => {
          const interrupted = () => reject(new Error("Search interrupted"));
          if (init?.signal?.aborted) interrupted();
          init?.signal?.addEventListener("abort", interrupted, { once: true });
        });
      return realFetch(input, init);
    });
  let store = openJobStore(file);
  let browserContext: BrowserContext | null = await browser.newContext();
  const detached = "frame.frameElement: Frame has been detached.";
  try {
    const runs: AgentDiscoveryOptions[] = [];
    const runtime = scriptedAgentRuntime({
      context: () => browserContext!,
      // The first attempt dies before the model looks, as Jobspresso's did.
      turnsFor: (run) => (run === 1 ? { fail: detached } : walkBoard()),
      outOfTurns: () => undefined,
      loaded: [],
      runs,
      prompts: [],
    });
    const calls: ModelCall[] = [];
    const first = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls), runtime),
      readContext: () => Promise.resolve(context),
    });
    const started = await first.start({
      depth: "thorough",
      postedWithin: "any",
    });
    const rows = () => createSearchSourcesStore(store);
    await vi.waitFor(
      () => expect(rows().failure(started.id, "1")).not.toBeNull(),
      { timeout: 60_000, interval: 20 },
    );
    expect(rows().get(started.id, "1")).toMatchObject({ state: "failed" });
    first.suspend();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.searches.get(started.id)?.state).toBe("running");
    store.close();
    await browserContext.close();

    // The next process: the failed site gets another real attempt.
    hold = false;
    store = openJobStore(file);
    browserContext = await browser.newContext();
    const second = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls), runtime),
      readContext: () => Promise.resolve(context),
    });
    await vi.waitFor(() =>
      expect(store.searches.get(started.id)?.state).toBe("running"),
    );
    await finished(second, store, started.id);
    expect(store.searches.get(started.id)).toMatchObject({
      state: "done",
      sourcesTotal: 2,
      sourcesDone: 2,
    });
    expect(runs).toHaveLength(2);
    const row = rows().get(started.id, "1")!;
    expect(row).toMatchObject({ state: "done", cards: 60 });
    expect(row.message).toMatch(/^60 listings;/u);
    expect(row.message).toContain("Read pages 1 to 6 of 6.");
    expect(row.message).toContain(
      `An earlier attempt failed: Agent discovery failed: ${detached}`,
    );
    expect(row.message).not.toContain("No listings found");
    expect(rows().failure(started.id, "1")).toBeNull();
    const saved = savedUrls(store);
    expect(new Set(saved).size).toBe(saved.length);
    expect(saved).toHaveLength(60);
    console.info(
      "[restart replica retry]",
      JSON.stringify({ attempts: runs.length, message: row.message }),
    );
    second.suspend();
  } finally {
    fetchSpy.mockRestore();
    store.close();
    await browserContext?.close().catch(() => undefined);
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("a site with an earlier good attempt and a later failure keeps its counts and shows the failure", async () => {
  const browser = await launch();
  const dir = mkdtempSync(join(tmpdir(), "nestor-search-restart-later-"));
  const file = join(dir, "jobs.sqlite");
  const context = searchContext(`${base}/longboard/`);
  const jobs = (n: number) =>
    `${base}/longboard/jobs${n > 1 ? `?page=${n}` : ""}`;
  let store = openJobStore(file);
  let browserContext: BrowserContext | null = await browser.newContext();
  const broken =
    "locator.evaluateAll: TypeError: node.matches is not a function";
  try {
    let quit: (() => void) | null = null;
    const runs: AgentDiscoveryOptions[] = [];
    const runtime = scriptedAgentRuntime({
      context: () => browserContext!,
      // Pages 1 and 2, then the app quits; the next attempt fails at once,
      // as Himalayas' did.
      turnsFor: (run) =>
        run === 1
          ? [1, 2].flatMap((page) => [
              { name: "navigate", args: { url: jobs(page) } },
              { name: "extract_jobs", args: { pageType: "search_results" } },
            ])
          : { fail: broken },
      outOfTurns: () => quit?.(),
      loaded: [],
      runs,
      prompts: [],
    });
    const calls: ModelCall[] = [];
    const first = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls), runtime),
      readContext: () => Promise.resolve(context),
    });
    let stopped!: () => void;
    const quitting = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    quit = () => {
      quit = null;
      first.suspend();
      stopped();
    };
    const started = await first.start({
      depth: "thorough",
      postedWithin: "any",
    });
    await quitting;
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.close();
    await browserContext.close();

    store = openJobStore(file);
    browserContext = await browser.newContext();
    const second = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls), runtime),
      readContext: () => Promise.resolve(context),
    });
    await vi.waitFor(() =>
      expect(store.searches.get(started.id)?.state).toBe("running"),
    );
    await finished(second, store, started.id);
    expect(store.searches.get(started.id)?.state).toBe("done");
    expect(runs).toHaveLength(2);
    const rows = createSearchSourcesStore(store);
    const row = rows.get(started.id, "1")!;
    // What the first attempt found stays; the later failure is added.
    expect(row).toMatchObject({ state: "partial", cards: 20 });
    expect(row.message).toMatch(/^20 listings;/u);
    expect(row.message).toContain(
      `The last attempt to read this site failed: Agent discovery failed: ${broken}`,
    );
    expect(row.message).not.toContain("No listings found");
    // A resume would try the site again.
    expect(rows.failure(started.id, "1")).toContain(broken);
    const saved = savedUrls(store);
    expect(new Set(saved).size).toBe(saved.length);
    expect(saved).toHaveLength(20);
    console.info("[restart replica later failure]", JSON.stringify({ row }));
    second.suspend();
  } finally {
    store.close();
    await browserContext?.close().catch(() => undefined);
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
