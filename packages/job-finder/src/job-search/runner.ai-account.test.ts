import {
  AI_ACCESS_MESSAGES,
  AI_SERVICE_PAUSED_MESSAGE,
  markAiKeyAsNestors,
  aiAccessBlocks,
  checkAiAccessAgain,
  createOpenAiCompatibleJobFinderAiClient,
  ModelRequestHttpError,
  resetAiAccessForTests,
  type AiAccessBlock,
  type AiAccessStatus,
} from "@nestor/ai-providers";
import { screenCards as screenListingCards } from "@nestor/browser-agent";
import {
  CandidateProfileSchema,
  JobDiscoveryTargetSchema,
  JobSearchPreferencesSchema,
  type FoundJob,
  type JobSearchStatus,
  type ListingCard,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterEach, expect, test, vi } from "vitest";

import type { AiAccessWatch } from "../internal/ai-access-watch";
import type { JobSearchEngine } from "./engine";
import { createJobSearchRunner } from "./runner";
import type { JobSearchContext, JobSearchRunner } from "./types";

// A scripted provider: no real service or account is ever called.
const TOP_UP =
  "https://model.example.test/console/account-test/billing?credits=1";
const OUT_OF_CREDIT = `Insufficient balance. Top up at ${TOP_UP}.`;

const stores: JobStore[] = [];
const runners: JobSearchRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
  for (const store of stores.splice(0)) store.close();
  resetAiAccessForTests();
  vi.unstubAllGlobals();
});

function card(sourceId: string, n: number): ListingCard {
  return {
    url: `https://${sourceId}.example/jobs/${n}`,
    title: `Backend Engineer ${n}`,
    text: `Backend Engineer ${n} at Real Employer`,
    cardFingerprint: `${sourceId}:${n}`,
    sourceId,
    sourceLabel: sourceId,
  };
}
function found(row: ListingCard): FoundJob {
  return {
    title: row.title,
    company: "Real Employer",
    location: "Remote, Worldwide",
    workModes: ["remote"],
    url: row.url,
    applyUrl: null,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    sourceJobId: row.url,
    postedAt: "2026-11-01T00:00:00Z",
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: "Full-time",
    summary: null,
    description:
      "Full published listing: build production APIs. Requirements: SQL and distributed systems.",
  };
}

function setup(aiAccess?: AiAccessWatch) {
  const store = openJobStore(":memory:");
  stores.push(store);
  const context: JobSearchContext = {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      firstName: "Robin",
      lastName: "Ashford",
      fullName: "Robin Ashford",
      headline: "Backend engineer",
      summary: null,
      currentLocation: "United States",
      yearsExperience: 8,
      baseResume: {
        id: "resume",
        fileName: "synthetic.txt",
        uploadedAt: "2026-11-01T00:00:00Z",
      },
    }),
    searchPreferences: JobSearchPreferencesSchema.parse({
      targetRoles: ["Backend Engineer"],
      locations: ["United States"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    }),
    sources: [
      JobDiscoveryTargetSchema.parse({
        id: "one",
        label: "one",
        startingUrl: "https://one.example/",
      }),
    ],
    sourceInstructionArtifacts: [],
  };
  const engine = {
    collectSource: vi.fn<JobSearchEngine["collectSource"]>(({ target }) =>
      Promise.resolve({
        cards: [1, 2, 3].map((n) => card(target.id, n)),
        pagesRead: 1,
        complete: true,
        notes: [],
      }),
    ),
    screenCards: vi.fn<JobSearchEngine["screenCards"]>(),
    readListings: vi.fn<JobSearchEngine["readListings"]>(({ cards }) =>
      Promise.resolve({ jobs: cards.map(found), failures: [] }),
    ),
    fitJobs: vi.fn<JobSearchEngine["fitJobs"]>(({ jobs }) =>
      Promise.resolve(
        jobs.map((job) => ({
          id: job.id,
          score: 82,
          summary: "Relevant API ownership.",
          reasons: ["Backend experience"],
          gaps: [],
        })),
      ),
    ),
  };
  const runner = createJobSearchRunner({
    store,
    engine,
    readContext: () => Promise.resolve(context),
    ...(aiAccess ? { aiAccess } : {}),
  });
  runners.push(runner);
  return { store, runner, engine };
}

function settledStatus(
  runner: JobSearchRunner,
  done: (status: JobSearchStatus) => boolean,
): Promise<JobSearchStatus> {
  if (done(runner.status())) return Promise.resolve(runner.status());
  return new Promise((resolve) => {
    const off = runner.onStatus((status) => {
      if (done(status)) {
        off();
        resolve(status);
      }
    });
  });
}

test("a search the AI account refuses stops taking cards at the first refusal, keeps its queue and the provider's reason, and continues by itself once calls go through", async () => {
  const { store, runner, engine } = setup();
  let funded = false;
  const request = vi.fn(() =>
    funded
      ? new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '{"keep":{"0":1,"1":1,"2":1}}' },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )
      : new Response(JSON.stringify({ error: { message: OUT_OF_CREDIT } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
  );
  vi.stubGlobal("fetch", request);
  const client = createOpenAiCompatibleJobFinderAiClient({
    baseUrl: "https://model.example.test/v1",
    apiKey: "scripted",
    model: "scripted",
  });
  engine.screenCards.mockImplementation((input) =>
    screenListingCards({
      client: { chatWithTools: client.chatWithTools.bind(client) },
      cards: input.cards,
      signal: input.signal,
      goals: {
        targetRoles: ["Backend Engineer"],
        relatedRoles: [],
        strategy: "wide_net",
      },
      ...(input.onRelated ? { onRelated: input.onRelated } : {}),
    }),
  );

  await runner.start({ postedWithin: "any" });
  const parked = await settledStatus(runner, (status) => !!status.parked);
  // One refused call, then nothing more is leased or read.
  expect(request).toHaveBeenCalledOnce();
  expect(parked.parked).toEqual({
    owner: "person",
    message: AI_ACCESS_MESSAGES.funding,
    providerMessage: OUT_OF_CREDIT,
  });
  // Never done or failed for the refusal, and every card still queued.
  expect(parked.search?.state).toBe("running");
  expect(parked.progress?.failed ?? 0).toBe(0);
  expect(parked.sources.every((source) => source.state !== "failed")).toBe(
    true,
  );
  const searchId = parked.search!.id;
  expect(
    store
      .sql("SELECT count(*) AS n FROM search_listing_queue WHERE search_id = ?")
      .get(searchId),
  ).toEqual({ n: 3 });
  expect(engine.readListings).not.toHaveBeenCalled();
  expect(aiAccessBlocks()).toEqual([
    expect.objectContaining({ reason: "funding", actionUrl: TOP_UP }),
  ]);

  // The person topped up: the waiting search is the check, and continues.
  funded = true;
  expect(checkAiAccessAgain()).toBe(true);
  const done = await settledStatus(
    runner,
    (status) => status.search?.state !== "running",
  );
  expect(done.search?.id).toBe(searchId);
  expect(done.search?.state).toBe("done");
  expect(done.parked ?? null).toBeNull();
  expect(store.listJobs({ stage: "found" }).rows).toHaveLength(3);
  expect(aiAccessBlocks()).toEqual([]);
});

test("Stop on a parked search ends it as stopped", async () => {
  const { runner, engine } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Response(JSON.stringify({ error: { message: OUT_OF_CREDIT } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  const client = createOpenAiCompatibleJobFinderAiClient({
    baseUrl: "https://model.example.test/v1",
    apiKey: "scripted-stop",
    model: "scripted",
  });
  engine.screenCards.mockImplementation((input) =>
    screenListingCards({
      client: { chatWithTools: client.chatWithTools.bind(client) },
      cards: input.cards,
      signal: input.signal,
      goals: {
        targetRoles: ["Backend Engineer"],
        relatedRoles: [],
        strategy: "wide_net",
      },
    }),
  );
  await runner.start({ postedWithin: "any" });
  await settledStatus(runner, (status) => !!status.parked);
  runner.stop();
  expect(runner.status().search?.state).toBe("stopped");
  expect(runner.status().parked ?? null).toBeNull();
});

/** The AI account as a scripted transport leaves it, driven by the test. */
function scriptedAccess() {
  let status: AiAccessStatus = "unknown";
  const changes = new Set<(status: AiAccessStatus) => void>();
  const refusals = new Set<(block: AiAccessBlock) => void>();
  const watch: AiAccessWatch = {
    status: () => status,
    onChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    onRefused: (listener) => {
      refusals.add(listener);
      return () => refusals.delete(listener);
    },
    onRecheck: () => () => undefined,
    letCallsThrough: vi.fn(),
  };
  return {
    watch,
    refuse() {
      status = "blocked";
      for (const listener of refusals)
        listener({
          id: "scripted",
          provider: "https://model.example.test",
          reason: "funding",
          owner: "person",
          message: AI_ACCESS_MESSAGES.funding,
          providerMessage: OUT_OF_CREDIT,
          actionUrl: TOP_UP,
          since: new Date().toISOString(),
        });
    },
    set(next: AiAccessStatus) {
      status = next;
      for (const listener of changes) listener(next);
    },
  };
}

test("fit the account refused keeps its jobs unscored, says why, and scores them once calls go through", async () => {
  const access = scriptedAccess();
  const { store, runner, engine } = setup(access.watch);
  store.saveFoundJobs({
    searchId: null,
    jobs: [1, 2].map((n) => found(card("one", n))),
  });
  engine.fitJobs.mockImplementationOnce(() => {
    access.refuse();
    return Promise.reject(
      new Error("Fit failed", {
        cause: new ModelRequestHttpError(OUT_OF_CREDIT, 402, null),
      }),
    );
  });
  await runner.scoreUnscored().catch(() => undefined);
  expect(store.unscoredJobIds(10)).toHaveLength(2);
  expect(runner.status().fitError).toBe(AI_ACCESS_MESSAGES.funding);

  access.set("available");
  await vi.waitFor(() => expect(store.unscoredJobIds(10)).toHaveLength(0), {
    timeout: 5_000,
  });
  expect(engine.fitJobs).toHaveBeenCalledTimes(2);
});

test("with Nestor's bundled key the parked search says Nestor's AI is paused and shows no account words", async () => {
  markAiKeyAsNestors("nestor-bundled");
  const { runner, engine } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Response(JSON.stringify({ error: { message: OUT_OF_CREDIT } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  const client = createOpenAiCompatibleJobFinderAiClient({
    baseUrl: "https://model.example.test/v1",
    apiKey: "nestor-bundled",
    model: "scripted",
  });
  engine.screenCards.mockImplementation((input) =>
    screenListingCards({
      client: { chatWithTools: client.chatWithTools.bind(client) },
      cards: input.cards,
      signal: input.signal,
      goals: {
        targetRoles: ["Backend Engineer"],
        relatedRoles: [],
        strategy: "wide_net",
      },
    }),
  );
  await runner.start({ postedWithin: "any" });
  const parked = await settledStatus(runner, (status) => !!status.parked);
  expect(parked.parked).toEqual({
    owner: "nestor",
    message: AI_SERVICE_PAUSED_MESSAGE,
    providerMessage: null,
  });
  expect(parked.search?.state).toBe("running");
});
