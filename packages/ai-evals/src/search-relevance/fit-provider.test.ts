import { afterEach, expect, test, vi } from "vitest";
import {
  createOpenAiCompatibleJobFinderAiClient,
  modelOutputLimit,
} from "@nestor/ai-providers";
import { fitJobs } from "@nestor/browser-agent";
import { CandidateProfileSchema, JobDetailSchema } from "@nestor/contracts";
import { searchPersonas } from "./personas";

const persona = searchPersonas[1]!;
const jobs = Array.from({ length: 48 }, (_, i) =>
  JobDetailSchema.parse({
    id: i + 1,
    title: "Senior Frontend Engineer",
    company: `Synthetic Employer ${i}`,
    location: "Remote worldwide",
    workModes: ["remote"],
    stage: "found",
    stageChangedAt: "2026-11-06T00:00:00Z",
    foundAt: "2026-11-06T00:00:00Z",
    seenAt: "2026-11-06T00:00:00Z",
    sourceLabel: "Synthetic",
    sourceCount: 1,
    url: `https://example.test/${i}`,
    applyUrl: null,
    description:
      "Remote worldwide. Build accessible React and TypeScript web products. Five years of frontend delivery required; GraphQL preferred. USD 140000–180000 per year.",
    stageNote: null,
    postedAt: null,
    searchId: null,
    salaryText: null,
    summary: null,
    seniority: null,
    employmentType: null,
    salary: null,
    fit: null,
    fitScore: null,
    fitSummary: null,
    facts: {},
    sightings: [],
  }),
);
const fits = jobs.map(({ id }) => ({
  id,
  s: 91,
  why: "Your React product delivery matches; confirm the team's GraphQL depth expectations.",
  w: "React match; GraphQL depth",
  e: {
    status: "compatible",
    quote: "Remote worldwide",
    kind: "broader_remote",
    countries: "",
    publishedLocation: "Remote worldwide",
    workCountry: "US",
    residence: {
      status: "met",
      reason: "Worldwide remote includes your US location.",
    },
    authorization: {
      status: "not_required",
      reason: "No specific authorization requirement is published.",
    },
  },
  r: {
    status: "strong",
    reason:
      "Your accessible React products directly match the advertised daily work.",
  },
  p: {
    status: "aligned",
    reason:
      "Worldwide remote work supports your Chicago location and senior IC goals.",
  },
  c: {
    status: "strong",
    reason:
      "Your seven years of React and TypeScript support the required experience.",
  },
  h: {
    status: "met",
    reason: "Your saved frontend delivery exceeds the five-year requirement.",
  },
  pay: {
    minimum: 140000,
    maximum: 180000,
    currency: "USD",
    interval: "year",
    basis: "base",
    quote: "USD 140000–180000 per year",
  },
}));
const content = JSON.stringify({ fits });
afterEach(() => vi.unstubAllGlobals());

test.each(["none", "low", "medium", "high", "xhigh", "max"] as const)(
  "accepts all 48 realistic Responses fit rows at %s effort after one retry at the model maximum",
  async (effort) => {
    expect(content.length).toBeGreaterThan(35000);
    const bodies: Array<{
      max_output_tokens: number;
      reasoning: { effort: string };
      temperature?: number;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, options: RequestInit) => {
        if (typeof options.body !== "string")
          throw new Error("Expected JSON request body");
        bodies.push(JSON.parse(options.body) as (typeof bodies)[number]);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              bodies.length === 1
                ? {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                    output_text: content.slice(0, 300),
                  }
                : { status: "completed", output_text: content },
            ),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "synthetic",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "muse-spark-1.3-contributor",
      apiMode: "responses",
      streaming: false,
      maxAttempts: 1,
      taskReasoningEfforts: { fit_batch: effort },
    });
    const result = await fitJobs({
      client: { chatWithTools: (...args) => client.chatWithTools(...args) },
      profile: persona.profile,
      goals: persona.goals,
      jobs,
    });
    expect(result.map(({ id }) => id)).toEqual(jobs.map(({ id }) => id));
    expect(bodies.map((body) => body.max_output_tokens)).toEqual([
      modelOutputLimit("muse-spark-1.3-contributor"),
      modelOutputLimit("muse-spark-1.3-contributor"),
    ]);
    expect(bodies.every((body) => body.reasoning?.effort === effort)).toBe(
      true,
    );
    expect(bodies.every((body) => body.temperature === 0)).toBe(true);
  },
);

test("the live fit path receives every profile record and a requirement in the middle of a long posting", async () => {
  const profile = CandidateProfileSchema.parse({
    ...persona.profile,
    skills: Array.from({ length: 90 }, (_, i) => `Synthetic skill ${i}`),
    experiences: Array.from({ length: 16 }, (_, i) => ({
      ...persona.profile.experiences[0],
      id: `synthetic_role_${i}`,
    })),
    projects: Array.from({ length: 20 }, (_, i) => ({
      id: `synthetic_project_${i}`,
      name: `Synthetic project ${i}`,
      summary: "Confirmed project evidence",
      skills: [],
    })),
  });
  const description = `${"Published introduction. ".repeat(240)} Europe-only residence and current work authorization required. ${"Published duties. ".repeat(240)}`;
  const seen: string[] = [];
  await fitJobs({
    profile,
    goals: persona.goals,
    jobs: [{ ...jobs[0]!, description }],
    client: {
      chatWithTools: (messages) => {
        seen.push(String(messages[1]!.content));
        return Promise.resolve({
          content: JSON.stringify({
            fits: [
              {
                ...fits[0]!,
                e: {
                  ...fits[0]!.e,
                  status: "review",
                  residence: {
                    status: "unknown",
                    reason: "Your eligibility needs checking.",
                  },
                },
              },
            ],
          }),
        });
      },
    },
  });
  const request = JSON.parse(seen[0]!) as {
    person: { skills: string[]; experiences: unknown[]; projects: unknown[] };
    listings: { description: string }[];
  };
  expect(request.person.skills).toEqual(profile.skills);
  expect(request.person.experiences).toHaveLength(16);
  expect(request.person.projects).toHaveLength(20);
  expect(request.listings[0]!.description).toBe(description);
});

test.each(["length", "max_output_tokens", "transport"])(
  "reports repeated %s truncation after exactly two calls",
  async (reason) => {
    const chatWithTools = vi.fn(() =>
      reason === "transport"
        ? Promise.reject(
            new Error(
              "Model returned an incomplete response: max_output_tokens",
            ),
          )
        : Promise.resolve({ content, finishReason: reason }),
    );
    await expect(
      fitJobs({
        client: { chatWithTools },
        profile: persona.profile,
        goals: persona.goals,
        jobs,
      }),
    ).rejects.toThrow("output limit");
    expect(chatWithTools).toHaveBeenCalledTimes(2);
  },
);

test("a recorded fit request keeps its assessment date on later replays", async () => {
  const requests: string[] = [];
  const chatWithTools = vi.fn((messages: Array<{ content: string }>) => {
    requests.push(messages[1]!.content);
    return Promise.resolve({ content: JSON.stringify({ fits: [fits[0]] }) });
  });
  await fitJobs({
    client: { chatWithTools },
    profile: persona.profile,
    goals: persona.goals,
    jobs: jobs.slice(0, 1),
    assessmentDate: "2026-10-26",
  });
  expect(JSON.parse(requests[0]!) as { assessmentDate: string }).toMatchObject({
    assessmentDate: "2026-10-26",
  });
});
