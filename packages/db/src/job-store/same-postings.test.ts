import type { FoundJob } from "@nestor/contracts";
import { afterEach, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import { employerApplyTarget } from "./found-jobs";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "./job-store";

function posting(overrides: Partial<FoundJob>): FoundJob {
  return {
    title: "Staff Software Engineer",
    company: "ZenRows",
    location: "Remote",
    workModes: ["remote"],
    url: "https://remotive.test/remote/jobs/staff-software-engineer-1",
    applyUrl: null,
    sourceId: "remotive",
    sourceLabel: "Remotive",
    sourceJobId: null,
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: "Build the scraping platform.",
    ...overrides,
  };
}

// The three boards that listed one ZenRows posting in the owner's search,
// each naming its place differently.
const remotive = posting({
  company: "Zenrows",
  location: "EMEA",
  applyUrl: "https://job-boards.greenhouse.test/zenrows/jobs/5028295101",
});
const builtIn = posting({
  location: "26 Locations",
  url: "https://builtin.test/job/staff-software-engineer/12096536",
  applyUrl:
    "https://builtin.test/auth/login?destination=/job/staff-software-engineer/12096536",
  sourceId: "builtin",
  sourceLabel: "Built In",
});
const himalayas = posting({
  location: "Europe (EMEA)",
  url: "https://himalayas.test/companies/zenrows/jobs/staff-software-engineer",
  sourceId: "himalayas",
  sourceLabel: "Himalayas",
  facts: { fullListingRead: true },
});
// One TeamSystem posting: a LinkedIn card and the employer's own page.
const linkedIn = posting({
  title: "DevOps Lead",
  company: "TeamSystem",
  location: "Tirana, Tirana, Albania",
  url: "https://al.linkedin.test/jobs/view/devops-lead-at-teamsystem-4480452664",
  sourceId: "linkedin",
  sourceLabel: "LinkedIn",
});
const workday = posting({
  title: "DevOps Lead",
  company: "TeamSystem",
  location: "Albania, Tirana",
  url: "https://teamsystem.wd103.workday.test/TeamSystem/job/Albania-Tirana/DevOps-Lead_JR0000001910",
  applyUrl:
    "https://teamsystem.wd103.workday.test/TeamSystem/job/Albania-Tirana/DevOps-Lead_JR0000001910/apply",
  sourceId: "url",
  sourceLabel: "Added by URL",
});

const stores: JobStore[] = [];
function open(): JobStore {
  const store = openJobStore(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Saves each posting as its own job, as searches did before role matching. */
function savedSeparately(store: JobStore, jobs: FoundJob[]): number[] {
  return jobs.map((job) => {
    const id = store.saveFoundJobs({ searchId: null, jobs: [job] }).added[0]!;
    store
      .sql("DELETE FROM job_keys WHERE key >= 'role:' AND key < 'role;'")
      .run();
    return id;
  });
}

it("saves one posting listed on three boards as one job, whatever each board calls its place", () => {
  const store = open();
  const first = store.saveFoundJobs({ searchId: "s1", jobs: [remotive] });
  const later = store.saveFoundJobs({
    searchId: "s2",
    jobs: [builtIn, himalayas],
  });
  expect(later.added).toEqual([]);
  expect(later.merged).toEqual(first.added);
  const job = store.getJob(first.added[0]!)!;
  expect(job.sightings.map((sighting) => sighting.sourceLabel)).toEqual([
    "Remotive",
    "Built In",
    "Himalayas",
  ]);
  expect(job.sourceCount).toBe(3);
  // Another board's full read does not replace the saved listing's own link.
  expect(job.applyUrl).toBe(remotive.applyUrl);
  expect(job.location).toBe("EMEA");
  expect(store.stageCounts().found).toBe(1);

  const teamSystem = store.saveFoundJobs({
    searchId: "s3",
    jobs: [linkedIn, workday],
  });
  expect(teamSystem.added).toHaveLength(1);
  expect(store.getJob(teamSystem.added[0]!)?.sightings).toHaveLength(2);
});

it("keeps postings apart when their boards send applicants to different employer forms", () => {
  const store = open();
  store.saveFoundJobs({ searchId: "s1", jobs: [remotive] });
  const other = store.saveFoundJobs({
    searchId: "s2",
    jobs: [
      posting({
        url: "https://otherboard.test/jobs/zenrows-staff",
        sourceId: "other",
        applyUrl: "https://jobs.lever.test/zenrows/another-opening",
      }),
    ],
  });
  expect(other.added).toHaveLength(1);
});

it("keeps a role apart when several saved openings share its employer and title", () => {
  const store = open();
  const ats = store.saveFoundJobs({
    searchId: "s1",
    jobs: [1, 2].map((n) =>
      posting({
        title: "DevOps Lead",
        company: "TeamSystem",
        location: n === 1 ? "Tirana" : "Milan",
        url: `https://teamsystem-ats.test/TeamSystem/job/${n}`,
        sourceId: "ats",
      }),
    ),
  });
  expect(ats.added).toHaveLength(2);
  expect(
    store.saveFoundJobs({ searchId: "s2", jobs: [linkedIn] }).added,
  ).toHaveLength(1);
});

it("joins duplicates saved before role matching, keeping applications, resumes and stage", () => {
  const store = open();
  const zen = savedSeparately(store, [remotive, builtIn, himalayas]);
  const [card, page] = savedSeparately(store, [linkedIn, workday]);
  store.setStage([card!], "shortlisted");
  // The person applied through the employer page's row.
  approveOriginalResumesForTests(store, [page!]);
  const applications = createApplicationStore(store);
  applications.applyJobs({ selection: { ids: [page!] } });
  const application = applications.forJobs([page!])[0]!;
  expect(store.stageCounts().found).toBe(3);

  const report = store.mergeSamePostings();
  expect(report.keptApart).toEqual([]);
  expect(report.merged).toEqual(
    expect.arrayContaining([
      { kept: zen[0], merged: zen[1] },
      { kept: zen[0], merged: zen[2] },
      { kept: page, merged: card },
    ]),
  );
  expect(report.merged).toHaveLength(3);
  expect(store.getJob(zen[1]!)).toBeNull();
  expect(store.getJob(zen[2]!)).toBeNull();
  expect(store.getJob(card!)).toBeNull();
  expect(store.getJob(zen[0]!)?.sightings).toHaveLength(3);
  expect(store.getJob(zen[0]!)?.sourceCount).toBe(3);
  const kept = store.getJob(page!)!;
  expect(kept.stage).toBe("resume");
  expect(kept.sightings).toHaveLength(2);
  expect(applications.forJobs([page!])[0]?.id).toBe(application.id);
  expect(store.stageCounts()).toMatchObject({ found: 1, shortlisted: 0 });
  // A later search finds the kept job through the merged job's own link.
  expect(store.findKnownUrls([linkedIn.url])).toEqual([linkedIn.url]);
  const again = store.saveFoundJobs({
    searchId: "s3",
    jobs: [linkedIn, posting({ ...builtIn, url: `${builtIn.url}?ref=x` })],
  });
  expect(again.added).toEqual([]);
  expect(again.merged.sort()).toEqual([zen[0]!, page!].sort());
  // Running it again changes nothing.
  expect(store.mergeSamePostings()).toEqual({ merged: [], keptApart: [] });
});

it("leaves two jobs apart when each already has its own application, and says so", () => {
  const store = open();
  const ids = savedSeparately(store, [remotive, builtIn]);
  approveOriginalResumesForTests(store, ids);
  createApplicationStore(store).applyJobs({ selection: { ids } });
  const report = store.mergeSamePostings();
  expect(report.merged).toEqual([]);
  expect(report.keptApart).toHaveLength(1);
  expect(report.keptApart[0]?.ids).toEqual(ids);
  expect(report.keptApart[0]?.tables).toEqual(
    expect.arrayContaining(["applications", "resumes"]),
  );
  expect(store.getJob(ids[0]!)).not.toBeNull();
  expect(store.getJob(ids[1]!)).not.toBeNull();
});

it("counts only another site's application form as an employer target", () => {
  expect(
    employerApplyTarget(
      "https://al.linkedin.com/jobs/view/devops-lead-1",
      "https://www.linkedin.com/jobs/view/devops-lead-1/apply?trk=x",
    ),
  ).toBeNull();
  expect(employerApplyTarget(builtIn.url, builtIn.applyUrl)).toBeNull();
  expect(employerApplyTarget(remotive.url, remotive.applyUrl)).toBe(
    "job-boards.greenhouse.test/zenrows/jobs/5028295101",
  );
  expect(
    employerApplyTarget(remotive.url, "https://zenrows.test/careers"),
  ).toBeNull();
});
