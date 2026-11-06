import { expect, test } from "vitest";
import { fitJobs } from "@nestor/browser-agent";
import { CandidateProfileSchema, JOB_FIT_BANDS } from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { searchPersonas } from "./personas";

// Labels precede the scripted verdicts. All jobs share the same matching duties;
// only hiring scope/permission differs. The model's role score is deliberately
// optimistic to exercise production caps and the persisted best-fit ordering.
const cases = [
  {
    id: "europe_only",
    location: "Remote, Europe",
    description: "Work remotely from Europe only.",
    expected: "limited",
  },
  {
    id: "europe_shared_body",
    location: "Europe",
    description: "Work remotely in Americas or Europe.",
    expected: "limited",
  },
  {
    id: "us_remote",
    location: "Remote, United States",
    description:
      "Work remotely within the United States. US work authorization required.",
    expected: "strong",
  },
  {
    id: "worldwide",
    location: "Remote worldwide",
    description: "Work remotely worldwide.",
    expected: "strong",
  },
  {
    id: "permission_unknown",
    location: "Remote worldwide",
    description: "Work remotely worldwide. German work authorization required.",
    expected: "limited",
  },
  {
    id: "permission_conflict",
    location: "Remote worldwide",
    description:
      "Work remotely worldwide. German work authorization required; no sponsorship.",
    expected: "limited",
  },
] as const;
const person = searchPersonas[0]!;
const proof = (country: string) => ({
  workCountry: country,
  residence: {
    status: "met",
    reason: `The published region includes your ${country} work location.`,
  },
  authorization: {
    status: "not_required",
    reason:
      "This remote listing states no specific work-authorization requirement.",
  },
});

test("US-only persona: Europe-only and unresolved permission stay below eligible US/worldwide jobs in the store", async () => {
  const store = openJobStore(":memory:");
  try {
    store.saveFoundJobs({
      searchId: "synthetic_region",
      jobs: cases.map((entry) => ({
        title: "Senior Full Stack Engineer",
        company: `Synthetic ${entry.id}`,
        location: entry.location,
        workModes: ["remote"],
        url: `https://example.test/${entry.id}`,
        applyUrl: null,
        sourceId: "synthetic",
        sourceLabel: "Synthetic",
        sourceJobId: entry.id,
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: "Senior",
        employmentType: "Full-time",
        summary: null,
        description: `${entry.description} Build React/TypeScript products with Node and PostgreSQL.`,
      })),
    });
    const jobs = store
      .listJobs({ stage: "found" })
      .rows.map(({ id }) => store.getJob(id)!);
    const fits = await fitJobs({
      profile: person.profile,
      goals: person.goals,
      jobs,
      client: {
        chatWithTools: () =>
          Promise.resolve({
            content: JSON.stringify({
              fits: jobs.map((job) => {
                const entry = cases.find((entry) =>
                  job.url.endsWith(entry.id),
                )!;
                const e = {
                  status: "compatible",
                  quote: entry.description.split(".")[0],
                  kind:
                    entry.id === "us_remote"
                      ? "country_remote"
                      : "broader_remote",
                  countries: entry.id === "us_remote" ? "US" : "",
                  ...proof("US"),
                  publishedLocation: entry.location,
                };
                if (entry.id === "europe_only") {
                  // Reproduce the original malformed positive: a regional quote without
                  // a judgment of the person's inclusion must never suffice.
                  return {
                    id: job.id,
                    s: 99,
                    why: "Your full-stack work is an excellent match.",
                    w: "Excellent match",
                    r: ["strong", "Exact duties"],
                    p: ["aligned", "Remote"],
                    c: ["strong", "Direct experience"],
                    e: [
                      "compatible",
                      "Work remotely from Europe only",
                      "broader_remote",
                      "",
                    ],
                  };
                }
                if (entry.id === "us_remote")
                  e.authorization = {
                    status: "met",
                    reason:
                      "Your saved US authorization meets the stated US requirement.",
                  };
                if (entry.id === "permission_unknown")
                  e.authorization = {
                    status: "unknown",
                    reason:
                      "The listing requires German authorization, which your saved facts do not establish.",
                  };
                if (entry.id === "permission_conflict")
                  e.authorization = {
                    status: "conflict",
                    reason:
                      "German authorization without sponsorship contradicts your explicit US-only permission.",
                  };
                return {
                  id: job.id,
                  s: 96,
                  why: "Your full-stack work is an excellent match.",
                  w: "Excellent match",
                  r: ["strong", "Exact duties"],
                  p: ["aligned", "Remote"],
                  c: ["strong", "Direct experience"],
                  e,
                };
              }),
            }),
          }),
      },
    });
    expect(fits).toHaveLength(cases.length);
    store.setFit(fits);
    const rows = store.listJobs({ stage: "found", sort: "best_fit" }).rows;
    expect(
      rows
        .slice(0, 2)
        .map((row) => row.company)
        .sort(),
    ).toEqual(["Synthetic us_remote", "Synthetic worldwide"]);
    expect(
      store.listJobs({ stage: "found", minFit: JOB_FIT_BANDS.good }).rows,
    ).toHaveLength(2);
    for (const row of rows) {
      const entry = cases.find(
        (entry) => row.company === `Synthetic ${entry.id}`,
      )!;
      if (entry.expected === "strong") expect(row.fitScore).toBe(96);
      else {
        expect(row.fitScore).toBeLessThan(JOB_FIT_BANDS.good);
        expect(row.fitSummary).not.toContain("excellent match");
        expect(store.getJob(row.id)?.fit?.short).toBeUndefined();
      }
    }
    expect(
      rows.find((row) => row.company.endsWith("permission_conflict"))?.fitScore,
    ).toBe(39);
    expect(
      rows.find((row) => row.company.endsWith("permission_unknown"))
        ?.fitSummary,
    ).toContain("German authorization");
  } finally {
    store.close();
  }
});

test.each(["country_remote", "broader_remote"])(
  "EU-only persona cannot satisfy US-only hiring even when e claims compatible (%s)",
  async (kind) => {
    const store = openJobStore(":memory:");
    try {
      store.saveFoundJobs({
        searchId: null,
        jobs: [
          {
            title: "Senior Full Stack Engineer",
            company: "Synthetic US-only",
            location: "Remote, United States",
            workModes: ["remote"],
            url: "https://example.test/us-only",
            applyUrl: null,
            sourceId: "synthetic",
            sourceLabel: "Synthetic",
            sourceJobId: null,
            postedAt: null,
            salaryText: null,
            salaryMin: null,
            salaryMax: null,
            salaryCurrency: null,
            seniority: null,
            employmentType: null,
            summary: null,
            description:
              "Work remotely within the United States only. US work authorization required. Build TypeScript products.",
          },
        ],
      });
      const profile = CandidateProfileSchema.parse({
        ...person.profile,
        currentCountry: "Germany",
        currentLocation: "Berlin, Germany",
        currentCity: "Berlin",
        currentRegion: "Berlin",
        timeZone: "Europe/Berlin",
        workEligibility: {
          authorizedWorkCountries: ["European Union"],
          willingToRelocate: false,
        },
      });
      const [fit] = await fitJobs({
        profile,
        goals: person.goals,
        jobs: [store.getJob(1)!],
        client: {
          chatWithTools: () =>
            Promise.resolve({
              content: JSON.stringify({
                fits: [
                  {
                    id: 1,
                    s: 99,
                    why: "Excellent match",
                    w: "Excellent match",
                    r: ["strong", "Exact duties"],
                    p: ["aligned", "Remote"],
                    c: ["strong", "Direct evidence"],
                    e: {
                      status: "compatible",
                      quote: "United States only",
                      kind,
                      countries: "US",
                      ...proof("DE"),
                      publishedLocation: "Remote, United States",
                      residence: {
                        status: "conflict",
                        reason:
                          "You work in Germany; this role requires US residence.",
                      },
                      authorization: {
                        status: "unknown",
                        reason:
                          "Your EU permission does not establish required US authorization.",
                      },
                    },
                  },
                ],
              }),
            }),
        },
      });
      expect(fit?.score).toBe(39);
      expect(fit?.summary).toContain("requires US residence");
      expect(fit?.short).toBeUndefined();
    } finally {
      store.close();
    }
  },
);
