import type { FoundJob, ListingCard } from "@nestor/contracts";
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openJobStore, type JobStore } from "./job-store";

const url = "https://board.example/jobs/interface-engineer-101";
const job: FoundJob = {
  title: "Interface Engineer",
  company: "Own Employer",
  location: "Remote, Worldwide",
  workModes: ["remote"],
  url,
  applyUrl: url,
  sourceId: "board",
  sourceLabel: "Board",
  sourceJobId: "101",
  description: "Own employer's complete responsibilities and requirements.",
  facts: { fullListingRead: true },
  postedAt: null,
  salaryText: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  seniority: null,
  employmentType: null,
  summary: null,
};
const card: ListingCard = {
  url,
  title: job.title,
  text: "Interface Engineer\nOwn Employer\nRemote, Worldwide\n1 day ago",
  cardFingerprint: "title",
  sourceId: "board",
  sourceLabel: "Board",
  companyHint: job.company,
  locationHint: job.location,
};
function saveRead(store: JobStore, current: ListingCard, read: FoundJob): void {
  store.saveFoundJobs({
    searchId: "again",
    jobs: [
      {
        ...read,
        listingCardEvidence: {
          url: current.url,
          sourceId: current.sourceId,
          fingerprint: current.evidenceFingerprint!,
        },
      },
    ],
  });
}

test("a repaired legacy binding survives reopening the store", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "nestor-card-evidence-"));
  const file = path.join(folder, "jobs.sqlite");
  let store = openJobStore(file);
  try {
    const external = {
      ...job,
      applyUrl: "https://employer.example/application/101",
    };
    store.saveFoundJobs({ searchId: "old", jobs: [external] });
    const first = store.prepareListingCards([card]);
    expect(first.refreshUrls).toEqual([url]);
    saveRead(store, first.cards[0]!, external);
    store.close();
    store = openJobStore(file);
    expect(store.prepareListingCards([card]).refreshUrls).toEqual([]);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an unchanged complete saved posting gets a cheap baseline; an age badge is not changed content", () => {
  const store = openJobStore(":memory:");
  try {
    store.saveFoundJobs({ searchId: "old", jobs: [job] });
    expect(store.prepareListingCards([card]).refreshUrls).toEqual([]);
    expect(
      store.prepareListingCards([
        { ...card, text: card.text.replace("1 day ago", "2 days ago") },
      ]).refreshUrls,
    ).toEqual([]);
    expect(
      store.prepareListingCards([
        { ...card, text: `${card.text}\nNew responsibilities` },
      ]).refreshUrls,
    ).toEqual([url]);
  } finally {
    store.close();
  }
});

test.each([
  {
    description: "Different employer's duties",
    location: "Wrong country",
    applyUrl: "https://board.example/blog/applying",
  },
  { applyUrl: "https://external.example/forms/101" },
  { description: "" },
  { applyUrl: null },
])("legacy suspect evidence gets one repair read: %j", (wrong) => {
  const store = openJobStore(":memory:");
  try {
    const stale = { ...job, ...wrong };
    const [id] = store.saveFoundJobs({ searchId: "old", jobs: [stale] }).added;
    const prepared = store.prepareListingCards([card]);
    expect(prepared.refreshUrls).toEqual([url]);
    // The model may legitimately confirm an external application URL, or no link.
    const repaired = {
      ...job,
      applyUrl:
        wrong.applyUrl === "https://external.example/forms/101" ||
        wrong.applyUrl === null
          ? wrong.applyUrl
          : job.applyUrl,
    };
    saveRead(store, prepared.cards[0]!, repaired);
    expect(store.getJob(id!)?.description).toBe(job.description);
    expect(store.prepareListingCards([card]).refreshUrls).toEqual([]);
  } finally {
    store.close();
  }
});

test("changed card evidence rereads once; fit changes only when the resulting listing facts changed", () => {
  const store = openJobStore(":memory:");
  try {
    const [id] = store.saveFoundJobs({ searchId: "old", jobs: [job] }).added;
    store.prepareListingCards([card]);
    store.setFit([
      { id: id!, score: 82, summary: "Same duties", reasons: [], gaps: [] },
    ]);
    const changed = { ...card, text: `${card.text}\nNew visible card text` };
    const prepared = store.prepareListingCards([changed]);
    expect(prepared.refreshUrls).toEqual([url]);
    saveRead(store, prepared.cards[0]!, job);
    expect(store.getJob(id!)).toMatchObject({ fitScore: 82, fitStale: false });
    expect(store.prepareListingCards([changed]).refreshUrls).toEqual([]);
    store.db
      .prepare("UPDATE job_details SET description=? WHERE job_id=?")
      .run("Crossed later by an old writer", id!);
    expect(store.prepareListingCards([changed]).refreshUrls).toEqual([url]);
    saveRead(store, prepared.cards[0]!, {
      ...job,
      description: "New actual listing responsibilities",
    });
    expect(store.getJob(id!)?.fitStale).toBe(true);
    expect(store.prepareListingCards([changed]).refreshUrls).toEqual([]);
  } finally {
    store.close();
  }
});
