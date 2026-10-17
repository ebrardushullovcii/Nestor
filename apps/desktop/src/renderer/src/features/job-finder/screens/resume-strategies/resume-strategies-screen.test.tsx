// @vitest-environment jsdom

import type {
  JobSearchCampaign,
  ResumeStrategy,
  SaveResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
} from "@nestor/contracts";
import { ResumeStrategySchema } from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeStrategiesScreen } from "./resume-strategies-screen";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function render(
  element: Parameters<typeof rtlRender>[0],
  initialEntries: string[] = ["/job-finder/resume-strategies"],
) {
  return rtlRender(
    <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>,
  );
}

function strategy(overrides: Partial<ResumeStrategy> = {}): ResumeStrategy {
  return ResumeStrategySchema.parse({
    id: "strategy_1",
    name: "Backend engineering",
    roleFamily: "Backend Engineering",
    baseResumeDocumentId: "resume_1",
    templateId: "classic_ats",
    headlinePolicy: "fixed",
    skillsPolicy: "base_only",
    coveragePolicy: "base_omissions",
    tailoringStrength: "conservative",
    evidenceBoundaries: {},
    enabled: true,
    createdAt: "2026-08-15T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    ...overrides,
  });
}

function campaign(
  overrides: Partial<JobSearchCampaign> = {},
): JobSearchCampaign {
  return {
    id: "campaign_1",
    name: "Remote backend",
    description: "Backend roles",
    mode: "precision",
    status: "active",
    sourceTargetIds: [],
    jobIds: [],
    minimumFitScore: null,
    searchPreferences: {
      targetRoles: ["Backend Engineer"],
      jobFamilies: [],
      locations: [],
      excludedLocations: [],
      workModes: [],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "unknown",
      },
      approvalMode: "manual",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [],
      },
    },
    limits: {
      retainedJobTarget: 15,
      analysisConcurrency: 2,
      preparationBatchSize: 5,
      dailyPreparationLimit: null,
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
      defaultResumeStrategyId: null,
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
      jobsFound: 0,
      jobsRetained: 0,
      applicationsPrepared: 0,
      applicationsApplied: 0,
      currentBatchCompleted: 0,
      currentBatchTotal: 0,
      blockedCount: 0,
      remainingQueueSize: 0,
      lastRunAt: null,
      lastUpdatedAt: "2026-08-15T09:00:00.000Z",
    },
    history: [],
    createdAt: "2026-08-15T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    rules: [],
    ...overrides,
  } as unknown as JobSearchCampaign;
}

describe("ResumeStrategiesScreen", () => {
  it("shows an honest empty state when no strategies exist", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    expect(
      screen.getByText("Save how you want your resume tailored"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("searchbox", { name: "Search approaches" }),
    ).toBeNull();
  });

  it("repeats the New strategy action inside the strategies empty state", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    const newStrategyButtons = screen.getAllByRole("button", {
      name: "New resume approach",
    });
    expect(newStrategyButtons.length).toBe(2);

    fireEvent.click(newStrategyButtons[1]!);
    expect(
      screen.getByRole("heading", { name: "Create resume approach" }),
    ).toBeTruthy();
  });

  it("offers a safe return to the shortlisted job", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
      [
        "/job-finder/resume-strategies?returnTo=%2Fjob-finder%2Freview-queue%3FjobId%3Djob_1",
      ],
    );

    expect(
      screen
        .getByRole("link", { name: "Back to shortlisted job" })
        .getAttribute("href"),
    ).toBe("/job-finder/review-queue?jobId=job_1");
  });

  it("ignores an unsafe return target", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
      [
        "/job-finder/resume-strategies?returnTo=https%3A%2F%2Fevil.example%2Fsteal",
      ],
    );

    expect(
      screen.queryByRole("link", { name: "Back to shortlisted job" }),
    ).toBeNull();
  });

  it("shows a loading state while the strategies are still loading", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    expect(screen.getByText("Loading resume approaches")).toBeTruthy();
  });

  it("searches strategies by role family and shows a no-match state", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[
          strategy(),
          strategy({
            id: "strategy_2",
            name: "Data engineering",
            roleFamily: "Data Engineering",
          }),
        ]}
      />,
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search approaches" }),
      {
        target: { value: "data" },
      },
    );
    expect(screen.getByText("Data engineering")).toBeTruthy();
    expect(screen.queryByText("Backend engineering")).toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search approaches" }),
      {
        target: { value: "design" },
      },
    );
    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent === "No approaches match “design”",
      ),
    ).toBeTruthy();
  });

  it("disables an enabled strategy through the card action", () => {
    const onDisableStrategy = vi.fn();
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={onDisableStrategy}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[strategy()]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(onDisableStrategy).toHaveBeenCalledWith("strategy_1");
  });

  it("re-enables a disabled strategy by saving with enabled true", () => {
    const onSaveStrategy = vi
      .fn<(input: SaveResumeStrategyInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    const disabled = strategy({ enabled: false });
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={onSaveStrategy}
        onSetCampaignDefault={vi.fn()}
        strategies={[disabled]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    const saved = onSaveStrategy.mock.calls[0]?.[0];
    expect(saved?.id).toBe("strategy_1");
    expect(saved?.enabled).toBe(true);
    expect(saved?.name).toBe("Backend engineering");
  });

  it("creates a strategy with explicit policy fields and never an approval flag", () => {
    const onSaveStrategy = vi
      .fn<(input: SaveResumeStrategyInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={onSaveStrategy}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "New resume approach" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Frontend engineering" },
    });
    fireEvent.change(screen.getByLabelText("Role family"), {
      target: { value: "Frontend Engineering" },
    });
    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "modern_split" },
    });
    fireEvent.change(screen.getByLabelText("Tailoring strength"), {
      target: { value: "balanced" },
    });
    fireEvent.click(
      screen.getByLabelText("Allow paraphrased claims grounded in evidence"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create resume approach" }),
    );

    const saved = onSaveStrategy.mock.calls[0]?.[0];
    expect(saved?.id).toBeNull();
    expect(saved?.name).toBe("Frontend engineering");
    expect(saved?.roleFamily).toBe("Frontend Engineering");
    expect(saved?.templateId).toBe("modern_split");
    expect(saved?.tailoringStrength).toBe("balanced");
    expect(saved?.baseResumeDocumentId).toBe("resume_1");
    expect(saved?.evidenceBoundaries.allowParaphrasedClaims).toBe(true);
    expect(saved).not.toHaveProperty("approvedAt");
    expect(saved).not.toHaveProperty("applicationReady");
  });

  it("assigns a campaign default from enabled strategies only", () => {
    const onSetCampaignDefault =
      vi.fn<(input: SetCampaignResumeStrategyDefaultInput) => void>();
    const disabled = strategy({
      id: "strategy_disabled",
      name: "Legacy",
      enabled: false,
    });
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[campaign()]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={onSetCampaignDefault}
        strategies={[strategy(), disabled]}
      />,
    );

    const select = screen.getByLabelText("Remote backend");
    const options = Array.from(select.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    // The disabled strategy is not offered as a campaign default.
    expect(options).toContain("Backend engineering");
    expect(options).not.toContain("Legacy");

    fireEvent.change(select, { target: { value: "strategy_1" } });
    expect(onSetCampaignDefault).toHaveBeenCalledWith({
      campaignId: "campaign_1",
      strategyId: "strategy_1",
    });
  });

  it("keeps a disabled persisted default visible with status and a clear action", () => {
    const onSetCampaignDefault =
      vi.fn<(input: SetCampaignResumeStrategyDefaultInput) => void>();
    const disabled = strategy({
      id: "strategy_disabled",
      name: "Legacy",
      enabled: false,
    });
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[
          campaign({
            applicationPolicy: {
              ...campaign().applicationPolicy,
              defaultResumeStrategyId: "strategy_disabled",
            },
          }),
        ]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={onSetCampaignDefault}
        strategies={[strategy(), disabled]}
      />,
    );

    const disabledOption = screen.getByRole("option", {
      name: "Legacy (Disabled)",
    });
    expect(disabledOption).toBeTruthy();
    expect((disabledOption as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Legacy is still this search plan's default, but it will not be recommended while disabled.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear default" }));
    expect(onSetCampaignDefault).toHaveBeenCalledWith({
      campaignId: "campaign_1",
      strategyId: null,
    });
  });

  it("retains the editor draft when saving fails", async () => {
    const onSaveStrategy = vi
      .fn<(input: SaveResumeStrategyInput) => Promise<boolean>>()
      .mockResolvedValue(false);
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={onSaveStrategy}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "New resume approach" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Frontend engineering" },
    });
    fireEvent.change(screen.getByLabelText("Role family"), {
      target: { value: "Frontend Engineering" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create resume approach" }),
    );

    await waitFor(() => expect(onSaveStrategy).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("heading", { name: "Create resume approach" }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Frontend engineering")).toBeTruthy();
  });

  it("closes the editor only after saving succeeds", async () => {
    const onSaveStrategy = vi
      .fn<(input: SaveResumeStrategyInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={onSaveStrategy}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "New resume approach" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Frontend engineering" },
    });
    fireEvent.change(screen.getByLabelText("Role family"), {
      target: { value: "Frontend Engineering" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create resume approach" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Create resume approach" }),
      ).toBeNull(),
    );
  });

  it("rejects nothing and keeps controls keyboard accessible", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage="Strategy saved. Reusing it never approves a résumé."
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[strategy()]}
      />,
    );

    expect(screen.getByRole("status")).toBeTruthy();
    // Native controls used throughout are keyboard reachable.
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("styles native strategy selects with canonical field tokens and focus hierarchy", () => {
    const { container } = render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[campaign()]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "New resume approach" })[0]!,
    );

    // Five editor policy selects plus the campaign default select.
    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects.length).toBe(6);
    for (const select of selects) {
      for (const className of [
        "border-(--field-border)",
        "bg-(--field)",
        "outline-none",
        "focus-visible:border-(--field-focus-border)",
        "focus-visible:bg-(--field-strong)",
        "focus-visible:shadow-[var(--field-focus-shadow)]",
      ]) {
        expect(select.classList.contains(className)).toBe(true);
      }
      expect(select.className).not.toContain("border-input");
      expect(select.className).not.toContain("--surface-panel-raised");
    }
    expect(container.innerHTML).not.toContain("border-input");
  });

  it("shows a truthful unavailable state with a working retry instead of a false empty success", () => {
    const onRetry = vi.fn();
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        loadError="Strategies could not be loaded. Check your connection and try again."
        onDisableStrategy={vi.fn()}
        onRetry={onRetry}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Resume approaches unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Strategies could not be loaded. Check your connection and try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your saved approaches are safe. You can retry loading them now.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No resume strategies yet")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps stored strategies visible alongside the unavailable banner when a refresh fails", () => {
    const onRetry = vi.fn();
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        loadError="Could not refresh strategies."
        onDisableStrategy={vi.fn()}
        onRetry={onRetry}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[strategy()]}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Backend engineering")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("offers a safe return to the shortlisted job from the unavailable state", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        loadError="Strategies could not be loaded."
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
      [
        "/job-finder/resume-strategies?returnTo=%2Fjob-finder%2Freview-queue%3FjobId%3Djob_1",
      ],
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    const backLinks = screen.getAllByRole("link", {
      name: "Back to shortlisted job",
    });
    expect(backLinks.length).toBeGreaterThanOrEqual(1);
    expect(
      backLinks.some(
        (link) =>
          link.getAttribute("href") === "/job-finder/review-queue?jobId=job_1",
      ),
    ).toBe(true);
  });

  it("does not show a retry action when no retry handler is owned", () => {
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        loadError="Strategies could not be loaded."
        onDisableStrategy={vi.fn()}
        onSaveStrategy={vi.fn()}
        onSetCampaignDefault={vi.fn()}
        strategies={[]}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("ResumeStrategiesScreen usage after an edit", () => {
  it("says which shortlisted jobs use the saved approach and offers to re-tailor their unapproved drafts", async () => {
    const onSaveStrategy = vi.fn().mockResolvedValue(true);
    const onRetailorJobs = vi.fn();
    render(
      <ResumeStrategiesScreen
        actionMessage={null}
        baseResumeDocumentId="resume_1"
        campaigns={[]}
        candidateDocumentIds={[]}
        isCampaignDefaultPending={() => false}
        isDisablePending={() => false}
        isLoading={false}
        isSavePending={false}
        onDisableStrategy={vi.fn()}
        onRetailorJobs={onRetailorJobs}
        onSaveStrategy={onSaveStrategy}
        onSetCampaignDefault={vi.fn()}
        strategies={[strategy()]}
        strategyUsage={() => ({
          jobCount: 3,
          retailorableJobIds: ["job_1", "job_2"],
          approvedCount: 1,
        })}
      />,
    );

    expect(screen.getByText("3 shortlisted jobs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    const notice = await screen.findByTestId("resume-strategy-usage-notice");
    expect(notice.textContent).toContain("3 shortlisted jobs use");
    expect(notice.textContent).toContain("1 approved resume is left untouched");
    fireEvent.click(screen.getByRole("button", { name: "Re-tailor 2 drafts" }));
    expect(onRetailorJobs).toHaveBeenCalledWith(["job_1", "job_2"]);
    expect(screen.queryByTestId("resume-strategy-usage-notice")).toBeNull();
  });
});
