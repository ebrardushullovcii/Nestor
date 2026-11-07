import { CandidateProfileSchema, JobDetailSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { fitJobs } from "./listing-engine";

const profile = CandidateProfileSchema.parse({
  id: "synthetic",
  fullName: "Synthetic Applicant",
  headline: "Software engineer",
  yearsExperience: 8,
  currentLocation: "Pristina",
  currentCity: "Pristina",
  currentRegion: "Pristina",
  currentCountry: "Kosovo",
  skills: ["TypeScript"],
  workEligibility: {
    authorizedWorkCountries: ["Kosovo"],
    remoteEligible: true,
  },
  baseResume: {
    id: "synthetic",
    fileName: "synthetic.txt",
    uploadedAt: "2026-10-27T00:00:00Z",
  },
});
const job = JobDetailSchema.parse({
  id: 1,
  stage: "found",
  stageNote: null,
  stageChangedAt: "2026-10-27T00:00:00Z",
  title: "Software Engineer",
  company: "Synthetic Lab",
  location: "Remote, US only",
  workModes: ["remote"],
  url: "https://synthetic.test/job",
  applyUrl: null,
  description:
    "Build TypeScript products. Applicants must reside in the United States.",
  foundAt: "2026-10-27T00:00:00Z",
  seenAt: "2026-10-27T00:00:00Z",
  sourceLabel: "Synthetic",
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

test.each(["compatible", "review", "blocked"] as const)(
  "the model's score and reason survive its %s eligibility verdict",
  async (status) => {
    const [fit] = await fitJobs({
      profile,
      jobs: [job],
      goals: { targetRoles: [], locations: [] },
      client: {
        chatWithTools: () =>
          Promise.resolve({
            content: JSON.stringify({
              fits: [
                {
                  id: 1,
                  s: 92,
                  why: "The model's own overall reason.",
                  w: "Model reason",
                  r: ["strong", "Requested work"],
                  p: ["mixed", "Model preference reason"],
                  c: ["strong", "Experience"],
                  h: ["conflict", "Model requirement reason"],
                  e: [status, "US only", "country_remote", "US"],
                },
              ],
            }),
          }),
      },
    });
    expect(fit).toMatchObject({
      score: 92,
      summary: "The model's own overall reason.",
      short: "Model reason",
      preferences: {
        assessment: "mixed",
        explanation: "Model preference reason",
      },
    });
  },
);

test("fit gets explicit residence and saved country-list rules, without changing work permission", async () => {
  const rule = {
    primary: "Kosovo",
    fallback: "Albania",
    whenNeitherOffered: "skip_application" as const,
  };
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(() =>
    Promise.resolve({
      content: JSON.stringify({
        fits: [
          {
            id: 1,
            s: 95,
            why: "Your listed country choice is accepted",
            r: ["strong", "Requested work"],
            p: ["aligned", "Your saved rule matches"],
            c: ["strong", "Direct evidence"],
            e: [
              "compatible",
              "Albania, Serbia and Montenegro",
              "offered_list",
              "AL,RS,ME",
            ],
          },
        ],
      }),
    }),
  );
  await fitJobs({
    client: { chatWithTools },
    profile,
    jobs: [
      {
        ...job,
        location: "Remote",
        description: "Offered country choices: Albania, Serbia and Montenegro.",
      },
    ],
    countryOptionFallbacks: [rule],
    goals: { targetRoles: [], locations: [] },
  });
  const [messages] = chatWithTools.mock.calls[0];
  const data = JSON.parse(messages[1].content) as {
    person: {
      currentCountry: string;
      currentCity: string;
      currentRegion: string;
      workEligibility: { authorizedWorkCountries: string[] };
    };
    countryOptionFallbacks: Array<typeof rule>;
  };
  expect(data.person).toMatchObject({
    currentCountry: "Kosovo",
    currentCity: "Pristina",
    currentRegion: "Pristina",
  });
  expect(data.person.workEligibility.authorizedWorkCountries).toEqual([
    "Kosovo",
  ]);
  expect(data.countryOptionFallbacks).toEqual([rule]);
  expect(messages[0].content).toContain("Neither choice offered is a conflict");
  expect(messages[0].content).toContain(
    "fit label never grants work permission",
  );
});

test("fit gets the person's saved eligibility answers as facts and reads preferences as preferences", async () => {
  const savedAnswers = [
    {
      question: "Are you legally authorized to work in the United States?*",
      answer: "Yes",
    },
    {
      question:
        "United States work authorization and citizenship status (both questions on one form, or either one)",
      answer:
        "I am legally authorized to work in the US (Yes). I am not a US citizen or permanent resident.",
    },
  ];
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(() =>
    Promise.resolve({
      content: JSON.stringify({
        fits: [
          {
            id: 1,
            s: 80,
            why: "Your US authorization meets the residence requirement",
            r: ["strong", "Requested work"],
            p: ["aligned", "Remote"],
            c: ["strong", "Direct evidence"],
            e: [
              "compatible",
              "must reside in the United States",
              "country_remote",
              "US",
            ],
          },
        ],
      }),
    }),
  );
  await fitJobs({
    client: { chatWithTools },
    profile,
    jobs: [job],
    savedAnswers,
    goals: { targetRoles: [], locations: [] },
  });
  const [messages] = chatWithTools.mock.calls[0];
  const data = JSON.parse(messages[1].content) as {
    savedAnswers: typeof savedAnswers;
  };
  expect(data.savedAnswers).toEqual(savedAnswers);
  expect(messages[0].content).toContain(
    "Their answers about work authorization, citizenship, permanent residence, visas, sponsorship, clearance and similar eligibility are established facts for e and h",
  );
  expect(messages[0].content).toContain(
    "A preferred, nice-to-have or bonus qualification is not a requirement, and a requirement the listing states as alternatives (X, Y or Z) is met by any one of them",
  );
});

test("different fit batches retain the exact context prefix and response schema", async () => {
  const requests: Parameters<LLMClient["chatWithTools"]>[] = [];
  const client: LLMClient = {
    chatWithTools: (...args) => {
      requests.push(args);
      const { listings } = JSON.parse(args[0][1].content) as {
        listings: { id: number }[];
      };
      return Promise.resolve({
        content: JSON.stringify({
          fits: listings.map(({ id }) => ({
            id,
            s: 90,
            why: "Matching work",
            r: ["strong", "Direct work"],
            p: ["aligned", "Remote"],
            c: ["strong", "Evidence"],
            e: ["compatible", "Worldwide remote", "broader_remote", ""],
          })),
        }),
      });
    },
  };
  for (const ids of [[1], [20, 21]]) {
    await fitJobs({
      client,
      profile,
      goals: { targetRoles: ["Software Engineer"], locations: ["Europe"] },
      countryOptionFallbacks: [
        {
          primary: "Kosovo",
          fallback: "Albania",
          whenNeitherOffered: "skip_application",
        },
      ],
      request: "Hands-on product work",
      jobs: ids.map((id) => ({
        ...job,
        id,
        description: `Complete listing ${id}. Worldwide remote.`,
      })),
    });
  }
  expect(requests[0][0][0]).toEqual(requests[1][0][0]);
  expect(requests[0][2]?.jsonSchema).toEqual(requests[1][2]?.jsonSchema);
  const prefixes = requests.map(
    ([messages]) => messages[1].content.split(',"listings":')[0],
  );
  expect(prefixes[0]).toBe(prefixes[1]);
  expect(Object.keys(JSON.parse(requests[0][0][1].content) as object)).toEqual([
    "assessmentDate",
    "person",
    "goals",
    "countryOptionFallbacks",
    "request",
    "listings",
  ]);
  expect(requests[0][0][1].content).not.toBe(requests[1][0][1].content);
});

test("a stable schema still rejects a verdict for a job outside the batch", async () => {
  let calls = 0;
  const fits = await fitJobs({
    profile,
    jobs: [job],
    goals: { targetRoles: [], locations: [] },
    client: {
      chatWithTools: () =>
        Promise.resolve({
          content: JSON.stringify({
            fits: [
              {
                id: ++calls === 1 ? 999 : job.id,
                s: 90,
                why: "Matching work",
                r: ["strong", "Work"],
                p: ["aligned", "Remote"],
                c: ["strong", "Evidence"],
                e: ["compatible", "Worldwide", "broader_remote", ""],
              },
            ],
          }),
        }),
    },
  });
  expect(calls).toBe(2);
  expect(fits.map(({ id }) => id)).toEqual([job.id]);
});
