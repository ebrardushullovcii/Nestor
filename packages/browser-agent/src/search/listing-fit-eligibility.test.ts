import {
  CandidateProfileSchema,
  JobDetailSchema,
  JOB_FIT_BANDS,
} from "@nestor/contracts";
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

test.each([
  ["US-only residence contradicts your country", "blocked", 99, 39],
  ["Required work authorization is not known", "review", 99, 84],
  ["Worldwide remote includes your country", "compatible", 99, 99],
  ["Europe hiring includes your country", "compatible", 90, 90],
  ["EU-only hiring excludes your country", "blocked", 90, 39],
  ["A low role score is never promoted", "compatible", 20, 20],
] as const)("%s", async (reason, status, score, expected) => {
  const client: LLMClient = {
    chatWithTools: () =>
      Promise.resolve({
        content: JSON.stringify({
          fits: [
            {
              id: 1,
              s: score,
              why: "Exact skills",
              r: ["strong", "Requested work"],
              p: ["aligned", "Remote work"],
              c: ["strong", "Direct evidence"],
              e: [status, reason],
            },
          ],
        }),
      }),
  };
  const [fit] = await fitJobs({
    client,
    profile,
    jobs: [job],
    goals: { targetRoles: ["Software Engineer"], locations: ["Europe"] },
  });
  expect(fit?.score).toBe(expected);
  if (status === "blocked") {
    expect(fit?.score).toBeLessThan(JOB_FIT_BANDS.good);
    expect(fit?.preferences).toEqual({
      assessment: "conflict",
      explanation: reason,
    });
  }
  if (score > expected) expect(fit?.summary).toBe(reason);
});

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
            e: ["compatible", "Your saved country-list rule applies"],
          },
        ],
      }),
    }),
  );
  await fitJobs({
    client: { chatWithTools },
    profile,
    jobs: [job],
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
  expect(messages[0].content).toContain(
    "Neither choice offered is a conflict",
  );
  expect(messages[0].content).toContain("never Strong");
});

test("a response with no eligibility verdict cannot silently become Strong", async () => {
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
                s: 99,
                why: "Exact skills",
                r: ["strong", "Requested work"],
                p: ["aligned", "Remote"],
                c: ["strong", "Direct evidence"],
              },
            ],
          }),
        }),
    },
  });
  expect(fit?.score).toBe(JOB_FIT_BANDS.strong - 1);
  expect(fit?.preferences.assessment).toBe("unknown");
});
