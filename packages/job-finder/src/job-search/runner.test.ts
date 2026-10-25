import {
  CandidateProfileSchema,
  JobDiscoveryTargetSchema,
  JobSearchPreferencesSchema,
  type FoundJob,
  type ListingCard,
  type JobSearchStatus,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
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
    runner
      .status()
      .sources.every((source) => source.message?.includes("already seen")),
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
