import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  DiscoveryPageReadError,
  DiscoveryRunResultSchema,
  JobDiscoveryTargetSchema,
  JobSearchSettingsSchema,
} from "@nestor/contracts";
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
              e: ["compatible", "Fully remote worldwide", "broader_remote", ""],
              h: ["met", "No unmet mandatory requirements."],
              pay: {
                minimum: null,
                maximum: null,
                currency: null,
                interval: null,
                basis: null,
                quote: "",
              },
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
    expect(
      chatWithTools.mock.calls.map((call) => call[2]?.conversationKey),
    ).toEqual([
      `fit-judging:${seed.profile.id}`,
      `fit-judging:${seed.profile.id}`,
    ]);
  } finally {
    store.close();
  }
});

test.each([999, 403, 429])(
  "HTTP %s continues through browser navigation and reads the full listing",
  async (status) => {
    const seed = createSeed();
    const sourceUrl = "https://board.example/jobs";
    const target = JobDiscoveryTargetSchema.parse({
      id: "1",
      label: "Synthetic board",
      startingUrl: sourceUrl,
    });
    const fullText =
      "Complete requirements: TypeScript and Albanian. " +
      "Full duties. ".repeat(4000);
    const job = {
      ...seed.savedJobs[0]!,
      canonicalUrl: "https://board.example/vacancy/one",
      source: "target_site",
      description: fullText,
    };
    const runAgentDiscovery = vi.fn<
      NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>
    >(() =>
      Promise.resolve(
        DiscoveryRunResultSchema.parse({
          source: "target_site",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          querySummary: "Synthetic search",
          warning: null,
          jobs: [job],
          inventoryCompleteness: "complete",
          agentMetadata: {
            incomplete: false,
            phaseCompletionMode: "structured_finish",
          },
        }),
      ),
    );
    const readRenderedPage = vi.fn(() => {
      throw new DiscoveryPageReadError(status);
    });
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response("Site refusal", { status })),
      );
    const engine = createListingSearchEngine({
      aiClient: {
        ...createDeterministicJobFinderAiClient(),
        chatWithTools: () => Promise.resolve({ content: "{}" }),
      },
      browserRuntime: { readRenderedPage, runAgentDiscovery },
    });
    const context = {
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      sources: [],
      sourceInstructionArtifacts: [],
      browserPermissions: {
        signIn: true,
        googleSignIn: true,
        createAccounts: true,
        solveCaptchas: true,
      },
    };
    const input = {
      target,
      context,
      settings: JobSearchSettingsSchema.parse({ depth: "thorough" }),
      signal: new AbortController().signal,
      message: () => {},
      knownUrls: () => [],
    };
    try {
      const http = await engine.collectSource({ ...input, lane: "http" });
      expect(http.requiresBrowser).toBe(true);
      const browser = await engine.collectSource({ ...input, lane: "browser" });
      expect(browser.complete).toBe(true);
      expect(browser.needsYou).not.toBe(true);
      expect(runAgentDiscovery).toHaveBeenCalledOnce();
      const read = await engine.readListings({
        cards: browser.cards,
        context,
        lane: "browser",
        signal: input.signal,
      });
      expect(read.failures).toEqual([]);
      expect(read.jobs[0]?.description).toBe(fullText.trim());
      expect(runAgentDiscovery).toHaveBeenCalledTimes(2);
      expect(runAgentDiscovery.mock.calls[0]?.[1]).toMatchObject({
        browserPermissions: context.browserPermissions,
        dedicatedPage: true,
      });
    } finally {
      request.mockRestore();
    }
  },
);
