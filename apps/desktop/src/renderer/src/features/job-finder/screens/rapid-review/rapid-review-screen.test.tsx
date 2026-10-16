// @vitest-environment jsdom

import {
  RapidReviewDecisionLogSchema,
  SavedJobSchema,
  type RapidReviewDecisionLog,
  type RapidReviewMutationInput,
  type SavedJob,
} from "@nordri/contracts";
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
import {
  acquireJobFinderOverlay,
  resetJobFinderOverlaysForTests,
} from "../../lib/job-finder-overlay-ownership";
import { RapidReviewScreen } from "./rapid-review-screen";

function createJob(overrides: Partial<SavedJob> = {}): SavedJob {
  return SavedJobSchema.parse({
    id: "job_posted",
    source: "target_site",
    sourceJobId: "source_posted",
    canonicalUrl: "https://jobs.example.test/roles/posted",
    applicationUrl: "https://jobs.example.test/roles/posted/apply",
    title: "Product Engineer",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-07-30T10:00:00.000Z",
    salaryText: null,
    description: "Own product systems.",
    status: "discovered",
    matchAssessment: {
      score: 82,
      reasons: ["Relevant product experience"],
      gaps: [],
    },
    postedAt: "2026-03-20T09:00:00.000Z",
    postedAtText: null,
    ...overrides,
  });
}

function renderRapidReview(
  jobs: readonly SavedJob[],
  options: {
    log?: RapidReviewDecisionLog | null;
    onMutate?: (input: RapidReviewMutationInput) => Promise<unknown>;
  } = {},
) {
  return render(
    <RapidReviewScreen
      campaignId="campaign_1"
      campaignName="Posted campaign"
      jobs={jobs}
      log={options.log ?? null}
      onInspectJob={vi.fn()}
      onMutate={options.onMutate ?? vi.fn(() => Promise.resolve())}
      pending={false}
    />,
  );
}

function createLog(entries: Array<Record<string, unknown>>) {
  return RapidReviewDecisionLogSchema.parse({
    campaignId: "campaign_1",
    entries,
  });
}

afterEach(cleanup);

describe("RapidReviewScreen readability", () => {
  it("labels the empty screen as Quick review and links to Search plans", () => {
    render(
      <MemoryRouter>
        <RapidReviewScreen
          campaignId="campaign_1"
          campaignName="Posted campaign"
          jobs={[]}
          log={null}
          onInspectJob={vi.fn()}
          onMutate={() => Promise.resolve()}
          pending={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Quick review" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Rapid review" })).toBeNull();

    const link = screen.getByRole("link", { name: "Open Find jobs" });
    expect(link.getAttribute("href")).toBe("/job-finder/discovery");
  });

  it("formats the posted date instead of exposing a raw ISO timestamp", () => {
    renderRapidReview([createJob()]);

    expect(
      screen.getByText(/Compensation not listed · Posted \d{2} Mar 2026/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("2026-03-20T09:00:00.000Z");
  });

  it("shows the source posted text when no posting date was stored", () => {
    renderRapidReview([
      createJob({ postedAt: null, postedAtText: "2 days ago" }),
    ]);

    expect(screen.getByText(/2 days ago/)).toBeTruthy();
  });

  it("prefers the stored posting date over aging site text", () => {
    renderRapidReview([createJob({ postedAtText: "2 days ago" })]);

    expect(screen.getByText(/20 Mar 2026/)).toBeTruthy();
    expect(screen.queryByText(/2 days ago/)).toBeNull();
  });

  it("labels provider-only freshness as updated", () => {
    renderRapidReview([
      createJob({
        postedAt: null,
        postedAtText: null,
        providerUpdatedAt: "2026-07-30T12:00:00.000Z",
      }),
    ]);

    expect(
      screen.getByText(/Compensation not listed · Updated 30 Jul 2026/),
    ).toBeTruthy();
  });

  it("renders scannable keyboard hints with labelled key chips", () => {
    const { container } = renderRapidReview([createJob()]);

    expect(
      screen.getByText(
        "Keyboard shortcuts, while the review workspace has focus:",
      ),
    ).toBeTruthy();
    expect(container.querySelectorAll("kbd")).toHaveLength(5);
    for (const label of ["move", "shortlist", "reject", "inspect", "undo"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText(/J\/K move ·/)).toBeNull();
  });
});

function decisionEntry(input: {
  id: string;
  jobId: string;
  kind: "shortlist" | "reject" | "inspect";
  revision: number;
  stamp: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    campaignId: "campaign_1",
    jobId: input.jobId,
    kind: input.kind,
    revision: input.revision,
    reason: null,
    createdAt: input.stamp,
    updatedAt: input.stamp,
    undo: null,
  };
}

describe("RapidReviewScreen undo binding", () => {
  it("binds U to the newest logged decision instead of the active row", () => {
    const jobs = [
      createJob({ id: "job_a", sourceJobId: "source_a" }),
      createJob({ id: "job_b", sourceJobId: "source_b" }),
    ];
    const log = createLog([
      decisionEntry({
        id: "decision_a",
        jobId: "job_a",
        kind: "shortlist",
        revision: 0,
        stamp: "2026-07-30T10:00:01.000Z",
      }),
      decisionEntry({
        id: "decision_b",
        jobId: "job_b",
        kind: "shortlist",
        revision: 1,
        stamp: "2026-07-30T10:00:02.000Z",
      }),
    ]);
    const mutations: RapidReviewMutationInput[] = [];
    renderRapidReview(jobs, {
      log,
      onMutate: (input) => {
        mutations.push(input);
        return Promise.resolve();
      },
    });

    // The first row is active, but the newest decision belongs to job_b.
    fireEvent.keyDown(window, { key: "u" });

    expect(mutations).toEqual([
      {
        type: "undo",
        campaignId: "campaign_1",
        jobId: "job_b",
        expectedRevision: 1,
        reason: null,
      },
    ]);
  });

  it("labels the undo control with the decision it will revert", () => {
    const jobs = [
      createJob({ id: "job_a", sourceJobId: "source_a" }),
      createJob({ id: "job_b", sourceJobId: "source_b" }),
    ];
    const log = createLog([
      decisionEntry({
        id: "decision_b_reject",
        jobId: "job_b",
        kind: "reject",
        revision: 1,
        stamp: "2026-07-30T10:00:02.000Z",
      }),
    ]);

    renderRapidReview(jobs, { log });

    expect(
      screen.getByRole("button", { name: "Undo reject: Product Engineer" }),
    ).toBeTruthy();
  });

  it("offers no undo control and no U action without a decision log", () => {
    const mutations: RapidReviewMutationInput[] = [];
    renderRapidReview([createJob()], {
      onMutate: (input) => {
        mutations.push(input);
        return Promise.resolve();
      },
    });

    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();

    fireEvent.keyDown(window, { key: "u" });

    expect(mutations).toEqual([]);
  });
});

describe("RapidReviewScreen shortcut focus scope", () => {
  afterEach(() => {
    resetJobFinderOverlaysForTests();
  });

  function renderCapturingMutations(jobs: readonly SavedJob[]) {
    const mutations: RapidReviewMutationInput[] = [];
    const view = renderRapidReview(jobs, {
      onMutate: (input) => {
        mutations.push(input);
        return Promise.resolve();
      },
    });
    return { mutations, view };
  }

  function getWorkspace(view: { container: HTMLElement }): HTMLElement {
    return view.container.firstElementChild as HTMLElement;
  }

  function appendShellMain(): HTMLElement {
    const shellMain = document.createElement("main");
    shellMain.tabIndex = -1;
    document.body.appendChild(shellMain);
    return shellMain;
  }

  it("claims workspace focus after the shell route focus settles", async () => {
    const shellMain = appendShellMain();
    try {
      const jobs = [
        createJob(),
        createJob({
          id: "job_b",
          sourceJobId: "source_b",
          title: "Platform Engineer",
        }),
      ];
      const { mutations, view } = renderCapturingMutations(jobs);
      const workspace = getWorkspace(view);
      expect(workspace.getAttribute("tabindex")).toBe("-1");

      // The shell route focus lands on <main> after the screen mounts.
      shellMain.focus();
      expect(document.activeElement).toBe(shellMain);

      // The workspace re-claims with preventScroll once focus settles.
      await waitFor(() => expect(document.activeElement).toBe(workspace));

      // The loop is alive again: J moves from the claimed workspace.
      fireEvent.keyDown(window, { key: "j" });
      expect(view.container.querySelector('[aria-current="true"]')).toBe(
        screen.getByRole("button", { name: /Platform Engineer/ }),
      );
      expect(mutations).toEqual([]);
    } finally {
      shellMain.remove();
    }
  });

  it("keeps S/X/I/U/J/K dead while shell main or body holds focus", () => {
    const shellMain = appendShellMain();
    try {
      const { mutations, view } = renderCapturingMutations([
        createJob(),
        createJob({
          id: "job_b",
          sourceJobId: "source_b",
          title: "Platform Engineer",
        }),
      ]);
      const workspace = getWorkspace(view);

      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(window, { key: "x" });
      expect(mutations).toEqual([]);

      shellMain.focus();
      expect(document.activeElement).toBe(shellMain);
      fireEvent.keyDown(window, { key: "s" });
      expect(mutations).toEqual([]);

      // Clicking/focusing back into the workspace restores the loop.
      workspace.focus();
      fireEvent.keyDown(window, { key: "s" });
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toMatchObject({
        decision: "shortlist",
        jobIds: ["job_posted"],
      });
    } finally {
      shellMain.remove();
    }
  });

  it("keeps non-row controls guarded while the workspace has focus", () => {
    const { mutations, view } = renderCapturingMutations([createJob()]);
    getWorkspace(view).focus();

    const searchField = screen.getByRole("searchbox");
    searchField.focus();
    fireEvent.keyDown(searchField, { key: "x" });
    const checkbox = screen.getByRole("checkbox", {
      name: "Select Product Engineer at Acme",
    });
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: "x" });
    expect(mutations).toEqual([]);

    // Row buttons remain the intended character-shortcut owners.
    const rowButton = screen.getByRole("button", { name: /Product Engineer/ });
    rowButton.focus();
    fireEvent.keyDown(rowButton, { key: "s" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ decision: "shortlist" });
  });

  it("stays inert while an overlay owns interaction despite workspace focus", () => {
    const { mutations, view } = renderCapturingMutations([createJob()]);
    const workspace = getWorkspace(view);
    workspace.focus();
    const overlay = acquireJobFinderOverlay(() => {});

    fireEvent.keyDown(window, { key: "x" });
    expect(mutations).toEqual([]);
    expect(document.activeElement).toBe(workspace);

    overlay.release();
    fireEvent.keyDown(window, { key: "s" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ decision: "shortlist" });
  });

  it("does not steal focus from a focused child or claim under an overlay", async () => {
    const jobs = [
      createJob(),
      createJob({
        id: "job_b",
        sourceJobId: "source_b",
        title: "Platform Engineer",
      }),
    ];
    const { view } = renderCapturingMutations(jobs);

    // A focused child keeps focus across parent rerenders.
    const rowB = screen.getByRole("button", { name: /Platform Engineer/ });
    rowB.focus();
    view.rerender(
      <RapidReviewScreen
        campaignId="campaign_1"
        campaignName="Posted campaign"
        jobs={jobs}
        log={null}
        onInspectJob={vi.fn()}
        onMutate={() => Promise.resolve()}
        pending={true}
      />,
    );
    expect(document.activeElement).toBe(rowB);

    // An open overlay blocks the mount-time claim entirely.
    const shellMain = appendShellMain();
    try {
      shellMain.focus();
      const overlay = acquireJobFinderOverlay(() => {});
      renderRapidReview([createJob()]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(document.activeElement).toBe(shellMain);
      overlay.release();
    } finally {
      shellMain.remove();
    }
  });

  it("links every review row to a stable labelled detail region", () => {
    renderRapidReview([createJob()]);

    const detail = screen.getByRole("article", { name: "Product Engineer" });
    expect(detail.id).toBe("rapid-review-job-detail");

    const rows = within(
      screen.getByRole("list", { name: "Jobs to review" }),
    ).getAllByRole("button");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute("aria-controls")).toBe(detail.id);
    }
  });

  it("announces the reviewed job politely without moving focus", () => {
    const view = renderRapidReview([
      createJob(),
      createJob({
        id: "job_b",
        sourceJobId: "source_b",
        title: "Platform Engineer",
      }),
    ]);
    getWorkspace(view).focus();
    expect(document.activeElement).toBe(getWorkspace(view));
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Product Engineer");

    fireEvent.keyDown(window, { key: "j" });

    expect(status.textContent).toContain("Platform Engineer");
  });

  it("gives Compare a distinct enlarged target outside the row button", () => {
    renderRapidReview([createJob()]);

    const rowButton = screen.getByRole("button", { name: /Product Engineer/ });
    const checkbox = screen.getByRole("checkbox", {
      name: "Select Product Engineer at Acme",
    });
    const toggle = checkbox.closest("label");

    // No nested or overlapping interaction: Compare lives outside the row
    // button target with its own padded >=24px hit area.
    expect(toggle).toBeTruthy();
    expect(rowButton.contains(checkbox)).toBe(false);
    expect(toggle?.className).toContain("p-2");
  });
});

describe("RapidReviewScreen xl detail layout", () => {
  it("pins the detail beside the list only at xl, never below it", () => {
    renderRapidReview([
      createJob(),
      createJob({
        id: "job_b",
        sourceJobId: "source_b",
        title: "Platform Engineer",
      }),
    ]);

    const article = screen.getByRole("article", { name: "Product Engineer" });
    const tokens = article.className.split(/\s+/);

    // At xl the detail stays useful while walking a 40-row page: pinned
    // under the viewport top, bounded to it, and scrolling internally.
    expect(tokens).toContain("xl:sticky");
    expect(tokens).toContain("xl:top-4");
    expect(tokens).toContain("xl:self-start");
    expect(tokens.some((token) => token.startsWith("xl:max-h-"))).toBe(true);
    expect(tokens).toContain("xl:overflow-y-auto");

    // Below xl the detail keeps normal stacked flow: no bare sticky and no
    // smaller-breakpoint positioning may creep back in.
    for (const token of tokens) {
      expect(token === "sticky").toBe(false);
      expect(
        /^(sm|md|lg):(sticky|top-|self-start|max-h-|overflow-y-auto)/.test(
          token,
        ),
      ).toBe(false);
    }
  });
});
