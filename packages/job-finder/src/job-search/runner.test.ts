import {
  CandidateProfileSchema,
  JobSearchSettingsSchema,
  jobSiteTarget,
  JobDiscoveryTargetSchema,
  JobSearchPreferencesSchema,
  type FoundJob,
  type ListingCard,
  type JobSearchStatus,
  type JobFitUpdate,
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
import { createFitQueue } from "./fit-queue";
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
function setup(readRemoteCountsAsAnyLocation?: () => boolean) {
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
    ...(readRemoteCountsAsAnyLocation ? { readRemoteCountsAsAnyLocation } : {}),
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

test.each([false, true])(
  "source retry keeps its ticket until detail reads finish (blocked=%s)",
  async (blocked) => {
    const { runner, engine, store, context } = setup();
    const sites = createJobSitesStore(store),
      access = createSourceAccessStore(store);
    sites.add({ text: "https://locked.example/jobs" });
    context.sources = sites.enabled().map(jobSiteTarget);
    access.request(1, "Sign in");
    const pending =
      deferred<Awaited<ReturnType<JobSearchEngine["readListings"]>>>();
    engine.collectSource.mockResolvedValue({
      cards: [card("1")],
      pagesRead: 1,
      complete: true,
      notes: [],
    });
    engine.readListings.mockImplementation(() => pending.promise);
    await runner.retrySource(1);
    await vi.waitFor(() => expect(engine.readListings).toHaveBeenCalled());
    expect(access.pending(1)).toBe(true);
    pending.resolve(
      blocked
        ? {
            jobs: [],
            failures: [
              {
                url: card("1").url,
                reason: "Verification required",
                needsYou: true,
              },
            ],
          }
        : { jobs: [found(card("1"))], failures: [] },
    );
    await finished(runner);
    expect(access.pending(1)).toBe(blocked);
  },
);
afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
  for (const store of stores.splice(0)) store.close();
});

test("a remote-policy change during a model call cannot save an old score; retry judges with the new policy", async () => {
  let remoteCountsAsAnyLocation = true;
  const { runner, engine, store } = setup(() => remoteCountsAsAnyLocation);
  const first = deferred<JobFitUpdate[]>();
  engine.fitJobs.mockImplementationOnce(({ context }) => {
    expect(context.remoteCountsAsAnyLocation).toBe(true);
    return first.promise;
  });
  await runner.start({ postedWithin: "any" });
  await vi.waitFor(() => expect(engine.fitJobs).toHaveBeenCalledTimes(1));
  const id = engine.fitJobs.mock.calls[0]![0].jobs[0]!.id;
  remoteCountsAsAnyLocation = false;
  first.resolve([
    { id, score: 92, summary: "Old policy", reasons: [], gaps: [] },
  ]);
  await finished(runner);
  expect(store.getJob(id)?.fitScore).toBeNull();
  expect(runner.status().search?.error).toBeNull();
  engine.fitJobs.mockImplementation(({ jobs, context }) => {
    expect(context.remoteCountsAsAnyLocation).toBe(false);
    return Promise.resolve(
      jobs.map(({ id }) => ({
        id,
        score: 45,
        summary: "New policy",
        reasons: [],
        gaps: [],
      })),
    );
  });
  expect(await runner.scoreUnscored()).toBe(1);
  expect(store.getJob(id)?.fitScore).toBe(45);
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
  expect(runner.status().search?.alreadySaved).toBe(0);
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(engine.readListings.mock.calls[1]![0].cards).toEqual([]);
  expect(engine.fitJobs).toHaveBeenCalledTimes(1);
  expect(
    createSearchSourcesStore(store)
      .list({})
      .rows.every((source) => source.seen === 2),
  ).toBe(true);
  expect(runner.status().search?.alreadySaved).toBe(1);
});

test("a retention choice keeps full older listings without fit spend; Any can score them later", async () => {
  const { runner, store, engine } = setup();
  await runner.start({ postedWithin: "week" });
  await finished(runner);
  const row = store.listJobs({ stage: "hidden" }).rows[0]!;
  const detail = store.getJob(row.id)!;
  expect(detail.stageNote).toContain("Posted more than 7 days ago");
  expect(detail.description).toContain("Requirements: SQL");
  expect(detail.fitScore).toBeNull();
  expect(engine.fitJobs).not.toHaveBeenCalled();
  expect(runner.status().search?.scored).toBe(0);
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(store.getJob(row.id)?.stage).toBe("found");
  expect(store.getJob(row.id)?.stageNote).toBeNull();
  expect(store.getJob(row.id)?.fitScore).toBe(82);
});

test.each(["week", "month"] as const)(
  "%s skips only excluded older hidden listings, never an unknown posting date",
  async (postedWithin) => {
    const { runner, store, engine } = setup();
    engine.readListings.mockImplementation(({ cards }) =>
      Promise.resolve({
        jobs: cards.map((entry) => ({
          ...found(entry),
          company: `Synthetic employer ${entry.sourceId}`,
          postedAt: entry.sourceId === "one" ? "2026-08-01T00:00:00Z" : null,
        })),
        failures: [],
      }),
    );
    await runner.start({ postedWithin });
    await finished(runner);
    const judged = engine.fitJobs.mock.calls.flatMap(([input]) => input.jobs);
    expect(judged).toHaveLength(1);
    expect(judged[0]?.postedAt).toBeNull();
    expect(store.stageCounts()).toMatchObject({ found: 1, hidden: 1 });
    expect(runner.status().search?.scored).toBe(1);
    const hidden = store.listJobs({ stage: "hidden" }).rows[0]!;
    expect(store.getJob(hidden.id)?.description).toContain("Requirements: SQL");
  },
);

test("Month still scores a three-week-old listing that Week excludes", async () => {
  const { runner, engine } = setup();
  engine.readListings.mockImplementation(({ cards }) =>
    Promise.resolve({
      jobs: cards.map((entry) => ({
        ...found(entry),
        company: `Synthetic employer ${entry.sourceId}`,
        postedAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
      })),
      failures: [],
    }),
  );
  await runner.start({ postedWithin: "month" });
  await finished(runner);
  expect(
    engine.fitJobs.mock.calls.flatMap(([input]) => input.jobs),
  ).toHaveLength(2);
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

test("an entirely unreadable source set finishes as failed with its per-site reasons", async () => {
  const { runner, engine, store } = setup();
  engine.collectSource.mockRejectedValue(Error("The source could not be read"));
  await runner.start({});
  const status = await finished(runner);
  expect(status.search?.state).toBe("failed");
  expect(status.search?.added).toBe(0);
  expect(status.search?.error).toContain("2 sites could not be read");
  expect(status.progress?.failed).toBe(2);
  expect(
    createSearchSourcesStore(store).list({ state: "failed" }).rows,
  ).toHaveLength(2);
});

test.each(["mixed", "sign-in only", "one failed", "one readable"])(
  "%s sources distinguish an unreadable search from a successfully read empty board",
  async (kind) => {
    const { runner, engine, store, context } = setup();
    const sites = createJobSitesStore(store);
    sites.add({ text: "https://failed.example/\nhttps://sign-in.example/" });
    context.sources = sites
      .enabled()
      .map(jobSiteTarget)
      .slice(0, kind === "one failed" ? 1 : 2);
    engine.collectSource.mockImplementation(({ target }) => {
      if (kind === "one readable" && target.id === "2")
        return Promise.resolve({
          cards: [],
          pagesRead: 1,
          complete: true,
          notes: ["No open jobs"],
        });
      if (kind === "sign-in only" || target.id === "2")
        return Promise.resolve({
          cards: [],
          pagesRead: 1,
          complete: false,
          needsYou: true,
          notes: ["Sign in to view jobs"],
        });
      return Promise.reject(Error("The site could not be reached"));
    });
    await runner.start({});
    const status = await finished(runner);
    expect(status.search?.state).toBe(
      kind === "one readable" ? "done" : "failed",
    );
    if (kind === "one failed")
      expect(status.search?.error).toContain("1 site could not be read.");
    if (kind === "mixed") {
      expect(status.search?.error).toContain("2 sites could not be read.");
      expect(status.search?.error).toContain(
        "1 site needs sign-in in Needs you.",
      );
      expect(status.progress).toMatchObject({ failed: 1, needsYou: 1 });
    }
    if (kind === "sign-in only")
      expect(status.progress).toMatchObject({ failed: 0, needsYou: 2 });
  },
);

test("a source timeout explains retry without creating a sign-in ticket", async () => {
  const { runner, engine, store } = setup();
  engine.collectSource.mockRejectedValue(
    Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    }),
  );
  await runner.start({});
  const status = await finished(runner);
  expect(status.search?.state).toBe("failed");
  expect(status.progress).toMatchObject({ failed: 2, needsYou: 0 });
  for (const row of createSearchSourcesStore(store).list({}).rows)
    expect(row.message).toContain("Open it to check it loads, then retry");
  expect(store.sql("SELECT count(*) AS n FROM source_needs_you").get()?.n).toBe(
    0,
  );
});

function numberedCards(
  sourceId: string,
  count: number,
  title = "Nurse",
  offset = 0,
) {
  return Array.from({ length: count }, (_, index) => ({
    ...card(sourceId, title),
    url: `https://${sourceId}.example/jobs/${offset + index}`,
    cardFingerprint: `${sourceId}:${title}:${offset + index}`,
  }));
}

test.each(["pages", "one large inventory"])(
  "Quick stops an unrelated board after screening 100 cards: %s",
  async (kind) => {
    const { runner, engine, context, store } = setup();
    context.sources = context.sources.slice(0, 1);
    let pages = 0;
    engine.collectSource.mockImplementation(
      async ({ target, signal, onCards }) => {
        if (kind === "one large inventory")
          return {
            cards: numberedCards(target.id, 1274),
            complete: true,
            pagesRead: 1,
            notes: [],
          };
        const cards: ListingCard[] = [];
        for (let page = 0; page < 51; page++) {
          signal.throwIfAborted();
          pages++;
          const next = numberedCards(target.id, 25, "Nurse", page * 25);
          cards.push(...next);
          await onCards?.(next);
        }
        return { cards, complete: true, pagesRead: pages, notes: [] };
      },
    );
    await runner.start({ depth: "quick" });
    const status = await finished(runner);
    expect(status.search).toMatchObject({
      state: "done",
      sourcesDone: 1,
      found: 0,
    });
    expect(engine.collectSource).toHaveBeenCalledTimes(1);
    expect(
      engine.screenCards.mock.calls.flatMap(([input]) => input.cards),
    ).toHaveLength(100);
    const source = createSearchSourcesStore(store).list({}).rows[0]!;
    expect(source).toMatchObject({
      state: "stopped",
      cards: 100,
      unrelated: 100,
    });
    expect(source.message).toContain("100 consecutive unrelated");
    expect(source.message).toContain("Coverage is partial");
    expect(engine.fitJobs).not.toHaveBeenCalled();
    if (kind === "pages") expect(pages).toBe(4);
  },
);

test("related work resets the unrelated run; Quick does not stop a mixed board early", async () => {
  const { runner, engine, context, store } = setup();
  context.sources = context.sources.slice(0, 1);
  engine.collectSource.mockImplementation(({ target }) =>
    Promise.resolve({
      cards: [
        ...numberedCards(target.id, 99),
        ...numberedCards(target.id, 1, "Backend Engineer", 99),
        ...numberedCards(target.id, 99, "Nurse", 100),
        ...numberedCards(target.id, 1, "Backend Engineer", 199),
        ...numberedCards(target.id, 50, "Nurse", 200),
      ],
      complete: true,
      pagesRead: 5,
      notes: [],
    }),
  );
  await runner.start({ depth: "quick", postedWithin: "any" });
  await finished(runner);
  expect(createSearchSourcesStore(store).list({}).rows[0]).toMatchObject({
    state: "done",
    cards: 250,
    related: 2,
    unrelated: 248,
  });
  expect(engine.fitJobs).toHaveBeenCalled();
});

test("Thorough can reach a related listing after 1274 unrelated cards", async () => {
  const { runner, engine, context, store } = setup();
  context.sources = context.sources.slice(0, 1);
  engine.collectSource.mockImplementation(({ target }) =>
    Promise.resolve({
      cards: [
        ...numberedCards(target.id, 1274),
        ...numberedCards(target.id, 1, "Backend Engineer", 1274),
      ],
      complete: true,
      pagesRead: 51,
      notes: [],
    }),
  );
  await runner.start({ depth: "thorough", postedWithin: "any" });
  await finished(runner);
  expect(createSearchSourcesStore(store).list({}).rows[0]).toMatchObject({
    state: "done",
    cards: 1275,
    related: 1,
    unrelated: 1274,
  });
  expect(engine.fitJobs).toHaveBeenCalled();
});

test("Quick reports its card cap as partial even on a productive board", async () => {
  const { runner, engine, context, store } = setup();
  context.sources = context.sources.slice(0, 1);
  engine.collectSource.mockImplementation(({ target }) =>
    Promise.resolve({
      cards: numberedCards(target.id, 400, "Backend Engineer"),
      complete: true,
      pagesRead: 1,
      notes: [],
    }),
  );
  await runner.start({ depth: "quick", postedWithin: "any" });
  await finished(runner);
  expect(createSearchSourcesStore(store).list({}).rows[0]).toMatchObject({
    state: "stopped",
    cards: 300,
    related: 300,
  });
  expect(createSearchSourcesStore(store).list({}).rows[0]?.message).toContain(
    "300-listing limit",
  );
});

test("Quick bounds HTTP collection without cancelling an accepted listing read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { runner, engine, context, store } = setup();
    context.sources = context.sources.slice(0, 1);
    let collectionSignal: AbortSignal | undefined;
    let readSignal: AbortSignal | undefined;
    const pending =
      deferred<Awaited<ReturnType<JobSearchEngine["readListings"]>>>();
    engine.readListings.mockImplementation(({ signal }) => {
      readSignal = signal;
      return pending.promise;
    });
    engine.collectSource.mockImplementation(
      async ({ target, onCards, signal }) => {
        collectionSignal = signal;
        await onCards?.([card(target.id)]);
        return new Promise(() => {});
      },
    );
    await runner.start({ depth: "quick", postedWithin: "any" });
    await vi.advanceTimersByTimeAsync(180001);
    expect(collectionSignal?.aborted).toBe(true);
    expect(readSignal?.aborted).toBe(false);
    expect(engine.collectSource).toHaveBeenCalledTimes(1);
    pending.resolve({
      jobs: [found(card(context.sources[0]!.id))],
      failures: [],
    });
    await vi.runAllTimersAsync();
    expect(runner.status().search).toMatchObject({ state: "done", scored: 1 });
    expect(createSearchSourcesStore(store).list({}).rows[0]?.message).toContain(
      "three-minute collection limit",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("material profile changes refresh found jobs on a repeat with no new jobs; phone edits reuse fit", async () => {
  const { runner, context, engine, store } = setup();
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  const before = store.listJobs({ stage: "found" }).rows[0]!;
  const fingerprint = store.getJob(before.id)?.fit?.inputFingerprint;
  expect(fingerprint).toBeTruthy();
  context.profile.phone = "+49 555 1234";
  await runner.scoreUnscored();
  expect(engine.fitJobs).toHaveBeenCalledTimes(1);
  context.profile.workEligibility.authorizedWorkCountries = ["Germany"];
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(runner.status().search?.added).toBe(0);
  expect(engine.fitJobs).toHaveBeenCalledTimes(2);
  expect(store.getJob(before.id)?.fit?.inputFingerprint).not.toBe(fingerprint);
});

test("rapid eligibility edits fence superseded results and preserve the old score", async () => {
  const { runner, context, engine, store } = setup();
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  const row = store.listJobs({ stage: "found" }).rows[0]!;
  const pending = deferred<JobFitUpdate[]>();
  engine.fitJobs.mockImplementationOnce(() => pending.promise);
  context.profile.workEligibility.authorizedWorkCountries = ["Germany"];
  const run = runner.scoreUnscored();
  await vi.waitFor(() => expect(engine.fitJobs).toHaveBeenCalledTimes(2));
  expect(runner.status().fitRechecking).toBe(1);
  expect(store.getJob(row.id)?.fitScore).toBe(82);
  context.profile.workEligibility.authorizedWorkCountries = ["Canada"];
  pending.resolve([
    { id: row.id, score: 99, summary: "Superseded", reasons: [], gaps: [] },
  ]);
  await run;
  expect(store.getJob(row.id)?.fitScore).toBe(82);
  expect(store.getJob(row.id)?.fitStale).toBe(true);
  await runner.scoreUnscored();
  expect(engine.fitJobs).toHaveBeenCalledTimes(3);
  expect(store.getJob(row.id)?.fitStale).toBe(false);
});

test("a bounded pass prioritizes visible jobs and leaves later work persisted", async () => {
  const { runner, context, engine, store } = setup();
  context.sources = [];
  const ids = store.saveFoundJobs({
    searchId: "seed",
    jobs: Array.from({ length: 120 }, (_, n) => ({
      ...found(card("seed")),
      title: `Backend Engineer ${n}`,
      sourceJobId: String(n),
      url: `https://seed.example/${n}`,
      description: "Complete listing requirements. ".repeat(500),
    })),
  }).added;
  runner.prioritizeFit([ids.at(-1)!]);
  await runner.scoreUnscored();
  expect(engine.fitJobs.mock.calls[0]?.[0].jobs[0]?.id).toBe(ids.at(-1));
  const scored = engine.fitJobs.mock.calls.flatMap(
    ([input]) => input.jobs,
  ).length;
  expect(scored).toBeGreaterThan(0);
  expect(scored).toBeLessThan(ids.length);
  expect(store.unscoredJobIds(200)).toHaveLength(ids.length - scored);
});

test("quick-stopped validated cards record successful access, while later auth evidence wins", async () => {
  const { runner, engine, store, context } = setup();
  const sites = createJobSitesStore(store);
  sites.add({ text: "https://partial.example/source" });
  context.sources = sites.enabled().map(jobSiteTarget);
  engine.collectSource.mockImplementation(async ({ target, onCards }) => {
    await onCards?.(numberedCards(target.id, 400, "Backend Engineer"));
    return { cards: [], complete: false, pagesRead: 1, notes: [] };
  });
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(sites.get(1)).toMatchObject({ health: "healthy", lane: "http" });
  expect(sites.get(1)?.lastSearchedAt).toBeTruthy();
  expect(createSearchSourcesStore(store).list({}).rows[0]?.message).toContain(
    "partial",
  );
  engine.collectSource.mockImplementation(() =>
    Promise.resolve({
      cards: [],
      complete: false,
      needsYou: true,
      pagesRead: 1,
      notes: [],
    }),
  );
  await runner.start({ postedWithin: "any" });
  await finished(runner);
  expect(sites.get(1)?.health).toBe("needs_sign_in");
});

test.each([false, true])(
  "quick-stop health does not close an access ticket before detail reads (blocked=%s)",
  async (blocked) => {
    const { runner, engine, store, context } = setup();
    const sites = createJobSitesStore(store);
    const access = createSourceAccessStore(store);
    sites.add({ text: "https://partial.example/source" });
    context.sources = sites.enabled().map(jobSiteTarget);
    access.request(1, "Sign in");
    const gate = deferred<void>();
    let reads = 0;
    engine.collectSource.mockImplementation(async ({ target, onCards }) => {
      const cards = numberedCards(target.id, 400, "Backend Engineer");
      await onCards?.(cards.slice(0, 1));
      await onCards?.(cards.slice(1));
      return { cards: [], complete: false, pagesRead: 1, notes: [] };
    });
    engine.readListings.mockImplementation(async ({ cards }) => {
      const first = reads++ === 0;
      if (!first) await gate.promise;
      return blocked && !first
        ? {
            jobs: [],
            failures: cards.map(({ url }) => ({
              url,
              reason: "Verification required",
              needsYou: true,
            })),
          }
        : { jobs: cards.map(found), failures: [] };
    });
    await runner.retrySource(1);
    await vi.waitFor(() => expect(sites.get(1)?.health).toBe("healthy"));
    expect(access.pending(1)).toBe(true);
    gate.resolve(undefined);
    await finished(runner);
    expect(access.pending(1)).toBe(blocked);
    expect(sites.get(1)?.health).toBe(blocked ? "needs_sign_in" : "healthy");
  },
);

test("reported token usage stops the pass before another estimated batch starts", async () => {
  const { context, engine, store } = setup();
  const ids = store.saveFoundJobs({
    searchId: "seed",
    jobs: Array.from({ length: 120 }, (_, n) => ({
      ...found(card("seed")),
      title: `Backend Engineer ${n}`,
      sourceJobId: String(n),
      url: `https://seed.example/usage-${n}`,
      description: "Complete listing.",
    })),
  }).added;
  engine.fitJobs.mockImplementation(({ jobs, onUsage }) => {
    onUsage?.({
      inputTokens: 49_000,
      outputTokens: 500,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    return Promise.resolve(
      jobs.map(({ id }) => ({
        id,
        score: 80,
        summary: "Fit",
        reasons: [],
        gaps: [],
      })),
    );
  });
  const controller = new AbortController();
  const queue = createFitQueue(
    { store, engine, readContext: () => Promise.resolve(context) },
    context,
    controller.signal,
    1,
    () => {},
    () => {},
    JobSearchSettingsSchema.parse({ postedWithin: "any" }),
  );
  queue.enqueue(ids);
  await queue.drain();
  expect(engine.fitJobs).toHaveBeenCalledTimes(1);
  expect(queue.scored).toBe(48);
  expect(queue.needsAnotherPass).toBe(true);
  expect(store.unscoredJobIds(200)).toHaveLength(72);
  controller.abort();
});
