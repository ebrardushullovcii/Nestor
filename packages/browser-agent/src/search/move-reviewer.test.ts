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
