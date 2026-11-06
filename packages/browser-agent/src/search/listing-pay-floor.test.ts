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

test.each([
  [20, 20, "EUR 20 per hour", true],
  [20, 23.5, "EUR 20–23.50 per hour", true],
  [24, 24, "EUR 24 per hour", false],
  [22, 27, "EUR 22–27 per hour", false],
])(
  "published bounds override a contradictory recommendation (%s–%s)",
  async (minimum, maximum, quote, below) => {
    const result = await fitJobs({
      profile,
      goals,
      jobs: [job(1, `Remote within Germany. ${quote}. SQL reporting duties.`)],
      client: {
        chatWithTools: vi.fn(() =>
          Promise.resolve({
            content: JSON.stringify({
              fits: [
                verdict(1, {
                  minimum,
                  maximum,
                  currency: "EUR",
                  interval: "hour",
                  basis: "base",
                  quote,
                }),
              ],
            }),
          }),
        ),
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].score < 65).toBe(below);
    if (below) {
      expect(result[0].summary).toContain("below your 24/hour minimum");
      expect(result[0].preferences?.assessment).toBe("conflict");
    } else {
      expect(result[0].score).toBe(94);
      expect(result[0].summary).toBe("Excellent match worth applying");
    }
  },
);

test.each([
  {
    minimum: null,
    maximum: null,
    currency: null,
    interval: null,
    basis: null,
    quote: "",
  },
  {
    minimum: 50000,
    maximum: 50000,
    currency: "EUR",
    interval: "year",
    basis: "base",
    quote: "EUR 50000 per year",
  },
  {
    minimum: 30,
    maximum: 30,
    currency: "USD",
    interval: "hour",
    basis: "base",
    quote: "USD 30 per hour",
  },
])(
  "missing or incomparable pay is uncertainty, never an invented below-floor offer",
  async (pay) => {
    const fits = await fitJobs({
      profile,
      goals,
      jobs: [job(1, `Remote within Germany. SQL. ${pay.quote}`)],
      client: {
        chatWithTools: () =>
          Promise.resolve({
            content: JSON.stringify({ fits: [verdict(1, pay)] }),
          }),
      },
    });
    expect(fits[0].score).toBe(94);
    expect(fits[0].summary).toContain("Excellent match worth applying");
    expect(fits[0].summary).toContain("cannot yet be compared");
    expect(fits[0].summary).not.toContain("Published pay");
    expect(fits[0].summary).not.toContain(
      "its currency, interval, basis or amount is unresolved",
    );
    expect(fits[0].short).toBeUndefined();
    expect(fits[0].preferences?.assessment).toBe("unknown");
  },
);

test("borrowed pay evidence leaves only that row retryable and retains a valid sibling", async () => {
  const good = {
    minimum: 20,
    maximum: 20,
    currency: "EUR",
    interval: "hour",
    basis: "base",
    quote: "EUR 20 per hour",
  };
  const jobs = [
    job(1, "Remote within Germany. EUR 20 per hour. SQL reporting."),
    job(2, "Remote within Germany. Pay to be discussed. SQL reporting."),
  ];
  const stop = new AbortController();
  let calls = 0;
  const client = {
    chatWithTools: vi.fn(() => {
      if (++calls === 2) stop.abort(new Error("Stopped"));
      return Promise.resolve({
        content: JSON.stringify({ fits: [verdict(1, good), verdict(2, good)] }),
      });
    }),
  };
  const onBatch = vi.fn<(fits: Array<{ id: number }>) => void>();
  await expect(
    fitJobs({ profile, goals, jobs, client, onBatch, signal: stop.signal }),
  ).rejects.toThrow("Stopped");
  expect(
    onBatch.mock.calls.flatMap(([fits]) =>
      fits.map((f: { id: number }) => f.id),
    ),
  ).toEqual([1]);
  expect(client.chatWithTools.mock.calls.length).toBeGreaterThan(1);
});

test("Chat receives the required pay contract and repairs only the omitted sibling", async () => {
  const pay = {
    minimum: 27,
    maximum: 27,
    currency: "EUR",
    interval: "hour",
    basis: "base",
    quote: "EUR 27 per hour",
  };
  const requests: number[][] = [];
  const batches: number[][] = [];
  const fits = await fitJobs({
    profile,
    goals,
    jobs: [1, 2].map((id) =>
      job(id, "Remote within Germany. EUR 27 per hour. SQL reporting."),
    ),
    onBatch: (updates) => {
      batches.push(updates.map((row) => row.id));
    },
    client: {
      chatWithTools: (messages, _tools, options) => {
        const instruction = String(messages[0].content);
        expect(options?.jsonOutput).not.toBe(true);
        const schema = JSON.parse(
          instruction.split("Required response JSON Schema: ")[1],
        ) as { properties: { fits: { items: { required: string[] } } } };
        expect(schema.properties.fits.items.required).toContain("pay");
        expect(instruction).toContain(
          '"h":{"status":"met|conflict|unknown|not_requested","reason":"mandatory requirements reason"},"pay":',
        );
        const input = JSON.parse(String(messages[1].content)) as {
          listings: { id: number }[];
          repair?: { id: number; issues: string[] }[];
        };
        requests.push(input.listings.map((row: { id: number }) => row.id));
        if (requests.length === 1)
          return Promise.resolve({
            content: JSON.stringify({
              fits: [verdict(1, pay), verdict(2, undefined)],
            }),
          });
        expect(input.repair).toEqual([{ id: 2, issues: ["missing_pay"] }]);
        return Promise.resolve({
          content: JSON.stringify({ fits: [verdict(2, pay)] }),
        });
      },
    },
  });
  expect(requests).toEqual([[1, 2], [2]]);
  expect(batches).toEqual([[1], [2]]);
  expect(fits.map((row) => row.id)).toEqual([1, 2]);
});

test("pay repair identifies an ungrounded quote and keeps the grounding gate", async () => {
  const issues: string[][] = [];
  const stop = new AbortController();
  await expect(
    fitJobs({
      profile,
      goals,
      signal: stop.signal,
      jobs: [job(1, "Remote within Germany. EUR 27 per hour. SQL reporting.")],
      client: {
        chatWithTools: (messages) => {
          const input = JSON.parse(String(messages[1].content)) as {
            listings: { id: number }[];
            repair?: { id: number; issues: string[] }[];
          };
          if (input.repair) {
            issues.push(input.repair[0].issues);
            stop.abort(new Error("Stopped"));
          }
          return Promise.resolve({
            content: JSON.stringify({
              fits: [
                verdict(1, {
                  minimum: 27,
                  maximum: 27,
                  currency: "EUR",
                  interval: "hour",
                  basis: "base",
                  quote: "EUR 27/hour",
                }),
              ],
            }),
          });
        },
      },
    }),
  ).rejects.toThrow("Stopped");
  expect(issues).toEqual([["pay_quote_not_verbatim_or_bounds_reversed"]]);
});

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
