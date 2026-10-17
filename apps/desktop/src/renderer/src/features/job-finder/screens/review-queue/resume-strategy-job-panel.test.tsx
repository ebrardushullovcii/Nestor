// @vitest-environment jsdom

import type {
  ResumeStrategy,
  ResumeStrategyRecommendation,
  ResumeStrategySelection,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
} from "@nestor/contracts";
import { ResumeStrategySchema } from "@nestor/contracts";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeStrategyJobPanel } from "./resume-strategy-job-panel";

afterEach(() => {
  cleanup();
});

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

function recommendation(
  overrides: Partial<ResumeStrategyRecommendation> = {},
): ResumeStrategyRecommendation {
  return {
    jobId: "job_1",
    campaignId: "campaign_1",
    roleFamily: "Backend Engineering",
    strategyId: "strategy_1",
    strategyName: "Backend engineering",
    source: "role_family",
    reason: "Exact enabled role family match: “Backend Engineering”.",
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("ResumeStrategyJobPanel", () => {
  it("shows the inspectable recommendation reason and lets the user select it", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockResolvedValue(recommendation());
    const onSelect = vi.fn<(input: SelectResumeStrategyInput) => void>();

    render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={onSelect}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    expect(screen.getByText(/Checking approaches for this job/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Recommended: Backend engineering/)).toBeTruthy();
    });
    expect(screen.getByText(/Exact enabled role family match/)).toBeTruthy();

    fireEvent.change(
      screen.getByLabelText("Choose a resume approach for this job"),
      {
        target: { value: "strategy_1" },
      },
    );
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        campaignId: "campaign_1",
        strategyId: "strategy_1",
        source: "manual",
      }),
    );
    const selection = onSelect.mock.calls[0]?.[0];
    expect(selection?.reason).toContain(
      "User accepted the recommended approach",
    );
    expect(selection?.reason).toContain("Exact enabled role family match");
  });

  it("records a manual choice with a distinct inspectable reason", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockResolvedValue(recommendation());
    const onSelect = vi.fn<(input: SelectResumeStrategyInput) => void>();

    render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={onSelect}
        selections={[]}
        strategies={[
          strategy(),
          strategy({
            id: "strategy_2",
            name: "Frontend engineering",
            roleFamily: "Frontend Engineering",
          }),
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Recommended: Backend engineering/)).toBeTruthy();
    });
    fireEvent.change(
      screen.getByLabelText("Choose a resume approach for this job"),
      {
        target: { value: "strategy_2" },
      },
    );
    const selection = onSelect.mock.calls[0]?.[0];
    expect(selection?.strategyId).toBe("strategy_2");
    expect(selection?.reason).toContain(
      'User chose approach "Frontend engineering"',
    );
    expect(selection?.reason).not.toContain("strategy");
    expect(selection?.reason).toContain("instead of the recommendation");
  });

  it("shows a legacy persisted selection with strategy wording reworded to approach at display time only", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockResolvedValue(recommendation());
    const selection: ResumeStrategySelection = {
      id: "selection_1",
      campaignId: "campaign_1",
      jobId: "job_1",
      strategyId: "strategy_1",
      source: "user",
      reason: "User picked the backend strategy for this posting.",
      selectedAt: "2026-08-15T10:00:00.000Z",
    };

    render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[selection]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Your choice: Backend engineering/)).toBeTruthy();
    });
    // The stored reason keeps its original history; only the displayed copy
    // uses the current approach terminology.
    expect(
      screen.getByText("User picked the backend approach for this posting."),
    ).toBeTruthy();
    expect(screen.queryByText(/strategy for this posting/)).toBeNull();
  });

  it("shows an honest no-match state and never offers a disabled strategy", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockResolvedValue(
        recommendation({
          strategyId: null,
          strategyName: null,
          source: "none",
          roleFamily: null,
          reason:
            "No enabled approach matched role family “Data Engineering” and no search plan fallback is set.",
        }),
      );

    render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[
          strategy({ enabled: false }),
          strategy({
            id: "strategy_3",
            name: "Data engineering",
            roleFamily: "Data Engineering",
          }),
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No resume approach recommended")).toBeTruthy();
    });
    expect(
      screen.getByText(/No enabled approach matched role family/),
    ).toBeTruthy();

    const select = screen.getByLabelText(
      "Choose a resume approach for this job",
    );
    const options = Array.from(select.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toContain("Data engineering");
    expect(options).not.toContain("Backend engineering");
  });

  it("offers no approach-creation entry point in the shortlisted journey", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockResolvedValue(
        recommendation({
          strategyId: null,
          strategyName: null,
          source: "none",
          roleFamily: null,
          reason: "No enabled strategy is available for this job.",
        }),
      );

    render(
      <MemoryRouter>
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          selections={[]}
          strategies={[]}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledTimes(1);
    });
    // Creating a reusable approach is optional configuration; it belongs
    // behind More > Resume approaches, not in the middle of preparing a
    // resume for one job.
    expect(
      screen.queryByRole("link", {
        name: /Create custom resume approach/u,
      }),
    ).toBeNull();
    expect(screen.queryByText(/\(optional\)/u)).toBeNull();
  });

  it("does not re-request when the callback identity changes, but does refresh for a new job", async () => {
    let resolveRecommendation: (
      value: ResumeStrategyRecommendation | null,
    ) => void = () => undefined;
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockImplementation(
        () =>
          new Promise<ResumeStrategyRecommendation | null>((resolve) => {
            resolveRecommendation = resolve;
          }),
      );
    const { rerender } = render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledTimes(1);
    });

    const replacementOnRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockImplementation(({ jobId }) =>
        Promise.resolve(recommendation({ jobId })),
      );
    rerender(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={true}
        jobId="job_1"
        onRecommend={replacementOnRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    expect(replacementOnRecommend).not.toHaveBeenCalled();

    resolveRecommendation(recommendation());
    await waitFor(() => {
      expect(screen.getByText(/Recommended: Backend engineering/)).toBeTruthy();
    });

    rerender(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_2"
        onRecommend={replacementOnRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(replacementOnRecommend).toHaveBeenCalledWith({ jobId: "job_2" });
    });
    expect(onRecommend).toHaveBeenCalledTimes(1);
    expect(replacementOnRecommend).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the recommendation request when StrictMode replays the effect", async () => {
    const recommendationRequest =
      deferred<ResumeStrategyRecommendation | null>();
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockReturnValue(recommendationRequest.promise);

    render(
      <StrictMode>
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          selections={[]}
          strategies={[strategy()]}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledTimes(1);
    });
    expect(onRecommend).toHaveBeenCalledWith({ jobId: "job_1" });

    await act(async () => {
      recommendationRequest.resolve(recommendation());
      await recommendationRequest.promise;
    });
    expect(screen.getByText(/Recommended: Backend engineering/)).toBeTruthy();
  });

  it("ignores a job 1 recommendation that resolves after switching to job 2", async () => {
    const job1Request = deferred<ResumeStrategyRecommendation | null>();
    const job2Request = deferred<ResumeStrategyRecommendation | null>();
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockImplementation(({ jobId }) =>
        jobId === "job_1" ? job1Request.promise : job2Request.promise,
      );
    const { rerender } = render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledWith({ jobId: "job_1" });
    });
    rerender(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_2"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );
    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledWith({ jobId: "job_2" });
    });

    await act(async () => {
      job1Request.resolve(
        recommendation({
          jobId: "job_1",
          reason: "Stale job 1 recommendation.",
        }),
      );
      await job1Request.promise;
    });
    expect(screen.getByText(/Checking approaches for this job/)).toBeTruthy();
    expect(screen.queryByText("Stale job 1 recommendation.")).toBeNull();

    await act(async () => {
      job2Request.resolve(
        recommendation({
          jobId: "job_2",
          reason: "Fresh job 2 recommendation.",
        }),
      );
      await job2Request.promise;
    });
    expect(screen.getByText("Fresh job 2 recommendation.")).toBeTruthy();
  });

  it("ignores a job 1 recommendation failure after switching to job 2", async () => {
    const job1Request = deferred<ResumeStrategyRecommendation | null>();
    const job2Request = deferred<ResumeStrategyRecommendation | null>();
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockImplementation(({ jobId }) =>
        jobId === "job_1" ? job1Request.promise : job2Request.promise,
      );
    const { rerender } = render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledWith({ jobId: "job_1" });
    });
    rerender(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_2"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );
    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledWith({ jobId: "job_2" });
    });

    await act(async () => {
      job1Request.reject(new Error("Stale job 1 failure."));
      await Promise.resolve();
    });
    expect(screen.getByText(/Checking approaches for this job/)).toBeTruthy();
    expect(screen.queryByText("Stale job 1 failure.")).toBeNull();
    expect(screen.queryByText("Recommendation unavailable")).toBeNull();

    await act(async () => {
      job2Request.resolve(
        recommendation({
          jobId: "job_2",
          reason: "Fresh job 2 recommendation after stale failure.",
        }),
      );
      await job2Request.promise;
    });
    expect(
      screen.getByText("Fresh job 2 recommendation after stale failure."),
    ).toBeTruthy();
  });

  it("does not update after a pending recommendation resolves after unmount", async () => {
    const recommendationRequest =
      deferred<ResumeStrategyRecommendation | null>();
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockReturnValue(recommendationRequest.promise);
    const { unmount } = render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(onRecommend).toHaveBeenCalledTimes(1);
    });
    unmount();

    await act(async () => {
      recommendationRequest.resolve(
        recommendation({ reason: "Resolved after unmount." }),
      );
      await recommendationRequest.promise;
    });
    expect(screen.queryByText("Resolved after unmount.")).toBeNull();
    expect(screen.queryByText(/Recommended:/)).toBeNull();
  });

  it("shows a loading state while recommending and an error state on failure", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockRejectedValue(new Error("The campaign is unavailable."));

    render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Recommendation unavailable")).toBeTruthy();
    });
    expect(screen.getByText("The campaign is unavailable.")).toBeTruthy();
  });

  it("offers a truthful retry and safe navigation after the recommendation is unavailable", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockRejectedValueOnce(new Error("The campaign is unavailable."))
      .mockResolvedValueOnce(recommendation());

    render(
      <MemoryRouter>
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          selections={[]}
          strategies={[strategy()]}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Recommendation unavailable")).toBeTruthy();
    });
    expect(screen.getByText("The campaign is unavailable.")).toBeTruthy();
    expect(
      screen.getByText(
        "Nothing was changed. You can retry the recommendation or manage your approaches directly.",
      ),
    ).toBeTruthy();
    const manageLink = screen.getByRole("link", {
      name: "Manage resume approaches",
    });
    expect(manageLink.getAttribute("href")).toBe(
      "/job-finder/resume-strategies?returnTo=%2Fjob-finder%2Freview-queue%3FjobId%3Djob_1",
    );

    expect(onRecommend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByText(/Checking approaches for this job/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/Recommended: Backend engineering/)).toBeTruthy();
    });
    expect(onRecommend).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Recommendation unavailable")).toBeNull();
  });

  it("retries without fabricating success when the retry also fails", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockRejectedValueOnce(new Error("The campaign is unavailable."))
      .mockRejectedValueOnce(new Error("Still unavailable."));

    render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Recommendation unavailable")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(screen.getByText("Still unavailable.")).toBeTruthy();
    });
    expect(screen.getByText("Recommendation unavailable")).toBeTruthy();
    expect(screen.queryByText(/Recommended:/)).toBeNull();
    expect(onRecommend).toHaveBeenCalledTimes(2);
  });

  it("styles the strategy select with canonical field tokens and focus hierarchy", async () => {
    const onRecommend = vi
      .fn<
        (input: {
          jobId: string;
        }) => Promise<ResumeStrategyRecommendation | null>
      >()
      .mockResolvedValue(recommendation());

    const { container } = render(
      <ResumeStrategyJobPanel
        campaignId="campaign_1"
        isPending={false}
        jobId="job_1"
        onRecommend={onRecommend}
        onSelect={vi.fn()}
        selections={[]}
        strategies={[strategy()]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Recommended: Backend engineering/)).toBeTruthy();
    });

    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects.length).toBe(1);
    const select = selects[0]!;
    for (const className of [
      "h-11",
      "rounded-(--radius-field)",
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
    expect(container.innerHTML).not.toContain("border-input");
  });

  describe("when enabled approaches exist but nothing is recommended", () => {
    function softwareStrategy(): ResumeStrategy {
      return strategy({
        id: "strategy_se",
        name: "Software engineering",
        roleFamily: "Software Engineering",
      });
    }

    function mismatchedRecommendation(): ResumeStrategyRecommendation {
      return recommendation({
        strategyId: null,
        strategyName: null,
        source: "none",
        roleFamily: null,
        reason:
          "No enabled approach matched this job and no search plan fallback is set.",
      });
    }

    function userSelection(
      overrides: Partial<ResumeStrategySelection> = {},
    ): ResumeStrategySelection {
      return {
        id: "selection_se",
        campaignId: "campaign_1",
        jobId: "job_1",
        strategyId: "strategy_se",
        source: "user",
        reason:
          'User chose strategy "Software engineering" for this job instead of the recommendation.',
        selectedAt: "2026-08-25T10:00:00.000Z",
        ...overrides,
      };
    }

    it("explains the mismatch in plain language and still lists the enabled approach", async () => {
      const onRecommend = vi
        .fn<
          (input: {
            jobId: string;
          }) => Promise<ResumeStrategyRecommendation | null>
        >()
        .mockResolvedValue(mismatchedRecommendation());

      render(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          selections={[]}
          strategies={[softwareStrategy()]}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("No resume approach recommended")).toBeTruthy();
      });
      expect(
        screen.getByText(/None of your enabled approaches matched this job/),
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Creating a new approach never applies it automatically/,
        ),
      ).toBeTruthy();

      const select = screen.getByLabelText(
        "Choose a resume approach for this job",
      );
      const options = Array.from(select.querySelectorAll("option")).map(
        (option) => option.textContent,
      );
      expect(options).toContain("Software engineering");
    });

    it("keeps a per-job choice scoped to this job and never touches the search plan default", async () => {
      const onSelect = vi.fn<(input: SelectResumeStrategyInput) => void>();
      const onSetCampaignDefault =
        vi.fn<(input: SetCampaignResumeStrategyDefaultInput) => void>();
      const onRecommend = vi
        .fn<
          (input: {
            jobId: string;
          }) => Promise<ResumeStrategyRecommendation | null>
        >()
        .mockResolvedValue(mismatchedRecommendation());

      const { rerender } = render(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={onSelect}
          onSetCampaignDefault={onSetCampaignDefault}
          selections={[]}
          strategies={[softwareStrategy()]}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("No resume approach recommended")).toBeTruthy();
      });
      expect(screen.getByText("Use for this job only")).toBeTruthy();
      expect(
        screen.getByText(
          /Other jobs and this search plan's default stay unchanged/,
        ),
      ).toBeTruthy();

      fireEvent.change(
        screen.getByLabelText("Choose a resume approach for this job"),
        { target: { value: "strategy_se" } },
      );
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job_1",
          campaignId: "campaign_1",
          strategyId: "strategy_se",
          source: "manual",
        }),
      );
      expect(onSetCampaignDefault).not.toHaveBeenCalled();

      // The parent applies the selection; the search plan default stays null.
      rerender(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={onSelect}
          onSetCampaignDefault={onSetCampaignDefault}
          selections={[userSelection()]}
          strategies={[softwareStrategy()]}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText("Your choice: Software engineering"),
        ).toBeTruthy();
      });
      expect(
        screen.getByText(
          /Applies to this job only — other jobs and the search plan default are unchanged/,
        ),
      ).toBeTruthy();
      expect(onSetCampaignDefault).not.toHaveBeenCalled();
    });

    it("sets the search plan fallback only after an explicit click and then recommends from it", async () => {
      const fallbackRecommendation = recommendation({
        strategyId: "strategy_se",
        strategyName: "Software engineering",
        source: "campaign_default",
        roleFamily: null,
        reason:
          "No enabled approach matched this job; using search plan fallback “Software engineering”.",
      });
      const onSetCampaignDefault =
        vi.fn<(input: SetCampaignResumeStrategyDefaultInput) => void>();
      const onRecommend = vi
        .fn<
          (input: {
            jobId: string;
          }) => Promise<ResumeStrategyRecommendation | null>
        >()
        .mockResolvedValueOnce(mismatchedRecommendation())
        .mockResolvedValueOnce(fallbackRecommendation);

      const { rerender } = render(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          onSetCampaignDefault={onSetCampaignDefault}
          selections={[]}
          strategies={[softwareStrategy()]}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("No resume approach recommended")).toBeTruthy();
      });
      fireEvent.change(
        screen.getByLabelText("Choose a resume approach for this job"),
        { target: { value: "strategy_se" } },
      );

      // The parent applied the per-job choice; now the deliberate fallback
      // action is offered for that chosen approach.
      rerender(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          onSetCampaignDefault={onSetCampaignDefault}
          selections={[userSelection()]}
          strategies={[softwareStrategy()]}
        />,
      );

      const fallbackButton = await waitFor(() =>
        screen.getByRole("button", { name: "Set as search plan default" }),
      );
      expect(onSetCampaignDefault).not.toHaveBeenCalled();
      expect(screen.getByText(/future jobs in this search plan/)).toBeTruthy();

      fireEvent.click(fallbackButton);
      expect(onSetCampaignDefault).toHaveBeenCalledTimes(1);
      expect(onSetCampaignDefault).toHaveBeenCalledWith({
        campaignId: "campaign_1",
        strategyId: "strategy_se",
      });

      // The parent persisted the default; the recommendation refreshes from it.
      rerender(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          campaignDefaultResumeStrategyId="strategy_se"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          onSetCampaignDefault={onSetCampaignDefault}
          selections={[userSelection()]}
          strategies={[softwareStrategy()]}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText("Recommended: Software engineering"),
        ).toBeTruthy();
      });
      expect(onRecommend).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText(/using search plan fallback “Software engineering”/),
      ).toBeTruthy();
      expect(
        screen.getByText("Search plan default: Software engineering"),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Set as search plan default" }),
      ).toBeNull();
    });

    it("keeps a matched role-family recommendation unchanged", async () => {
      const onRecommend = vi
        .fn<
          (input: {
            jobId: string;
          }) => Promise<ResumeStrategyRecommendation | null>
        >()
        .mockResolvedValue(recommendation());

      render(
        <ResumeStrategyJobPanel
          campaignId="campaign_1"
          isPending={false}
          jobId="job_1"
          onRecommend={onRecommend}
          onSelect={vi.fn()}
          selections={[]}
          strategies={[strategy(), softwareStrategy()]}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText(/Recommended: Backend engineering/),
        ).toBeTruthy();
      });
      expect(
        screen.queryByText(/None of your enabled approaches matched this job/),
      ).toBeNull();
      // Without an explicit user choice there is no fallback offer.
      expect(
        screen.queryByRole("button", { name: "Set as search plan default" }),
      ).toBeNull();

      const select = screen.getByLabelText(
        "Choose a resume approach for this job",
      );
      const options = Array.from(select.querySelectorAll("option")).map(
        (option) => option.textContent,
      );
      expect(options).toContain("Backend engineering (recommended)");
    });
  });
});
