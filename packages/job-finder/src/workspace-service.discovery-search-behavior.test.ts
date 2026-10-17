import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { JobPostingSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/**
 * Settings' "How picky a search is" and "Count remote jobs as any location"
 * must change what a search keeps, not only the words the search agent reads.
 * How the kept jobs fit is the model's judgment (ADR 0041).
 */
function card(token: string, title: string, location: string) {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: `job_${token}`,
    discoveryMethod: "browser_agent",
    canonicalUrl: `https://jobs.example.test/job/${token}`,
    title,
    company: `Company ${token}`,
    location,
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-03-20T10:00:00.000Z",
    salaryText: null,
    summary: "Build product interfaces with React and TypeScript.",
    description: "Build product interfaces with React and TypeScript.",
    keySkills: ["React", "TypeScript"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    benefits: [],
  });
}

const CARDS = [
  card("europe", "Frontend Engineer", "Remote, Europe"),
  card("worldwide", "Frontend Engineer", "Remote, Worldwide"),
  card("americas", "Frontend Engineer", "Remote, Americas"),
  card("berlin", "Frontend Engineer", "Berlin, Germany"),
  card("data", "Data Analyst", "Berlin, Germany"),
  card("platform", "Platform Engineer", "Berlin, Germany"),
];

function runtimeReturning(): BrowserSessionRuntime {
  return {
    ...createAgentBrowserRuntime([]),
    runAgentDiscovery(source) {
      return Promise.resolve({
        source,
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: "2026-03-20T10:00:05.000Z",
        querySummary: "Search behavior test run",
        inventoryCompleteness: "partial" as const,
        warning: null,
        jobs: CARDS,
        agentMetadata: null,
      });
    },
  };
}

/**
 * Stands in for the model judging the cards (ADR 0041): a frontend role is
 * the work asked for; Berlin is in the person's area; a remote role reaches
 * them only while remote counts as any location, and never from the
 * Americas.
 */
function judgeLikeTheModel(input: JudgeJobFitsInput) {
  const remoteCounts =
    input.searchPreferences.discovery.remoteCountsAsAnyLocation !== false;
  return Promise.resolve(
    input.jobs.map(({ jobId, posting }) => {
      const role = posting.title.startsWith("Frontend")
        ? ("exact" as const)
        : ("conflict" as const);
      const locationReach =
        posting.location === "Berlin, Germany"
          ? ("in_area" as const)
          : remoteCounts && !posting.location.includes("Americas")
            ? ("remote_preferred" as const)
            : ("outside_area" as const);
      return {
        jobId,
        score: role === "exact" ? 80 : 20,
        recommendation:
          role === "exact" ? ("strong_fit" as const) : ("skip" as const),
        role,
        roleExplanation: null,
        preferences: "aligned" as const,
        preferencesExplanation: null,
        locationReach,
        reasons: [],
        gaps: [],
        listingClosed: false,
        listingClosedEvidence: null,
      };
    }),
  );
}

async function search(input: {
  selectivity: "best_matches" | "balanced" | "wide_net";
  remoteCountsAsAnyLocation: boolean;
  targetRoles?: string[];
  planSelectivity?: "best_matches" | "balanced" | "wide_net";
}) {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.searchPreferences.targetRoles = input.targetRoles ?? [
    "Frontend Engineer",
  ];
  seed.searchPreferences.locations = ["Berlin, Germany"];
  seed.searchPreferences.workModes = [];
  seed.searchPreferences.excludedLocations = [];
  seed.searchPreferences.searchSelectivity = input.planSelectivity;
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.companyBlacklist = [];
  // The Settings save mirrors Best matches only into the strict filter.
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches =
    input.selectivity === "best_matches";
  seed.searchPreferences.discovery.targets = [
    {
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "target_behavior",
      label: "Behavior board",
      startingUrl: "https://jobs.example.test/jobs",
    },
  ];
  seed.settings.aiBehavior = {
    ...(seed.settings.aiBehavior ?? {}),
    jobSearch: {
      selectivity: input.selectivity,
      remoteCountsAsAnyLocation: input.remoteCountsAsAnyLocation,
    },
  } as typeof seed.settings.aiBehavior;
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    browserRuntime: runtimeReturning(),
    aiClient: { ...createAgentAiClient(), judgeJobFits: judgeLikeTheModel },
  });
  const snapshot = await workspaceService.runDiscoveryForTarget(
    "target_behavior",
    () => {},
    new AbortController().signal,
  );
  const scores: Record<string, number> = {};
  for (const job of snapshot.discoveryJobs) {
    scores[job.canonicalUrl.split("/").pop() ?? job.id] =
      job.matchAssessment.score;
  }
  return scores;
}

describe("saved search behavior changes what a search keeps", () => {
  test("searches an enabled source when target roles are blank", async () => {
    const kept = await search({
      selectivity: "wide_net",
      remoteCountsAsAnyLocation: true,
      targetRoles: [],
    });
    expect(Object.keys(kept)).toHaveLength(CARDS.length);
  }, 60_000);

  test("Best matches only drops the cards the model judged outside the role or place", async () => {
    const kept = await search({
      selectivity: "best_matches",
      remoteCountsAsAnyLocation: true,
    });
    expect(Object.keys(kept).sort()).toEqual(["berlin", "europe", "worldwide"]);
  }, 60_000);

  test("Best matches only with remote off keeps only the card in a saved place", async () => {
    const kept = await search({
      selectivity: "best_matches",
      remoteCountsAsAnyLocation: false,
    });
    expect(Object.keys(kept)).toEqual(["berlin"]);
  }, 60_000);

  test.each(["balanced", "wide_net"] as const)(
    "%s keeps adjacent jobs whatever the remote setting; the model judges their fit",
    async (selectivity) => {
      const on = await search({
        selectivity,
        remoteCountsAsAnyLocation: true,
      });
      const off = await search({
        selectivity,
        remoteCountsAsAnyLocation: false,
      });
      expect(Object.keys(on).sort()).toEqual([
        "americas",
        "berlin",
        "data",
        "europe",
        "platform",
        "worldwide",
      ]);
      expect(Object.keys(off).sort()).toEqual(Object.keys(on).sort());
    },
    60_000,
  );
});

test("R3-193 independent saved plan pickiness controls retention despite opposite Settings", async () => {
  const strict = await search({
    selectivity: "wide_net",
    planSelectivity: "best_matches",
    remoteCountsAsAnyLocation: true,
  });
  const broad = await search({
    selectivity: "best_matches",
    planSelectivity: "wide_net",
    remoteCountsAsAnyLocation: true,
  });
  expect(Object.keys(strict).sort()).toEqual(["berlin", "europe", "worldwide"]);
  expect(Object.keys(broad)).toHaveLength(CARDS.length);
}, 60000);
