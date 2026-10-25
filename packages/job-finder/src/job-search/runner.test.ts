import {
  CandidateProfileSchema,
  jobSiteTarget,
  JobDiscoveryTargetSchema,
  JobSearchPreferencesSchema,
  type FoundJob,
  type ListingCard,
  type JobSearchStatus,
} from "@nestor/contracts";
import {
  createJobSitesStore,
  createSearchSourcesStore,
  createSourceAccessStore,
  type JobStore,
  openJobStore,
} from "@nestor/db/job-store";
import { afterEach, expect, test, vi } from "vitest";
import type { JobSearchEngine } from "./engine";
import { createJobSearchRunner } from "./runner";
import type { JobSearchContext, JobSearchRunner } from "./types";

const stores: JobStore[] = [];
const runners: JobSearchRunner[] = [];
const now = "2026-10-25T08:00:00Z";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function card(sourceId: string, title = "Backend Engineer"): ListingCard {
  return {
    url: `https://${sourceId}.example/jobs/${title === "Nurse" ? "nurse" : "one"}`,
    title,
    text: `${title} at Real Employer`,
    cardFingerprint: `${sourceId}:${title}`,
    sourceId,
    sourceLabel: sourceId,
  };
}
function found(card: ListingCard): FoundJob {
  return {
    title: card.title,
    company: "Real Employer",
    location: "Remote, Worldwide",
    workModes: ["remote"],
    url: card.url,
    applyUrl: null,
    sourceId: card.sourceId,
    sourceLabel: card.sourceLabel,
    sourceJobId: "one",
    postedAt: "2026-08-01T00:00:00Z",
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
function setup() {
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
      baseResume: { id: "resume", fileName: "synthetic.txt", uploadedAt: now },
    }),
    searchPreferences: JobSearchPreferencesSchema.parse({
      targetRoles: ["Backend Engineer"],
      locations: ["United States"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    }),
    sources: ["one", "two"].map((id) =>
      JobDiscoveryTargetSchema.parse({
        id,
        label: id,
        startingUrl: `https://${id}.example/`,
      }),
    ),
    sourceInstructionArtifacts: [],
  };
  const collectSource = vi.fn<JobSearchEngine["collectSource"]>(({ target }) =>
    Promise.resolve({
      cards: [card(target.id), card(target.id, "Nurse")],
      pagesRead: 1,
      complete: true,
      notes: ["All observed pages covered."],
    }),
  );
  const screenCards = vi.fn<JobSearchEngine["screenCards"]>((input) => {
    const saved = new Set(input.knownUrls(input.cards.map((card) => card.url)));
    const seen = new Set(
      input.seenCards(input.cards, "roles").map((card) => card.cardFingerprint),
    );
    const fresh = input.cards.filter(
      (card) => !saved.has(card.url) && !seen.has(card.cardFingerprint),
    );
    return Promise.resolve({
      related: fresh.filter((card) => card.title !== "Nurse"),
      seen: fresh
        .filter((card) => card.title === "Nurse")
        .map((card) => ({
          url: card.url,
          cardFingerprint: card.cardFingerprint,
          roleGoalsKey: "roles",
          verdict: "unrelated",
        })),
      skipped: input.cards.length - fresh.length,
    });
  });
  const readListings = vi.fn<JobSearchEngine["readListings"]>(({ cards }) =>
    Promise.resolve({ jobs: cards.map(found), failures: [] }),
  );
  const fitJobs = vi.fn<JobSearchEngine["fitJobs"]>(({ jobs }) =>
    Promise.resolve(
      jobs.map((job) => ({
        id: job.id,
        score: 82,
        summary: "Relevant API ownership.",
        reasons: ["Backend experience"],
        gaps: [],
      })),
    ),
  );
  const engine = { collectSource, screenCards, readListings, fitJobs };
  const runner = createJobSearchRunner({
    store,
    engine,
    readContext: () => Promise.resolve(context),
  });
  runners.push(runner);
  return { store, context, runner, engine };
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
});

test("a background search merges all sightings before fitting; repeat reads and fits no saved jobs", async () => {
  const { runner, engine, store } = setup();
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(store.listJobs({ stage: "found" }).rows).toHaveLength(1);
  expect(engine.fitJobs).toHaveBeenCalledTimes(1);
  const judged = engine.fitJobs.mock.calls[0]![0].jobs[0]!;
  expect(judged.sightings).toHaveLength(2);
  expect(judged.description).toContain(
    "Requirements: SQL and distributed systems.",
  );
  expect(store.getJob(judged.id)?.fitScore).toBe(82);
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(engine.readListings.mock.calls[1]![0].cards).toEqual([]);
  expect(engine.fitJobs).toHaveBeenCalledTimes(1);
  expect(
    createSearchSourcesStore(store)
      .list({})
      .rows.every((source) => source.seen === 2),
  ).toBe(true);
});

test("a retention choice saves older related jobs hidden, with full text, fit and an undoable reason", async () => {
  const { runner, store } = setup();
  await runner.start({ postedWithin: "week" });
  await finished(runner);
  const row = store.listJobs({ stage: "hidden" }).rows[0]!;
  const detail = store.getJob(row.id)!;
  expect(detail.stageNote).toContain("Posted more than 7 days ago");
  expect(detail.description).toContain("Requirements: SQL");
  expect(detail.fitScore).toBe(82);
  store.moveJobs({ selection: { ids: [row.id] }, to: "found" });
  expect(store.getJob(row.id)?.stage).toBe("found");
});

test("stop ends the search promptly and ignores a source that completes afterwards", async () => {
  const { runner, engine, store } = setup();
  const pending =
    deferred<Awaited<ReturnType<JobSearchEngine["collectSource"]>>>();
  engine.collectSource.mockImplementation(() => pending.promise);
  const record = await runner.start({ postedWithin: "any" });
  expect(record.state).toBe("running");
  runner.stop();
  expect(runner.status().search?.state).toBe("stopped");
  pending.resolve({
    cards: [card("one")],
    complete: true,
    pagesRead: 1,
    notes: [],
  });
  await Promise.resolve();
  expect(store.stageCounts().found).toBe(0);
  expect(engine.fitJobs).not.toHaveBeenCalled();
});

test("recovery shares the live fit queue rather than judging a job twice", async () => {
  const { runner, engine, store } = setup();
  const started = deferred<void>(),
    fit = deferred<Awaited<ReturnType<JobSearchEngine["fitJobs"]>>>();
  engine.fitJobs.mockImplementation(() => {
    started.resolve();
    return fit.promise;
  });
  await runner.start({ postedWithin: "any" });
  await started.promise;
  const recovery = runner.scoreUnscored();
  const id = store.listJobs({ stage: "found" }).rows[0]!.id;
  fit.resolve([{ id, score: 82, summary: "Relevant", reasons: [], gaps: [] }]);
  await recovery;
  await finished(runner);
  expect(engine.fitJobs).toHaveBeenCalledTimes(1);
});

test("HTTP jobs stream while a browser site is waiting; retry rechecks only its site and keeps one access ticket", async () => {
  const { runner, engine, store, context } = setup();
  const sites = createJobSitesStore(store),
    access = createSourceAccessStore(store);
  sites.add({
    text: "https://locked.example/jobs\nhttps://readable.example/jobs",
  });
  context.sources = sites.enabled().map(jobSiteTarget);
  const held =
    deferred<Awaited<ReturnType<JobSearchEngine["collectSource"]>>>();
  let unlocked = false;
  engine.collectSource.mockImplementation(async ({ target, lane }) => {
    if (target.id === "1" && !unlocked)
      return lane === "http"
        ? {
            cards: [],
            pagesRead: 1,
            complete: false,
            requiresBrowser: true,
            notes: [],
          }
        : {
            cards: [],
            pagesRead: 1,
            complete: false,
            needsYou: true,
            notes: ["Sign in."],
          };
    if (target.id === "2" && lane === "browser") return held.promise;
    if (target.id === "2")
      return {
        cards: [card("2")],
        pagesRead: 1,
        complete: false,
        requiresBrowser: true,
        notes: [],
      };
    return {
      cards: [card(target.id)],
      pagesRead: 1,
      complete: true,
      notes: [],
    };
  });
  await runner.start({ postedWithin: "any" });
  await vi.waitFor(() => expect(store.stageCounts().found).toBe(1), {
    timeout: 10000,
  });
  await runner.scoreUnscored();
  expect(runner.status().search?.state).toBe("running");
  expect(store.listJobs({ stage: "found" }).rows[0]?.fitScore).toBe(82);
  expect(access.pending(1)).toBe(true);
  const before = engine.collectSource.mock.calls.filter(
    ([input]) => input.target.id === "2",
  ).length;
  unlocked = true;
  sites.update({ id: 1, enabled: false });
  await runner.retrySource(1);
  await vi.waitFor(() => expect(access.pending(1)).toBe(false), {
    timeout: 10000,
  });
  expect(
    engine.collectSource.mock.calls.filter(
      ([input]) => input.target.id === "2",
    ),
  ).toHaveLength(before);
  expect(sites.get(1)?.enabled).toBe(false);
  held.resolve({ cards: [], pagesRead: 1, complete: true, notes: [] });
  await finished(runner);
  expect(runner.status().search?.sourcesTotal).toBe(2);
  expect(runner.status().search?.sourcesDone).toBe(2);
  expect(store.sql("SELECT count(*) AS n FROM needs_you").get()).toMatchObject({
    n: 1,
  });
});

test("900 sites have compact progress and paged results; a repeat does not reread or refit saved jobs", async () => {
  const { runner, store, engine, context } = setup();
  const sites = createJobSitesStore(store);
  sites.add({
    text: Array.from(
      { length: 900 },
      (_, i) => `https://boards.example/site-${i}/`,
    ).join("\n"),
  });
  context.sources = sites.enabled().map(jobSiteTarget);
  let largest = 0;
  const off = runner.onStatus((status) => {
    largest = Math.max(largest, status.sources.length);
  });
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(runner.status().search).toMatchObject({
    sourcesTotal: 900,
    sourcesDone: 900,
  });
  expect(largest).toBeLessThanOrEqual(3);
  expect(createSearchSourcesStore(store).list({ limit: 25 })).toMatchObject({
    total: 900,
  });
  expect(createSearchSourcesStore(store).list({ limit: 25 }).rows).toHaveLength(
    25,
  );
  const before = engine.fitJobs.mock.calls.length;
  engine.readListings.mockClear();
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  off();
  expect(engine.fitJobs).toHaveBeenCalledTimes(before);
  expect(
    engine.readListings.mock.calls.every(([input]) => input.cards.length === 0),
  ).toBe(true);
});

test("a closed related vacancy is saved hidden with its full text and no fit spend; a known card can retire an open Found row", async () => {
  const { runner, engine, store } = setup();
  engine.readListings.mockImplementation(({ cards }) =>
    Promise.resolve({
      jobs: cards.map((card) => ({
        ...found(card),
        hiddenReason:
          "Closed: this vacancy is no longer accepting applications.",
      })),
      failures: [],
    }),
  );
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(store.stageCounts().found).toBe(0);
  expect(store.stageCounts().hidden).toBe(1);
  expect(engine.fitJobs).not.toHaveBeenCalled();
  const hidden = store.listJobs({ stage: "hidden" }).rows[0]!;
  expect(store.getJob(hidden.id)?.description).toContain(
    "Full published listing",
  );
  store.moveJobs({ selection: { ids: [hidden.id] }, to: "found" });
  engine.collectSource.mockImplementation(({ target }) =>
    Promise.resolve({
      cards: [{ ...card(target.id), closed: true }],
      complete: true,
      pagesRead: 1,
      notes: [],
    }),
  );
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(store.getJob(hidden.id)?.stage).toBe("hidden");
  expect(store.getJob(hidden.id)?.stageNote).toMatch(/^Closed:/);
});

test.each(["incomplete", "browser error", "listing error"])(
  "%s without an access wall never creates a sign-in ticket",
  async (kind) => {
    const { runner, engine, store, context } = setup(),
      sites = createJobSitesStore(store);
    sites.add({ text: "https://readable.example/source" });
    context.sources = sites.enabled().map(jobSiteTarget);
    engine.collectSource.mockImplementation(({ target, lane }) => {
      if (kind === "listing error")
        return Promise.resolve({
          cards: [card(target.id)],
          pagesRead: 1,
          complete: true,
          notes: [],
        });
      if (lane === "http")
        return Promise.resolve({
          cards: [],
          pagesRead: 1,
          complete: false,
          requiresBrowser: true,
          notes: [],
        });
      if (kind === "browser error")
        return Promise.reject(new Error("The page could not be read"));
      return Promise.resolve({
        cards: [],
        pagesRead: 1,
        complete: false,
        notes: ["No listings found."],
      });
    });
    if (kind === "listing error")
      engine.readListings.mockImplementation(({ cards, lane }) =>
        lane === "browser"
          ? Promise.reject(new Error("The listing could not be read"))
          : Promise.resolve({
              jobs: [],
              failures: cards.map((card) => ({
                url: card.url,
                reason: "Needs rendering",
                requiresBrowser: true,
              })),
            }),
      );
    await runner.start({ postedWithin: "any" });
    await finished(runner);
    expect(createSourceAccessStore(store).pending(1)).toBe(false);
    expect(
      (store.sql("SELECT count(*) AS n FROM needs_you").get() as { n: number })
        .n,
    ).toBe(0);
    expect(sites.get(1)?.health).not.toBe("needs_sign_in");
    expect(sites.get(1)?.signInState).not.toBe("required");
  },
);

test("a site's screening failure stays visible without stopping successful sites or marking failed cards seen", async () => {
  const { runner, engine, store } = setup();
  engine.screenCards.mockImplementation(({ cards }) =>
    Promise.resolve({
      related: cards.filter(
        (row) => row.sourceId === "one" && row.title !== "Nurse",
      ),
      seen: [],
      skipped: 0,
      failed: cards
        .filter((row) => row.sourceId === "two")
        .map((row) => ({ url: row.url, reason: "Incomplete screen response" })),
    }),
  );
  await runner.start({ postedWithin: "any" });
  const status = await finished(runner);
  expect(status.search?.state).toBe("done");
  expect(store.listJobs({ stage: "found" }).total).toBe(1);
  const failed = createSearchSourcesStore(store)
    .list({})
    .rows.find((row) => row.sourceId === "two");
  expect(failed?.state).toBe("failed");
  expect(failed?.seen).toBe(0);
  expect(failed?.failedReads).toBe(2);
});

test("a proven access block becomes one source ticket if browser reading also fails", async () => {
  const { runner, engine, store, context } = setup();
  const sites = createJobSitesStore(store);
  sites.add({ text: "https://blocked.example/jobs" });
  context.sources = sites.enabled().map(jobSiteTarget);
  engine.collectSource.mockImplementation(({ lane }) =>
    lane === "http"
      ? Promise.resolve({
          cards: [],
          pagesRead: 1,
          complete: false,
          requiresBrowser: true,
          accessBlocked: true,
          notes: ["HTTP 403"],
        })
      : Promise.reject(Error("Browser access blocked")),
  );
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(createSourceAccessStore(store).pending(1)).toBe(true);
  expect(
    (store.sql("SELECT count(*) AS n FROM needs_you").get() as { n: number }).n,
  ).toBe(1);
  expect(createSearchSourcesStore(store).list({}).rows[0]?.state).toBe(
    "needs_you",
  );
});
