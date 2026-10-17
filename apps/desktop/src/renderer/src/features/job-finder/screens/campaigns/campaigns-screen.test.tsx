// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  DiscoveryRunRecord,
  JobSearchCampaign,
  SaveJobSearchCampaignInput,
} from "@nordri/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { round3SearchRun } from "../../lib/discovery-round3.test-fixture";
import { resetJobFinderOverlaysForTests } from "../../lib/job-finder-overlay-ownership";
import { deviceTimeZone } from "../../lib/job-finder-timestamp-format";
import { describePlanRunFailure, CampaignsScreen } from "./campaigns-screen";
import { resolveCampaignSourceTargetIds } from "@nordri/contracts";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetJobFinderOverlaysForTests();
  // Every production campaigns flow must resolve destructive decisions
  // in-app; the native confirm stays uncalled for the whole suite.
  expect(confirmNeverSpy).not.toHaveBeenCalled();
});

const confirmNeverSpy = vi
  .spyOn(window, "confirm")
  .mockImplementation(() => false);

it.each([897, 3_000, 10_000])(
  "keeps all %i sources reachable with a full dirty selection and bounded checkboxes",
  async (count) => {
    const existing = campaign("scale", "Large source plan", "precision");
    const template = existing.searchPreferences.discovery.targets[0]!;
    existing.searchPreferences.discovery.targets = Array.from(
      { length: count },
      (_, index) => ({
        ...template,
        id: `scale_source_${index}`,
        label: `Scale source ${index}`,
        startingUrl: `https://sources.example/${index}`,
      }),
    );
    existing.sourceTargetIds = existing.searchPreferences.discovery.targets.map(
      (target) => target.id,
    );
    existing.sourceSelectionMode = "selected";
    const includes = vi.spyOn(existing.sourceTargetIds, "includes");
    const onSaveCampaign = vi
      .fn<(value: SaveJobSearchCampaignInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    const view = render(
      <CampaignsScreen
        activeCampaignId="scale"
        campaigns={[existing]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Retained dirty name" },
    });
    const fieldset = screen.getByText("Included sources").closest("fieldset")!;
    const nav = within(fieldset).getByRole("navigation", {
      name: "sources pagination",
    });
    const reached = new Set<string>();
    const collect = () => {
      const inputs =
        fieldset.querySelectorAll<HTMLInputElement>("input[aria-label]");
      expect(inputs.length).toBeLessThanOrEqual(40);
      for (const input of inputs)
        reached.add(input.getAttribute("aria-label")!);
    };
    collect();
    fireEvent.click(screen.getByLabelText("Scale source 0"));
    const move = async (direction: "Next" | "Previous") => {
      fireEvent.click(
        within(nav).getByRole("button", { name: `${direction} page` }),
      );
      await waitFor(() => expect(nav.getAttribute("aria-busy")).toBe("false"));
    };
    await move("Next");
    fireEvent.click(screen.getByLabelText("Scale source 40"));
    await move("Previous");
    expect(
      screen.getByLabelText<HTMLInputElement>("Scale source 0").checked,
    ).toBe(false);
    for (let page = 1; page <= Math.ceil(count / 40); page++) {
      collect();
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
        "Retained dirty name",
      );
      if (page < Math.ceil(count / 40)) await move("Next");
    }
    fireEvent.click(screen.getByLabelText(`Scale source ${count - 1}`));
    expect(reached.size).toBe(count);
    expect(includes).not.toHaveBeenCalled();
    expect(nav.textContent).toContain(`of ${count}`);
    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
    await waitFor(() => expect(onSaveCampaign).toHaveBeenCalledTimes(1));
    const saved = onSaveCampaign.mock.calls[0]![0];
    expect(saved.name).toBe("Retained dirty name");
    expect(saved.sourceTargetIds).toEqual(
      existing.sourceTargetIds.filter(
        (id) =>
          id !== "scale_source_0" &&
          id !== "scale_source_40" &&
          id !== `scale_source_${count - 1}`,
      ),
    );
    expect(saved.searchPreferences.discovery.targets).toEqual(
      existing.searchPreferences.discovery.targets,
    );
    expect(
      view.container.querySelectorAll('input[aria-label^="Scale source"]'),
    ).toHaveLength(0);
  },
  60_000,
);

it("uses every enabled Profile source across pages when selecting all 897 sources", async () => {
  const existing = campaign(
    "profile_scale",
    "Profile source plan",
    "precision",
  );
  const template = existing.searchPreferences.discovery.targets[0]!;
  existing.searchPreferences.discovery.targets = Array.from(
    { length: 897 },
    (_, index) => ({
      ...template,
      id: `source_${index}`,
      label: `Profile source ${index}`,
    }),
  );
  existing.sourceTargetIds = ["source_0"];
  existing.sourceSelectionMode = "selected";
  const onSaveCampaign = vi
    .fn<(value: SaveJobSearchCampaignInput) => Promise<boolean>>()
    .mockResolvedValue(true);
  render(
    <CampaignsScreen
      activeCampaignId={existing.id}
      campaigns={[existing]}
      onSaveCampaign={onSaveCampaign}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByLabelText("Use enabled sources from Profile"));
  expect(
    screen.getByLabelText<HTMLInputElement>("Profile source 39").checked,
  ).toBe(true);
  const nav = screen.getByRole("navigation", { name: "sources pagination" });
  fireEvent.click(within(nav).getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(nav.getAttribute("aria-busy")).toBe("false"));
  expect(
    screen.getByLabelText<HTMLInputElement>("Profile source 79").checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
  await waitFor(() => expect(onSaveCampaign).toHaveBeenCalledTimes(1));
  const saved = onSaveCampaign.mock.calls[0]![0];
  expect(saved.sourceSelectionMode).toBe("profile");
  expect(resolveCampaignSourceTargetIds(saved)).toEqual(
    existing.searchPreferences.discovery.targets.map((target) => target.id),
  );
});

it("replaces only the safeguarded plan's next run and restores it on dismissal", () => {
  const props = {
    activeCampaignId: "one",
    campaigns: [
      campaign("one", "First", "precision"),
      campaign("two", "Second", "precision"),
    ],
    onSaveCampaign: vi.fn(),
    onSelectCampaign: vi.fn(),
    pending: false,
  };
  const { rerender } = render(
    <CampaignsScreen
      {...props}
      safeguardPauses={[
        {
          id: "pause",
          campaignId: "one",
          planName: "First",
          title: "Paused",
          explanation: "Review failures.",
          route: "/job-finder/safeguards",
        },
      ]}
    />,
  );
  expect(screen.getAllByText("Paused by a safeguard")).toHaveLength(1);
  rerender(<CampaignsScreen {...props} safeguardPauses={[]} />);
  expect(screen.queryByText("Paused by a safeguard")).toBeNull();
});

it("prints next run in the schedule zone and past activity in the device zone", () => {
  const scheduled = {
    ...campaign("one", "First", "precision"),
    schedule: {
      mode: "daily" as const,
      enabled: true,
      daysOfWeek: [],
      localStartTime: "08:00",
      timeZone: "America/Chicago",
      pauseWindows: [],
      runFacts: {
        // 2026-09-12T13:00Z is 08:00 in Chicago.
        nextRunAt: "2026-09-12T13:00:00.000Z",
        lastRunAt: "2026-09-11T13:01:00.000Z",
        lastRunOutcome: "completed" as const,
        lastRunSummary: null,
        consecutiveFailures: 0,
      },
    },
  } as unknown as JobSearchCampaign;

  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[scheduled]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );

  const nextRun = screen.getByText("Next run").parentElement;
  const lastRun = screen.getByText("Last run").parentElement;
  const expectedNext = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  }).format(new Date("2026-09-12T13:00:00.000Z"));
  const expectedLast = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: deviceTimeZone(),
  }).format(new Date("2026-09-11T13:01:00.000Z"));
  expect(nextRun?.textContent).toContain(expectedNext);
  expect(nextRun?.textContent).toContain("America/Chicago");
  expect(lastRun?.textContent).toContain(expectedLast);
  expect(
    screen.getByText(
      `Past activity is shown in ${deviceTimeZone()}. Schedule times and pauses use each plan’s saved time zone.`,
    ),
  ).toBeTruthy();
  if (deviceTimeZone() !== "America/Chicago") {
    expect(screen.getByText("Runs at 8:00 AM America/Chicago")).toBeTruthy();
  }
});

it("prints one timestamp shape whether or not the plan saved a time zone", () => {
  // "succeeded · Sep 12, 5:41 AM CDT" on one card beside "succeeded ·
  // Sep 12, 12:42 PM" on the next: one kind of fact, two shapes.
  const withZone = {
    ...campaign("one", "First", "precision"),
    schedule: {
      ...campaign("one", "First", "precision").schedule,
      timeZone: "America/Chicago",
      runFacts: {
        nextRunAt: null,
        lastRunAt: "2026-09-12T10:41:00.000Z",
        lastRunOutcome: "completed" as const,
        lastRunSummary: null,
        consecutiveFailures: 0,
      },
    },
  } as unknown as JobSearchCampaign;
  const withoutZone = {
    ...campaign("two", "Second", "precision"),
    schedule: {
      ...campaign("two", "Second", "precision").schedule,
      timeZone: null,
      runFacts: {
        nextRunAt: null,
        lastRunAt: "2026-09-12T10:42:00.000Z",
        lastRunOutcome: "completed" as const,
        lastRunSummary: null,
        consecutiveFailures: 0,
      },
    },
  } as unknown as JobSearchCampaign;

  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[withZone, withoutZone]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );

  const lastRunTexts = screen
    .getAllByText("Last run")
    .map((node) => node.parentElement?.textContent ?? "");
  const first = lastRunTexts[0] ?? "";
  const second = lastRunTexts[1] ?? "";
  // Both name their zone, so neither number is read on a clock the reader
  // has to guess at.
  const zoneSuffix = /\b[A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?$/u;
  expect(zoneSuffix.test(first.trim())).toBe(true);
  expect(zoneSuffix.test(second.trim())).toBe(true);
  expect(
    screen.getAllByText(
      `Past activity is shown in ${deviceTimeZone()}. Schedule times and pauses use each plan’s saved time zone.`,
    ),
  ).toHaveLength(1);
});

it("names each plan's selected share of job sites", () => {
  const first = {
    ...campaign("one", "First", "precision"),
    sourceTargetIds: ["source-1", "source-2"],
    searchPreferences: {
      ...campaign("one", "First", "precision").searchPreferences,
      discovery: {
        historyLimit: 5,
        targets: [1, 2, 3].map((index) => ({
          ...campaign("one", "First", "precision").searchPreferences.discovery
            .targets[0]!,
          id: `source-${index}`,
        })),
      },
    },
  } as JobSearchCampaign;
  const second = {
    ...campaign("two", "Second", "precision"),
    sourceTargetIds: ["source-3"],
  } as JobSearchCampaign;

  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[first, second]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );

  expect(screen.getByText("Uses 2 of your 3 job sites.")).toBeTruthy();
});

it("never says No run yet on a plan whose own progress records a run", () => {
  // "Jobs in this plan 50" two lines above "Last run  No run yet".
  const ran = {
    ...campaign("one", "First", "precision"),
    progress: {
      ...campaign("one", "First", "precision").progress,
      jobsFound: 50,
      lastRunAt: "2026-09-12T10:41:00.000Z",
    },
  } as unknown as JobSearchCampaign;

  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[ran]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );

  const lastRun = screen.getByText("Last run").parentElement?.textContent ?? "";
  expect(lastRun).not.toContain("No run yet");
  expect(lastRun).toContain("outcome not recorded");
});

function campaign(id: string, name: string, mode: "precision" | "scale") {
  return {
    id,
    name,
    description: `${name} purpose`,
    mode,
    status: "active",
    sourceTargetIds: ["source-1"],
    jobIds: [],
    minimumFitScore: 70,
    searchPreferences: {
      targetRoles: ["Software Engineer"],
      jobFamilies: [],
      locations: ["Worldwide remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: 2_000,
        maximum: 4_000,
        interval: "month",
        currency: "EUR",
        currencyStatus: "explicit",
      },
      approvalMode: "manual",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "source-1",
            label: "Example jobs",
            startingUrl: "https://example.com/jobs",
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
        ],
      },
    },
    limits: {
      retainedJobTarget: mode === "precision" ? 15 : 1_000,
      analysisConcurrency: 2,
      preparationBatchSize: 5,
      dailyPreparationLimit: 20,
    },
    stopRules: {
      pauseOnLoginRequired: false,
      pauseOnChangedForm: true,
      pauseOnUncertainEligibility: true,
      pauseOnFailureRatePercent: 30,
      failureRateMinimumSample: 5,
    },
    applicationPolicy: {
      resumeStrategy: "job_specific",
      requireReviewBeforePreparation: true,
      requireReviewBeforeExternalWrite: true,
      finalSubmitAuthorized: false,
    },
    schedule: {
      mode: "manual",
      enabled: false,
      daysOfWeek: [],
      localStartTime: null,
      timeZone: null,
      pauseWindows: [],
      runFacts: {
        nextRunAt: null,
        lastRunAt: null,
        lastRunOutcome: null,
        lastRunSummary: null,
        consecutiveFailures: 0,
      },
    },
    progress: {
      jobsFound: 10,
      jobsRetained: 3,
      applicationsPrepared: 1,
      applicationsApplied: 0,
      currentBatchCompleted: 0,
      currentBatchTotal: 0,
      blockedCount: 0,
      remainingQueueSize: 2,
      lastRunAt: null,
      lastUpdatedAt: "2026-08-15T09:00:00.000Z",
    },
    history: [],
    createdAt: "2026-08-15T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    rules: [],
  } as unknown as JobSearchCampaign;
}

function localPlan(id: string, locations: readonly string[]) {
  const base = campaign(id, "Local plan", "precision");
  return {
    ...base,
    searchPreferences: {
      ...base.searchPreferences,
      locations: [...locations],
      // Remote unticked: only then can remote-only sources let this plan down.
      workModes: ["onsite", "hybrid"],
    },
  } as unknown as JobSearchCampaign;
}

function finishedRun(
  id: string,
  campaignId: string,
  completedAt: string,
  warnings: readonly string[],
) {
  return {
    id,
    campaignId,
    state: "completed",
    runPhase: "complete",
    scope: "run_all",
    startedAt: completedAt,
    completedAt,
    targetIds: ["source-1"],
    targetExecutions: [],
    activity: [],
    summary: { warnings: [...warnings] },
  } as unknown as DiscoveryRunRecord;
}

describe("CampaignsScreen remote-only source warning", () => {
  it.each([
    "This search returned only remote jobs",
    "Your sources only list remote jobs",
  ])(
    "describes remote-only results from current or legacy notice: %s",
    (opening) => {
      render(
        <CampaignsScreen
          activeCampaignId="one"
          campaigns={[localPlan("one", ["Chicago, IL"])]}
          discoveryRuns={[
            finishedRun("run_1", "one", "2026-09-11T10:00:00.000Z", [
              `${opening}; try another search for jobs in Chicago, IL.`,
            ]),
          ]}
          onSaveCampaign={vi.fn()}
          onSelectCampaign={vi.fn()}
          pending={false}
        />,
      );

      expect(
        screen.getByTestId("campaign-remote-only-sources-note").textContent,
      ).toBe(
        "This search returned only remote jobs; try another search for jobs in Chicago, IL.",
      );
    },
  );

  it("names the plan's current places, not the ones the run was told about", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[localPlan("one", ["Belgrade", "Novi Sad"])]}
        discoveryRuns={[
          finishedRun("run_1", "one", "2026-09-11T10:00:00.000Z", [
            "This search returned only remote jobs; try another search for jobs in Chicago, IL.",
          ]),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.getByTestId("campaign-remote-only-sources-note").textContent,
    ).toBe(
      "This search returned only remote jobs; try another search for jobs in Belgrade or Novi Sad.",
    );
  });

  it("stays silent for a plan that ticked remote, and for another plan's run", () => {
    const remotePlan = campaign("one", "First", "precision");

    const { rerender } = render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[remotePlan]}
        discoveryRuns={[
          finishedRun("run_1", "one", "2026-09-11T10:00:00.000Z", [
            "This search returned only remote jobs; try another search for jobs in Worldwide remote.",
          ]),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.queryByTestId("campaign-remote-only-sources-note"),
    ).toBeNull();

    rerender(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[localPlan("one", ["Chicago, IL"])]}
        discoveryRuns={[
          finishedRun("run_other", "two", "2026-09-11T10:00:00.000Z", [
            "This search returned only remote jobs; try another search for jobs in Chicago, IL.",
          ]),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.queryByTestId("campaign-remote-only-sources-note"),
    ).toBeNull();
  });

  it("clears once the plan's newest finished run no longer reports it", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[localPlan("one", ["Chicago, IL"])]}
        discoveryRuns={[
          finishedRun("run_1", "one", "2026-09-11T10:00:00.000Z", [
            "This search returned only remote jobs; try another search for jobs in Chicago, IL.",
          ]),
          finishedRun("run_2", "one", "2026-09-12T10:00:00.000Z", []),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.queryByTestId("campaign-remote-only-sources-note"),
    ).toBeNull();
  });
});

describe("CampaignsScreen", () => {
  it("shows onboarding when no search plans exist yet", () => {
    render(
      <CampaignsScreen
        activeCampaignId="missing"
        campaigns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No search plans yet" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create your first search plan" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));

    expect(
      screen.getByRole("heading", { name: "Create search plan" }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("New search plan")).toBeTruthy();
  });

  it("keeps no-match copy for a real persisted query even with no plans", () => {
    window.localStorage.setItem(
      "nordri.job-finder.collection.campaigns.v1",
      JSON.stringify({
        density: "comfortable",
        query: "backend",
        savedViews: [],
      }),
    );

    render(
      <CampaignsScreen
        activeCampaignId="missing"
        campaigns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent === "No search plans match “backend”",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "No search plans yet" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  });

  it("searches plans without changing the active plan", () => {
    const onSelectCampaign = vi.fn();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={onSelectCampaign}
        pending={false}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search plans" }), {
      target: { value: "broad" },
    });
    expect(screen.queryByText("Remote TypeScript")).toBeNull();
    expect(screen.getByText("Broad engineering")).toBeTruthy();
    expect(onSelectCampaign).not.toHaveBeenCalled();
  });

  it("explains that plans are optional and discovery-only", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Search plans" })).toBeTruthy();
    // The header says it once; no explainer box repeats it above the plans.
    expect(
      screen.getByText(
        "Optional reusable searches. Find jobs always searches with the current plan.",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "details#search-plans-guide, [aria-labelledby='search-plans-guide']",
      ),
    ).toBeNull();
    // Plain language, not product vocabulary: a job seeker should not have
    // to learn "precision" and "scale" to pick one.
    expect(screen.queryByText(/precision|\bscale\b/i)).toBeNull();
    expect(screen.queryByText(/Prepare only/)).toBeNull();
    expect(screen.queryByText(/application/)).toBeNull();
  });

  it("explains the selected discovery volume", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByText(/Fewer jobs each run, chosen for a closer match/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("How many jobs each search keeps"), {
      target: { value: "scale" },
    });
    expect(
      screen.getByText(/More jobs each run, keeping more of them for review/),
    ).toBeTruthy();
  });

  it("hides legacy application policy and preserves it when discovery volume changes", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    const existing = campaign("one", "Remote TypeScript", "precision");
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[existing]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByText("Preparation batch")).toBeNull();
    expect(screen.queryByText("Daily preparation limit")).toBeNull();
    expect(screen.queryByText("Resume policy")).toBeNull();
    expect(
      screen.queryByText(
        "Require review before preparing application material",
      ),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("How many jobs each search keeps"), {
      target: { value: "scale" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));

    const saved = onSaveCampaign.mock.calls.at(-1)?.[0];
    expect(saved?.limits.retainedJobTarget).toBe(10_000);
    expect(saved?.limits.preparationBatchSize).toBe(5);
    expect(saved?.limits.dailyPreparationLimit).toBe(20);
    expect(saved?.stopRules).toEqual(existing.stopRules);
    expect(saved?.applicationPolicy).toEqual(existing.applicationPolicy);
  });

  it("creates a precision search plan from the current search scope", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "scale")]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Focused frontend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
    const saved = onSaveCampaign.mock.calls[0]?.[0];
    expect(saved?.id).toBeNull();
    expect(saved?.mode).toBe("precision");
    expect(saved?.name).toBe("Focused frontend");
    expect(saved?.applicationPolicy.finalSubmitAuthorized).toBe(false);
  });

  it("opens the rule builder from a campaign card and requests a funnel refresh", () => {
    const onRefreshCampaignRuleFunnel = vi.fn();
    const onToggleCampaignRule = vi.fn();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onRefreshCampaignRuleFunnel={onRefreshCampaignRuleFunnel}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        onToggleCampaignRule={onToggleCampaignRule}
        pending={false}
      />,
    );

    const rulesButton = screen.getByRole("button", { name: "Rules" });
    rulesButton.focus();
    fireEvent.click(rulesButton);
    expect(onRefreshCampaignRuleFunnel).toHaveBeenCalledWith("one");
    // The campaign-scoped builder is reachable from Campaigns.
    expect(
      screen.getByRole("region", { name: "Rules for Remote TypeScript" }),
    ).toBeTruthy();
    // Closing the builder does not mutate rules.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onToggleCampaignRule).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rulesButton);
  });

  it("restores focus to the Rules trigger when Escape closes the builder", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onRefreshCampaignRuleFunnel={vi.fn()}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const rulesButton = screen.getByRole("button", { name: "Rules" });
    rulesButton.focus();
    fireEvent.click(rulesButton);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(document.activeElement).toBe(rulesButton);
  });

  it("runs a campaign now from its card without changing the active campaign", () => {
    const onRunCampaignNow = vi.fn();
    const onSelectCampaign = vi.fn();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onRunCampaignNow={onRunCampaignNow}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={onSelectCampaign}
        pending={false}
      />,
    );

    const runNowButtons = screen.getAllByRole("button", { name: "Run now" });
    expect(runNowButtons).toHaveLength(2);
    fireEvent.click(runNowButtons[1]!);
    expect(onRunCampaignNow).toHaveBeenCalledWith("two");
    expect(onSelectCampaign).not.toHaveBeenCalled();
  });

  it("marks only the active plan with a filled Current badge", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const badges = screen.getAllByText("Current");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.className).toContain("bg-primary-fill");
    expect(badges[0]?.className).toContain("text-primary-fill-foreground");
    expect(badges[0]?.className).not.toContain("text-accent");
  });

  it("wraps long campaign titles while exposing the complete name", () => {
    const longName = "CampaignNameWithoutAnyWordBreaksAtAll";
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", longName, "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const title = screen.getByRole("heading", { name: longName });
    expect(title.className).toContain("min-w-0");
    expect(title.className).toContain("break-words");
    expect(title.getAttribute("title")).toBe(longName);
  });

  it("shows truthful next-run and last-run facts from persisted run facts", () => {
    const scheduled = {
      ...campaign("one", "Remote TypeScript", "precision"),
      schedule: {
        mode: "daily",
        enabled: true,
        daysOfWeek: [],
        localStartTime: "09:00",
        timeZone: "UTC",
        pauseWindows: [],
        runFacts: {
          nextRunAt: "2026-08-16T09:00:00.000Z",
          lastRunAt: "2026-08-15T09:00:00.000Z",
          lastRunOutcome: "partial",
          lastRunSummary: "Discovery partially completed: 2 jobs found.",
          consecutiveFailures: 2,
        },
      },
    } as unknown as JobSearchCampaign;
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[scheduled]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    // The card shows the persisted next run instant instead of an estimate.
    expect(screen.getByText(/Next run/)).toBeTruthy();
    // Minute precision, no seconds: the same instant is not printed twice
    // as a machine-shaped locale string.
    expect(
      screen.getAllByText(/\d{1,2}:\d{2}\s?(AM|PM|am|pm)?/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/:\d{2}:\d{2}/)).toBeNull();
    expect(
      screen.getByText(/Finished with some sources incomplete/),
    ).toBeTruthy();
    expect(screen.getByText(/2 consecutive failed runs recorded/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // The editor shows the persisted run summary verbatim.
    expect(
      screen.getByText("Discovery partially completed: 2 jobs found."),
    ).toBeTruthy();
  });

  it("renders the latest persisted digest counts and failed sources", () => {
    const withDigest = {
      ...campaign("one", "Remote TypeScript", "precision"),
      latestDigest: {
        id: "digest_run_1",
        campaignId: "one",
        discoveryRunId: "run_1",
        generatedAt: "2026-08-15T09:00:00.000Z",
        counts: {
          new: 3,
          changed: 2,
          reactivated: 1,
          inactive: 4,
          known: 9,
          skipped: 2,
        },
        failedSources: [
          {
            sourceTargetId: "target_ashby",
            reason: "The source stopped responding.",
            failedAt: "2026-08-15T08:55:00.000Z",
            retryable: false,
          },
        ],
        jobIds: ["job_1", "job_2"],
      },
    } as unknown as JobSearchCampaign;
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[withDigest]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const digest = screen.getByText("What the last run found")
      .parentElement as HTMLElement;
    fireEvent.click(screen.getByText("What the last run found"));
    expect(within(digest).getByText("3")).toBeTruthy();
    expect(within(digest).queryByText("Seen before")).toBeNull();
    expect(within(digest).getByText("4")).toBeTruthy();
    expect(screen.getByText(/The source stopped responding/)).toBeTruthy();
  });

  it("edits daily schedules, selected-day schedules, and pause windows", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.click(screen.getByLabelText("Run this search on a schedule"));
    fireEvent.change(screen.getByLabelText("How often"), {
      target: { value: "selected_days" },
    });
    fireEvent.click(screen.getByLabelText("Mon"));
    fireEvent.click(screen.getByLabelText("Fri"));
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "08:30" },
    });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Europe/Belgrade" },
    });

    // Add a pause window through the editor controls.
    fireEvent.change(screen.getByLabelText("Do not run from"), {
      target: { value: "2026-08-20T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Do not run until"), {
      target: { value: "2026-08-20T12:00" },
    });
    fireEvent.change(screen.getByLabelText("Why not to run then"), {
      target: { value: "Offline" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add a time not to run" }),
    );
    expect(screen.getByText(/Offline/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
    const saved = onSaveCampaign.mock.calls.at(-1)?.[0];
    expect(saved?.schedule.mode).toBe("selected_days");
    expect(saved?.schedule.enabled).toBe(true);
    expect(saved?.schedule.daysOfWeek).toEqual(expect.arrayContaining([1, 5]));
    expect(saved?.schedule.localStartTime).toBe("08:30");
    expect(saved?.schedule.timeZone).toBe("Europe/Belgrade");
    expect(saved?.schedule.pauseWindows).toHaveLength(1);
    const window = saved?.schedule.pauseWindows[0];
    expect(Date.parse(window?.startsAt ?? "")).toBeLessThan(
      Date.parse(window?.endsAt ?? ""),
    );
    expect(window?.reason).toBe("Offline");
    expect(window?.enabled).toBe(true);
  });

  it("says schedules and existing stop rules are enforced", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Enable a daily schedule so the enforced-runner copy is visible.
    fireEvent.click(screen.getByLabelText("Run this search on a schedule"));
    fireEvent.change(screen.getByLabelText("How often"), {
      target: { value: "daily" },
    });

    // The stale "saved for planning but not enforced" copy is gone.
    expect(
      screen.queryByText(/does not start work automatically yet/),
    ).toBeNull();
    expect(screen.queryByText(/are not automatically enforced yet/)).toBeNull();
    // Truthful enforcement copy is present.
    expect(
      screen.getByText(/starts this search for you at that time/),
    ).toBeTruthy();
    expect(screen.getByText(/stop rules are enforced/)).toBeTruthy();
    expect(
      screen.queryByText(/cannot authorize an external submit/),
    ).toBeNull();
  });

  // "I would never click 'Saved safety and automation policy' looking for a
  // daily run time."
  it("puts the run time under its own Run automatically section", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByText("Saved safety and automation policy")).toBeNull();
    const runAutomatically = screen.getByText("Run automatically")
      .parentElement as HTMLElement;
    expect(
      within(runAutomatically).getByLabelText("Run this search on a schedule"),
    ).toBeTruthy();
    expect(within(runAutomatically).getByLabelText("How often")).toBeTruthy();
    expect(within(runAutomatically).getByLabelText("Start time")).toBeTruthy();
    expect(within(runAutomatically).getByLabelText("Time zone")).toBeTruthy();
    // Safety settings keep their own section and do not hide the run time.
    const safetyLimits = screen.getByText("Safety limits")
      .parentElement as HTMLElement;
    expect(within(safetyLimits).queryByLabelText("Start time")).toBeNull();
    expect(
      within(safetyLimits).getByLabelText("Pause above failure rate (%)"),
    ).toBeTruthy();
  });

  // "86% of what?"
  it("says what the fit percentage measures and what it does", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByText("Minimum fit score")).toBeNull();
    expect(
      screen.getByLabelText(/Only show jobs scored at least this % fit/),
    ).toBeTruthy();
    expect(
      screen.getByText(/how closely a job matches what you saved about/),
    ).toBeTruthy();
  });

  it("keeps pause-window controls keyboard accessible", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const starts = screen.getByLabelText("Do not run from");
    const ends = screen.getByLabelText("Do not run until");
    const addButton = screen.getByRole("button", {
      name: "Add a time not to run",
    });
    // All controls are native form controls reachable by keyboard.
    expect(starts.tagName).toBe("INPUT");
    expect(ends.tagName).toBe("INPUT");
    expect(addButton).toBeTruthy();
    // The add button stays disabled until both window bounds are valid.
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    // Fill valid bounds, then focus the now-enabled control.
    fireEvent.change(starts, { target: { value: "2026-08-20T10:00" } });
    fireEvent.change(ends, { target: { value: "2026-08-20T12:00" } });
    expect((addButton as HTMLButtonElement).disabled).toBe(false);
    addButton.focus();
    expect(document.activeElement).toBe(addButton);

    // An invalid window (end before start) must not be added.
    fireEvent.change(starts, { target: { value: "2026-08-20T12:00" } });
    fireEvent.change(ends, { target: { value: "2026-08-20T10:00" } });
    expect(screen.getByRole("alert").textContent).toContain(
      "The end has to be later than the start.",
    );
    expect(starts.getAttribute("aria-invalid")).toBe("true");
    expect(ends.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(addButton);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("explains why the current plan cannot be archived and disables that choice", () => {
    const onSaveCampaign = vi.fn();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    expect(
      screen.getByRole<HTMLOptionElement>("option", { name: "Archived" })
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/make another plan current first/)).toBeTruthy();
    expect(onSaveCampaign).not.toHaveBeenCalled();
  });

  it("blocks an archived draft if that plan becomes current before saving", () => {
    const onSaveCampaign = vi.fn();
    const props = {
      campaigns: [
        campaign("one", "Remote TypeScript", "precision"),
        campaign("two", "Broad engineering", "scale"),
      ],
      onSaveCampaign,
      onSelectCampaign: vi.fn(),
      pending: false,
    };
    const { rerender } = render(
      <CampaignsScreen {...props} activeCampaignId="one" />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "archived" },
    });
    rerender(<CampaignsScreen {...props} activeCampaignId="two" />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Save search plan",
      }).disabled,
    ).toBe(true);
    fireEvent.submit(
      screen.getByRole("button", { name: "Save search plan" }).closest("form")!,
    );
    expect(onSaveCampaign).not.toHaveBeenCalled();
  });

  it("archives a non-current plan through the editor status", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Broad engineering",
    );
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "archived" },
    });
    expect(screen.queryByRole("alert")).toBeNull();

    const saveButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Save search plan",
    });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    const saved = onSaveCampaign.mock.calls.at(-1)?.[0];
    expect(saved?.id).toBe("two");
    expect(saved?.status).toBe("archived");
  });

  it("binds the editor to the selected plan when switching between plans", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Remote TypeScript",
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Broad engineering",
    );
  });

  it("does not ask to discard an edit that was typed and then undone", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText<HTMLInputElement>("Name");
    fireEvent.change(name, { target: { value: "Something else" } });
    fireEvent.change(name, { target: { value: "Remote TypeScript" } });
    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));

    expect(
      screen.queryByRole("alertdialog", {
        name: "Discard unsaved search-plan changes?",
      }),
    ).toBeNull();
  });

  it("asks through the app-owned dialog before a dirty switch to New", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dirty draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));

    const dialog = screen.getByRole("alertdialog", {
      name: "Discard unsaved search-plan changes?",
    });
    expect(dialog.textContent).toContain("cannot be undone");
    expect(confirmNeverSpy).not.toHaveBeenCalled();
    // Focus moves into the dialog; staying owns the first (initially
    // focused) tab position as the safe default.
    expect(document.activeElement).toBe(dialog);
    expect(dialog.querySelector("button")?.textContent).toBe("Keep editing");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Dirty draft",
    );

    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Create search plan" }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "New search plan",
    );
  });

  it("keeps the open editor when discarding unsaved changes is declined", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dirty draft" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);

    // The dialog names the plan the editor would switch to.
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Broad engineering");
    expect(confirmNeverSpy).not.toHaveBeenCalled();

    // The backdrop resolves to staying, keeping the dirty draft intact.
    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Dirty draft",
    );
  });

  it("warns before discarding unsaved changes when cancelling the editor", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dirty draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = screen.getByRole("alertdialog", {
      name: "Discard unsaved search-plan changes?",
    });
    expect(dialog.textContent).toContain("still has edits that were not saved");
    expect(confirmNeverSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Edit search plan" }),
    ).toBeTruthy();

    // Staying keeps the dirty editor open.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Edit search plan" }),
    ).toBeTruthy();

    // Explicit discard closes the editor exactly once.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Edit search plan" }),
    ).toBeNull();
  });

  it("closes the create form and asks once before making the new plan current", async () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    onSaveCampaign.mockResolvedValue(true);
    const onSelectCampaign = vi.fn();
    const view = render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={onSelectCampaign}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Focused frontend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));

    expect(
      await screen.findByText(/Search plan "Focused frontend" created\./),
    ).toBeTruthy();
    // R6: the create form used to stay open, with a live "Save search plan"
    // button, while the banner below it said the plan was already created.
    expect(
      screen.queryByRole("button", { name: "Save search plan" }),
    ).toBeNull();
    expect(onSelectCampaign).not.toHaveBeenCalled();

    view.rerender(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Focused frontend", "precision"),
        ]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={onSelectCampaign}
        pending={false}
      />,
    );
    await screen.findByText(/Search plan "Focused frontend" created\./);
    expect(onSelectCampaign).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Make current" })[0]!,
    );
    expect(onSelectCampaign).toHaveBeenCalledWith("two");
    view.rerender(
      <CampaignsScreen
        activeCampaignId="two"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Focused frontend", "precision"),
        ]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={onSelectCampaign}
        pending={false}
      />,
    );
    expect(
      screen.queryByText(/Search plan "Focused frontend" created\./),
    ).toBeNull();
  });

  it("keeps archived plans out of switch-active controls and tags them", () => {
    const archivedPlan = {
      ...campaign("three", "Old broad", "scale"),
      status: "archived",
    } as unknown as JobSearchCampaign;
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
          archivedPlan,
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "Make current" }),
    ).toHaveLength(1);
    const archivedArticle = screen.getByText("Old broad").closest("article");
    expect(archivedArticle).toBeTruthy();
    expect(archivedArticle?.className).toContain("opacity-60");
    expect(
      within(archivedArticle!).queryByRole("button", {
        name: "Make current",
      }),
    ).toBeNull();
    expect(within(archivedArticle!).getByText("Archived")).toBeTruthy();
  });

  it("reports successful saves through a status message", async () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    onSaveCampaign.mockResolvedValue(true);
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));

    // R6: the editor used to stay open holding its pre-save draft, so its own
    // "Run status" block said "Next run not scheduled yet" while the card
    // below already showed the saved next run, and Cancel then claimed
    // unsaved edits. A landed save closes the form and says so once.
    expect(
      await screen.findByText('Search plan "Renamed plan" saved.'),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save search plan" }),
    ).toBeNull();
    expect(
      screen.queryByRole("alertdialog", {
        name: "Discard unsaved search-plan changes?",
      }),
    ).toBeNull();
  });

  it("guards Escape like cancel while the editor has unsaved changes", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dirty draft" },
    });
    // The form-level Escape opens the app-owned confirmation.
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(confirmNeverSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", {
        name: "Discard unsaved search-plan changes?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Edit search plan" }),
    ).toBeTruthy();

    // With the dialog open, Escape is addressed to it and resolves to
    // staying, keeping the dirty editor intact.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Edit search plan" }),
    ).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(
      screen.queryByRole("heading", { name: "Edit search plan" }),
    ).toBeNull();
  });

  it("closes a clean editor on Escape without asking", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(confirmNeverSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Edit search plan" }),
    ).toBeNull();
  });

  it("offers no delete action until an onDeleteCampaign handler is provided", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Delete plan" })).toBeNull();
  });

  it("deletes a non-current plan only after confirmation", async () => {
    const onDeleteCampaign = vi.fn<(campaignId: string) => Promise<boolean>>();
    onDeleteCampaign.mockResolvedValue(true);
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onDeleteCampaign={onDeleteCampaign}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Delete plan" })[1]!);
    const region = screen.getByRole("group", {
      name: "Confirm deleting Broad engineering",
    });
    expect(within(region).getByText(/Permanently delete/)).toBeTruthy();

    fireEvent.click(within(region).getByRole("button", { name: "Cancel" }));
    expect(onDeleteCampaign).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("group", {
        name: "Confirm deleting Broad engineering",
      }),
    ).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete plan" })[1]!);
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Confirm deleting Broad engineering",
        }),
      ).getByRole("button", { name: "Delete plan" }),
    );
    await waitFor(() => expect(onDeleteCampaign).toHaveBeenCalledWith("two"));
    expect(
      screen.queryByRole("group", {
        name: "Confirm deleting Broad engineering",
      }),
    ).toBeNull();
  });

  it("explains automatic handoff when deleting the current plan with alternatives", () => {
    const onDeleteCampaign = vi.fn<(campaignId: string) => Promise<boolean>>();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onDeleteCampaign={onDeleteCampaign}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Delete plan" })[0]!);
    const region = screen.getByRole("group", {
      name: "Confirm deleting Remote TypeScript",
    });
    expect(
      within(region).getByText(
        /switches automatically to another non-archived plan/,
      ),
    ).toBeTruthy();
  });

  it("blocks deletion and explains the next step when no other usable plan exists", () => {
    const onDeleteCampaign = vi.fn<(campaignId: string) => Promise<boolean>>();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onDeleteCampaign={onDeleteCampaign}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Delete plan" })[0]!);
    const region = screen.getByRole("group", {
      name: "Confirm deleting Remote TypeScript",
    });
    expect(
      within(region).getByText(/Keep at least one non-archived plan/),
    ).toBeTruthy();
    const deleteButton = within(region).getByRole<HTMLButtonElement>("button", {
      name: "Delete plan",
    });
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(onDeleteCampaign).not.toHaveBeenCalled();
  });

  it("reports failed deletion inline and keeps the confirmation open", async () => {
    const onDeleteCampaign = vi.fn<(campaignId: string) => Promise<boolean>>();
    onDeleteCampaign.mockResolvedValue(false);
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onDeleteCampaign={onDeleteCampaign}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Delete plan" })[1]!);
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Confirm deleting Broad engineering",
        }),
      ).getByRole("button", { name: "Delete plan" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("failed");
    expect(
      screen.getByRole("group", {
        name: "Confirm deleting Broad engineering",
      }),
    ).toBeTruthy();
  });

  it("offers no collection toolbar for a single plan", () => {
    const view = render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    // Search field, density switch, saved views and "1 result" is the full
    // collection toolbar for one card.
    expect(screen.queryByRole("group", { name: "List density" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Saved views/u })).toBeNull();
    expect(
      screen.queryByPlaceholderText(/Search a plan by name or status/u),
    ).toBeNull();

    view.rerender(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    // With something to search, the search field returns — the density
    // switch and named views do not.
    expect(
      screen.getByPlaceholderText("Search a plan by name or status"),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "List density" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Saved views/u })).toBeNull();
  });

  it("spans a lone plan across the full row instead of a dead half column", () => {
    const view = render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const grid = screen
      .getByText("Remote TypeScript")
      .closest("article")?.parentElement;
    expect(grid?.className).not.toContain("xl:grid-cols-2");

    view.rerender(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          campaign("one", "Remote TypeScript", "precision"),
          campaign("two", "Broad engineering", "scale"),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(grid?.className).toContain("xl:grid-cols-2");
  });

  it("styles every editor field with canonical tokens, focus hierarchy, and preserved geometry", () => {
    const { container } = render(
      <CampaignsScreen
        activeCampaignId="missing"
        campaigns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New search plan" }));

    const selects = Array.from(container.querySelectorAll("select"));
    const textareas = Array.from(container.querySelectorAll("textarea"));
    // Volume, Status, Pay interval (inside the closed compensation section),
    // and How often.
    expect(selects).toHaveLength(6);
    // Plan purpose.
    expect(textareas).toHaveLength(1);

    for (const control of [...selects, ...textareas]) {
      for (const className of [
        "border-(--field-border)",
        "bg-(--field)",
        "outline-none",
        "focus-visible:border-(--field-focus-border)",
        "focus-visible:bg-(--field-strong)",
        "focus-visible:shadow-[var(--field-focus-shadow)]",
      ]) {
        expect(control.className).toContain(className);
      }
      expect(control.className).not.toContain("border-input");
      expect(control.className).not.toContain("--surface-panel-raised");
      expect(control.className).not.toContain("focus-visible:ring");
    }
    // Native selects share the Input's 44px height and padding so a select
    // beside a text field sits on the same baseline.
    for (const select of selects) {
      expect(select.className).toContain("h-11");
      expect(select.className).toContain("rounded-(--radius-field)");
      expect(select.className).toContain("px-3.5");
    }
    expect(textareas[0]?.className).toContain("min-h-20");

    // Protected selection controls stay bare native checkboxes without field
    // styling.
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes.length).toBeGreaterThanOrEqual(4);
    for (const checkbox of checkboxes) {
      expect(checkbox.className).not.toContain("field-");
      expect(checkbox.className).not.toContain("focus-visible");
      expect(checkbox.getAttribute("type")).toBe("checkbox");
    }
  });

  function planWithTwoTargets(
    base: JobSearchCampaign,
    options: {
      firstEnabled: boolean;
      secondEnabled: boolean;
      sourceTargetIds?: string[];
    },
  ): JobSearchCampaign {
    const template = base.searchPreferences.discovery.targets[0];
    if (!template) throw new Error("Expected a seeded target.");
    return {
      ...base,
      sourceTargetIds: options.sourceTargetIds ?? [],
      searchPreferences: {
        ...base.searchPreferences,
        discovery: {
          ...base.searchPreferences.discovery,
          targets: [
            {
              ...template,
              id: "source-1",
              label: "Example jobs",
              enabled: options.firstEnabled,
            },
            {
              ...template,
              id: "source-2",
              label: "Second careers",
              enabled: options.secondEnabled,
            },
          ],
        },
      },
    } as unknown as JobSearchCampaign;
  }

  it("persists Included sources only in the plan's source ids", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    onSaveCampaign.mockResolvedValue(true);
    const existing = planWithTwoTargets(
      campaign("one", "Remote TypeScript", "precision"),
      {
        firstEnabled: true,
        secondEnabled: false,
        sourceTargetIds: ["source-1"],
      },
    );
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[existing]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const first = screen.getByLabelText<HTMLInputElement>("Example jobs");
    const second = screen.getByLabelText<HTMLInputElement>("Second careers");
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);

    fireEvent.click(first);
    fireEvent.click(second);

    expect(
      screen.getByText(
        (content, element) =>
          element?.tagName === "P" &&
          /^Searches 1 job site for 1 role you saved/.test(content),
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));

    const saved = onSaveCampaign.mock.calls.at(-1)?.[0];
    if (!saved) throw new Error("Expected a save.");
    expect(
      saved.searchPreferences.discovery.targets.map((target) => target.enabled),
    ).toEqual([true, false]);
    expect(saved.sourceTargetIds).toEqual(["source-2"]);
  });

  it("restores Included sources checkboxes from the plan's source ids", () => {
    const onSaveCampaign =
      vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
    onSaveCampaign.mockResolvedValue(true);
    // Profile's stored enabled flags can disagree without changing this
    // plan's explicit source selection.
    const existing = planWithTwoTargets(
      campaign("one", "Remote TypeScript", "precision"),
      {
        firstEnabled: false,
        secondEnabled: true,
        sourceTargetIds: ["source-1"],
      },
    );
    const view = render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[existing]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByLabelText<HTMLInputElement>("Example jobs").checked,
    ).toBe(true);
    expect(
      screen.getByLabelText<HTMLInputElement>("Second careers").checked,
    ).toBe(false);

    fireEvent.click(screen.getByLabelText("Second careers"));
    fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
    const saved = onSaveCampaign.mock.calls.at(-1)?.[0];
    if (!saved) throw new Error("Expected a save.");

    view.unmount();
    const persisted = {
      ...existing,
      sourceTargetIds: saved.sourceTargetIds,
      searchPreferences: saved.searchPreferences,
    } as unknown as JobSearchCampaign;
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[persisted]}
        onSaveCampaign={onSaveCampaign}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByLabelText<HTMLInputElement>("Example jobs").checked,
    ).toBe(true);
    expect(
      screen.getByLabelText<HTMLInputElement>("Second careers").checked,
    ).toBe(true);
  });
});

describe("a finished run reports one set of numbers", () => {
  const runReport = {
    version: 1 as const,
    measuredAt: "2026-09-12T12:42:00.000Z",
    found: 50,
    new: 50,
    saved: 50,
    retained: 15,
    worthOpening: 0,
    duplicates: 0,
    retentionLimitApplied: 15,
    minimumFitScoreApplied: 70,
  };

  const planWithDigest = (id: string, name: string) =>
    ({
      ...campaign(id, name, "precision"),
      latestDigest: {
        id: `digest_run_${id}`,
        campaignId: id,
        discoveryRunId: `run_${id}`,
        generatedAt: "2026-09-12T12:42:00.000Z",
        counts: {
          // The change tally counts sightings, not results. It used to be
          // printed as "New 100" directly under "50 found · 50 new".
          new: 100,
          changed: 0,
          reactivated: 0,
          inactive: 0,
          known: 0,
          skipped: 0,
        },
        report: runReport,
        failedSources: [],
        jobIds: [],
      },
    }) as unknown as JobSearchCampaign;

  it.each(["stopped", "interrupted"] as const)(
    "names %s work on a plan without its run record",
    (outcome) => {
      const plan = planWithDigest("two", "Example plan");
      plan.latestDigest!.outcome = outcome;
      render(
        <CampaignsScreen
          activeCampaignId="one"
          campaigns={[plan]}
          discoveryRuns={[]}
          onSaveCampaign={vi.fn()}
          onSelectCampaign={vi.fn()}
          pending={false}
        />,
      );
      expect(
        screen.getByText(
          new RegExp(`^${outcome === "stopped" ? "Stopped" : "Interrupted"} ·`),
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByText("What the last run found"));
      expect(screen.queryByText("No source problems in this run.")).toBeNull();
    },
  );

  it("prints the run's own counts on a plan the screen holds no run record for", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[planWithDigest("two", "Chicago marketing manager")]}
        // Only the active plan's runs ever reach this screen.
        discoveryRuns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByText("What the last run found"));
    const digest = screen.getByText("What the last run found")
      .parentElement as HTMLElement;

    expect(
      within(digest).queryByText("Counts were not recorded for this run."),
    ).toBeNull();
    expect(
      within(digest).getByText(
        "50 found · 50 new · 15 kept · 15-job plan limit reached",
      ),
    ).toBeTruthy();
    // The tile reads the same record as the sentence above it.
    const newTile = within(digest).getByText("New")
      .parentElement as HTMLElement;
    expect(newTile.textContent).toContain("50");
    expect(newTile.textContent).not.toContain("100");
  });

  it("agrees with its own headline about how many were already here", () => {
    const plan = planWithDigest("two", "Chicago marketing manager");
    plan.latestDigest = {
      ...plan.latestDigest!,
      // The sighting tally recorded nothing; the frozen run report says seven
      // of the listings were already saved. The headline printed the report's
      // number while the breakdown printed the tally's zero.
      counts: { ...plan.latestDigest!.counts, known: 0 },
      report: { ...runReport, found: 50, new: 43, duplicates: 7 },
    };

    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[plan]}
        discoveryRuns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByText("What the last run found"));
    const digest = screen.getByText("What the last run found")
      .parentElement as HTMLElement;

    expect(
      within(digest).getByText(
        "50 found · 43 new · 15 kept · 7 already here · 15-job plan limit reached",
      ),
    ).toBeTruthy();
    expect(within(digest).queryByText("Seen before")).toBeNull();
  });

  it("does not count a failed source as completed and names its reason", () => {
    const plan = planWithDigest("one", "Chicago marketing manager");
    plan.latestDigest = {
      ...plan.latestDigest!,
      sourceOutcome: { completed: 2, planned: 3 },
      failedSources: [
        {
          sourceTargetId: "source-1",
          reason: "The source timed out.",
          failedAt: "2026-09-12T12:42:00.000Z",
          retryable: true,
        },
      ],
    };
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[plan]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByText("What the last run found"));

    expect(
      screen.getByText(
        "2 of 3 sources completed · Example jobs failed (The source timed out.)",
      ),
    ).toBeTruthy();
  });

  it("opens Run automatically by default for a scheduled plan and accepts the first checkbox click", () => {
    const scheduled = campaign("one", "Scheduled", "precision");
    scheduled.schedule = {
      ...scheduled.schedule,
      enabled: true,
      mode: "daily",
      localStartTime: "09:00",
      timeZone: "America/Chicago",
    };
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[scheduled]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const section = screen.getByText("Run automatically")
      .parentElement as HTMLElement;
    expect(within(section).getByLabelText("Start time")).toBeTruthy();
    const checkbox = screen.getByLabelText("Run this search on a schedule");
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it("uses one arithmetically consistent population when an older report disagrees", () => {
    const reported = planWithDigest("one", "Chicago marketing manager");
    const mismatched = {
      ...reported,
      latestDigest: {
        ...reported.latestDigest,
        report: {
          ...reported.latestDigest?.report,
          found: 94,
          new: 0,
          retained: 15,
        },
        counts: {
          new: 0,
          changed: 8,
          reactivated: 0,
          inactive: 0,
          known: 48,
          skipped: 2,
        },
      },
    } as JobSearchCampaign;
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[mismatched]}
        discoveryRuns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByText("What the last run found"));
    expect(
      screen.getByText(
        "94 found · 0 new · 15 kept · 15-job plan limit reached",
      ),
    ).toBeTruthy();
  });

  // R8: "Last run skipped · Sep 12, 5:48 PM" sat directly above that same
  // run's "97 found · 97 new · 15 kept", and an earlier reading of the same
  // card said "Ran · ... (outcome not recorded)".
  it("never calls a run with its own report skipped or unrecorded", () => {
    const reported = planWithDigest("one", "Chicago marketing manager");
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          {
            ...reported,
            schedule: {
              ...reported.schedule,
              runFacts: {
                ...reported.schedule.runFacts,
                lastRunAt: "2026-09-12T12:42:00.000Z",
                lastRunOutcome: "skipped",
              },
            },
          } as unknown as JobSearchCampaign,
        ]}
        discoveryRuns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const lastRun =
      screen.getByText("Last run").parentElement?.textContent ?? "";
    expect(lastRun).not.toContain("Skipped");
    expect(lastRun).not.toContain("outcome not recorded");
    expect(lastRun).toContain("Ran");
  });

  it("says so when the run really recorded no counts", () => {
    const legacy = planWithDigest("one", "Older plan");
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[
          {
            ...legacy,
            latestDigest: { ...legacy.latestDigest, report: null },
          } as unknown as JobSearchCampaign,
        ]}
        discoveryRuns={[]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByText("What the last run found"));
    expect(
      screen.getByText("Counts were not recorded for this run."),
    ).toBeTruthy();
  });
});

describe("Run now while a search is running", () => {
  it("says why it cannot start and disables the button", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        activeDiscoveryRun={{ campaignId: "one" }}
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onRunCampaignNow={vi.fn()}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(
      screen.getByText("A search is already running for this plan."),
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: "Search running" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  // R7: one plan running greyed out every plan's Run now button, so the plan
  // the person wanted to start looked broken before they touched it.
  it("keeps Run now live on the other plans and explains only when pressed", () => {
    const onRunCampaignNow = vi.fn();
    render(
      <CampaignsScreen
        activeCampaignId="one"
        activeDiscoveryRun={{ campaignId: "two" }}
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onRunCampaignNow={onRunCampaignNow}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const button = screen.getByRole("button", { name: "Run now" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(
      screen.queryByText(
        "A search is already running for another plan. Wait for it to finish, then run this one.",
      ),
    ).toBeNull();

    fireEvent.click(button);

    expect(onRunCampaignNow).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "A search is already running for another plan. Wait for it to finish, then run this one.",
      ),
    ).toBeTruthy();
  });

  it("leaves Run now enabled when nothing is running", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        activeDiscoveryRun={null}
        campaigns={[campaign("one", "Remote TypeScript", "precision")]}
        onRunCampaignNow={vi.fn()}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    const button = screen.getByRole("button", { name: "Run now" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});

describe("arriving from a Find jobs plan link", () => {
  it("opens that plan's editor instead of leaving the person on the plan list", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "First", "precision")]}
        editCampaignId="one"
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(screen.getByText("Edit search plan")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("First");
  });

  it("leaves the plan list alone when no plan editor was requested", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[campaign("one", "First", "precision")]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    expect(screen.queryByText("Edit search plan")).toBeNull();
  });
});

describe("a run that failed before it reached a source", () => {
  const planWithFailedRun = () =>
    ({
      ...campaign("one", "Chicago marketing manager", "precision"),
      latestDigest: {
        id: "digest_run_failed",
        campaignId: "one",
        discoveryRunId: "run_failed",
        generatedAt: "2026-09-12T12:42:00.000Z",
        counts: {
          new: 0,
          changed: 0,
          reactivated: 0,
          inactive: 0,
          known: 0,
          skipped: 0,
        },
        report: null,
        failedSources: [],
        jobIds: [],
      },
    }) as unknown as JobSearchCampaign;

  const failedRun = (warnings: readonly string[]) =>
    ({
      id: "run_failed",
      campaignId: "one",
      state: "failed",
      runPhase: "complete",
      scope: "run_all",
      startedAt: "2026-09-12T12:42:00.000Z",
      completedAt: "2026-09-12T12:42:00.000Z",
      targetIds: [],
      targetExecutions: [],
      activity: [],
      summary: { warnings: [...warnings] },
    }) as unknown as DiscoveryRunRecord;

  it("says why the run failed instead of reporting no source problems", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[planWithFailedRun()]}
        discoveryRuns={[
          failedRun([
            "This plan has no job sites to search; add one in Profile.",
          ]),
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByText("What the last run found"));

    expect(
      screen.getByText(
        "This plan has no job sites to search; add one in Profile.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No source problems in this run.")).toBeNull();
  });

  it("still reports no source problems for a run that finished", () => {
    render(
      <CampaignsScreen
        activeCampaignId="one"
        campaigns={[planWithFailedRun()]}
        discoveryRuns={[
          {
            ...failedRun([]),
            state: "completed",
          } as unknown as DiscoveryRunRecord,
        ]}
        onSaveCampaign={vi.fn()}
        onSelectCampaign={vi.fn()}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByText("What the last run found"));

    expect(screen.getByText("No source problems in this run.")).toBeTruthy();
  });
});

it("reports dirty plan edits to the navigation guard and clears them after save or unmount", async () => {
  const onDirtyChange = vi.fn();
  const view = render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[campaign("one", "Original plan", "precision")]}
      onDirtyChange={onDirtyChange}
      onSaveCampaign={vi.fn(() => Promise.resolve(true))}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Edited plan" },
  });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Another draft" },
  });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it("shows inherited enabled sources, and unchecking the last one saves an empty explicit selection", () => {
  const existing = {
    ...campaign("inherit", "Inherited", "precision"),
    sourceTargetIds: [],
    sourceSelectionMode: "profile" as const,
  } as JobSearchCampaign;
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <CampaignsScreen
      activeCampaignId="inherit"
      campaigns={[existing]}
      pending={false}
      onSaveCampaign={onSave}
      onSelectCampaign={vi.fn()}
    />,
  );
  expect(screen.getByText("Uses 1 of your 1 job sites.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText<HTMLInputElement>("Example jobs").checked).toBe(
    true,
  );
  expect(screen.getByText(/These sources control new searches/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Example jobs"));
  fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    sourceSelectionMode: "selected",
    sourceTargetIds: [],
  });
});

it("keeps city and state together when saving plan locations", () => {
  const onSave = vi
    .fn<(input: SaveJobSearchCampaignInput) => Promise<boolean>>()
    .mockResolvedValue(true);
  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[campaign("one", "Seattle plan", "precision")]}
      pending={false}
      onSaveCampaign={onSave}
      onSelectCampaign={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByPlaceholderText("Seattle, WA; Portland, OR"), {
    target: { value: "Seattle, WA; Portland, OR" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
  expect(onSave.mock.calls[0]?.[0].searchPreferences.locations).toEqual([
    "Seattle, WA",
    "Portland, OR",
  ]);
});

it("distinguishes two unnamed sources on one host in the plan picker", () => {
  const plan = campaign("employers", "Employer sources", "precision");
  const original = plan.searchPreferences.discovery.targets[0]!;
  const sources = ["gong", "glean"].map((employer) => ({
    ...original,
    id: employer,
    label: "job-boards.greenhouse.io",
    startingUrl: `https://job-boards.greenhouse.io/${employer}/jobs/123`,
  }));
  render(
    <CampaignsScreen
      activeCampaignId={plan.id}
      campaigns={[
        {
          ...plan,
          searchPreferences: {
            ...plan.searchPreferences,
            discovery: {
              ...plan.searchPreferences.discovery,
              targets: sources,
            },
          },
        },
      ]}
      pending={false}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  for (const employer of ["gong", "glean"]) {
    expect(
      screen.getByRole("checkbox", {
        name: `job-boards.greenhouse.io/${employer}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(`https://job-boards.greenhouse.io/${employer}/jobs/123`),
    ).toBeTruthy();
  }
});

it("shows a plain timeout reason without terminal logs on the plan card", () => {
  const plan = campaign("one", "First", "precision");
  const raw =
    "page.goto: Timeout 30000ms exceeded. Call log: \u001b[2m waiting for navigation";
  const run = {
    id: "timeout",
    state: "failed",
    summary: { warnings: [raw] },
  } as DiscoveryRunRecord;
  const digest = {
    ...plan.latestDigest,
    discoveryRunId: "timeout",
    outcome: "failed",
  } as NonNullable<JobSearchCampaign["latestDigest"]>;
  const reason = describePlanRunFailure([run], digest);
  expect(reason).toBeTruthy();
  expect(reason).not.toContain("page.goto");
  expect(reason).not.toContain("\u001b");
});

it("R3-193 and R3-138 save plan pickiness and OTE basis", () => {
  const onSaveCampaign =
    vi.fn<(campaign: SaveJobSearchCampaignInput) => Promise<boolean>>();
  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[campaign("one", "Focused", "precision")]}
      onSaveCampaign={onSaveCampaign}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Search pickiness")).toHaveProperty("value", "");
  fireEvent.change(screen.getByLabelText("Search pickiness"), {
    target: { value: "best_matches" },
  });
  fireEvent.change(screen.getByLabelText("Minimum pay counts as"), {
    target: { value: "total_ote" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save search plan" }));
  expect(onSaveCampaign.mock.calls[0]?.[0].searchPreferences).toMatchObject({
    searchSelectivity: "best_matches",
    compensation: { basis: "total_ote" },
  });
});

it("names the selected weekdays beside the scheduled time on the plan card", () => {
  const plan = campaign("one", "Weekday plan", "precision");
  plan.schedule = {
    ...plan.schedule,
    enabled: true,
    mode: "selected_days",
    daysOfWeek: [5, 1, 3],
    localStartTime: "08:00",
    timeZone: deviceTimeZone(),
  };
  render(
    <CampaignsScreen
      activeCampaignId="one"
      campaigns={[plan]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );
  expect(screen.getByText("Runs Mon, Wed, Fri at 8:00 AM")).toBeTruthy();
});

it("labels an explicitly selected source that is off in Profile without disabling this plan", () => {
  const plan = campaign("off", "Explicit", "precision");
  const target = plan.searchPreferences.discovery.targets[0]!;
  plan.sourceTargetIds = [target.id];
  plan.sourceSelectionMode = "selected";
  plan.searchPreferences.discovery.targets = [{ ...target, enabled: false }];
  render(
    <CampaignsScreen
      activeCampaignId="off"
      campaigns={[plan]}
      pending={false}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    screen.getByText("Off in Profile; this plan still searches it"),
  ).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>(target.label).checked).toBe(
    true,
  );
});

it("uses the shared run report for the plan card without replacing new jobs with retained jobs", () => {
  const run = round3SearchRun();
  const plan: JobSearchCampaign = {
    ...campaign("plan", "Example search", "precision"),
    latestDigest: {
      id: "digest",
      campaignId: "plan",
      discoveryRunId: run.id,
      generatedAt: run.startedAt,
      counts: {
        new: 22,
        changed: 0,
        reactivated: 0,
        inactive: 0,
        known: 0,
        skipped: 0,
      },
      failedSources: [],
      sourceOutcome: null,
      jobIds: [],
      report: { ...run.summary.report!, new: 22 },
    },
  };
  render(
    <CampaignsScreen
      activeCampaignId="plan"
      campaigns={[plan]}
      discoveryRuns={[run]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );
  const details = screen
    .getByText("What the last run found")
    .closest("details")!;
  expect(details.textContent).toContain("25 new to you");
  expect(details.textContent).toContain("22 kept");
  expect(details.textContent).toContain(
    "52 postings seen · 25 unique jobs · 25 new to you · 22 kept by this plan · 27 duplicates merged · 0 rejected · 0 deferred · 7 pages covered",
  );
  expect(details.textContent).not.toContain("22 new to you");
});

it("uses plain words for saved plan history and keeps toasts off plan actions", () => {
  const plan = campaign("one", "Plan", "scale");
  plan.history = [
    {
      id: "created",
      campaignId: plan.id,
      kind: "created",
      occurredAt: plan.createdAt,
      summary: "Plan created in precision mode.",
      discoveryRunId: null,
    },
    {
      id: "selected",
      campaignId: plan.id,
      kind: "activated",
      occurredAt: plan.createdAt,
      summary: "Plan selected as the active campaign.",
      discoveryRunId: null,
    },
  ];
  render(
    <CampaignsScreen
      activeCampaignId={plan.id}
      campaigns={[plan]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      onRunCampaignNow={vi.fn()}
      pending={false}
    />,
  );
  expect(screen.getByText(/Made current/)).toBeTruthy();
  expect(
    screen.getByText(/Created with the Focused search setting/),
  ).toBeTruthy();
  expect(screen.queryByText(/precision mode|active campaign/)).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Run now" })
      .closest("[data-toast-avoid]"),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Rules" }).closest("[data-toast-avoid]"),
  ).toBeTruthy();
});

it("collapses consecutive Made current history before taking the five visible entries", () => {
  const plan = campaign("one", "Plan", "scale");
  plan.history = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `select-${index}`,
      campaignId: plan.id,
      kind: "activated" as const,
      occurredAt: plan.createdAt,
      summary: "Made current",
      discoveryRunId: null,
    })),
    {
      id: "search",
      campaignId: plan.id,
      kind: "discovery_run",
      occurredAt: plan.createdAt,
      summary: "Search finished: 2 jobs saved.",
      discoveryRunId: "run",
    },
    {
      id: "select-older",
      campaignId: plan.id,
      kind: "activated",
      occurredAt: plan.createdAt,
      summary: "Made current",
      discoveryRunId: null,
    },
  ];
  render(
    <CampaignsScreen
      activeCampaignId={plan.id}
      campaigns={[plan]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      pending={false}
    />,
  );
  expect(screen.getAllByText(/Made current/)).toHaveLength(2);
  expect(screen.getByText(/Search finished: 2 jobs saved/)).toBeTruthy();
  expect(plan.history).toHaveLength(8);
});

it("keeps stacked toasts away from Delete plan and its confirmation", () => {
  const plan = campaign("one", "Plan", "scale");
  render(
    <CampaignsScreen
      activeCampaignId={plan.id}
      campaigns={[plan, campaign("two", "Other", "scale")]}
      onSaveCampaign={vi.fn()}
      onSelectCampaign={vi.fn()}
      onDeleteCampaign={vi.fn()}
      pending={false}
    />,
  );
  const deleteButton = screen.getAllByRole("button", {
    name: "Delete plan",
  })[0]!;
  expect(deleteButton.closest("[data-toast-avoid]")).toBeTruthy();
  fireEvent.click(deleteButton);
  expect(
    screen
      .getByRole("group", { name: "Confirm deleting Plan" })
      .hasAttribute("data-toast-avoid"),
  ).toBe(true);
});
