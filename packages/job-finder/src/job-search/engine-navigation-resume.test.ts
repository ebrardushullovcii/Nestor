import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import type { AgentDiscoveryOptions } from "@nestor/browser-runtime";
import {
  DiscoveryRunResultSchema,
  JobDiscoveryTargetSchema,
  JobSearchSettingsSchema,
  SourceDebugPhaseEvidenceSchema,
  type BrowserAgentRunCheckpoint,
  type JobPosting,
  type SourceNavigationProgress,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import { createListingSearchEngine } from "./engine";

/** Collection makes no model call of its own here: navigation is scripted. */
const scriptedModel = () => ({
  ...createDeterministicJobFinderAiClient(),
  chatWithTools: vi.fn(() =>
    Promise.reject(new Error("No model call was expected.")),
  ),
});

test("a browser collection cut short by a restart continues from the page it reached, and one the model finished is not repeated", async () => {
  const seed = createSeed();
  const target = JobDiscoveryTargetSchema.parse({
    id: "source",
    label: "Synthetic board",
    startingUrl: "https://careers.example/jobs",
  });
  const context = {
    profile: seed.profile,
    searchPreferences: seed.searchPreferences,
    sources: [],
    sourceInstructionArtifacts: [],
  };
  const settings = JobSearchSettingsSchema.parse({});
  const posting = (n: number): JobPosting => ({
    ...seed.savedJobs[0]!,
    canonicalUrl: `https://careers.example/jobs/${n}`,
    title: `Platform Engineer ${n}`,
    description: "Synthetic card",
    company: "Synthetic Employer",
    location: "Berlin",
    listingDetailFetch: null,
  });
  const page = (n: number) => `https://careers.example/jobs?page=${n}`;
  const checkpoint = (
    at: number,
    jobs: JobPosting[],
    visited: string[],
  ): BrowserAgentRunCheckpoint => ({
    revision: at,
    savedAt: new Date().toISOString(),
    currentUrl: page(at),
    lastStableUrl: page(at),
    stepCount: at * 2,
    collectedJobs: jobs,
    visitedUrls: visited,
    phaseEvidence: SourceDebugPhaseEvidenceSchema.parse({}),
  });
  // The store keeps progress across processes; a Map stands in for it here.
  const saved = new Map<string, SourceNavigationProgress>();
  const navigation = {
    read: (startUrl: string) => saved.get(startUrl) ?? null,
    save: (startUrl: string, progress: SourceNavigationProgress) => {
      saved.set(startUrl, structuredClone(progress));
    },
  };
  const runs: AgentDiscoveryOptions[] = [];
  const quit = new Error("The app quit");
  let run = 0;
  const runAgentDiscovery = vi.fn(
    async (_source: unknown, options: AgentDiscoveryOptions) => {
      runs.push(options);
      run++;
      if (run === 1) {
        await options.onCheckpoint?.(
          checkpoint(1, [posting(1)], [target.startingUrl]),
        );
        await options.onCheckpoint?.(
          checkpoint(
            2,
            [posting(1), posting(2)],
            [target.startingUrl, page(2)],
          ),
        );
        throw quit;
      }
      await options.onCheckpoint?.(
        checkpoint(3, [posting(3)], [target.startingUrl, page(2), page(3)]),
      );
      return DiscoveryRunResultSchema.parse({
        source: "target_site",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        querySummary: "Synthetic",
        warning: null,
        jobs: [posting(3)],
        agentMetadata: {
          pagesCovered: 3,
          incomplete: false,
          phaseCompletionMode: "structured_finish",
          phaseCompletionReason: "Read pages 1 to 3 of 3.",
        },
      });
    },
  );
  const engine = createListingSearchEngine({
    aiClient: scriptedModel(),
    browserRuntime: {
      // The board draws its list with script: browser navigation reads it.
      readRenderedPage: (url: string) =>
        Promise.resolve({
          finalUrl: url,
          html: '<main><p>Loading...</p><script src="/app.js"></script></main>',
        }),
      runAgentDiscovery,
    },
  });
  const accepted: string[] = [];
  const collect = () =>
    engine.collectSource({
      target,
      context,
      settings,
      signal: new AbortController().signal,
      lane: "browser",
      navigation,
      message: () => {},
      knownUrls: () => [],
      onCards: (cards) => {
        accepted.push(...cards.map((card) => card.url));
        return Promise.resolve();
      },
    });

  await expect(collect()).rejects.toBe(quit);
  expect(saved.get(target.startingUrl)).toMatchObject({
    currentUrl: page(2),
    visitedUrls: [target.startingUrl, page(2)],
    collected: 2,
  });
  expect(saved.get(target.startingUrl)?.outcome).toBeUndefined();

  // The next process starts at the page the collection had reached and
  // tells the model what the earlier run did.
  const resumed = await collect();
  expect(runs[1]?.startingUrls).toEqual([page(2), target.startingUrl]);
  expect(runs[1]?.resumeCheckpoint).toMatchObject({
    currentUrl: page(2),
    collectedJobs: [],
    collectedEarlier: 2,
    visitedUrls: [target.startingUrl, page(2)],
  });
  expect(resumed).toMatchObject({ complete: true, resumed: true });
  expect(saved.get(target.startingUrl)).toMatchObject({
    currentUrl: page(3),
    collected: 3,
    outcome: { complete: true, pagesRead: 3 },
  });

  // Its cards were accepted as they were collected; a later restart reuses
  // the finished collection instead of navigating the site again.
  const again = await collect();
  expect(runAgentDiscovery).toHaveBeenCalledTimes(2);
  expect(again).toMatchObject({ complete: true, resumed: true, cards: [] });
  expect([...new Set(accepted)].sort()).toEqual([
    "https://careers.example/jobs/1",
    "https://careers.example/jobs/2",
    "https://careers.example/jobs/3",
  ]);
});

test("a collection an outage cut short is resumed, not reused as finished", async () => {
  const seed = createSeed();
  const target = JobDiscoveryTargetSchema.parse({
    id: "source",
    label: "Synthetic board",
    startingUrl: "https://careers.example/jobs",
  });
  const saved = new Map<string, SourceNavigationProgress>();
  const runAgentDiscovery = vi.fn(() =>
    Promise.resolve(
      DiscoveryRunResultSchema.parse({
        source: "target_site",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        querySummary: "Synthetic",
        warning:
          "The AI service is unavailable right now. Nothing was changed.",
        jobs: [],
        agentMetadata: {
          incomplete: true,
          phaseCompletionMode: null,
        },
      }),
    ),
  );
  const engine = createListingSearchEngine({
    aiClient: scriptedModel(),
    browserRuntime: {
      readRenderedPage: (url: string) =>
        Promise.resolve({
          finalUrl: url,
          html: '<main><p>Loading...</p><script src="/app.js"></script></main>',
        }),
      runAgentDiscovery,
    },
  });
  const collect = () =>
    engine.collectSource({
      target,
      context: {
        profile: seed.profile,
        searchPreferences: seed.searchPreferences,
        sources: [],
        sourceInstructionArtifacts: [],
      },
      settings: JobSearchSettingsSchema.parse({}),
      signal: new AbortController().signal,
      lane: "browser",
      navigation: {
        read: (url) => saved.get(url) ?? null,
        save: (url, progress) => saved.set(url, progress),
      },
      message: () => {},
      knownUrls: () => [],
    });
  expect(await collect()).toMatchObject({ complete: false });
  expect(saved.get(target.startingUrl)?.outcome).toBeUndefined();
  await collect();
  expect(runAgentDiscovery).toHaveBeenCalledTimes(2);
});
