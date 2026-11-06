import { expect, test, vi } from "vitest";
import { CandidateProfileSchema, JobDetailSchema } from "@nestor/contracts";
import { fitJobs } from "./listing-engine";

const profile = CandidateProfileSchema.parse({
  id: "synthetic",
  fullName: "Jamie Synthetic",
  headline: "Data Analyst",
  currentCountry: "Germany",
  workEligibility: { authorizedWorkCountries: ["Germany"] },
  skills: ["SQL"],
  yearsExperience: 2,
  baseResume: {
    id: "synthetic",
    fileName: "synthetic.txt",
    uploadedAt: "2026-11-05T00:00:00Z",
  },
});
const job = (id: number, description: string) =>
  JobDetailSchema.parse({
    id,
    stage: "found",
    stageNote: null,
    stageChangedAt: "2026-11-05T00:00:00Z",
    title: "Data Analyst",
    company: "Synthetic Employer",
    location: "Germany",
    workModes: ["remote"],
    url: `https://example.test/job/${id}`,
    applyUrl: null,
    description,
    foundAt: "2026-11-05T00:00:00Z",
    seenAt: "2026-11-05T00:00:00Z",
    sourceLabel: "Example",
    sourceCount: 1,
    postedAt: null,
    searchId: null,
    fitScore: null,
    fitSummary: null,
    salaryText: null,
    seniority: null,
    employmentType: null,
    salary: null,
    facts: {},
    fit: null,
    sightings: [],
    summary: null,
  });
const verdict = (id: number, pay: unknown) => ({
  id,
  s: 94,
  why: "Excellent match worth applying",
  w: "Great match",
  r: ["strong", "SQL duties match"],
  p: ["mixed", "Pay differs"],
  c: ["strong", "Direct evidence"],
  h: ["met", "Other requirements met"],
  e: ["compatible", "Remote within Germany", "country_remote", "DE"],
  pay,
});
const goals = {
  targetRoles: ["Data Analyst"],
  locations: ["Germany"],
  compensation: {
    minimum: 24,
    maximum: null,
    interval: "hour" as const,
    currency: "EUR",
    currencyStatus: "explicit" as const,
    basis: "base" as const,
  },
};

test.each([19, 24, 27])(
  "published pay %s is a fact for the model and never rewrites its judgment",
  async (amount) => {
    const pay = {
      minimum: amount,
      maximum: amount,
      currency: "EUR",
      interval: "hour",
      basis: "base",
      quote: `EUR ${amount}/hour`,
    };
    const chatWithTools = vi.fn<
      NonNullable<Parameters<typeof fitJobs>[0]["client"]>["chatWithTools"]
    >((messages) => {
      expect(messages[1].content).toContain('"minimum":24');
      expect(messages[1].content).toContain(`EUR ${amount}/hour`);
      return Promise.resolve({
        content: JSON.stringify({ fits: [verdict(1, pay)] }),
      });
    });
    const [fit] = await fitJobs({
      profile,
      goals,
      jobs: [job(1, `SQL reporting. EUR ${amount}/hour.`)],
      client: { chatWithTools },
    });
    expect(fit).toMatchObject({
      score: 94,
      summary: "Excellent match worth applying",
      preferences: { assessment: "mixed", explanation: "Pay differs" },
    });
    expect(chatWithTools).toHaveBeenCalledOnce();
  },
);

test("truncated fit batches split to single listings without losing a judgment", async () => {
  const groups: number[][] = [];
  const pay = {
    minimum: 27,
    maximum: 27,
    currency: "EUR",
    interval: "hour",
    basis: "base",
    quote: "EUR 27 per hour",
  };
  const fits = await fitJobs({
    profile,
    goals,
    jobs: [1, 2, 3, 4].map((id) =>
      job(id, "Remote within Germany. EUR 27 per hour. SQL reporting."),
    ),
    client: {
      chatWithTools: (messages) => {
        const input = JSON.parse(String(messages[1].content)) as {
          listings: { id: number }[];
          repair?: unknown;
        };
        const ids = input.listings.map((row) => row.id);
        groups.push(ids);
        if (ids.length > 1)
          return Promise.resolve({
            content: "partial",
            finishReason: "length",
          });
        expect(input.repair).toBeDefined();
        return Promise.resolve({
          content: JSON.stringify({ fits: ids.map((id) => verdict(id, pay)) }),
        });
      },
    },
  });
  expect(groups).toEqual([[1, 2, 3, 4], [1, 2], [1], [2], [3, 4], [3], [4]]);
  expect(fits.map((fit) => fit.id)).toEqual([1, 2, 3, 4]);
});

test("omitted fit ids get explicit feedback and smaller groups then report a persistent single-job failure", async () => {
  const groups: number[][] = [];
  const repairs: unknown[] = [];
  await expect(
    fitJobs({
      profile,
      goals,
      jobs: [1, 2, 3, 4].map((id) =>
        job(id, "Remote within Germany. SQL reporting."),
      ),
      client: {
        chatWithTools: (messages) => {
          const input = JSON.parse(String(messages[1].content)) as {
            listings: { id: number }[];
            repair?: unknown;
          };
          groups.push(input.listings.map((row) => row.id));
          repairs.push(input.repair);
          return Promise.resolve({ content: '{"fits":[]}' });
        },
      },
    }),
  ).rejects.toThrow("job 1");
  expect(groups).toEqual([[1, 2, 3, 4], [1, 2], [1], [2], [3, 4], [3], [4]]);
  expect(repairs[2]).toEqual([
    { id: 1, issues: ["missing_invalid_or_duplicate_judgment"] },
  ]);
});

test("single-job output truncation returns a real error instead of replaying the request", async () => {
  const chatWithTools = vi.fn(() =>
    Promise.resolve({ content: "partial", finishReason: "length" }),
  );
  await expect(
    fitJobs({
      profile,
      goals,
      jobs: [job(1, "SQL reporting")],
      client: { chatWithTools },
    }),
  ).rejects.toThrow();
  expect(chatWithTools).toHaveBeenCalledOnce();
});
