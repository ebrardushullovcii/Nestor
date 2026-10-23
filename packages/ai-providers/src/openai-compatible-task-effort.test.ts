import { afterEach, expect, test, vi } from "vitest";
import { createJobFinderAiClientFromEnvironment } from "./openai-compatible";
import type { ModelReasoningTask } from "./openai-compatible-transport";
import {
  createEnvironment,
  createJobPosting,
  createPreferences,
  createProfile,
} from "./test-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Records the effort each request asked for; answers every call with `{}`-ish JSON. */
function captureEfforts(): Array<{ model: string; effort: string | null }> {
  const requests: Array<{ model: string; effort: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { model: string; reasoning_effort?: string };
      requests.push({ model: body.model, effort: body.reasoning_effort ?? null });
      const content = JSON.stringify({
        jobs: [],
        judgments: [],
        checks: [],
        score: 50,
        reasons: [],
        gaps: [],
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: "stop" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  return requests;
}

// The owner's dogfood settings: everything at high before per-task effort.
const ownerEnvironment = {
  NESTOR_AI_MODEL: "primary-model",
  NESTOR_AI_REASONING_EFFORT: "high",
  NESTOR_AI_AGENT_REASONING_EFFORT: "high",
  NESTOR_AI_AGGRESSIVE_MODEL: "aggressive-model",
  NESTOR_AI_AGGRESSIVE_API_MODE: "chat_completions",
  NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "high",
};

const claimInput = {
  tailoringStrength: "balanced",
  job: { title: "Data Analyst", company: "Northwind", description: "SQL." },
  evidence: [{ id: "experience:1", text: "Built SQL dashboards." }],
  resumeText: null,
  claims: [{ id: "a", section: "Experience", text: "Built SQL dashboards." }],
};

test("each task asks for its own effort; the writer keeps the main effort", async () => {
  const requests = captureEfforts();
  const client = createJobFinderAiClientFromEnvironment(
    createEnvironment(ownerEnvironment),
  );
  const turn = (reasoningTask: ModelReasoningTask | undefined) =>
    client.chatWithTools!(
      [{ role: "user", content: "Synthetic turn" }],
      [],
      reasoningTask ? { reasoningTask } : {},
    );

  await turn("search");
  await turn("apply");
  await turn("claim_check");
  await turn("resume_writer");
  await turn(undefined);
  await client.extractJobsFromPage({
    pageText: "Analyst at Northwind",
    pageUrl: "https://jobs.example.test/search",
    pageType: "search_results",
    maxJobs: 5,
  });
  await client.judgeJobFits!({
    assessmentDate: "2026-10-21",
    profile: createProfile(),
    searchPreferences: createPreferences(),
    jobs: [{ jobId: "job_1", posting: createJobPosting() }],
  });
  await client.checkResumeClaims!(claimInput);
  await client.assessJobFit({
    profile: createProfile(),
    searchPreferences: createPreferences(),
    job: createJobPosting(),
  });

  expect(requests.map((request) => request.effort)).toEqual([
    "low", // search turn
    "low", // application form turn
    "medium", // answer fact check
    "high", // resume writer: NESTOR_AI_REASONING_EFFORT
    "high", // untagged tool work: NESTOR_AI_AGENT_REASONING_EFFORT
    "low", // page read
    "medium", // fit batch
    "medium", // resume claim check
    "high", // full listing read
  ]);
});

test("every task effort can be overridden by its own variable", async () => {
  const requests = captureEfforts();
  const client = createJobFinderAiClientFromEnvironment(
    createEnvironment({
      ...ownerEnvironment,
      NESTOR_AI_SEARCH_REASONING_EFFORT: "medium",
      NESTOR_AI_APPLY_REASONING_EFFORT: "medium",
      NESTOR_AI_PAGE_READ_REASONING_EFFORT: "none",
      NESTOR_AI_FIT_REASONING_EFFORT: "low",
      NESTOR_AI_CLAIM_CHECK_REASONING_EFFORT: "high",
      NESTOR_AI_LISTING_READ_REASONING_EFFORT: "medium",
      NESTOR_AI_REASONING_EFFORT: "xhigh",
    }),
  );
  for (const reasoningTask of [
    "search",
    "apply",
    "resume_writer",
  ] as const) {
    await client.chatWithTools!(
      [{ role: "user", content: "Synthetic turn" }],
      [],
      { reasoningTask },
    );
  }
  await client.extractJobsFromPage({
    pageText: "Analyst at Northwind",
    pageUrl: "https://jobs.example.test/search",
    pageType: "search_results",
    maxJobs: 5,
  });
  await client.judgeJobFits!({
    assessmentDate: "2026-10-21",
    profile: createProfile(),
    searchPreferences: createPreferences(),
    jobs: [{ jobId: "job_1", posting: createJobPosting() }],
  });
  await client.checkResumeClaims!(claimInput);
  await client.assessJobFit({
    profile: createProfile(),
    searchPreferences: createPreferences(),
    job: createJobPosting(),
  });
  expect(requests.map((request) => request.effort)).toEqual([
    "medium",
    "medium",
    "xhigh",
    "none",
    "low",
    "high",
    "medium",
  ]);
});

test("the aggressive route keeps its model, but its fact checks use the check effort", async () => {
  const requests = captureEfforts();
  const client = createJobFinderAiClientFromEnvironment(
    createEnvironment({
      ...ownerEnvironment,
      NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "max",
    }),
  );
  await client.checkResumeClaims!({
    ...claimInput,
    tailoringStrength: "aggressive",
  });
  expect(requests).toEqual([{ model: "aggressive-model", effort: "medium" }]);
});

test("a full listing read nobody waits on runs at the fit-check effort", async () => {
  const requests = captureEfforts();
  const client = createJobFinderAiClientFromEnvironment(
    createEnvironment(ownerEnvironment),
  );
  const input = {
    profile: createProfile(),
    searchPreferences: createPreferences(),
    job: createJobPosting(),
  };
  await client.assessJobFit({ ...input, background: true });
  await client.assessJobFit(input);
  expect(requests.map((request) => request.effort)).toEqual([
    "medium", // a search refreshing an older full read
    "high", // the person pressed "Judge fit"
  ]);
});

test("card and detail extraction preserve the existing page-read effort and its override", async () => {
  const requests = captureEfforts();
  for (const overrides of [
    {},
    {
      NESTOR_AI_PAGE_READ_REASONING_EFFORT: "medium",
      NESTOR_AI_LISTING_READ_REASONING_EFFORT: "medium",
    },
  ]) {
    const client = createJobFinderAiClientFromEnvironment(
      createEnvironment({ ...ownerEnvironment, ...overrides }),
    );
    for (const pageType of ["search_results", "job_detail"] as const) {
      await client.extractJobsFromPage({
        pageText: "Analyst at Northwind",
        pageUrl: "https://jobs.example.test/job/1",
        pageType,
        maxJobs: 1,
      });
    }
  }
  expect(requests.map((request) => request.effort)).toEqual([
    "low",
    "low",
    "medium",
    "medium",
  ]);
});
