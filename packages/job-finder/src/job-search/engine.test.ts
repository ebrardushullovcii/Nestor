import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import { openJobStore } from "@nestor/db/job-store";
import { expect, test, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import { createListingSearchEngine } from "./engine";

test("passes remote location policy into fit and retains the model's changed score", async () => {
  const seed = createSeed();
  const store = openJobStore(":memory:");
  try {
    const [id] = store.saveFoundJobs({
      searchId: null,
      jobs: [
        {
          title: "Frontend Engineer",
          company: "Synthetic Lab",
          location: "Remote, worldwide",
          workModes: ["remote"],
          url: "https://synthetic.test/job",
          applyUrl: null,
          sourceId: "test",
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
            "Build React and TypeScript products. Fully remote worldwide.",
        },
      ],
    }).added;
    const chatWithTools = vi.fn<
      NonNullable<JobFinderAiClient["chatWithTools"]>
    >((messages) => {
      const data = JSON.parse(messages[1]!.content) as {
        goals: { remoteCountsAsAnyLocation?: boolean };
      };
      const off = data.goals.remoteCountsAsAnyLocation === false;
      expect(messages[0]!.content.includes("remote alone does not match")).toBe(
        off,
      );
      return Promise.resolve({
        content: JSON.stringify({
          fits: [
            {
              id,
              s: off ? 45 : 92,
              why: off
                ? "Saved place does not match."
                : "Matching remote work.",
              r: ["strong", "Requested work."],
              p: [off ? "conflict" : "aligned", "Location preference."],
              c: ["strong", "React and TypeScript experience."],
            },
          ],
        }),
      });
    });
    const engine = createListingSearchEngine({
      aiClient: { ...createDeterministicJobFinderAiClient(), chatWithTools },
      browserRuntime: {},
    });
    const context = {
      profile: seed.profile,
      searchPreferences: { ...seed.searchPreferences, locations: ["Berlin"] },
      sources: [],
      sourceInstructionArtifacts: [],
    };
    const judge = (remoteCountsAsAnyLocation: boolean) =>
      engine.fitJobs({
        jobs: [store.getJob(id!)!],
        context: { ...context, remoteCountsAsAnyLocation },
        signal: new AbortController().signal,
      });
    expect((await judge(true))[0]?.score).toBe(92);
    expect((await judge(false))[0]).toMatchObject({
      score: 45,
      preferences: { assessment: "conflict" },
    });
    expect(chatWithTools).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});
