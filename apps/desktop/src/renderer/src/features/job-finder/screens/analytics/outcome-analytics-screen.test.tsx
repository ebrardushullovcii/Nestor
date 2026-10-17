// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  OutcomeEventSchema,
} from "@nestor/contracts";
import type {
  JobSearchCampaign,
  OutcomeAnalyticsOverview,
  OutcomeEvent,
  ResumeStrategy,
  SetOutcomeSuggestionEnabledInput,
} from "@nestor/contracts";
import { MemoryRouter } from "react-router-dom";
import { OutcomeAnalyticsScreen } from "./outcome-analytics-screen";

const now = "2026-08-15T10:00:00.000Z";

function getAnalyticsButton(name: string): HTMLButtonElement {
  const element = screen.getByRole("button", { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${name} control is not a button`);
  }
  return element;
}

function event(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  const id = overrides.id ?? "event-1";
  return OutcomeEventSchema.parse({
    id,
    outcome: "applied",
    jobId: overrides.jobId ?? `job-${id}`,
    campaignId: "campaign-1",
    source: "example",
    company: "Example Corp",
    jobTitle: "Software Engineer",
    occurredAt: now,
    userControlled: true,
    ...overrides,
  });
}

const campaigns: readonly JobSearchCampaign[] = [
  {
    id: "campaign-1",
    name: "Fall campaign",
    jobIds: ["job-1"],
  },
  {
    id: "campaign-2",
    name: "Winter campaign",
    jobIds: ["job-2"],
  },
] as unknown as readonly JobSearchCampaign[];

const resumeStrategies: readonly ResumeStrategy[] = [
  {
    id: "strategy-1",
    name: "SWE generalist",
    roleFamily: "software_engineering",
  },
] as unknown as readonly ResumeStrategy[];

function overviewWith(
  overrides: Partial<OutcomeAnalyticsOverview> = {},
): OutcomeAnalyticsOverview {
  return {
    generatedAt: now,
    buckets: [
      {
        dimension: "campaign",
        key: "campaign-1",
        label: "campaign-1",
        sampleSize: 30,
        outcomeCounts: { interview: 10, rejected: 20 },
        rateNumerators: {
          applied: 30,
          response: 30,
          interview: 10,
          offer: 0,
        },
        appliedRate: 1,
        responseRate: 1,
        interviewRate: 1 / 3,
        offerRate: 0,
        uncertainty: {
          level: "medium",
          minimumSampleForConfidence: 30,
          confidenceInterval95HalfWidth: 0.1,
        },
        suggestion: {
          enabled: true,
          kind: "increase_volume",
          label: "Increase volume for campaign-1",
          reason:
            "Interview rate 33% meets or exceeds the 20% target — increase volume for this campaign.",
          disabledByUser: false,
          resetRequested: false,
          lastResetAt: null,
        },
        updatedAt: now,
      },
    ],
    ...overrides,
  };
}

/** The rendered bucket card for one stored key, or null when it is not shown. */
function bucketKeyCard(key: string): Element | null {
  return document.querySelector(`[data-outcome-bucket-key="${key}"]`);
}

function renderScreen(props: {
  events?: readonly OutcomeEvent[];
  overview?: OutcomeAnalyticsOverview | null;
  onSetOutcomeSuggestionEnabled?: (
    input: SetOutcomeSuggestionEnabledInput,
  ) => Promise<boolean>;
  isSuggestionPending?: (dimension: string, key: string) => boolean;
  actionMessage?: string | null;
}) {
  return render(
    <MemoryRouter>
      <OutcomeAnalyticsScreen
        actionMessage={props.actionMessage ?? null}
        activeCampaignId="campaign-1"
        campaigns={campaigns}
        events={props.events ?? []}
        generatedAt={now}
        isSuggestionPending={props.isSuggestionPending ?? (() => false)}
        onSetOutcomeSuggestionEnabled={
          props.onSetOutcomeSuggestionEnabled ?? (() => Promise.resolve(true))
        }
        overview={props.overview ?? null}
        resumeStrategies={resumeStrategies}
      />
    </MemoryRouter>,
  );
}

describe("OutcomeAnalyticsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows an honest empty state when no outcomes have been recorded", () => {
    renderScreen({});

    expect(
      screen.getByRole("heading", { name: "No outcomes recorded yet" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Response and interview rates from your recorded outcomes/i,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Outcomes" })).toBeTruthy();
    expect(
      screen.getByText(
        "Response and interview rates from your recorded outcomes.",
      ).textContent.length,
    ).toBeLessThanOrEqual(90);
  });

  it("links the all-time empty state to the Applications Tracker", () => {
    renderScreen({});

    const link = screen.getByRole("link", {
      name: "Open Applications Tracker",
    });
    expect(link.getAttribute("href")).toBe("/job-finder/applications");
  });

  it("links the campaign-scoped empty state to the Applications Tracker", () => {
    renderScreen({
      events: [event({ campaignId: "campaign-2", id: "event-other" })],
    });

    const link = screen.getByRole("link", {
      name: "Open Applications Tracker",
    });
    expect(link.getAttribute("href")).toBe("/job-finder/applications");
    expect(
      screen.getByRole("heading", { name: "No outcomes in this search plan" }),
    ).toBeTruthy();
  });

  it("shows rates, sample sizes, and uncertainty from the durable overview", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    renderScreen({ events, overview: overviewWith() });

    expect(screen.getAllByText("Fall campaign").length).toBeGreaterThan(0);
    expect(screen.getByText("Current search plan")).toBeTruthy();
    expect(screen.getAllByText(/30 applications/).length).toBeGreaterThan(0);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.getAllByText(/Medium uncertainty/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/Increase volume for campaign-1/i)).toBeTruthy();
  });

  it("disables a suggestion through the page action without applying it", async () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const onSetOutcomeSuggestionEnabled = vi
      .fn<(input: SetOutcomeSuggestionEnabledInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderScreen({
      events,
      overview: overviewWith(),
      onSetOutcomeSuggestionEnabled,
    });

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await vi.waitFor(() => {
      expect(onSetOutcomeSuggestionEnabled).toHaveBeenCalledWith({
        dimension: "campaign",
        key: "campaign-1",
        enabled: false,
        reset: false,
      });
    });
  });

  it("resets a suggestion with the reset flag so analytics re-evaluate it", async () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const onSetOutcomeSuggestionEnabled = vi
      .fn<(input: SetOutcomeSuggestionEnabledInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderScreen({
      events,
      overview: overviewWith(),
      onSetOutcomeSuggestionEnabled,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await vi.waitFor(() => {
      expect(onSetOutcomeSuggestionEnabled).toHaveBeenCalledWith({
        dimension: "campaign",
        key: "campaign-1",
        enabled: true,
        reset: true,
      });
    });
  });

  it("surfaces a disabled-by-user suggestion with only a reset control", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const overview = overviewWith();
    overview.buckets[0]!.suggestion = {
      enabled: false,
      kind: "none",
      label: null,
      reason: null,
      disabledByUser: true,
      resetRequested: false,
      lastResetAt: null,
    };
    renderScreen({ events, overview });

    expect(screen.getByText("Suggestion disabled by you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.getByText("Suggestion off")).toBeTruthy();
  });

  it("filters buckets by local search and shows a no-match state", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    renderScreen({ events, overview: overviewWith() });

    const search = screen.getByLabelText(/Filter search plans/i);
    fireEvent.change(search, { target: { value: "Fall campaign" } });
    expect(screen.getAllByText("Fall campaign").length).toBeGreaterThan(0);

    fireEvent.change(search, { target: { value: "no-such-campaign" } });
    expect(screen.getByText(/No search plans match/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText(/No search plans match/i)).toBeNull();
  });

  it("switches dimensions with keyboard-accessible tab buttons", () => {
    const events = [
      event({ id: "s1", source: "linkedin", jobId: "job-s1" }),
      event({ id: "s2", source: "linkedin", jobId: "job-s2" }),
      event({ id: "s3", source: "linkedin", jobId: "job-s3" }),
      event({ id: "s4", source: "linkedin", jobId: "job-s4" }),
      event({ id: "s5", source: "linkedin", jobId: "job-s5" }),
      event({ id: "s6", source: "linkedin", jobId: "job-s6" }),
      event({ id: "s7", source: "linkedin", jobId: "job-s7" }),
      event({ id: "s8", source: "linkedin", jobId: "job-s8" }),
      event({ id: "s9", source: "linkedin", jobId: "job-s9" }),
      event({ id: "s10", source: "linkedin", jobId: "job-s10" }),
    ];
    const overview = overviewWith({
      buckets: [
        {
          dimension: "source",
          key: "linkedin",
          label: "linkedin",
          sampleSize: 10,
          outcomeCounts: { applied: 10 },
          rateNumerators: {
            applied: 10,
            response: 0,
            interview: 0,
            offer: 0,
          },
          appliedRate: 1,
          responseRate: 0,
          interviewRate: 0,
          offerRate: 0,
          uncertainty: {
            level: "high",
            minimumSampleForConfidence: 30,
            confidenceInterval95HalfWidth: null,
          },
          suggestion: {
            enabled: false,
            kind: "none",
            label: null,
            reason: null,
            disabledByUser: false,
            resetRequested: false,
            lastResetAt: null,
          },
          updatedAt: now,
        },
      ],
    });
    renderScreen({ events, overview });

    const sourceTab = screen.getByRole("button", { name: "Source" });
    expect(sourceTab.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(sourceTab);
    expect(sourceTab.getAttribute("aria-pressed")).toBe("true");
    // The stored source value is never shown; the card is found by its key.
    expect(
      document.querySelector('[data-outcome-bucket-key="linkedin"]'),
    ).toBeTruthy();
  });

  it("keeps a 10k-event dimension view deterministic and paged", () => {
    const events = Array.from({ length: 10_000 }, (_, index) =>
      event({
        id: `large-${index}`,
        jobId: `large-job-${index}`,
        source: `source-${String(index).padStart(5, "0")}`,
      }),
    );
    renderScreen({ events });

    fireEvent.click(screen.getByRole("button", { name: "Source" }));

    expect(screen.getAllByRole("article")).toHaveLength(40);
    expect(screen.getByText(/1–40 of 10000/)).toBeTruthy();
    expect(screen.getByText("Page 1 of 250")).toBeTruthy();
    expect(bucketKeyCard("source-00000")).toBeTruthy();
    expect(bucketKeyCard("source-00040")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getAllByRole("article")).toHaveLength(40);
    expect(screen.getByText(/41–80 of 10000/)).toBeTruthy();
    expect(screen.getByText("Page 2 of 250")).toBeTruthy();
    expect(bucketKeyCard("source-00040")).toBeTruthy();
    expect(bucketKeyCard("source-00000")).toBeNull();
  });

  it("keeps suggestion controls disabled while their action is pending", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    renderScreen({
      events,
      overview: overviewWith(),
      isSuggestionPending: (dimension, key) =>
        dimension === "campaign" && key === "campaign-1",
    });

    // Pending keeps the suggestion controls exposed but inert.
    expect(getAnalyticsButton("Disable").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(getAnalyticsButton("Reset").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("shows the action message as a live status region", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e-${index}`,
        jobId: `job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    renderScreen({
      events,
      overview: overviewWith(),
      actionMessage:
        "Suggestion disabled. It will stay off until you reset it.",
    });

    expect(screen.getByRole("status").textContent).toMatch(
      /Suggestion disabled/,
    );
  });

  it("shows an honest loading state while analytics inputs are loading", () => {
    render(
      <MemoryRouter>
        <OutcomeAnalyticsScreen
          actionMessage={null}
          activeCampaignId="campaign-1"
          campaigns={campaigns}
          events={[]}
          generatedAt={now}
          isSuggestionPending={() => false}
          loading
          onSetOutcomeSuggestionEnabled={() => Promise.resolve(true)}
          overview={null}
          resumeStrategies={resumeStrategies}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Loading outcome analytics/i)).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "No outcomes recorded yet" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Search plan scope")).toBeNull();
  });

  it("styles the campaign scope select with canonical field tokens and focus hierarchy", () => {
    const { container } = renderScreen({});

    const select = screen.getByLabelText("Search plan scope");
    for (const className of [
      "h-11",
      "w-full",
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
    expect(select.className).not.toContain("bg-background");
    expect(select.className).not.toContain("focus-visible:ring");
    expect(container.innerHTML).not.toContain("border-input");
  });
});

it("shows the verified application funnel on the loaded screen for a small sample", () => {
  const results = ["a", "b"].map((jobId) =>
    ApplyJobResultSchema.parse({
      id: jobId,
      runId: "run",
      jobId,
      applicationRecordId: `application-${jobId}`,
      state: "submitted",
      summary: "Sent",
      detail: "Local receipt",
      startedAt: now,
      updatedAt: now,
      privacyReceipt: {
        generatedAt: now,
        lineage: { runId: "run", jobId, resultId: jobId },
        destination: { origin: "http://127.0.0.1:47950", safePath: "/apply" },
        resume: { source: "original_upload", fileName: "synthetic.pdf" },
        finalSubmitAuthorized: true,
        finalSubmitOccurred: true,
      },
    }),
  );
  render(
    <MemoryRouter>
      <OutcomeAnalyticsScreen
        actionMessage={null}
        activeCampaignId="campaign-1"
        campaigns={campaigns}
        events={[
          event({
            outcome: "employer_response",
            applicationRecordId: "application-a",
            jobId: "a",
          }),
        ]}
        generatedAt={now}
        isSuggestionPending={() => false}
        onSetOutcomeSuggestionEnabled={vi.fn()}
        overview={null}
        resumeStrategies={[]}
        applyJobResults={results}
        applyRuns={[
          ApplyRunSchema.parse({
            id: "run",
            campaignId: "campaign-1",
            mode: "queue_auto",
            state: "completed",
            jobIds: ["a", "b"],
            createdAt: now,
            updatedAt: now,
            summary: "Sent two",
            detail: "Local receipts",
          }),
        ]}
      />
    </MemoryRouter>,
  );
  const funnel = screen.getByLabelText("Application funnel");
  expect(funnel.textContent).toContain("2 sent");
  expect(funnel.textContent).toContain("1 employer response");
  expect(funnel.textContent).toContain("50% response rate");
  expect(funnel.textContent).toContain("small sample");
});
