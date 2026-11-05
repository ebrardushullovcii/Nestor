import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  BrowserAgentRunCheckpointSchema,
  JobDiscoveryTargetSchema,
  JobSearchSettingsSchema,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import { createListingSearchEngine } from "./engine";

test("a navigation checkpoint can wait for profession verification to render its detail without holding the reader queue", async () => {
  const seed = createSeed();
  const target = JobDiscoveryTargetSchema.parse({
    id: "source",
    label: "Synthetic",
    startingUrl: "https://careers.example/",
  });
  const listingUrl = "https://careers.example/security/1";
  const signal = AbortSignal.timeout(1500);
  const context = {
    profile: seed.profile,
    searchPreferences: {
      ...seed.searchPreferences,
      targetRoles: ["Frontend Engineer"],
      jobFamilies: [],
    },
    sources: [],
    sourceInstructionArtifacts: [],
  };
  const settings = JobSearchSettingsSchema.parse({});
  const checkpoint = BrowserAgentRunCheckpointSchema.parse({
    revision: 0,
    savedAt: new Date().toISOString(),
    currentUrl: target.startingUrl,
    lastStableUrl: target.startingUrl,
    stepCount: 1,
    visitedUrls: [target.startingUrl],
    phaseEvidence: {},
    collectedJobs: [
      {
        ...seed.savedJobs[0],
        canonicalUrl: listingUrl,
        title: "Interface Engineer",
        description: "Synthetic card",
        company: "Synthetic Employer",
        location: "Berlin",
        listingDetailFetch: null,
      },
    ],
  });
  const chatWithTools = vi
    .fn<NonNullable<JobFinderAiClient["chatWithTools"]>>()
    .mockResolvedValueOnce({ content: '{"keep":{"0":0}}' })
    .mockResolvedValueOnce({ content: '{"keep":{"0":1}}' });
  const readRenderedPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html:
        url === listingUrl
          ? "<main><h1>Interface Engineer</h1><p>Synthetic Employer</p><p>Build frontend interfaces with React and TypeScript, partnering with designers and engineers on accessible components.</p></main>"
          : '<main><p>Loading...</p><script src="/app.js"></script></main>',
    }),
  );
  const completed = new Error("Navigation finished after screening");
  const fetchPage = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          "<title>Just a moment...</title><main><h1>Just a moment...</h1><p>Performing security verification</p></main>",
        ),
      ),
    );
  const engine = createListingSearchEngine({
    aiClient: { ...createDeterministicJobFinderAiClient(), chatWithTools },
    browserRuntime: {
      readRenderedPage,
      runAgentDiscovery: async (_source, options) => {
        await options.onCheckpoint?.(checkpoint);
        throw completed;
      },
    },
  });
  let screened = false;
  try {
    await expect(
      engine.collectSource({
        target,
        context,
        settings,
        signal,
        lane: "browser",
        message: () => {},
        knownUrls: () => [],
        onCards: async (cards) => {
          const result = await engine.screenCards({
            cards,
            context,
            settings,
            signal,
            knownUrls: () => [],
            seenCards: () => [],
          });
          expect(result.failed).toEqual([]);
          expect(result.related[0]?.listingText).toContain(
            "Build frontend interfaces",
          );
          screened = true;
        },
      }),
    ).rejects.toBe(completed);
    expect(screened).toBe(true);
    expect(readRenderedPage.mock.calls.map(([url]) => url)).toEqual([
      target.startingUrl,
      listingUrl,
    ]);
  } finally {
    fetchPage.mockRestore();
  }
});
