import { useState } from "react";
import { APPLICATION_BOUNDARY_SENTENCE } from "./safeguards-application-boundary";
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JobFinderRendererWorkspaceSnapshot,
  SafeguardMutationInput,
  SetJobFinderActivityControlInput,
} from "@nordri/contracts";
import { JobFinderIntelligenceSafeguardsSchema } from "@nordri/contracts";
import { SafeguardsScreen } from "./safeguards-screen";

const now = "2026-08-15T10:00:00.000Z";

it.each([3_000, 10_000])(
  "keeps %i safeguard events searchable and reachable with at most 40 mounted cards",
  async (count) => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      listingSignals: Array.from({ length: count }, (_, index) => ({
        id: `scale_signal_${index}`,
        jobId: `scale_job_${index}`,
        signal: "suspicious",
        confidence: 1,
        detectedAt: now,
        provenance: "browser",
        explanation: `Scale event ${index}`,
        recoveryGuidance: "Inspect the listing before applying.",
      })),
    });
    const mutation = vi
      .fn<(input: SafeguardMutationInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    const view = renderScreen({
      workspace: workspaceWith(safeguards),
      onMutateSafeguards: mutation,
    });
    const nav = screen.getByRole("navigation", {
      name: "safeguards pagination",
    });
    const reached = new Set<string>();
    const cards = () =>
      view.container.querySelectorAll<HTMLElement>("[data-safeguard-kind]");
    expect(screen.getByRole("button", { name: `All ${count}` })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Listing signals ${count}` }),
    ).toBeTruthy();
    for (let page = 1; page <= Math.ceil(count / 40); page++) {
      expect(cards().length).toBeLessThanOrEqual(40);
      for (const card of cards()) {
        reached.add(card.textContent.match(/Scale event \d+/)![0]);
        expect(
          within(card)
            .getByRole("link", { name: "Open Shortlisted" })
            .getAttribute("href"),
        ).toBe("/job-finder/review-queue");
      }
      if (page < Math.ceil(count / 40)) {
        fireEvent.click(within(nav).getByRole("button", { name: "Next page" }));
        await waitFor(() =>
          expect(nav.getAttribute("aria-busy")).toBe("false"),
        );
      }
    }
    expect(reached.size).toBe(count);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search safeguards" }),
      { target: { value: `Scale event ${count - 1}` } },
    );
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toContain(`Scale event ${count - 1}`);
    fireEvent.click(
      within(cards()[0]!).getByRole("button", { name: "Dismiss signal" }),
    );
    await waitFor(() =>
      expect(mutation).toHaveBeenCalledWith(
        expect.objectContaining({ referenceId: `scale_signal_${count - 1}` }),
      ),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search safeguards" }),
      { target: { value: "" } },
    );
    expect(cards()).toHaveLength(40);
    expect(
      screen.getByRole("navigation", { name: "safeguards pagination" })
        .textContent,
    ).toContain(`1–40 of ${count}`);
  },
  60_000,
);
afterEach(cleanup);

function emptySafeguards() {
  return JobFinderIntelligenceSafeguardsSchema.parse({});
}

function signalSafeguards() {
  return JobFinderIntelligenceSafeguardsSchema.parse({
    listingSignals: [
      {
        id: "signal_1",
        jobId: "job_ready",
        signal: "suspicious",
        detail: null,
        detectedAt: now,
        confidence: 0.95,
        provenance: "browser",
        explanation: "Listing shows unusual signs.",
        recoveryGuidance: "Inspect the listing before applying.",
      },
    ],
  });
}

function mixedSafeguards() {
  return JobFinderIntelligenceSafeguardsSchema.parse({
    listingSignals: [
      {
        id: "signal_1",
        jobId: "job_ready",
        signal: "suspicious",
        detail: null,
        detectedAt: now,
        confidence: 0.95,
        provenance: "browser",
        explanation: "Listing shows unusual signs.",
        recoveryGuidance: "Inspect the listing before applying.",
      },
    ],
    abnormalFailurePauses: [
      {
        id: "pause_1",
        windowStartedAt: "2026-08-01T00:00:00.000Z",
        failuresInWindow: 4,
        sampleSize: 5,
        failureRatePercent: 80,
        failureRateThresholdPercent: 40,
        minimumSample: 5,
        paused: true,
        explanation: "Elevated discovery failure rate.",
        recoveryGuidance:
          "Open Search history to see which source failed and why. Fix or disable that source, then retry.",
      },
    ],
  });
}

function contradictionSafeguards() {
  return JobFinderIntelligenceSafeguardsSchema.parse({
    contradictoryAnswerDetections: [
      {
        id: "detection_1",
        questionA: "How many years?",
        questionB: "Experience years?",
        answerA: "5",
        answerB: "2",
        contradictionScore: 0.9,
        status: "detected",
        detectedAt: now,
        resolvedAt: null,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to confirm the correct answer.",
      },
    ],
  });
}

function workspaceWith(
  safeguards: ReturnType<typeof emptySafeguards> = emptySafeguards(),
): JobFinderRendererWorkspaceSnapshot {
  return {
    module: "job-finder",
    generatedAt: now,
    discoveryJobs: [
      {
        id: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        location: "Remote",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["discoveryJobs"],
    applicationRecords: [],
    campaigns: [],
    activeCampaignId: null,
    intelligence: {
      safeguards,
    } as unknown as JobFinderRendererWorkspaceSnapshot["intelligence"],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function renderScreen(props: {
  onSetActivityControl?: (input: { paused: boolean }) => Promise<boolean>;
  onResetBrowser?: () => Promise<boolean>;
  onMutateSafeguards?: (input: SafeguardMutationInput) => Promise<boolean>;
  isPending?: (controlId: string) => boolean;
  actionMessage?: string | null;
  workspace?: JobFinderRendererWorkspaceSnapshot | null;
}) {
  return render(
    <MemoryRouter>
      <SafeguardsScreen
        {...(props.onSetActivityControl
          ? { onSetActivityControl: props.onSetActivityControl }
          : {})}
        {...(props.onResetBrowser
          ? { onResetBrowser: props.onResetBrowser }
          : {})}
        actionMessage={props.actionMessage ?? null}
        isPending={props.isPending ?? (() => false)}
        onMutateSafeguards={
          props.onMutateSafeguards ?? (() => Promise.resolve(true))
        }
        workspace={
          props.workspace === undefined ? workspaceWith() : props.workspace
        }
      />
    </MemoryRouter>,
  );
}

describe("SafeguardsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a loading state while the workspace is unavailable", () => {
    renderScreen({ workspace: null });
    expect(screen.getByText("Loading safeguards…")).toBeTruthy();
  });

  it("shows an empty state when no safeguards exist", () => {
    renderScreen({});
    expect(screen.getByText("No safety events yet")).toBeTruthy();
    // The empty state describes the rule conditionally instead of rendering a
    // card for a threshold nothing has crossed.
    expect(
      screen.getByText(/only when one of its limits is actually reached/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Nothing is being held back right now/i),
    ).toBeTruthy();
  });

  it("hides the search and category filters when there is nothing to filter", () => {
    renderScreen({});

    expect(document.querySelector("[data-safeguard-toolbar]")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Safeguard categories" }),
    ).toBeNull();
  });

  it("keeps the zero-row empty panel compact instead of viewport-tall", () => {
    renderScreen({});

    const emptyPanel = document.querySelector<HTMLElement>(
      "[data-safeguard-empty]",
    );
    expect(emptyPanel).toBeTruthy();
    expect(emptyPanel?.firstElementChild?.className).toContain("min-h-40");
  });

  it("keeps the search field and category filters in a responsive non-clipping toolbar", () => {
    renderScreen({ workspace: workspaceWith(signalSafeguards()) });

    const toolbar = document.querySelector<HTMLElement>(
      "[data-safeguard-toolbar]",
    );
    const categories = document.querySelector<HTMLElement>(
      "[data-safeguard-categories]",
    );

    expect(toolbar?.className).toContain("min-w-0");
    expect(toolbar?.className).toContain(
      "lg:grid-cols-[minmax(14rem,1fr)_minmax(0,3fr)]",
    );
    expect(categories?.className).toContain("min-w-0");
    expect(categories?.className).toContain("w-full");
    expect(categories?.className).toContain("flex-wrap");
    expect(
      screen.getByRole("group", { name: "Safeguard categories" }),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows signals with a dismiss control that calls the typed mutation", async () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      listingSignals: [
        {
          id: "signal_1",
          jobId: "job_ready",
          signal: "suspicious",
          detail: null,
          detectedAt: now,
          confidence: 0.95,
          provenance: "browser",
          explanation: "Listing shows unusual signs.",
          recoveryGuidance: "Inspect the listing before applying.",
        },
      ],
    });
    const onMutateSafeguards = vi
      .fn<(input: SafeguardMutationInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderScreen({ onMutateSafeguards, workspace: workspaceWith(safeguards) });

    expect(screen.getByText("Listing suspicious")).toBeTruthy();
    // The held count is said once, on the events section, not in a box.
    expect(screen.getByText(/1 holding work back/)).toBeTruthy();
    expect(screen.queryByText(/thing is being held back/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss signal" }));

    await vi.waitFor(() => {
      expect(onMutateSafeguards).toHaveBeenCalledWith({
        type: "dismiss_safeguard_entry",
        kind: "listing_signal",
        referenceId: "signal_1",
        reason: "rechecked",
        note: "Re-verified the listing.",
      });
    });
  });

  it("keeps contradictory answers visible as advisory with no blockers", () => {
    renderScreen({ workspace: workspaceWith(contradictionSafeguards()) });

    const advisory = document.querySelector(
      '[data-safeguard-kind="contradictions"]',
    );
    expect(advisory?.getAttribute("data-safeguard-blocked")).toBe("false");
    expect(screen.getByText("Advisory")).toBeTruthy();
    expect(
      screen.getByText(/Nothing is being held back right now/i),
    ).toBeTruthy();
  });

  it("shows a conflict row and resolves it through the typed mutation", async () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      simultaneousApplicationConflicts: [
        {
          id: "conflict_1",
          applicationRecordId: "application_a",
          conflictingApplicationRecordId: "application_b",
          status: "detected",
          explanation: "Two applications overlapped in time.",
          recoveryGuidance: "Review both applications and keep one.",
        },
      ],
    });
    const onMutateSafeguards = vi
      .fn<(input: SafeguardMutationInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderScreen({ onMutateSafeguards, workspace: workspaceWith(safeguards) });

    fireEvent.click(screen.getByRole("button", { name: "Resolve conflict" }));

    await vi.waitFor(() => {
      expect(onMutateSafeguards).toHaveBeenCalledWith({
        type: "resolve_simultaneous_application_conflict",
        conflictId: "conflict_1",
      });
    });
  });

  it("shows a no-match state when the search finds nothing", () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      listingSignals: [
        {
          id: "signal_1",
          jobId: "job_ready",
          signal: "closed",
          detail: null,
          detectedAt: now,
          confidence: 0.9,
          provenance: "provider",
          explanation: "Provider reported the listing as closed.",
          recoveryGuidance: "Re-verify the listing before applying.",
        },
      ],
    });
    renderScreen({ workspace: workspaceWith(safeguards) });

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search safeguards" }),
      { target: { value: "zzz-no-match" } },
    );

    expect(screen.getByText("No matching safeguards")).toBeTruthy();
    expect(screen.getByText(/Try a different term/)).toBeTruthy();
  });

  it("announces the active filter and preserves filtering and counts", () => {
    renderScreen({ workspace: workspaceWith(mixedSafeguards()) });

    const allFilter = screen.getByRole("button", { name: /^All 2$/ });
    const pausesFilter = screen.getByRole("button", {
      name: /^Automatic pauses 1$/,
    });
    const signalsFilter = screen.getByRole("button", {
      name: /^Listing signals 1$/,
    });

    expect(allFilter.getAttribute("aria-pressed")).toBe("true");
    expect(signalsFilter.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Listing suspicious")).toBeTruthy();

    fireEvent.click(pausesFilter);
    expect(pausesFilter.getAttribute("aria-pressed")).toBe("true");
    expect(allFilter.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Listing suspicious")).toBeNull();

    fireEvent.click(signalsFilter);
    expect(signalsFilter.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Listing suspicious")).toBeTruthy();
  });

  it("offers no zero-count category chips", () => {
    renderScreen({ workspace: workspaceWith(signalSafeguards()) });

    const group = screen.getByRole("group", { name: "Safeguard categories" });
    const filters = Array.from(group.querySelectorAll("button"));

    // Seven of eight chips used to read 0 and wrapped the row onto a second
    // line for categories with nothing in them.
    expect(filters.map((filter) => filter.textContent)).toEqual([
      "All1",
      "Listing signals1",
    ]);
    expect(
      filters.some((filter) => /\D0$/.test(filter.textContent ?? "")),
    ).toBe(false);
  });

  it("keeps every native filter button in the normal focus order", () => {
    renderScreen({ workspace: workspaceWith(mixedSafeguards()) });

    const group = screen.getByRole("group", { name: "Safeguard categories" });
    const filters = Array.from(group.querySelectorAll("button"));

    expect(filters).toHaveLength(3);
    expect(filters.every((filter) => filter.tabIndex === 0)).toBe(true);

    filters[2]!.focus();
    expect(document.activeElement).toBe(filters[2]);
    expect(filters[2]!.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(filters[2]!);
    expect(document.activeElement).toBe(filters[2]);
    expect(filters[2]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the All count equal to the categories and to the rendered list", () => {
    renderScreen({ workspace: workspaceWith(mixedSafeguards()) });

    const group = screen.getByRole("group", { name: "Safeguard categories" });
    const chipCounts = Array.from(group.querySelectorAll("button")).map(
      (filter) => ({
        label: filter.textContent ?? "",
        count: Number(
          filter.querySelector("span:last-of-type")?.textContent ?? "0",
        ),
      }),
    );
    const allChip = chipCounts.find((chip) => chip.label.startsWith("All"));
    const categoryChips = chipCounts.filter(
      (chip) => !chip.label.startsWith("All"),
    );
    const renderedCards = document.querySelectorAll("[data-safeguard-kind]");

    expect(allChip?.count).toBe(
      categoryChips.reduce((total, chip) => total + chip.count, 0),
    );
    expect(allChip?.count).toBe(renderedCards.length);
    // The banner and the list agree: one crossed threshold, one blocking
    // signal, and an `All` that counts both.
    expect(allChip?.count).toBe(2);
  });

  it("renders no card for a threshold that has not been crossed", () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      abnormalFailurePauses: [
        {
          id: "pause_quiet",
          windowStartedAt: "2026-08-01T00:00:00.000Z",
          failuresInWindow: 0,
          sampleSize: 1,
          failureRatePercent: 0,
          failureRateThresholdPercent: 40,
          minimumSample: 5,
          paused: false,
          explanation: "Discovery failures stayed under the safety threshold.",
          recoveryGuidance: "Nothing to do.",
        },
      ],
      companyApplicationCaps: [
        {
          id: "cap_quiet",
          companyId: "company_signal",
          maxApplicationsPerWindow: 3,
          windowDays: 7,
          currentWindowCount: 1,
          limitReached: false,
          windowStartedAt: "2026-08-01T00:00:00.000Z",
          explanation: "Per-company weekly cap.",
          recoveryGuidance: "Nothing to do.",
        },
      ],
    });
    renderScreen({ workspace: workspaceWith(safeguards) });

    expect(document.querySelectorAll("[data-safeguard-kind]")).toHaveLength(0);
    expect(screen.queryByText(/Below threshold/i)).toBeNull();
    expect(screen.queryByText(/Within limit/i)).toBeNull();
    // No raw machine timestamp survives to the user.
    expect(document.body.textContent).not.toContain("2026-08-01T00:00:00.000Z");
    expect(screen.getByText("No safety events yet")).toBeTruthy();
  });

  it("gives a named recovery action a control that performs it", () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      abnormalFailurePauses: [
        {
          id: "pause_1",
          windowStartedAt: "2026-08-01T00:00:00.000Z",
          failuresInWindow: 4,
          sampleSize: 5,
          failureRatePercent: 80,
          failureRateThresholdPercent: 40,
          minimumSample: 5,
          paused: true,
          explanation: "Elevated discovery failure rate.",
          recoveryGuidance:
            "Open Search history to see which source failed and why. Fix or disable that source, then retry.",
        },
      ],
    });
    renderScreen({ workspace: workspaceWith(safeguards) });

    const recovery = screen.getByRole("link", { name: "Open Find jobs" });
    expect(recovery.getAttribute("href")).toBe("/job-finder/discovery");
    // The window start reads as a date a person can check, not an instant.
    expect(document.body.textContent).not.toContain("2026-08-01T00:00:00.000Z");
  });

  it("surfaces a mutation failure as an inline error on the row", async () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      abnormalFailurePauses: [
        {
          id: "pause_1",
          windowStartedAt: "2026-08-01T00:00:00.000Z",
          failuresInWindow: 4,
          sampleSize: 5,
          failureRatePercent: 80,
          failureRateThresholdPercent: 40,
          minimumSample: 5,
          paused: true,
          explanation: "Elevated application failure rate.",
          recoveryGuidance:
            "Inspect the latest failure evidence before resuming.",
        },
      ],
    });
    const onMutateSafeguards = vi
      .fn<(input: SafeguardMutationInput) => Promise<boolean>>()
      .mockResolvedValue(false);
    renderScreen({ onMutateSafeguards, workspace: workspaceWith(safeguards) });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss pause" }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(
        /could not be saved/,
      );
    });
  });

  it("does not claim preparation is clear while the daily preparation limit is reached", () => {
    const workspace = workspaceWith();
    (
      workspace as {
        dashboard?: {
          globalDailyApplicationPreparationCapacity: Record<string, unknown>;
        };
      }
    ).dashboard = {
      globalDailyApplicationPreparationCapacity: {
        limit: 20,
        used: 20,
        legacyUncertain: 0,
        remaining: 0,
        localDate: "2026-08-25",
        resetsAt: "2026-08-26T04:00:00.000Z",
      },
    };

    renderScreen({ workspace });

    // The reached limit is an info item on the header status line.
    const status = document.querySelector(
      '[data-page-status-item="daily-capacity"]',
    ) as HTMLElement;
    expect(status.getAttribute("data-tone")).toBe("info");
    expect(status.closest("[data-page-header-status]")).toBeTruthy();
    expect(status.textContent).toMatch(/20 of 20 used today/i);
    expect(status.textContent).toMatch(/reset at local midnight \(/i);
    expect(status.textContent).not.toMatch(/applications can both run/i);
    // The positive clear banner is replaced, never shown beside the limit.
    expect(
      screen.queryByText(/Searching and preparing applications can both run/i),
    ).toBeNull();
  });

  it("keeps the clear status when daily capacity remains", () => {
    const workspace = workspaceWith();
    (
      workspace as {
        dashboard?: {
          globalDailyApplicationPreparationCapacity: Record<string, unknown>;
        };
      }
    ).dashboard = {
      globalDailyApplicationPreparationCapacity: {
        limit: 20,
        used: 3,
        legacyUncertain: 0,
        remaining: 17,
        localDate: "2026-08-25",
        resetsAt: "2026-08-26T04:00:00.000Z",
      },
    };

    renderScreen({ workspace });

    expect(
      screen.getByText(
        /Nothing is being held back right now\. Searching and preparing applications can both run\./i,
      ),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-page-status-item="daily-capacity"]'),
    ).toBeNull();
  });

  it("states the whole application boundary and keeps every permission revocable", async () => {
    const envelope = {
      allowedOrigins: ["https://boards.example.test"],
      allowedResumeSha256: [],
      createdAt: now,
      expiresAt: null,
      id: "envelope_1",
      intermediateMutationsAuthorized: false,
      maxApplicationsPerLocalDay: 20,
      maxApplicationsPerRun: 10,
      mode: "prepare_only",
      revision: 4,
      scope: { campaignId: null, jobIds: ["job_ready"] },
      status: "active",
      updatedAt: now,
    };
    const revokeApplicationAuthorityEnvelope = vi
      .fn()
      .mockResolvedValue({ status: "applied" });
    const listApplicationAuthorityEnvelopes = vi
      .fn()
      .mockResolvedValueOnce([envelope])
      .mockResolvedValue([{ ...envelope, status: "revoked" }]);
    (window as unknown as Record<string, unknown>).nordri = {
      jobFinder: {
        listApplicationAuthorityEnvelopes,
        revokeApplicationAuthorityEnvelope,
      },
    };

    renderScreen({});

    // The sentence a job seeker can hold the product to, verbatim.
    expect(screen.getByText(APPLICATION_BOUNDARY_SENTENCE)).toBeTruthy();

    const revokeTrigger = await screen.findByRole("button", {
      name: "Revoke permission",
    });
    fireEvent.click(revokeTrigger);
    // Revoking asks twice; the first click alone never changes authority.
    expect(revokeApplicationAuthorityEnvelope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));

    await waitFor(() => {
      expect(revokeApplicationAuthorityEnvelope).toHaveBeenCalledWith({
        expectedRevision: 4,
        id: "envelope_1",
      });
    });
    await waitFor(() => {
      expect(
        screen.getByText(
          "None. Job Finder prepares applications for your review only.",
        ),
      ).toBeTruthy();
    });

    delete (window as unknown as Record<string, unknown>).nordri;
  });
});

it("uses workspace actions to refresh immediately after Resume and browser reset", async () => {
  const next = workspaceWith();
  next.activityControl = { paused: false, reason: null, pausedAt: null };
  const initial = workspaceWith();
  initial.activityControl = { paused: true, reason: null, pausedAt: now };
  const setActivityControl = vi
    .fn<
      (
        command: SetJobFinderActivityControlInput,
      ) => Promise<JobFinderRendererWorkspaceSnapshot>
    >()
    .mockResolvedValue(next);
  const resetBrowser = vi
    .fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>()
    .mockResolvedValue(initial);
  function Harness() {
    const [workspace, setWorkspace] = useState(initial);
    return (
      <MemoryRouter>
        <SafeguardsScreen
          actionMessage={null}
          isPending={() => false}
          onMutateSafeguards={vi.fn()}
          workspace={workspace}
          onSetActivityControl={async (command) => {
            setWorkspace(await setActivityControl(command));
            return true;
          }}
          onResetBrowser={async () => {
            setWorkspace(await resetBrowser());
            return true;
          }}
        />
      </MemoryRouter>
    );
  }
  render(<Harness />);
  expect(screen.getByText(/Everything is paused/)).toBeTruthy();
  // The pause is one amber item on the status line, not a box.
  expect(
    document
      .querySelector('[data-page-status-item="activity-paused"]')
      ?.getAttribute("data-tone"),
  ).toBe("warning");
  fireEvent.click(screen.getByRole("button", { name: "Resume everything" }));
  await waitFor(() =>
    expect(screen.queryByText(/Everything is paused/)).toBeNull(),
  );
  expect(setActivityControl).toHaveBeenCalledWith({ paused: false });
  fireEvent.click(screen.getByRole("button", { name: "Reset browser" }));
  expect(resetBrowser).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog").textContent).toContain("sign-ins");
  fireEvent.click(screen.getByRole("button", { name: "Clear browser" }));
  await waitFor(() =>
    expect(screen.getByText(/Everything is paused/)).toBeTruthy(),
  );
  expect(resetBrowser).toHaveBeenCalledOnce();
});

it("puts events before permissions, with compact browser recovery inside permissions", () => {
  const { container } = renderScreen({
    workspace: workspaceWith(signalSafeguards()),
  });
  const events = container.querySelector("[data-safeguard-events]")!;
  const permissions = screen.getByTestId("safeguards-application-boundary");
  expect(
    events.compareDocumentPosition(permissions) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const reset = screen.getByRole("button", { name: "Reset browser" });
  expect(permissions.contains(reset)).toBe(true);
  expect(reset.parentElement?.className).toContain("justify-items-start");
  expect(screen.getAllByText(APPLICATION_BOUNDARY_SENTENCE)).toHaveLength(1);
});

it("keeps the inspected Safeguards section open after allowing a pair", async () => {
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    simultaneousApplicationConflicts: [
      {
        id: "pair",
        applicationRecordId: "a",
        conflictingApplicationRecordId: "b",
        companyKey: "synthetic",
        companyName: "Synthetic Workshop",
        jobIds: ["job_ready", "job_other"],
        status: "detected",
        explanation: "Same employer",
        recoveryGuidance: "Choose a pair",
      },
    ],
  });
  const initial = workspaceWith(safeguards);
  initial.companyJobs = [];
  initial.dismissedDiscoveryJobs = [];
  initial.discoveryJobs = [
    initial.discoveryJobs[0]!,
    { ...initial.discoveryJobs[0]!, id: "job_other", location: "London" },
  ];
  function Harness() {
    const [workspace, setWorkspace] = useState(initial);
    return (
      <MemoryRouter>
        <SafeguardsScreen
          actionMessage={null}
          isPending={() => false}
          workspace={workspace}
          onMutateSafeguards={() => {
            setWorkspace({
              ...workspace,
              intelligence: {
                ...workspace.intelligence,
                safeguards: JobFinderIntelligenceSafeguardsSchema.parse({
                  ...safeguards,
                  simultaneousApplicationConflicts: [
                    {
                      ...safeguards.simultaneousApplicationConflicts[0],
                      allowedPairs: [
                        {
                          jobIds: ["job_ready", "job_other"],
                          decidedAt: now,
                          revokedAt: null,
                        },
                      ],
                    },
                  ],
                }),
              },
            });
            return Promise.resolve(true);
          }}
        />
      </MemoryRouter>
    );
  }
  const view = render(<Harness />);
  const events = view.container.querySelector<HTMLDetailsElement>(
    "[data-safeguard-events]",
  )!;
  expect(events.open).toBe(true);
  const card = view.container.querySelector<HTMLElement>(
    "[data-safeguard-kind=conflicts]",
  )!;
  expect(card.className).toContain("min-w-0");
  expect(card.querySelector("h3")?.className).toContain("break-words");
  // A pair choice names both jobs; it wraps inside the card instead of
  // pushing it past a narrow column.
  const pairChoice = screen.getByRole("button", { name: /^Send both anyway:/ });
  expect(pairChoice.className).toContain("whitespace-normal");
  expect(pairChoice.className).toContain("max-w-full");
  expect(pairChoice.parentElement?.className).toContain("min-w-0");
  fireEvent.click(pairChoice);
  await screen.findByText("Pairs allowed by you");
  expect(events.open).toBe(true);
  expect(screen.queryByText(/Recovery: Choose Send both anyway/)).toBeNull();
});
