import type { AgentMessage, JobFinderAiClient } from "@nestor/ai-providers";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const FEED_TITLES = [
  "Senior Product Designer",
  "Account Executive",
  "Payroll Specialist",
];

function feedResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        jobs: FEED_TITLES.map((title, index) => ({
          id: 7100 + index,
          title,
          absolute_url: `https://job-boards.greenhouse.io/screenboard/jobs/${7100 + index}`,
          location: { name: "Remote" },
          updated_at: "2026-10-20T10:00:00.000Z",
          // Facts the merge derives hints from (sponsorship, relocation).
          content: `<p>${title} work for a product company. Visa sponsorship and relocation support are available.</p>${"<p>You will work with a small team on the product, plan the work each week, write clear notes for the people you work with, and look after the quality of what ships.</p>".repeat(6)}`,
        })),
      }),
  } as Response;
}

type ScreenListing = { id: string; title: string };

/**
 * A stand-in for the model's feed screen: rejects listings whose title is
 * not design work, as one grouped answer, and counts its calls.
 */
function createScreeningAiClient(mode: { fail: boolean }) {
  const screenCalls: ScreenListing[][] = [];
  const client = {
    ...createAiClient(),
    chatWithTools: (messages: AgentMessage[]) => {
      const system = messages.find((message) => message.role === "system");
      if (!system?.content.startsWith("You screen job listings")) {
        return Promise.resolve({ content: "ok", toolCalls: [] });
      }
      const user = messages.find((message) => message.role === "user");
      const listings = (
        JSON.parse(user?.content ?? "{}") as { listings: ScreenListing[] }
      ).listings;
      screenCalls.push(listings);
      if (mode.fail)
        return Promise.reject(new Error("The AI service is busy."));
      const rejected = listings
        .filter((listing) => !/design/i.test(listing.title))
        .map((listing) => listing.id);
      return Promise.resolve({
        content: JSON.stringify({
          keep: listings
            .filter((listing) => /design/i.test(listing.title))
            .map((listing) => listing.id),
          reject: [
            {
              ids: rejected,
              category: "role",
              reason: "Not design work.",
            },
          ],
        }),
        toolCalls: [],
      });
    },
  } satisfies JobFinderAiClient;
  return { client, screenCalls };
}

function createFeedScreenHarness(mode: { fail: boolean }) {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.targetRoles = ["Senior Product Designer"];
  seed.searchPreferences.discovery.targets = [
    {
      id: "target_screen_api",
      label: "Screen Board",
      startingUrl: "https://job-boards.greenhouse.io/screenboard",
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "missing",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    },
  ];
  const ai = createScreeningAiClient(mode);
  return {
    ...createWorkspaceServiceHarness({ seed, aiClient: ai.client }),
    screenCalls: ai.screenCalls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the model screens job-board feeds before a search keeps them", () => {
  test("keeps what fits, records the rest as rejected, and never screens a listing twice", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(feedResponse()),
    );
    const mode = { fail: false };
    const { repository, workspaceService, screenCalls } =
      createFeedScreenHarness(mode);

    const first = await workspaceService.runAgentDiscovery();
    const kept = (await repository.listSavedJobs()).map((job) => job.title);
    expect(kept).toEqual(["Senior Product Designer"]);
    expect(screenCalls).toHaveLength(1);
    expect(screenCalls[0]?.map((listing) => listing.title)).toEqual(
      FEED_TITLES,
    );
    const execution = first.recentDiscoveryRuns[0]?.targetExecutions[0];
    expect(execution?.state).toBe("completed");
    expect(execution?.rejectedListings).toEqual([
      expect.objectContaining({
        title: "Account Executive",
        category: "role",
        reason: "Not design work.",
      }),
      expect.objectContaining({
        title: "Payroll Specialist",
        category: "role",
      }),
    ]);
    const ledger = (await repository.getDiscoveryState()).discoveryLedger;
    expect(
      ledger.map((entry) => [entry.title, entry.listingScreen?.verdict]),
    ).toEqual(
      expect.arrayContaining([
        ["Senior Product Designer", "keep"],
        ["Account Executive", "reject"],
        ["Payroll Specialist", "reject"],
      ]),
    );

    // The same board fetched again costs nothing for listings decided, and
    // the kept job, unchanged, is not merged and rewritten again.
    const second = await workspaceService.runAgentDiscovery();
    expect(screenCalls).toHaveLength(1);
    const again = second.recentDiscoveryRuns[0]?.targetExecutions[0];
    expect(again).toMatchObject({
      state: "completed",
      jobsSkippedByLedger: 1,
      duplicatesMerged: 0,
    });
    expect(again?.changeDigest).toMatchObject({ changed: 0, unchanged: 3 });
    expect((await repository.listSavedJobs()).map((job) => job.title)).toEqual([
      "Senior Product Designer",
    ]);
  });

  test("keeps every listing when the screen cannot run, and puts the misfits away on the next search", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(feedResponse()),
    );
    const mode = { fail: true };
    const { repository, workspaceService, screenCalls } =
      createFeedScreenHarness(mode);

    const first = await workspaceService.runAgentDiscovery();
    expect(first.recentDiscoveryRuns[0]?.targetExecutions[0]?.state).toBe(
      "completed",
    );
    expect(
      (await repository.listSavedJobs()).map((job) => job.title).sort(),
    ).toEqual([...FEED_TITLES].sort());
    expect(
      (await repository.getDiscoveryState()).discoveryLedger.map(
        (entry) => entry.listingScreen?.verdict,
      ),
    ).toEqual(["pending", "pending", "pending"]);

    mode.fail = false;
    await workspaceService.runAgentDiscovery();
    expect(screenCalls).toHaveLength(2);
    const statuses = Object.fromEntries(
      (await repository.listSavedJobs()).map((job) => [job.title, job.status]),
    );
    expect(statuses).toEqual({
      "Senior Product Designer": "discovered",
      "Account Executive": "archived",
      "Payroll Specialist": "archived",
    });
  });
});
