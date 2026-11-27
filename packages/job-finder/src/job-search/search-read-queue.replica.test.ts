import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import {
  CandidateProfileSchema,
  JobDiscoveryTargetSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createListingSearchEngine, type JobSearchEngine } from "./engine";
import { createJobSearchRunner } from "./runner";
import type { JobSearchContext } from "./types";

/**
 * A big replica board whose detail pages answer slowly, with a scripted
 * model: screening of later waves goes on while earlier waves' detail reads
 * are still in flight, every related posting is fetched and read once, and a
 * posting page's links to sibling postings are not fetched.
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
          mkdtempSync(join(tmpdir(), "nestor-read-queue-replica-")),
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
const context = (target: string): JobSearchContext => ({
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
      label: "Broadfield Jobs",
      startingUrl: target,
    }),
  ],
  sourceInstructionArtifacts: [],
});

/** Keeps engineering titles, rejects kitchen ones, reads each page's own facts. */
function scriptedModel(log: {
  screened: Set<string>;
  read: string[];
  screenCalls: number;
}) {
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
          log.screenCalls++;
          const titles = (data.titles ?? []).map((row) => String(row[1]));
          for (const title of titles) log.screened.add(title);
          return Promise.resolve({
            content: JSON.stringify({
              keep: Object.fromEntries(
                titles.map((title, index) => [
                  String(index),
                  /engineer|developer/u.test(title) ? 1 : 0,
                ]),
              ),
            }),
          });
        }
        if (task === "page_read") {
          log.read.push(...(data.listings ?? []).map((row) => row.url));
          return Promise.resolve({
            content: JSON.stringify({
              jobs: (data.listings ?? []).map(({ id, title }) => ({
                id,
                title,
                company: "Broadfield Employer",
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

test("a big board keeps screening later waves while earlier detail reads drain, reads each related posting once, and fetches no sibling posting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nestor-read-queue-"));
  const traceDir = join(dir, "trace");
  const previousTrace = process.env.NESTOR_RUN_TRACE_DIR;
  process.env.NESTOR_RUN_TRACE_DIR = traceDir;
  const target = `${base}/broadfield/jobs`;
  const detail = /\/broadfield\/job\/(\d+)$/u;
  const log = {
    screened: new Set<string>(),
    read: [] as string[],
    screenCalls: 0,
  };
  const fetched: string[] = [];
  // Every detail page answers slowly, as a rate-limited site does; index
  // pages answer at once.
  let detailsDone = 0;
  const realFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (!detail.test(url)) return realFetch(input, init);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const response = await realFetch(input, init);
      detailsDone++;
      return response;
    });
  const store = openJobStore(join(dir, "jobs.sqlite"));
  const engine = createListingSearchEngine({
    aiClient: scriptedModel(log),
    browserRuntime: {},
  });
  // Each wave's size and how many detail reads had finished when it began.
  const waves: { size: number; detailsDoneAtStart: number }[] = [];
  const scriptedEngine: JobSearchEngine = {
    ...engine,
    screenCards: (request) => {
      waves.push({
        size: request.cards.length,
        detailsDoneAtStart: detailsDone,
      });
      return engine.screenCards(request);
    },
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
  try {
    const runner = createJobSearchRunner({
      store,
      engine: scriptedEngine,
      readContext: () => Promise.resolve(context(target)),
    });
    const started = await runner.start({
      depth: "thorough",
      postedWithin: "any",
    });
    await vi.waitFor(
      () => {
        expect(store.searches.get(started.id)?.state).not.toBe("running");
        expect(runner.status().fitRunning).toBe(false);
      },
      { timeout: 60_000, interval: 50 },
    );
    expect(store.searches.get(started.id)?.state).toBe("done");

    // More than one wave, and each later wave began screening while the
    // earlier waves' related postings (half their cards) were still being
    // read. A wave that waited for those reads would begin after all of them.
    expect(waves.length).toBeGreaterThan(1);
    expect(waves.reduce((sum, wave) => sum + wave.size, 0)).toBe(600);
    let earlierRelated = 0;
    for (const [index, wave] of waves.entries()) {
      if (index > 0)
        expect(wave.detailsDoneAtStart).toBeLessThan(earlierRelated);
      earlierRelated += wave.size / 2;
    }

    const related = Array.from(
      { length: 300 },
      (_, index) => `${base}/broadfield/job/${index * 2 + 1}`,
    );
    const details = fetched.filter((url) => detail.test(url));
    // Each related posting fetched and read once; no rejected or sibling one.
    expect([...details].sort()).toEqual([...related].sort());
    expect([...log.read].sort()).toEqual([...related].sort());
    expect(
      fetched.filter((url) => /\/broadfield\/(?:archived|apply)\//u.test(url)),
    ).toEqual([]);
    const jobs: string[] = [];
    for (let cursor: string | null = null; ; ) {
      const page = store.listJobs({ stage: "found", limit: 200, cursor });
      jobs.push(...page.rows.map((row) => store.getJob(row.id)!.url));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect([...jobs].sort()).toEqual([...related].sort());

    // A posting's fetch is recorded under that posting, never under the
    // listing whose finished fetch freed the site's slot.
    const events = readdirSync(traceDir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(traceDir, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    const starts = events.filter(
      (event) =>
        event.event === "search_page_started" && detail.test(String(event.url)),
    );
    expect(starts).toHaveLength(300);
    expect(starts.filter((event) => event.listingUrl !== event.url)).toEqual(
      [],
    );
    console.info(
      "[read queue replica]",
      JSON.stringify({
        waves,
        screenCalls: log.screenCalls,
        detailFetches: details.length,
        pageReads: log.read.length,
      }),
    );
    runner.suspend();
  } finally {
    fetchSpy.mockRestore();
    if (previousTrace === undefined) delete process.env.NESTOR_RUN_TRACE_DIR;
    else process.env.NESTOR_RUN_TRACE_DIR = previousTrace;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("quitting while related reads drain behind finished screening loses none and reads none twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nestor-read-queue-restart-"));
  const file = join(dir, "jobs.sqlite");
  const target = `${base}/broadfield/jobs`;
  const detail = /\/broadfield\/job\/(\d+)$/u;
  const related = Array.from(
    { length: 300 },
    (_, index) => `${base}/broadfield/job/${index * 2 + 1}`,
  );
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (!detail.test(url)) return realFetch(input, init);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return realFetch(input, init);
    });
  const engineFor = (log: Parameters<typeof scriptedModel>[0]) => {
    const engine = createListingSearchEngine({
      aiClient: scriptedModel(log),
      browserRuntime: {},
    });
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
    } satisfies JobSearchEngine;
  };
  const savedUrls = (store: ReturnType<typeof openJobStore>) => {
    const urls: string[] = [];
    for (let cursor: string | null = null; ; ) {
      const page = store.listJobs({ stage: "found", limit: 200, cursor });
      urls.push(...page.rows.map((row) => store.getJob(row.id)!.url));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return urls;
  };
  let store = openJobStore(file);
  try {
    const firstLog = { screened: new Set<string>(), read: [], screenCalls: 0 };
    const first = createJobSearchRunner({
      store,
      engine: engineFor(firstLog),
      readContext: () => Promise.resolve(context(target)),
    });
    const started = await first.start({
      depth: "thorough",
      postedWithin: "any",
    });
    // Quit once every card was screened and some reads were kept, with the
    // rest of the related reads still queued.
    await vi.waitFor(
      () => {
        expect(firstLog.screened.size).toBe(600);
        expect(store.stageCounts().found).toBeGreaterThan(40);
      },
      { timeout: 60_000, interval: 5 },
    );
    first.suspend();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.searches.get(started.id)?.state).toBe("running");
    const savedBefore = new Set(savedUrls(store));
    expect(savedBefore.size).toBeLessThan(300);
    store.close();

    // The next process.
    store = openJobStore(file);
    fetched.length = 0;
    const secondLog = {
      screened: new Set<string>(),
      read: [] as string[],
      screenCalls: 0,
    };
    const second = createJobSearchRunner({
      store,
      engine: engineFor(secondLog),
      readContext: () => Promise.resolve(context(target)),
    });
    await vi.waitFor(
      () => {
        expect(store.searches.get(started.id)?.state).toBe("done");
        expect(second.status().fitRunning).toBe(false);
      },
      { timeout: 60_000, interval: 50 },
    );
    // Reads kept before the quit are not fetched or read again; every other
    // related posting is fetched and read once in the next process.
    const rest = related.filter((url) => !savedBefore.has(url));
    const details = fetched.filter((url) => detail.test(url));
    expect([...details].sort()).toEqual([...rest].sort());
    expect([...secondLog.read].sort()).toEqual([...rest].sort());
    const jobs = savedUrls(store);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect([...jobs].sort()).toEqual([...related].sort());
    console.info(
      "[read queue restart replica]",
      JSON.stringify({
        savedBeforeQuit: savedBefore.size,
        detailFetchesAfter: details.length,
        pageReadsAfter: secondLog.read.length,
        screenCallsAfter: secondLog.screenCalls,
      }),
    );
    second.suspend();
  } finally {
    fetchSpy.mockRestore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
