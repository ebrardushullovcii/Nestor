// @vitest-environment jsdom

import {
  RapidReviewDecisionLogSchema,
  SavedJobSchema,
  type RapidReviewDecision,
  type RapidReviewDecisionKind,
  type RapidReviewDecisionLog,
  type RapidReviewMutationInput,
  type SavedJob,
} from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLatestDecisionIndex,
  findLatestUndoableDecision,
  RapidReviewScreen,
} from "./rapid-review-screen";

const JOB_COUNT = 550;
const PAGE_SIZE = 40;

// The multi-page keyboard/pagination walks are the heaviest jsdom renders in
// this file: every turn re-renders a full page plus detail at 500+ jobs and
// wall time varies several-fold between fast laptops and loaded serial CI
// runners. The per-test timeout only guards against true hangs.
const PAGING_WALK_TIMEOUT_MS = 15_000;

function createJobs(count: number = JOB_COUNT): SavedJob[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(4, "0");

    return SavedJobSchema.parse({
      id: `rapid_review_job_${ordinal}`,
      source: "target_site",
      sourceJobId: `rapid_review_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
      title: `Senior Product Designer ${ordinal}`,
      company: `Scale Company ${index % 50}`,
      location: index % 2 === 0 ? "Remote" : "Budapest, Hungary",
      workMode: index % 2 === 0 ? ["remote"] : ["hybrid"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: "2026-07-30T10:00:00.000Z",
      salaryText: null,
      description: `Own product systems for role ${ordinal}.`,
      status: "discovered",
      matchAssessment: {
        score: 70 + (index % 30),
        reasons: ["Relevant product design experience"],
        gaps: [],
      },
    });
  });
}

function createDecisionLog(jobCount: number) {
  return RapidReviewDecisionLogSchema.parse({
    campaignId: "campaign_scale",
    entries: Array.from({ length: jobCount }, (_, index) => {
      const ordinal = index.toString().padStart(4, "0");
      return {
        id: `rapid_review_decision_${ordinal}`,
        campaignId: "campaign_scale",
        jobId: `rapid_review_job_${ordinal}`,
        kind: index % 2 === 0 ? "shortlist" : "reject",
        revision: index,
        reason: null,
        createdAt: `2026-07-30T10:${Math.floor(index / 60)
          .toString()
          .padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`,
        updatedAt: `2026-07-30T10:${Math.floor(index / 60)
          .toString()
          .padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`,
        undo: null,
      };
    }),
  });
}

type DecisionEntryInput = {
  id: string;
  jobId: string;
  kind: RapidReviewDecisionKind;
  revision: number;
  stamp: string;
};

function makeDecisionEntry(input: DecisionEntryInput) {
  return {
    id: input.id,
    campaignId: "campaign_scale",
    jobId: input.jobId,
    kind: input.kind,
    revision: input.revision,
    reason: null,
    createdAt: input.stamp,
    updatedAt: input.stamp,
    undo: null,
  };
}

function markUndone(
  entry: ReturnType<typeof makeDecisionEntry>,
  undoneAt: string,
): RapidReviewDecision {
  return {
    ...entry,
    updatedAt: undoneAt,
    undo: {
      undoneAt,
      reason: null,
      restoringDecisionId: null,
    },
  };
}

function parseScaleLog(entries: Array<Record<string, unknown>>) {
  return RapidReviewDecisionLogSchema.parse({
    campaignId: "campaign_scale",
    entries,
  });
}

function rapidReviewScreenElement(
  jobs: readonly SavedJob[],
  log: RapidReviewDecisionLog | null,
  onMutate: (input: RapidReviewMutationInput) => Promise<unknown>,
) {
  return (
    <RapidReviewScreen
      campaignId="campaign_scale"
      campaignName="Scale campaign"
      jobs={jobs}
      log={log}
      onInspectJob={vi.fn()}
      onMutate={onMutate}
      pending={false}
    />
  );
}

function renderRapidReview(
  jobs: readonly SavedJob[],
  log: RapidReviewDecisionLog | null = null,
  onMutate: (input: RapidReviewMutationInput) => Promise<unknown> = vi.fn(() =>
    Promise.resolve(),
  ),
) {
  return render(rapidReviewScreenElement(jobs, log, onMutate));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("RapidReviewScreen workspace scale", () => {
  it("precomputes the latest active decision for each job in one log pass", () => {
    const log = RapidReviewDecisionLogSchema.parse({
      campaignId: "campaign_scale",
      entries: [
        {
          id: "decision_1",
          campaignId: "campaign_scale",
          jobId: "job_1",
          kind: "shortlist",
          revision: 1,
          reason: null,
          createdAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
          undo: null,
        },
        {
          id: "decision_2",
          campaignId: "campaign_scale",
          jobId: "job_1",
          kind: "reject",
          revision: 2,
          reason: null,
          createdAt: "2026-07-30T10:01:00.000Z",
          updatedAt: "2026-07-30T10:01:00.000Z",
          undo: {
            undoneAt: "2026-07-30T10:02:00.000Z",
            reason: null,
            restoringDecisionId: null,
          },
        },
        {
          id: "decision_3",
          campaignId: "campaign_scale",
          jobId: "job_1",
          kind: "inspect",
          revision: 3,
          reason: null,
          createdAt: "2026-07-30T10:03:00.000Z",
          updatedAt: "2026-07-30T10:03:00.000Z",
          undo: null,
        },
      ],
    });

    const index = buildLatestDecisionIndex(log);

    expect(index.size).toBe(1);
    expect(index.get("job_1")).toMatchObject({
      id: "decision_3",
      kind: "inspect",
    });
  });

  it(
    "mounts one page for a 550-job campaign and keeps paging accessible",
    () => {
      const jobs = createJobs();
      const log = createDecisionLog(550);
      const { container } = renderRapidReview(jobs, log);
      const list = screen.getByRole("list", { name: "Jobs to review" });

      expect(within(list).getAllByRole("button")).toHaveLength(PAGE_SIZE);
      expect(within(list).getAllByRole("checkbox")).toHaveLength(PAGE_SIZE);
      expect(screen.getByText("1–40 of 550")).toBeTruthy();
      expect(
        screen.getByRole("navigation", { name: "jobs pagination" }),
      ).toBeTruthy();
      expect(container.querySelectorAll("li")).toHaveLength(PAGE_SIZE);

      fireEvent.click(screen.getByRole("button", { name: "Next page" }));

      expect(within(list).getAllByRole("button")).toHaveLength(PAGE_SIZE);
      expect(within(list).getByRole("button", { name: /0040/ })).toBeTruthy();
      expect(within(list).queryByRole("button", { name: /0000/ })).toBeNull();
      expect(screen.getByText("41–80 of 550")).toBeTruthy();
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it(
    "moves the active keyboard review across page boundaries",
    () => {
      const jobs = createJobs();
      const { container } = renderRapidReview(jobs, createDecisionLog(550));
      const list = screen.getByRole("list", { name: "Jobs to review" });

      for (let index = 0; index < PAGE_SIZE; index += 1) {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      }

      expect(screen.getByText("41–80 of 550")).toBeTruthy();
      expect(container.querySelector('[aria-current="true"]')).toBe(
        within(list).getByRole("button", { name: /0040/ }),
      );
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it("lets the intended row own arrow navigation without a second window move", () => {
    const jobs = createJobs().slice(0, 3);
    const { container } = renderRapidReview(jobs);
    const list = screen.getByRole("list", { name: "Jobs to review" });
    const rowButtons = within(list).getAllByRole("button");

    // Focus/dispatch on the second row while the first row is still active.
    // A bubbling window shortcut would otherwise overwrite the row's move.
    fireEvent.keyDown(rowButtons[1]!, { key: "ArrowDown" });

    expect(container.querySelector('[aria-current="true"]')).toBe(
      rowButtons[2],
    );
  });

  it("leaves keyboard activation to the Compare checkbox and ignores nested controls", () => {
    const jobs = createJobs().slice(0, 3);
    const { container } = renderRapidReview(jobs);
    const list = screen.getByRole("list", { name: "Jobs to review" });
    const rowButtons = within(list).getAllByRole("button");
    const checkbox = within(list).getAllByRole(
      "checkbox",
    )[0]! as HTMLInputElement;

    for (const key of [" ", "Enter"]) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      });
      checkbox.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(container.querySelector('[aria-current="true"]')).toBe(
      rowButtons[0],
    );

    const nestedControl = document.createElement("button");
    nestedControl.type = "button";
    nestedControl.textContent = "Nested control";
    rowButtons[0]!.append(nestedControl);

    fireEvent.keyDown(nestedControl, { key: "ArrowDown" });

    expect(container.querySelector('[aria-current="true"]')).toBe(
      rowButtons[0],
    );
  });

  it("does not prevent ordinary Tab navigation", () => {
    const jobs = createJobs().slice(0, 3);
    const { container } = renderRapidReview(jobs);
    const list = screen.getByRole("list", { name: "Jobs to review" });
    const firstRow = within(list).getAllByRole("button")[0]!;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });

    firstRow.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[aria-current="true"]')).toBe(firstRow);
  });
});

describe("RapidReviewScreen pagination consistency", () => {
  function soleCurrentRow(container: HTMLElement): Element | null {
    const current = container.querySelectorAll('[aria-current="true"]');
    if (current.length !== 1) return null;
    return current[0] ?? null;
  }

  function clickNext(times = 1): void {
    for (let turn = 0; turn < times; turn += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    }
  }

  it(
    "keeps page 6 of a 500-job campaign anchored to one active row with a matching detail",
    () => {
      const { container } = renderRapidReview(createJobs(500));
      const list = screen.getByRole("list", { name: "Jobs to review" });

      clickNext(5);

      expect(screen.getByText("201–240 of 500")).toBeTruthy();
      // Exactly one rendered row carries the active state and it is the first
      // row of the requested page — never a stray from page 1.
      const firstPageSixRow = within(list).getByRole("button", {
        name: /Senior Product Designer 0200/,
      });
      expect(soleCurrentRow(container)).toBe(firstPageSixRow);
      expect(
        screen.getByRole("article", { name: "Senior Product Designer 0200" }),
      ).toBeTruthy();
      expect(within(list).queryByRole("button", { name: /0000/ })).toBeNull();
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it(
    "lands Next/Previous on the exact boundary rows with matching details",
    () => {
      const { container } = renderRapidReview(createJobs(500));
      const list = screen.getByRole("list", { name: "Jobs to review" });
      const previousButton = () =>
        screen.getByRole("button", { name: "Previous page" });

      clickNext();
      expect(screen.getByText("41–80 of 500")).toBeTruthy();
      expect(soleCurrentRow(container)).toBe(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0040/,
        }),
      );
      expect(
        screen.getByRole("article", { name: "Senior Product Designer 0040" }),
      ).toBeTruthy();

      fireEvent.click(previousButton());
      expect(screen.getByText("1–40 of 500")).toBeTruthy();
      expect(soleCurrentRow(container)).toBe(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0000/,
        }),
      );
      expect(
        screen.getByRole("article", { name: "Senior Product Designer 0000" }),
      ).toBeTruthy();
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it(
    "preserves the active row only while it stays on the requested page",
    () => {
      const { container } = renderRapidReview(createJobs(500));
      const list = screen.getByRole("list", { name: "Jobs to review" });

      clickNext();
      expect(screen.getByText("41–80 of 500")).toBeTruthy();

      // Activating a mid-page row keeps the page anchored to that row.
      fireEvent.click(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0045/,
        }),
      );
      expect(screen.getByText("41–80 of 500")).toBeTruthy();
      expect(soleCurrentRow(container)).toBe(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0045/,
        }),
      );

      // Leaving the page hands the anchor back to each visited page's first
      // row; the old mid-page selection is not resurrected.
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(soleCurrentRow(container)).toBe(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0000/,
        }),
      );
      clickNext();
      expect(screen.getByText("41–80 of 500")).toBeTruthy();
      expect(soleCurrentRow(container)).toBe(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0040/,
        }),
      );
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it("keeps pointer focus on the pagination control after a page turn", () => {
    const { container } = renderRapidReview(createJobs(500));

    clickNext();

    // CollectionPagination promises pointer users the control keeps focus;
    // the screen must not steal it onto a review row.
    const nextButton = screen.getByRole("button", { name: "Next page" });
    expect(document.activeElement).toBe(nextButton);
    expect(nextButton.hasAttribute("data-collection-item-id")).toBe(false);

    // The established guard holds: shortcuts stay dead while the control
    // holds focus, so J cannot move the anchor from outside the list.
    const anchoredRow = container.querySelector('[aria-current="true"]');
    fireEvent.keyDown(nextButton, { key: "j" });
    expect(container.querySelector('[aria-current="true"]')).toBe(anchoredRow);
  });

  it(
    "anchors the filtered last partial page",
    () => {
      const { container } = renderRapidReview(createJobs(500));
      const list = screen.getByRole("list", { name: "Jobs to review" });

      // Every other job sits in Budapest: 250 matches across 7 pages, ending
      // in a 10-row partial page.
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "Budapest" },
      });

      for (let turn = 0; turn < 8; turn += 1) {
        const nextButton = screen.getByRole("button", { name: "Next page" });
        if (nextButton.hasAttribute("disabled")) break;
        fireEvent.click(nextButton);
      }

      expect(screen.getByText("241–250 of 250")).toBeTruthy();
      expect(within(list).getAllByRole("button")).toHaveLength(10);
      const lastPartialFirstRow = within(list).getByRole("button", {
        name: /Senior Product Designer 0481/,
      });
      expect(soleCurrentRow(container)).toBe(lastPartialFirstRow);
      expect(
        screen.getByRole("article", { name: "Senior Product Designer 0481" }),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "Next page" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen
          .getByRole("button", { name: "Previous page" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it("restarts review at the first row after a route remount (no durable active-row state exists)", () => {
    const jobs = createJobs(45);
    const first = renderRapidReview(jobs);

    clickNext();
    expect(screen.getByText("41–45 of 45")).toBeTruthy();
    first.unmount();

    // Documented remount behavior: the route passes no active-job state and
    // the decision log — not localStorage — is the only durable record, so a
    // fresh mount restarts at page 1's first row. Persistence here would be
    // invented state, not retained context.
    const second = renderRapidReview(jobs);
    const list = screen.getByRole("list", { name: "Jobs to review" });
    expect(screen.getByText("1–40 of 45")).toBeTruthy();
    expect(soleCurrentRow(second.container)).toBe(
      within(list).getByRole("button", {
        name: /Senior Product Designer 0000/,
      }),
    );
    expect(
      screen.getByRole("article", { name: "Senior Product Designer 0000" }),
    ).toBeTruthy();
  });
});

describe("findLatestUndoableDecision", () => {
  it("returns the newest entry that has not been undone, across all jobs", () => {
    const log = parseScaleLog([
      makeDecisionEntry({
        id: "decision_a",
        jobId: "job_a",
        kind: "shortlist",
        revision: 0,
        stamp: "2026-07-30T10:00:01.000Z",
      }),
      makeDecisionEntry({
        id: "decision_b",
        jobId: "job_b",
        kind: "reject",
        revision: 3,
        stamp: "2026-07-30T10:00:02.000Z",
      }),
      markUndone(
        makeDecisionEntry({
          id: "decision_c",
          jobId: "job_c",
          kind: "inspect",
          revision: 5,
          stamp: "2026-07-30T10:00:03.000Z",
        }),
        "2026-07-30T10:00:04.000Z",
      ),
    ]);

    expect(findLatestUndoableDecision(log)).toMatchObject({
      id: "decision_b",
      jobId: "job_b",
      kind: "reject",
      revision: 3,
    });
    // The proposed target must always be that job's current decision too.
    const latest = findLatestUndoableDecision(log);
    expect(
      latest ? buildLatestDecisionIndex(log).get(latest.jobId) : null,
    ).toBe(latest);
  });

  it("returns null when every decision was undone or no log exists", () => {
    expect(findLatestUndoableDecision(null)).toBeNull();
    expect(
      findLatestUndoableDecision(
        parseScaleLog([
          markUndone(
            makeDecisionEntry({
              id: "decision_a",
              jobId: "job_a",
              kind: "shortlist",
              revision: 0,
              stamp: "2026-07-30T10:00:01.000Z",
            }),
            "2026-07-30T10:00:02.000Z",
          ),
        ]),
      ),
    ).toBeNull();
  });
});

describe("RapidReviewScreen undo recovery", () => {
  it(
    "undoes the rejected decision after the rejected job leaves the list at a page boundary",
    async () => {
      const jobs = createJobs();
      const shortlistFirstPageJob = makeDecisionEntry({
        id: "decision_0000_shortlist",
        jobId: "rapid_review_job_0000",
        kind: "shortlist",
        revision: 1,
        stamp: "2026-07-30T10:00:01.000Z",
      });
      const shortlistBoundaryJob = makeDecisionEntry({
        id: "decision_0040_shortlist",
        jobId: "rapid_review_job_0040",
        kind: "shortlist",
        revision: 1,
        stamp: "2026-07-30T10:00:02.000Z",
      });
      const mutations: RapidReviewMutationInput[] = [];
      const capture = (input: RapidReviewMutationInput) => {
        mutations.push(input);
        return Promise.resolve();
      };
      const view = renderRapidReview(
        jobs,
        parseScaleLog([shortlistFirstPageJob, shortlistBoundaryJob]),
        capture,
      );
      const list = screen.getByRole("list", { name: "Jobs to review" });

      // Walk the keyboard onto the first row of page 2 (a page boundary).
      for (let index = 0; index < PAGE_SIZE; index += 1) {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      }
      expect(view.container.querySelector('[aria-current="true"]')).toBe(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0040/,
        }),
      );

      // Reject the active boundary job and let the workspace refresh commit it.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Reject and next" }),
        );
        // Flush the mutation promise so decide's follow-up move commits.
        await Promise.resolve();
      });
      expect(mutations[0]).toMatchObject({
        type: "decide",
        campaignId: "campaign_scale",
        decision: "reject",
        jobIds: ["rapid_review_job_0040"],
        expectedRevisions: { rapid_review_job_0040: 1 },
      });

      // The reject archives the job, so the refreshed props no longer list it.
      const rejectEntry = makeDecisionEntry({
        id: "decision_0040_reject",
        jobId: "rapid_review_job_0040",
        kind: "reject",
        revision: 2,
        stamp: "2026-07-30T10:00:03.000Z",
      });
      const remainingJobs = jobs.filter(
        (job) => job.id !== "rapid_review_job_0040",
      );
      view.rerender(
        rapidReviewScreenElement(
          remainingJobs,
          parseScaleLog([
            shortlistFirstPageJob,
            shortlistBoundaryJob,
            rejectEntry,
          ]),
          capture,
        ),
      );

      expect(
        within(list).queryByRole("button", {
          name: /Senior Product Designer 0040/,
        }),
      ).toBeNull();
      // The archived job has no resolvable title, so the label stays truthful
      // without naming a row.
      expect(
        screen.getByRole("button", { name: "Undo last review decision" }),
      ).toBeTruthy();

      // U is pressed on whatever row currently holds focus — not on a hidden
      // selection — and must still revert the rejected job's new decision.
      const focusedRow = view.container.querySelector('[aria-current="true"]');
      if (!focusedRow) throw new Error("Expected an active review row");
      fireEvent.keyDown(focusedRow, { key: "u" });

      expect(mutations[mutations.length - 1]).toEqual({
        type: "undo",
        campaignId: "campaign_scale",
        jobId: "rapid_review_job_0040",
        expectedRevision: 2,
        reason: null,
      });

      // The undo restores the job: rerender with it back in discovery and its
      // reject stamped as undone in the log.
      view.rerender(
        rapidReviewScreenElement(
          jobs,
          parseScaleLog([
            shortlistFirstPageJob,
            shortlistBoundaryJob,
            markUndone(rejectEntry, "2026-07-30T10:00:04.000Z"),
          ]),
          capture,
        ),
      );

      expect(
        within(list).getByRole("button", {
          name: /Senior Product Designer 0040/,
        }),
      ).toBeTruthy();
      // With the job listed again, the control names the next undoable decision.
      expect(
        screen.getByRole("button", {
          name: "Undo shortlist: Senior Product Designer 0040",
        }),
      ).toBeTruthy();
    },
    PAGING_WALK_TIMEOUT_MS,
  );

  it("keeps undo reachable when the search filter hides every job", () => {
    const jobs = createJobs().slice(0, 3);
    const mutations: RapidReviewMutationInput[] = [];
    const view = renderRapidReview(
      jobs,
      parseScaleLog([
        makeDecisionEntry({
          id: "decision_0000_shortlist",
          jobId: "rapid_review_job_0000",
          kind: "shortlist",
          revision: 1,
          stamp: "2026-07-30T10:00:01.000Z",
        }),
      ]),
      (input) => {
        mutations.push(input);
        return Promise.resolve();
      },
    );

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz-no-match" },
    });
    expect(screen.getByText(/No jobs match/)).toBeTruthy();
    expect(
      view.container.querySelectorAll("[data-collection-item-id]"),
    ).toHaveLength(0);

    fireEvent.keyDown(window, { key: "u" });

    expect(mutations).toEqual([
      {
        type: "undo",
        campaignId: "campaign_scale",
        jobId: "rapid_review_job_0000",
        expectedRevision: 1,
        reason: null,
      },
    ]);
    expect(
      screen.getByRole("button", {
        name: "Undo shortlist: Senior Product Designer 0000",
      }),
    ).toBeTruthy();
  });

  it("does not undo while the user is typing in the search field", () => {
    const jobs = createJobs().slice(0, 3);
    const mutations: RapidReviewMutationInput[] = [];
    renderRapidReview(
      jobs,
      parseScaleLog([
        makeDecisionEntry({
          id: "decision_0000_shortlist",
          jobId: "rapid_review_job_0000",
          kind: "shortlist",
          revision: 1,
          stamp: "2026-07-30T10:00:01.000Z",
        }),
      ]),
      (input) => {
        mutations.push(input);
        return Promise.resolve();
      },
    );
    const searchField = screen.getByRole("searchbox");

    fireEvent.keyDown(searchField, { key: "u" });
    expect(mutations).toEqual([]);

    // Outside the editable field the same key undoes the latest decision.
    fireEvent.keyDown(window, { key: "u" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: "undo",
      jobId: "rapid_review_job_0000",
    });
  });
});
