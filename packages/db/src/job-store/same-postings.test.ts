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
  expect(store.mergeSamePostings()).toEqual({
    untangled: [],
    merged: [],
    keptApart: [],
  });
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

// The owner's arbeitnow listings once all named one blog article as their
// apply link, and We Work Remotely's all named its account sign-up page.
const arbeitnow = (company: string, slug: string, title: string) =>
  posting({
    title,
    company,
    location: "Berlin, Germany",
    url: `https://www.arbeitnow.test/jobs/companies/${company.toLowerCase()}/${slug}`,
    applyUrl: "https://www.arbeitnow.test/blog/applying-for-german-citizenship",
    sourceId: "arbeitnow",
    sourceLabel: "arbeitnow.com",
    facts: { fullListingRead: true },
  });
const circuitHub = arbeitnow(
  "CircuitHub",
  "remote-software-engineer-operations-research-57308",
  "Software Engineer, Operations Research",
);
const javaDeveloper = arbeitnow(
  "Collaboration",
  "java-developer-berlin-44767",
  "Java Developer (m/w/d)",
);

it("keeps listings apart that share a board's own page as their apply link", () => {
  const store = open();
  const saved = store.saveFoundJobs({
    searchId: "s1",
    jobs: [
      circuitHub,
      javaDeveloper,
      ...["samsara", "squarespace"].map((company) =>
        posting({
          company,
          title: `${company} engineer`,
          url: `https://weworkremotely.test/remote-jobs/${company}-engineer`,
          applyUrl:
            "https://weworkremotely.test/job-seekers/account/register?alert=Create+an+account+to+view+full+job+details.",
          sourceId: "wwr",
        }),
      ),
    ],
  });
  expect(saved.added).toHaveLength(4);
  expect(saved.merged).toEqual([]);
  expect(store.getJob(saved.added[0]!)?.title).toBe(
    "Software Engineer, Operations Research",
  );
});

it("joins same-board copies with one employer form and keeps distinct requisitions", () => {
  const store = open();
  const form = "https://employer.example/engineering/jobs/105";
  const original = posting({
    company: "Replica Employer",
    title: "Platform Engineer",
    location: "Spain",
    sourceId: "board",
    sourceJobId: "spain",
    url: "https://board.example/jobs/spain",
    applyUrl: form,
  });
  const result = store.saveFoundJobs({
    searchId: null,
    jobs: [
      original,
      {
        ...original,
        location: "Portugal",
        url: "https://board.example/jobs/portugal",
        sourceJobId: "portugal",
        applyUrl: `${form}?utm_source=board`,
      },
      {
        ...original,
        location: "France",
        url: "https://board.example/jobs/france",
        sourceJobId: "france",
        applyUrl: "https://employer.example/engineering/jobs/106",
      },
      {
        ...original,
        company: "Other Employer",
        location: "France",
        url: "https://board.example/jobs/partner",
        sourceJobId: "partner",
      },
    ],
  });
  expect(result.added).toHaveLength(3);
  expect(store.getJob(result.ids[0]!)?.sightings).toHaveLength(2);
  expect(result.ids[0]).toBe(result.ids[1]);
  expect(result.ids[2]).not.toBe(result.ids[0]);
  expect(result.ids[3]).not.toBe(result.ids[0]);
});

it("keeps different employers apart when a board repeats its job number, and joins one employer's", () => {
  const store = open();
  const numbered = (company: string, path: string) =>
    posting({
      company,
      title: company === "Bjak" ? "Full Stack Engineer" : "IT-System Engineer",
      url: `https://www.arbeitnow.test/jobs/companies/${path}`,
      sourceId: "arbeitnow",
      sourceJobId: "250365",
    });
  const saved = store.saveFoundJobs({
    searchId: "s1",
    jobs: [
      numbered("Bjak", "bjak/full-stack-engineer-ai-systems-germany-250365"),
      numbered("think about IT GmbH", "think/it-system-engineer-bochum-250365"),
    ],
  });
  expect(saved.added).toHaveLength(2);
  // One LinkedIn posting under two wordings of its address is one job.
  const linkedInSlugs = [
    "confirme-java-4474772284",
    "confirme-java-angular-4474772284",
  ].map((slug) =>
    posting({
      company: "Sopra Steria",
      title: "Développeur Fullstack",
      url: `https://fr.linkedin.test/jobs/view/${slug}`,
      sourceId: "linkedin",
      sourceJobId: "4474772284",
    }),
  );
  expect(
    store.saveFoundJobs({ searchId: "s2", jobs: linkedInSlugs }).added,
  ).toHaveLength(1);
});

it("does not take a board's tracking parameters for one employer form", () => {
  const store = open();
  const saved = store.saveFoundJobs({
    searchId: "s1",
    jobs: ["Senior QA Automation Engineer", "Senior Fullstack Developer"].map(
      (title, n) =>
        posting({
          company: "Proxify AB",
          title,
          url: `https://weworkremotely.test/listings/proxify-${n}`,
          applyUrl:
            "https://career.proxify.test/apply?utm_source=weworkremotely&utm_medium=job_posting",
          sourceId: "wwr",
        }),
    ),
  });
  expect(saved.added).toHaveLength(2);
});

/** What the old apply-link key left behind: other listings on one job, and its facts rewritten. */
function tangle(store: JobStore, id: number, others: FoundJob[]): void {
  for (const other of others) {
    store
      .sql(
        `INSERT INTO job_sightings (job_id, url, site, source_id, source_label, apply_url, seen_at)
         VALUES (?, ?, 'board', ?, ?, NULL, 1)`,
      )
      .run(id, other.url, other.sourceId, other.sourceLabel);
    store
      .sql("INSERT INTO job_keys (key, job_id) VALUES (?, ?)")
      .run(`url:${other.url.replace(/^https:\/\//u, "")}`, id);
    store
      .sql(
        `INSERT INTO listing_card_evidence (url, source_id, job_id, fingerprint, record_fingerprint)
         VALUES (?, ?, ?, 'card', 'record')`,
      )
      .run(other.url, other.sourceId, id);
  }
  store
    .sql(
      "INSERT INTO job_keys (key, job_id) VALUES ('id:arbeitnow:44767', ?), ('role:collaboration|java developer m w d|' || ?, ?)",
    )
    .run(id, id, id);
  store
    .sql(
      "UPDATE jobs SET title = 'Java Developer (m/w/d)', company = 'Collaboration', apply_url = ? WHERE id = ?",
    )
    .run(`${javaDeveloper.url}/apply`, id);
}

it("lets a job go of listings a shared board page joined to it, so each is read and saved again", () => {
  const store = open();
  const [own] = store.saveFoundJobs({
    searchId: "s1",
    jobs: [circuitHub],
  }).added;
  const zen = store.saveFoundJobs({
    searchId: "s1",
    jobs: [remotive, builtIn, himalayas],
  }).added[0]!;
  const elsewhere = posting({
    company: "virtual7",
    title: "Senior Java Fullstack Developer",
    url: "https://de.linkedin.test/jobs/view/senior-java-fullstack-developer-4471681305",
    sourceId: "linkedin",
  });
  tangle(store, own!, [
    javaDeveloper,
    arbeitnow("0g", "remote-product-engineer-96085", "Product Engineer"),
    elsewhere,
  ]);
  expect(store.getJob(own!)?.sightings).toHaveLength(4);

  const report = store.mergeSamePostings();
  expect(report.untangled).toEqual([{ id: own, released: 3 }]);
  const job = store.getJob(own!)!;
  expect(job.sightings.map((sighting) => sighting.url)).toEqual([
    circuitHub.url,
  ]);
  // The link its own listing gave, not the one another listing wrote over it.
  expect(job.applyUrl).toBe(circuitHub.applyUrl);
  // A job whose listings are one per board is left alone.
  expect(store.getJob(zen)?.sightings).toHaveLength(3);
  expect(
    store
      .sql("SELECT count(*) AS n FROM listing_card_evidence WHERE job_id = ?")
      .get(own!),
  ).toEqual({ n: 0 });

  // The next search saves each released listing as its own job, and its own
  // page gives the applied job back its facts.
  const again = store.saveFoundJobs({
    searchId: "s2",
    jobs: [javaDeveloper, elsewhere, circuitHub],
  });
  expect(again.added).toHaveLength(2);
  expect(again.merged).toEqual([own]);
  expect(store.getJob(own!)).toMatchObject({
    title: "Software Engineer, Operations Research",
    company: "CircuitHub",
  });
  expect(store.mergeSamePostings().untangled).toEqual([]);
});

it("keeps one posting's sightings on a board's country hosts together", () => {
  const store = open();
  const id = store.saveFoundJobs({ searchId: "s1", jobs: [linkedIn] })
    .added[0]!;
  store
    .sql(
      `INSERT INTO job_sightings (job_id, url, site, source_id, source_label, apply_url, seen_at)
       VALUES (?, ?, 'de.linkedin.test/jobs', 'linkedin', 'LinkedIn', NULL, 1)`,
    )
    .run(id, `${linkedIn.url.replace("al.", "de.")}?position=3&refId=x`);
  // We Work Remotely files one posting under two sections.
  store
    .sql(
      `INSERT INTO job_sightings (job_id, url, site, source_id, source_label, apply_url, seen_at)
       VALUES (?, ?, 'de.linkedin.test/jobs', 'linkedin', 'LinkedIn', NULL, 1)`,
    )
    .run(id, linkedIn.url.replace("/jobs/view/", "/jobs/collections/"));
  expect(store.mergeSamePostings().untangled).toEqual([]);
  expect(store.getJob(id)?.sightings).toHaveLength(3);
});
