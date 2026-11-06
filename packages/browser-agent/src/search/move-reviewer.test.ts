import { CandidateProfileSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import type { LLMClient } from "../agent/contracts";
import type { AgentConfig } from "../types";
import { createMoveReviewer, describeSearchGoal } from "./move-reviewer";

function config(): AgentConfig {
  return {
    source: "target_site",
    maxSteps: 60,
    targetJobCount: 10,
    userProfile: CandidateProfileSchema.parse({
      id: "candidate_test",
      firstName: "Robin",
      lastName: "Ashford",
      fullName: "Robin Ashford",
      headline: "Platform engineer",
      summary: "Builds tools.",
      currentLocation: "Manchester",
      yearsExperience: 8,
      baseResume: {
        id: "resume_test",
        fileName: "resume.txt",
        uploadedAt: "2026-09-01T09:00:00.000Z",
        textContent: "8 years.",
        textUpdatedAt: "2026-09-01T09:00:00.000Z",
        extractionStatus: "ready",
      },
    }),
    searchPreferences: { targetRoles: ["Platform Engineer"], locations: ["Manchester"] },
    startingUrls: ["https://jobs.example.test/search"],
    navigationPolicy: { allowedHostnames: ["jobs.example.test"] },
    promptContext: { siteLabel: "the example board" },
  };
}

describe("move reviewer", () => {
  test("does not give the move reviewer a hidden default result cap", () => {
    const goal = describeSearchGoal({ ...config(), retainAllFound: true });
    expect(goal).toContain("Find all suitable current job postings");
    expect(goal).not.toContain("up to 10");
  });

  test("hands the goal, the addresses, and the reason to the model and returns its decision", async () => {
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(() =>
      Promise.resolve({
        toolCalls: [
          {
            id: "d1",
            type: "function" as const,
            function: {
              name: "decide",
              arguments: JSON.stringify({ allowed: true, verdict: "The employer page is where the posting lives." }),
            },
          },
        ],
      }),
    );
    const review = createMoveReviewer({
      llmClient: { chatWithTools },
      goal: describeSearchGoal(config()),
      homeLabel: "the example board",
      homeHosts: ["jobs.example.test"],
    });

    const verdict = await review({
      url: "https://employer.example.test/jobs/1",
      reason: "The card links there for the full posting",
      fromUrl: "https://jobs.example.test/search",
    });

    expect(verdict).toEqual({ allowed: true, verdict: "The employer page is where the posting lives." });
    const prompt = chatWithTools.mock.calls[0]?.[0].map((message) => message.content).join("\n") ?? "";
    expect(prompt).toContain("Platform Engineer");
    expect(prompt).toContain("https://employer.example.test/jobs/1");
    expect(prompt).toContain("The card links there for the full posting");
    expect(chatWithTools.mock.calls[0]?.[1].map((tool) => tool.function.name)).toEqual(["decide"]);
  });

  test("no decision, or a failed review, refuses the move rather than allowing it", async () => {
    const home = { goal: describeSearchGoal(config()), homeLabel: "the example board", homeHosts: ["jobs.example.test"] };
    const silent = createMoveReviewer({
      llmClient: { chatWithTools: () => Promise.resolve({ content: "hmm" }) },
      ...home,
    });
    expect((await silent({ url: "https://x.test", reason: "r", fromUrl: null })).allowed).toBe(false);

    const failing = createMoveReviewer({
      llmClient: { chatWithTools: () => Promise.reject(new Error("provider down")) },
      ...home,
    });
    const verdict = await failing({ url: "https://x.test", reason: "r", fromUrl: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.verdict).toContain("could not be made");
  });
});

test("an interrupted review with an active run refuses this move with its cause and can retry", async () => {
  const controller=new AbortController();
  const chatWithTools=vi.fn<LLMClient["chatWithTools"]>()
    .mockRejectedValueOnce(new DOMException("The review connection was interrupted","AbortError"))
    .mockResolvedValueOnce({toolCalls:[{id:"decision",type:"function",function:{name:"decide",arguments:JSON.stringify({allowed:true,verdict:"Observed employer handoff"})}}]});
  const review=createMoveReviewer({llmClient:{chatWithTools},goal:"Read the listing",homeLabel:"Board",homeHosts:["board.test"],signal:controller.signal});
  const move={url:"https://employer.test/jobs/1",fromUrl:"https://board.test",reason:"The listing links to the employer"};
  const failed = await review(move);
  expect(failed.allowed).toBe(false);
  expect(failed.verdict).toContain("review connection was interrupted");
  expect((await review(move)).allowed).toBe(true);
  expect(controller.signal.aborted).toBe(false);
});

test("a real Stop still interrupts a move review", async () => {
  const controller=new AbortController();const cause=new DOMException("The person pressed Stop","AbortError");
  const review=createMoveReviewer({llmClient:{chatWithTools:()=>{controller.abort(cause);return Promise.reject(cause);}},goal:"Read",homeLabel:"Board",homeHosts:["board.test"],signal:controller.signal});
  await expect(review({url:"https://employer.test",fromUrl:"https://board.test",reason:"Employer handoff"})).rejects.toBe(cause);
});
