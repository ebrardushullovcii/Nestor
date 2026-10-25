import {
  createDeterministicJobFinderAiClient,
  type JudgeJobFitsInput,
  type JobFitJudgmentResult,
} from "@nestor/ai-providers";
import type { AgentDiscoveryOptions } from "@nestor/browser-runtime";
import {
  CandidateProfileSchema,
  DiscoveryRunResultSchema,
  JobDiscoveryTargetSchema,
  JobPostingSchema,
  JobSearchPreferencesSchema,
  SourceDebugPhaseEvidenceSchema,
  type BrowserAgentRunCheckpoint,
  type JobPosting,
  type JobSearchStatus,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCurrentSearchEngine } from "./engine";
import { createJobSearchRunner } from "./runner";
import { toFoundJob } from "./postings";
import type { JobSearchContext, JobSearchRunner } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const now = "2026-10-25T12:00:00.000Z";
function posting(n: number, overrides: Partial<JobPosting> = {}): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: String(n),
    canonicalUrl: `https://jobs.example.test/jobs/${n}`,
    title: `Engineer ${n}`,
    company: "Example",
    location: "Budapest, Hungary",
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    discoveredAt: now,
    salaryText: "EUR 60,000 per year",
    normalizedCompensation: {
      currency: "EUR",
      minAmount: 60000,
      maxAmount: 80000,
      interval: "year",
    },
    description: `Job ${n}: build and maintain TypeScript tools. `.repeat(20),
    keySkills: ["TypeScript"],
    responsibilities: ["Build tools"],
    ...overrides,
  });
}
function checkpoint(jobs: JobPosting[]): BrowserAgentRunCheckpoint {
  return {
    revision: 1,
    savedAt: now,
    currentUrl: "https://jobs.example.test",
    lastStableUrl: "https://jobs.example.test",
    stepCount: 1,
    collectedJobs: jobs,
    visitedUrls: [],
    phaseEvidence: SourceDebugPhaseEvidenceSchema.parse({}),
  };
}
function result(jobs: JobPosting[] = []) {
  return DiscoveryRunResultSchema.parse({
    source: "target_site",
    startedAt: now,
    completedAt: now,
    querySummary: "Search",
    warning: null,
    jobs,
  });
}
function judgments(input: JudgeJobFitsInput): JobFitJudgmentResult[] {
  return input.jobs.map(({ jobId }) => ({
    jobId,
    score: 82,
    recommendation: "apply_with_original",
    role: "exact",
    roleExplanation: "Relevant work",
    preferences: "aligned",
    preferencesExplanation: "Matches your goals",
    locationReach: "in_area",
    reasons: ["TypeScript experience"],
    gaps: ["Check the team"],
    summary: "Your TypeScript experience fits this work.",
    listingClosed: false,
    listingClosedEvidence: null,
  }));
}
function context(): JobSearchContext {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      firstName: "Test",
      lastName: "Person",
      fullName: "Test Person",
      headline: "Engineer",
      summary: "Builds tools",
      currentLocation: "Budapest",
      yearsExperience: 4,
      baseResume: {
        id: "synthetic-resume",
        fileName: "synthetic.txt",
        uploadedAt: now,
      },
    }),
    searchPreferences: JobSearchPreferencesSchema.parse({
      targetRoles: ["Engineer"],
      locations: ["Budapest"],
      workModes: ["remote"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    }),
    sources: [
      JobDiscoveryTargetSchema.parse({
        id: "one",
        label: "First site",
        startingUrl: "https://jobs.example.test",
      }),
    ],
    sourceInstructionArtifacts: [],
  };
}

const stores: JobStore[] = [];
const runners: JobSearchRunner[] = [];
function setup() {
  const store = openJobStore(":memory:");
  stores.push(store);
  const ctx = context();
  const runAgentDiscovery = vi.fn<
    NonNullable<
      Parameters<
        typeof createCurrentSearchEngine
      >[0]["browserRuntime"]["runAgentDiscovery"]
    >
  >(() => Promise.resolve(result()));
  const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(judgments(input)),
  );
  const openBrowserSession = vi.fn(() => Promise.resolve());
  const readContext = vi.fn(() => Promise.resolve(ctx));
  const runner = createJobSearchRunner({
    store,
    engine: createCurrentSearchEngine({
      browserRuntime: { runAgentDiscovery },
      aiClient: { ...createDeterministicJobFinderAiClient(), judgeJobFits },
      openBrowserSession,
    }),
    readContext,
  });
  runners.push(runner);
  return {
    store,
    ctx,
    runner,
    runAgentDiscovery,
    judgeJobFits,
    openBrowserSession,
    readContext,
  };
}
function finished(runner: JobSearchRunner): Promise<JobSearchStatus> {
  if (runner.status().search?.state !== "running")
    return Promise.resolve(runner.status());
  return new Promise((resolve) => {
    const off = runner.onStatus((status) => {
      if (status.search?.state !== "running") {
        off();
        resolve(status);
      }
    });
  });
}
afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("background job search", () => {
  it("saves checkpoints and shows batch fit scores before the source finishes", async () => {
    const { runner, store, runAgentDiscovery, judgeJobFits } = setup();
    const release = deferred<void>();
    const saved = deferred<void>();
    const scored = deferred<void>();
    const jobs = Array.from({ length: 41 }, (_, i) => posting(i + 1));
    const getJob = vi.spyOn(store, "getJob");
    const save = vi.spyOn(store, "saveFoundJobs");
    const off = store.onChange((change) => {
      if (change.cause === "fit" && store.unscoredJobIds(100).length === 1)
        scored.resolve();
    });
    runAgentDiscovery.mockImplementation(async (_source, options) => {
      await options.onCheckpoint?.(checkpoint(jobs));
      await options.onCheckpoint?.(checkpoint(jobs));
      saved.resolve();
      await release.promise;
      return result(jobs);
    });
    const started = await runner.start({});
    await saved.promise;
    await scored.promise;
    expect(runner.status().search).toMatchObject({
      id: started.id,
      state: "running",
      added: 41,
      scored: 40,
    });
    expect(store.listJobs({ stage: "found" }).rows[0]?.fitSummary).toBe(
      "Your TypeScript experience fits this work.",
    );
    expect(judgeJobFits.mock.calls.map(([input]) => input.jobs.length)).toEqual(
      [20, 20],
    );
    expect(save).toHaveBeenCalledTimes(1);
    release.resolve();
    expect((await finished(runner)).search).toMatchObject({
      state: "done",
      found: 41,
      added: 41,
      merged: 0,
      scored: 41,
    });
    expect(getJob).toHaveBeenCalledTimes(41);
    expect(judgeJobFits.mock.calls[0]?.[0].jobs[0]?.posting.description).toBe(
      jobs[0]?.description,
    );
    off();
  });

  it("a repeat search adds only new jobs, keeps hidden jobs hidden and does not re-score merges", async () => {
    const { runner, store, runAgentDiscovery, judgeJobFits } = setup();
    runAgentDiscovery.mockResolvedValue(result([posting(1), posting(2)]));
    await runner.start({});
    await finished(runner);
    const id = store.listJobs({ stage: "found" }).rows[0]!.id;
    store.moveJobs({ selection: { ids: [id] }, to: "hidden" });
    runAgentDiscovery.mockResolvedValue(
      result([posting(1), posting(2), posting(3)]),
    );
    await runner.start({});
    expect((await finished(runner)).search).toMatchObject({
      state: "done",
      added: 1,
      merged: 2,
      scored: 1,
    });
    expect(store.getJob(id)?.stage).toBe("hidden");
    expect(store.stageCounts()).toMatchObject({ found: 2, hidden: 1 });
    expect(judgeJobFits.mock.calls.map(([input]) => input.jobs.length)).toEqual(
      [2, 1],
    );
  });

  it("Stop aborts browser and fit, keeps saved jobs and ignores late callbacks", async () => {
    const { runner, store, runAgentDiscovery, judgeJobFits } = setup();
    const browser = deferred<ReturnType<typeof result>>();
    const ai = deferred<JobFitJudgmentResult[]>();
    const judging = deferred<JudgeJobFitsInput>();
    let options!: AgentDiscoveryOptions;
    runAgentDiscovery.mockImplementation(async (_source, input) => {
      options = input;
      await input.onCheckpoint?.(
        checkpoint(Array.from({ length: 20 }, (_, i) => posting(i))),
      );
      return browser.promise;
    });
    judgeJobFits.mockImplementation((input) => {
      judging.resolve(input);
      return ai.promise;
    });
    await runner.start({});
    const input = await judging.promise;
    runner.stop();
    expect(runner.status().search).toMatchObject({
      state: "stopped",
      added: 20,
      scored: 0,
    });
    expect(options.signal?.aborted).toBe(true);
    expect(input.signal?.aborted).toBe(true);
    await options.onCheckpoint?.(checkpoint([posting(99)]));
    ai.resolve(judgments(input));
    browser.resolve(result([posting(99)]));
    await Promise.resolve();
    expect(store.stageCounts().found).toBe(20);
    expect(store.unscoredJobIds(100)).toHaveLength(20);
  });

  it("continues past a failed source and reports a sign-in requirement while other sources run", async () => {
    const { runner, ctx, runAgentDiscovery, openBrowserSession } = setup();
    ctx.sources = ["bad", "signin", "good"].map((id) =>
      JobDiscoveryTargetSchema.parse({
        id,
        label: id,
        startingUrl: `https://${id}.example.test`,
      }),
    );
    const blocked = deferred<void>();
    const release = deferred<void>();
    runAgentDiscovery.mockImplementation(async (_source, options) => {
      if (options.siteLabel === "bad") throw new Error("Site unavailable");
      if (options.siteLabel === "signin")
        return {
          ...result(),
          agentMetadata: {
            ...DiscoveryRunResultSchema.parse({
              ...result(),
              agentMetadata: {},
            }).agentMetadata!,
            accessBlockerReason: "auth_required",
          },
        };
      blocked.resolve();
      await release.promise;
      return result([posting(1)]);
    });
    await runner.start({});
    await blocked.promise;
    const sawSignIn = deferred<void>();
    const off = runner.onStatus((status) => {
      if (status.sources.some((source) => source.state === "needs_you"))
        sawSignIn.resolve();
    });
    await sawSignIn.promise;
    expect(runner.status().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "signin",
          state: "needs_you",
          message: "Sign in to search this site.",
        }),
        expect.objectContaining({ sourceId: "bad", state: "failed" }),
      ]),
    );
    release.resolve();
    expect((await finished(runner)).search).toMatchObject({
      state: "done",
      sourcesDone: 3,
      added: 1,
    });
    expect(openBrowserSession).toHaveBeenCalledTimes(1);
    off();
  });

  it("filters rejected, excluded and old listings, preserving unknown dates and listing facts", async () => {
    const { runner, ctx, store, runAgentDiscovery } = setup();
    ctx.searchPreferences.companyBlacklist = ["Blocked Company"];
    ctx.searchPreferences.excludedLocations = ["Vienna"];
    runAgentDiscovery.mockResolvedValue(
      result([
        posting(1, { company: "Blocked Company Ltd" }),
        posting(2, { location: "Vienna, Austria" }),
        posting(3, { postedAt: "2001-01-01T00:00:00.000Z" }),
        posting(4, {
          searchRejection: { category: "role", reason: "Different work" },
        }),
        posting(5, { postedAt: null, department: "Product" }),
      ]),
    );
    await runner.start({
      postedWithin: "week",
      picky: "strict",
      depth: "thorough",
      note: "TypeScript tools",
    });
    expect((await finished(runner)).search).toMatchObject({ added: 1 });
    const row = store.listJobs({ stage: "found" }).rows[0]!;
    expect(store.getJob(row.id)).toMatchObject({
      postedAt: null,
      salary: { min: 60000, max: 80000, currency: "EUR" },
      facts: { department: "Product", keySkills: ["TypeScript"] },
    });
    expect(runAgentDiscovery.mock.calls[0]?.[1]).toMatchObject({
      dedicatedPage: true,
      retainAllFound: true,
      searchRequest: { intent: "TypeScript tools", freshness: "recent" },
      searchGuidance: { selectivity: "best_matches" },
      maxSteps: 240,
    });
  });

  it("coalesces simultaneous starts, selects enabled sites and recovers unscored jobs in batches", async () => {
    const { runner, ctx, runAgentDiscovery, readContext, judgeJobFits, store } =
      setup();
    ctx.sources = [
      ...ctx.sources,
      JobDiscoveryTargetSchema.parse({
        id: "disabled",
        label: "Disabled",
        startingUrl: "https://disabled.example.test",
        enabled: false,
      }),
      JobDiscoveryTargetSchema.parse({
        id: "other",
        label: "Other",
        startingUrl: "https://other.example.test",
      }),
    ];
    const jobs = Array.from({ length: 45 }, (_, i) => posting(i));
    runAgentDiscovery.mockResolvedValue(result(jobs));
    judgeJobFits.mockRejectedValue(
      new Error("Provider temporarily unavailable"),
    );
    const [first, second] = await Promise.all([
      runner.start({ sourceIds: ["one", "disabled"] }),
      runner.start({}),
    ]);
    expect(first.id).toBe(second.id);
    expect(readContext).toHaveBeenCalledTimes(1);
    expect((await finished(runner)).search).toMatchObject({
      state: "done",
      sourcesTotal: 1,
      added: 45,
      scored: 0,
      error: "Provider temporarily unavailable",
    });
    expect(runAgentDiscovery).toHaveBeenCalledTimes(1);
    judgeJobFits.mockImplementation((input) =>
      Promise.resolve(judgments(input)),
    );
    judgeJobFits.mockClear();
    const recovery = runner.scoreUnscored();
    expect(runner.scoreUnscored()).toBe(recovery);
    expect(await recovery).toBe(45);
    expect(judgeJobFits.mock.calls.map(([input]) => input.jobs.length)).toEqual(
      [20, 20, 5],
    );
    expect(store.unscoredJobIds(100)).toEqual([]);
    expect(await runner.scoreUnscored()).toBe(0);
  });

  it("uses one fit queue when recovery overlaps the beginning of a repeat search", async () => {
    const { runner, store, ctx, runAgentDiscovery, judgeJobFits } = setup();
    const jobs = Array.from({ length: 25 }, (_, i) => posting(i));
    store.saveFoundJobs({
      searchId: null,
      jobs: jobs.map((job) => toFoundJob(job, ctx.sources[0]!)),
    });
    runAgentDiscovery.mockResolvedValue(result(jobs));
    await runner.start({});
    expect(await runner.scoreUnscored()).toBe(25);
    expect((await finished(runner)).search).toMatchObject({
      added: 0,
      merged: 25,
      scored: 25,
    });
    expect(
      judgeJobFits.mock.calls.flatMap(([input]) =>
        input.jobs.map((job) => job.jobId),
      ),
    ).toHaveLength(25);
  });

  it("pools short pages across sites and keeps browser searches within the tab cap", async () => {
    const { runner, ctx, runAgentDiscovery, judgeJobFits } = setup();
    ctx.sources = Array.from({ length: 6 }, (_, index) =>
      JobDiscoveryTargetSchema.parse({
        id: String(index),
        label: String(index),
        startingUrl: `https://site${index}.example.test`,
      }),
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    let inFlight = 0;
    let most = 0;
    runAgentDiscovery.mockImplementation(async (_source, options) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const jobs = Array.from({ length: 5 }, (_, index) =>
        posting(Number(options.siteLabel) * 5 + index),
      );
      await options.onCheckpoint?.(checkpoint(jobs));
      if (inFlight === 2) entered.resolve();
      await release.promise;
      inFlight--;
      return result(jobs);
    });
    await runner.start({});
    await entered.promise;
    expect(runAgentDiscovery).toHaveBeenCalledTimes(2);
    expect(judgeJobFits).not.toHaveBeenCalled();
    release.resolve();
    expect((await finished(runner)).search).toMatchObject({
      added: 30,
      scored: 30,
      sourcesDone: 6,
    });
    expect(most).toBe(2);
    expect(judgeJobFits.mock.calls.map(([input]) => input.jobs.length)).toEqual(
      [20, 10],
    );
  });

  it("reads public feeds cheaply and uses catalog review for the person's intent", async () => {
    const { runner, ctx, runAgentDiscovery } = setup();
    ctx.sources = [
      JobDiscoveryTargetSchema.parse({
        id: "feed",
        label: "Example feed",
        startingUrl: "https://jobs.ashbyhq.com/synthetic",
      }),
    ];
    const fetchFeed = vi.fn(() =>
      Promise.resolve(
        Response.json({
          jobs: [
            {
              id: "one",
              title: "TypeScript Engineer",
              jobUrl: "https://jobs.ashbyhq.com/synthetic/one",
              location: "Budapest",
              descriptionPlain: "Build TypeScript tools.",
              isRemote: true,
            },
            {
              id: "two",
              title: "Designer",
              jobUrl: "https://jobs.ashbyhq.com/synthetic/two",
              location: "Budapest",
              descriptionPlain: "Design tools.",
              isRemote: true,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchFeed);
    await runner.start({ postedWithin: "any", picky: "open" });
    expect((await finished(runner)).search).toMatchObject({
      state: "done",
      added: 2,
    });
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    expect(runAgentDiscovery).not.toHaveBeenCalled();
    runAgentDiscovery.mockImplementation((_source, options) => {
      expect(options.sourceCatalog).toHaveLength(2);
      expect(options).toMatchObject({
        sourceCatalogComplete: true,
        searchRequest: { intent: "Only TypeScript work" },
      });
      return Promise.resolve(result([options.sourceCatalog![0]!]));
    });
    await runner.start({ postedWithin: "any", note: "Only TypeScript work" });
    expect((await finished(runner)).search).toMatchObject({
      state: "done",
      added: 0,
      merged: 1,
    });
    expect(runAgentDiscovery).toHaveBeenCalledTimes(1);
  });
});
