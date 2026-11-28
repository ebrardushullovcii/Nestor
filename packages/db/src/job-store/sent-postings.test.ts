import type { FoundJob } from "@nestor/contracts";
import { afterEach, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "./job-store";

function posting(overrides: Partial<FoundJob>): FoundJob {
  return {
    title: "Senior Product Engineer (TS/NodeJS/Vue)",
    company: "n8n",
    location: "Europe",
    workModes: ["remote"],
    url: "https://www.nomads.test/jobs/senior-product-engineer-n8n-1950011",
    applyUrl: null,
    sourceId: "nomads",
    sourceLabel: "Nomads",
    sourceJobId: null,
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: "Build the workflow editor.",
    facts: { fullListingRead: true },
    ...overrides,
  };
}

const stores: JobStore[] = [];
function open(): JobStore {
  const store = openJobStore(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Applies to a saved job and records the send the way a real one is stored. */
function sent(store: JobStore, id: number, form: string): number {
  approveOriginalResumesForTests(store, [id]);
  const applications = createApplicationStore(store);
  applications.applyJobs({ selection: { ids: [id] } });
  const application = applications.forJobs([id])[0]!;
  const url = new URL(form);
  store
    .sql(
      `UPDATE applications SET state='submitted', submitted_at=1, submission_outcome_json=? WHERE id=?`,
    )
    .run(
      JSON.stringify({
        outcome: "submitted",
        evidence: [
          {
            kind: "employer_site_state",
            destination: { origin: url.origin, safePath: url.pathname },
          },
        ],
      }),
      application.id,
    );
  store
    .sql(
      `INSERT INTO application_details (application_id, attempt, resume_artifact_json, execution_json, profile_digest)
       VALUES (?, 1, '{}', ?, 'digest')
       ON CONFLICT (application_id) DO UPDATE SET execution_json = excluded.execution_json`,
    )
    .run(
      application.id,
      JSON.stringify({ stepReceipts: [{ kind: "final", url: form }] }),
    );
  return application.id;
}

it("joins a board's second listing to the applied posting once its redirect is followed to the employer", () => {
  const store = open();
  // The listing that was applied to stored no apply link; the model went from
  // it to the employer's posting and sent the form there.
  const [applied] = store.saveFoundJobs({
    searchId: "s1",
    jobs: [posting({})],
  }).added;
  sent(
    store,
    applied!,
    "https://jobs.ashby.test/n8n/896c58a8-0388/application",
  );
  // The board relisted the posting; its only apply link is its own redirect.
  const relisted = posting({
    url: "https://www.nomads.test/jobs/senior-product-engineer-n8n-2033454",
    location: "Germany; Spain",
    applyUrl: "https://www.nomads.test/job/go/2033454/",
  });
  const [second] = store.saveFoundJobs({
    searchId: "s2",
    jobs: [relisted],
  }).added;
  expect(second).not.toBe(applied);

  // The next read followed the redirect to the employer's posting.
  const read = store.saveFoundJobs({
    searchId: "s3",
    jobs: [
      {
        ...relisted,
        applyUrl: "https://jobs.ashby.test/n8n/896c58a8-0388",
        facts: {
          fullListingRead: true,
          applyLinkFollowedUrl: relisted.applyUrl,
        },
      },
    ],
  });
  expect(read.ids).toEqual([applied]);
  expect(store.getJob(second!)).toBeNull();
  const job = store.getJob(applied!)!;
  expect(job.sightings.map((sighting) => sighting.url).sort()).toEqual(
    [posting({}).url, relisted.url].sort(),
  );
  // The applied job keeps what it was applied to, and now links the
  // employer's posting rather than the board's redirect.
  expect(job).toMatchObject({
    stage: "applied",
    location: "Europe",
    applyUrl: "https://jobs.ashby.test/n8n/896c58a8-0388",
  });
  // A later listing that leads to the same employer posting joins it directly.
  expect(
    store.saveFoundJobs({
      searchId: "s4",
      jobs: [
        posting({
          url: "https://remote.test/jobs/n8n-senior-product-engineer",
          sourceId: "remote",
          applyUrl: "https://jobs.ashby.test/n8n/896c58a8-0388?src=remote",
        }),
      ],
    }).ids,
  ).toEqual([applied]);
});

it("keeps another employer's posting apart even when its form sits under the same board", () => {
  const store = open();
  const [applied] = store.saveFoundJobs({
    searchId: "s1",
    jobs: [posting({})],
  }).added;
  sent(
    store,
    applied!,
    "https://jobs.ashby.test/n8n/896c58a8-0388/application",
  );
  const other = store.saveFoundJobs({
    searchId: "s2",
    jobs: [
      posting({
        title: "Staff Engineer",
        url: "https://www.nomads.test/jobs/staff-engineer-n8n-2040000",
        applyUrl: "https://jobs.ashby.test/n8n/1111-2222",
      }),
    ],
  });
  expect(other.added).toHaveLength(1);
});

it("keeps an applied job's employer and role when another listing joined to it is read, and takes them from its own listing", () => {
  const store = open();
  const own = posting({
    title: "Software Engineer, Operations Research",
    company: "CircuitHub",
    location: "Remote",
    url: "https://www.arbeit.test/jobs/companies/circuithub/remote-software-engineer-operations-research-57308",
    sourceId: "arbeit",
    applyUrl: "https://jobs.ashby.test/circuithub/05338831",
  });
  const [applied] = store.saveFoundJobs({
    searchId: "s1",
    jobs: [own],
  }).added;
  sent(
    store,
    applied!,
    "https://jobs.ashby.test/circuithub/05338831/application",
  );

  // Another listing that leads to the same employer form is read in full.
  const elsewhere = posting({
    title: "Software Engineer (Operations Research)",
    company: "Circuithub Ltd",
    location: "Cambridge, UK",
    url: "https://jobs.elsewhere.test/circuithub-operations-research",
    sourceId: "elsewhere",
    applyUrl: "https://jobs.ashby.test/circuithub/05338831",
    description: "Another board's copy.",
  });
  expect(
    store.saveFoundJobs({ searchId: "s2", jobs: [elsewhere] }).ids,
  ).toEqual([applied]);
  expect(store.getJob(applied!)).toMatchObject({
    title: own.title,
    company: own.company,
    location: own.location,
  });
  expect(store.getJob(applied!)?.description).toBe(own.description);

  // Facts a mistaken join once wrote over it come back from its own listing.
  store
    .sql(
      "UPDATE jobs SET title='Tech Lead (m/f/d)', company='Superchat' WHERE id=?",
    )
    .run(applied!);
  store.saveFoundJobs({ searchId: "s3", jobs: [own] });
  expect(store.getJob(applied!)).toMatchObject({
    title: own.title,
    company: own.company,
  });
});
