import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
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
  toJobSearchGoals,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
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

/** Keeps every title and reads each page's metadata from its own text. */
function scriptedModel(calls: { task: string; urls: string[] }[]) {
  return {
    ...createDeterministicJobFinderAiClient(),
    chatWithTools: vi.fn(
      (
        messages: readonly { role: string; content?: unknown }[],
        _tools: unknown,
        options?: { reasoningTask?: string },
      ) => {
        const task = options?.reasoningTask ?? "";
        const content = messages[1]?.content;
        const data = JSON.parse(
          typeof content === "string" ? content : "{}",
        ) as {
          titles?: unknown[][];
          listings?: { id: number; title: string; url: string }[];
        };
        if (task === "listing_screen") {
          calls.push({ task, urls: [] });
          return Promise.resolve({
            content: JSON.stringify({
              keep: Object.fromEntries(
                (data.titles ?? []).map((row) => [String(row[0]), 1]),
              ),
            }),
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

test("quitting while an HTTP index board is half read keeps its pages and reads, and fetches no index page again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nestor-search-restart-"));
  const file = join(dir, "jobs.sqlite");
  const target = `${base}/longboard/jobs`;
  const context = searchContext(target);
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  let quit: (() => void) | null = null;
  // Requests leave this process like the app's own; the quit happens while
  // page 4 of 6 is being fetched.
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (quit && url.includes("page=4")) {
        const stop = quit;
        quit = null;
        // Quit once pages 1 to 3 have produced some saved listing reads.
        void vi
          .waitFor(() => expect(store.stageCounts().found).toBeGreaterThan(5), {
            timeout: 30_000,
            interval: 5,
          })
          .then(stop);
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const interrupted = () => reject(new Error("Search interrupted"));
          if (signal?.aborted) interrupted();
          signal?.addEventListener("abort", interrupted, { once: true });
        });
      }
      return realFetch(input, init);
    });
  let store = openJobStore(file);
  const calls: { task: string; urls: string[] }[] = [];
  try {
    const first = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls)),
      readContext: () => Promise.resolve(context),
    });
    let stopped!: () => void;
    const quitting = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    quit = () => {
      first.suspend();
      stopped();
    };
    const started = await first.start({
      depth: "thorough",
      postedWithin: "any",
    });
    await quitting;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.searches.get(started.id)?.state).toBe("running");
    store.close();

    const indexFetches = (urls: string[]) =>
      urls.filter((url) => /\/longboard\/jobs(?:\?|$)/u.test(url));
    const before = {
      index: indexFetches(fetched),
      calls: calls.length,
    };
    expect(before.index.some((url) => url.includes("page=3"))).toBe(true);

    // The next process.
    store = openJobStore(file);
    const savedBefore = new Set(savedUrls(store));
    expect(savedBefore.size).toBeGreaterThan(5);
    fetched.length = 0;
    calls.length = 0;
    const second = createJobSearchRunner({
      store,
      engine: engineFor(scriptedModel(calls)),
      readContext: () => Promise.resolve(context),
    });
    await vi.waitFor(() =>
      expect(store.searches.get(started.id)?.state).toBe("running"),
    );
    await finished(second, store, started.id);
    expect(store.searches.get(started.id)?.state).toBe("done");

    const after = indexFetches(fetched);
    // Pages 1 to 3 were collected before the quit: none is fetched again.
    for (const url of before.index.filter((url) => !url.includes("page=4")))
      expect(after).not.toContain(url);
    expect(after.some((url) => url.includes("page=4"))).toBe(true);
    expect(after.some((url) => url.includes("page=6"))).toBe(true);
    // A listing whose read finished before the quit is not fetched or read
    // by the model again.
    for (const url of savedBefore) {
      expect(fetched).not.toContain(url);
      expect(calls.flatMap((call) => call.urls)).not.toContain(url);
    }
    // Every public posting is saved once.
    const jobs = savedUrls(store);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect(jobs).toHaveLength(60);
    expect(store.searches.get(started.id)).toMatchObject({ added: 60 });
    console.info(
      "[restart replica]",
      JSON.stringify({
        indexBefore: before.index.length,
        indexAfter: after.length,
        savedBeforeQuit: savedBefore.size,
        detailFetchesAfter: fetched.filter((url) =>
          url.includes("/longboard/job/"),
        ).length,
        modelCallsBefore: before.calls,
        modelCallsAfter: calls.length,
      }),
    );
    second.suspend();
  } finally {
    fetchSpy.mockRestore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

type Turn = { name: string; args: Record<string, unknown> };
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();
const headlessShell = existsSync(executablePath) ? executablePath : undefined;

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
    let current: Page | null = null;
    let quit: (() => void) | null = null;
    let run = 0;
    /** The scripted navigation model; each run follows its own turns. */
    const turnsFor = (n: number): Turn[] =>
      n === 1
        ? [
            { name: "navigate", args: { url: jobs(1) } },
            { name: "extract_jobs", args: { pageType: "search_results" } },
            { name: "navigate", args: { url: jobs(2) } },
            { name: "extract_jobs", args: { pageType: "search_results" } },
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
    const runtime = {
      readRenderedPage: async (url: string) => {
        const page = await browserContext!.newPage();
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
        runs.push(options);
        const turns = turnsFor(++run);
        const page = await browserContext!.newPage();
        current = page;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) loaded.push(`${run} ${frame.url()}`);
        });
        try {
          await page.goto(options.startingUrls[0]!);
          let turn = 0;
          const result = await runJobSearchAgent({
            page,
            hands: createApplyPageHands(
              createPlaywrightApplyPageMechanics(page),
            ),
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
                  prompts.push(
                    messages
                      .filter((message) => message.role === "user")
                      .map((message) => String(message.content))
                      .join("\n"),
                  );
                const action = turns[turn++];
                // The app quits after the first run's last checkpoint.
                if (!action) {
                  quit?.();
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
                      id: `run-${run}-${turn}`,
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
    browserContext = await browser.newContext();
    const calls: { task: string; urls: string[] }[] = [];
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
    });
    expect(loaded.filter((url) => url.startsWith("2 "))).not.toContain(
      `2 ${jobs(1)}`,
    );
    // From page 2 the agent walks the rest of the board itself: the restart
    // costs no model turn. (The model's resume prompt is checked in
    // job-search-agent.test.ts.)
    expect(prompts).toHaveLength(1);
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
