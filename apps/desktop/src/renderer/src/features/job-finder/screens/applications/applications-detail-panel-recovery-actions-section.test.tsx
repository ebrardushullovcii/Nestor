// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApplicationFormOpenStates } from "./application-form-open";
import {
  UserActionRequestSchema,
  PREPARED_PAGE_CLOSED_SUMMARY,
  ApplyRunSchema,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { ApplicationAnswerStepCard } from "./applications-answer-step";
import {
  ApplicationsDetailPanelRecoveryActionsSection,
  type FinishInBrowserHandler,
} from "./applications-detail-panel-recovery-actions-section";

afterEach(() => {
  cleanup();
  resetApplicationFormOpenStates();
});

it.each([false, true])(
  "answer progress distinguishes waiting from insertion with elapsed time (%s)",
  (waitingForTurn) => {
    const at = new Date(Date.now() - 125_000).toISOString();
    const request = UserActionRequestSchema.parse({
      id: "request-answer",
      revision: 1,
      dedupeKey: "answer",
      kind: "manual_answer",
      state: "verifying",
      scope: {
        type: "application",
        runId: "run_1",
        jobId: "job_1",
        applicationRecordId: "application_1",
        source: "target_site",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: "question",
      },
      title: "Answer",
      summary: "Continue",
      createdAt: at,
      updatedAt: at,
    });
    const view = render(
      <ApplicationAnswerStepCard
        step={{
          request,
          questions: [],
          isPending: false,
          waitingForTurn,
          onCommand: vi.fn(),
        }}
      />,
    );
    expect(view.getByRole("status").textContent).toContain(
      `${waitingForTurn ? "Waiting its turn" : "Inserting your answer"} (2 min)`,
    );
  },
);

type ApplyResult =
  JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];

function buildResult(overrides: Partial<ApplyResult>): ApplyResult {
  return {
    id: "result_1",
    runId: "run_1",
    jobId: "job_1",
    applicationRecordId: "application_1",
    queuePosition: 0,
    state: "blocked",
    summary: null,
    detail: null,
    startedAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:01:00.000Z",
    completedAt: "2026-09-01T10:01:00.000Z",
    blockerReason: null,
    blockerSummary: null,
    listingSignalEvidence: null,
    visualObservationSets: [],
    visualCheckpoints: [],
    latestQuestionCount: 0,
    latestAnswerCount: 0,
    pendingConsentRequestCount: 0,
    artifactCount: 0,
    latestCheckpointId: null,
    privacyReceipt: null,
    reviewCard: null,
    ...overrides,
  } as unknown as ApplyResult;
}

function renderSection(
  props: Partial<
    Parameters<typeof ApplicationsDetailPanelRecoveryActionsSection>[0]
  > = {},
) {
  return render(
    <ApplicationsDetailPanelRecoveryActionsSection
      canRestageAutoRun
      canRestageQueueRun={false}
      dailyPreparationCapacity={null}
      excludedQueueRecoveryEntries={[]}
      isApplyPending={false}
      onStartApplyCopilot={vi.fn()}
      onStartAutoApplyQueue={vi.fn()}
      selectedQueueOutcomeEntries={[]}
      selectedQueueRecoveryEntries={[]}
      selectedQueueRecoveryJobIds={[]}
      selectedRecordJobId="job_1"
      selectedApplicationRecordId="application_1"
      selectedRun={null}
      visibleApplyResult={null}
      {...props}
    />,
  );
}

/**
 * Every button that is visually the primary one. One state may never draw
 * more than a single one of these: "so many random buttons approve this
 * revoke this prepare this auto prepare" was the complaint that produced the
 * whole one-state-one-action rule.
 */
function primaryButtonLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="applications-recovery-primary-action-button"]',
    ),
  ).map((button) => (button.textContent ?? "").trim());
}

describe("ApplicationsDetailPanelRecoveryActionsSection · a sent application", () => {
  it("does not show its batch's recovery summary once it was sent", () => {
    const run = {
      id: "run_1",
      mode: "queue_auto",
      state: "completed",
      jobIds: ["job_1", "job_2"],
    } as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"][number];
    const entries = [
      {
        jobId: "job_2",
        label: "Dusk Engineer at Dusk",
        runResult: buildResult({ jobId: "job_2", state: "failed" }),
      },
    ] as unknown as Parameters<
      typeof ApplicationsDetailPanelRecoveryActionsSection
    >[0]["selectedQueueOutcomeEntries"];
    const sent = renderSection({
      selectedRun: run,
      selectedQueueOutcomeEntries: entries,
      visibleApplyResult: buildResult({ state: "submitted" }),
    });
    expect(sent.container.textContent).not.toMatch(/Run outcome summary/i);
    cleanup();
    const failed = renderSection({
      selectedRun: run,
      selectedQueueOutcomeEntries: entries,
      visibleApplyResult: buildResult({ state: "failed" }),
    });
    expect(failed.container.textContent).toMatch(/Run outcome summary/i);
  });
});

describe("ApplicationsDetailPanelRecoveryActionsSection", () => {
  it("shows one primary action per state, with the label the state earns", () => {
    const cases: Array<{
      name: string;
      expectedLabel: string | null;
      result: ApplyResult | null;
      isApplyPending?: boolean;
      onOpenSafeguards?: () => void;
    }> = [
      {
        name: "preparing",
        expectedLabel: null,
        isApplyPending: true,
        result: buildResult({ state: "filling" }),
      },
      {
        name: "needs sign-in",
        expectedLabel: "Open the Job Finder browser",
        result: buildResult({
          blockerReason: "auth_required",
          blockerSummary: "The employer site asked you to sign in.",
        }),
      },
      {
        name: "site blocked",
        expectedLabel: "Open Safeguards to reset the Job Finder browser",
        onOpenSafeguards: vi.fn(),
        result: buildResult({
          blockerSummary: "The page service worker blocked the run.",
        }),
      },
      {
        name: "structural stop",
        expectedLabel: "Open the listing in the Job Finder browser",
        result: buildResult({
          state: "failed",
          summary: "This listing has no apply link Job Finder can use.",
        }),
      },
      {
        name: "retryable failure",
        expectedLabel: "Try again",
        result: buildResult({
          state: "failed",
          summary: "The employer site timed out before the form loaded.",
        }),
      },
      {
        name: "uncertain outcome",
        expectedLabel: null,
        result: buildResult({
          blockerReason: "submission_outcome_uncertain",
          blockerSummary: "Nobody could tell whether this was sent.",
        }),
      },
    ];

    for (const testCase of cases) {
      const { container, unmount } = renderSection({
        isApplyPending: testCase.isApplyPending ?? false,
        visibleApplyResult: testCase.result,
        ...(testCase.onOpenSafeguards
          ? { onOpenSafeguards: testCase.onOpenSafeguards }
          : {}),
      });

      const primaries = primaryButtonLabels(container);
      if (testCase.expectedLabel === null) {
        expect(primaries, testCase.name).toEqual([]);
      } else {
        expect(primaries, testCase.name).toEqual([testCase.expectedLabel]);
      }

      unmount();
    }
  });

  it("says why the run stopped instead of a bare could-not-finish", () => {
    const { getByTestId, queryByText } = renderSection({
      visibleApplyResult: buildResult({
        state: "failed",
        summary: "Job Finder could not finish this application",
        blockerSummary:
          "The run stayed on the job listing and never reached an application form.",
      }),
    });

    expect(getByTestId("applications-recovery-reason").textContent).toBe(
      "The run stayed on the job listing and never reached an application form.",
    );
    expect(queryByText("Nothing blocking")).toBeNull();
  });

  it("never offers to prepare this job automatically", () => {
    const { queryByRole } = renderSection({
      canRestageQueueRun: true,
      selectedQueueRecoveryJobIds: ["job_2"],
      visibleApplyResult: buildResult({
        state: "failed",
        summary: "The employer site timed out.",
      }),
    });

    expect(
      queryByRole("button", { name: "Prepare this job automatically" }),
    ).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(
      /prepare this job automatically|approve|revoke/i,
    );
  });

  it("offers no retry at all when a fresh run cannot change the reason", () => {
    const { queryByRole, queryByTestId } = renderSection({
      visibleApplyResult: buildResult({
        state: "failed",
        summary: "This posting is closed and no longer accepting applications.",
      }),
    });

    expect(queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      queryByRole("button", { name: /run preparation again/i }),
    ).toBeNull();
    expect(queryByTestId("applications-recovery-more")).toBeNull();
  });

  it("keeps the fresh run and the batch action behind one More disclosure", () => {
    const { getByRole, getByTestId } = renderSection({
      canRestageQueueRun: true,
      selectedQueueRecoveryJobIds: ["job_2", "job_3"],
      visibleApplyResult: buildResult({
        blockerReason: "auth_required",
        blockerSummary: "The employer site asked you to sign in.",
      }),
    });

    const more = getByTestId("applications-recovery-more");
    expect(more.tagName).toBe("DETAILS");
    expect((more as HTMLDetailsElement).open).toBe(false);
    expect(getByRole("button", { name: "Run preparation again" })).toBeTruthy();
    expect(
      getByRole("button", { name: "Prepare remaining jobs" }),
    ).toBeTruthy();
  });

  it("starts a fresh run under the saved mode from Try again", () => {
    const onStartApplyCopilot = vi.fn();
    const { getByRole } = renderSection({
      onStartApplyCopilot,
      visibleApplyResult: buildResult({
        state: "failed",
        summary: "The employer site timed out before the form loaded.",
      }),
    });

    fireEvent.click(getByRole("button", { name: "Try again" }));
    expect(onStartApplyCopilot).toHaveBeenCalledWith({
      jobId: "job_1",
      applicationRecordId: "application_1",
    });
  });

  it("retries the existing failed application instead of reopening its closed question step", () => {
    const onStartApplyCopilot = vi.fn();
    const onOpenNeedsYou = vi.fn();
    const { getByRole, queryByRole, queryByText } = renderSection({
      canRestageAutoRun: false,
      onStartApplyCopilot,
      onOpenNeedsYou,
      pausedQuestionCount: 4,
      visibleApplyResult: buildResult({
        state: "failed",
        blockerReason: "required_human_input",
        latestQuestionCount: 4,
        detail: "The person closed this step. Choose Try again to continue.",
      }),
    });

    expect(queryByRole("button", { name: "Answer the questions" })).toBeNull();
    expect(queryByText("The form asks 4 questions.")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Try again" }));
    expect(onStartApplyCopilot).toHaveBeenCalledExactlyOnceWith({
      jobId: "job_1",
      applicationRecordId: "application_1",
    });
    expect(onOpenNeedsYou).not.toHaveBeenCalled();
  });

  it("offers one cleanup action while capacity is full instead of claiming it is filling", () => {
    const previous = window.nestor;
    const command = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { browser: { command } },
    });
    try {
      const { container, getByRole, queryByTestId } = renderSection({
        visibleApplyResult: buildResult({
          state: "filling",
          completedAt: null,
          summary: "Waiting for a free browser tab",
          detail:
            "Browser tab limit reached. Prepared, unsent forms stay open.",
        }),
      });
      expect(primaryButtonLabels(container)).toEqual(["Close finished tabs"]);
      expect(
        queryByTestId("applications-recovery-progress-spinner"),
      ).toBeNull();
      fireEvent.click(getByRole("button", { name: "Close finished tabs" }));
      expect(command).toHaveBeenCalledExactlyOnceWith({
        type: "close_finished_tabs",
      });
    } finally {
      Object.defineProperty(window, "nestor", {
        configurable: true,
        value: previous,
      });
    }
  });

  it("shows a progress sentence with a spinner and no button while preparing", () => {
    const { getByTestId, container } = renderSection({
      isApplyPending: true,
      visibleApplyResult: buildResult({ state: "filling" }),
    });

    expect(getByTestId("applications-recovery-progress-spinner")).toBeTruthy();
    expect(getByTestId("applications-recovery-progress").textContent).toMatch(
      /filling this application in the Job Finder browser now/i,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  describe("browser hand-off outcome truthfulness", () => {
    const finishResult = buildResult({
      blockerSummary:
        "Conflicting application fields need manual review before this can go on.",
      blockerReason: "required_human_input",
    });

    function renderHandoff(onFinishInBrowser: FinishInBrowserHandler) {
      return renderSection({
        onFinishInBrowser,
        visibleApplyResult: finishResult,
      });
    }

    it("says the exact application page opened only when it did", () => {
      const { getByTestId, getByRole } = renderHandoff(() => ({
        kind: "opened_application_page",
      }));

      fireEvent.click(
        getByRole("button", { name: "Open the Job Finder browser" }),
      );
      expect(
        getByTestId("manual-field-finish-status").getAttribute(
          "data-handoff-outcome",
        ),
      ).toBe("opened_application_page");
    });

    it("tells the person to send a filled-in form themselves once it is open", () => {
      const { getByTestId, getByRole } = renderSection({
        onFinishInBrowser: () => ({ kind: "opened_application_page" }),
        visibleApplyResult: buildResult({ state: "awaiting_review" }),
      });

      fireEvent.click(
        getByRole("button", { name: "Open the Job Finder browser" }),
      );
      expect(getByTestId("manual-field-finish-status").textContent).toMatch(
        /press the site's own send button/i,
      );
    });

    it("says only the window opened when the page was not reopened", () => {
      const { getByTestId, getByRole } = renderHandoff(() => ({
        kind: "opened_browser_only",
      }));

      fireEvent.click(
        getByRole("button", { name: "Open the Job Finder browser" }),
      );
      expect(getByTestId("manual-field-finish-status").textContent).toMatch(
        /this application page was not reopened/i,
      );
    });

    it("reports a rejected hand-off with its reason instead of claiming success", async () => {
      const { findByTestId, getByRole } = renderHandoff(() =>
        Promise.reject(new Error("The browser window is not available.")),
      );

      fireEvent.click(
        getByRole("button", { name: "Open the Job Finder browser" }),
      );
      const status = await findByTestId("manual-field-finish-status");
      expect(status.getAttribute("data-handoff-outcome")).toBe("failed");
      expect(status.textContent).toMatch(/The browser window is not available/);
      expect(status.textContent).toMatch(/nothing was sent to the employer/i);
    });

    it("claims nothing until an asynchronous hand-off settles", async () => {
      let settle: () => void = () => undefined;
      const pending = new Promise<{ kind: "opened_application_page" }>(
        (resolve) => {
          settle = () => {
            resolve({ kind: "opened_application_page" });
          };
        },
      );
      const { queryByTestId, findByTestId, getByRole } = renderHandoff(
        () => pending,
      );

      fireEvent.click(
        getByRole("button", { name: "Open the Job Finder browser" }),
      );
      expect(queryByTestId("manual-field-finish-status")).toBeNull();
      settle();
      await findByTestId("manual-field-finish-status");
    });

    it("promotes the confirm control once the page really opened", async () => {
      const { getByTestId, getByRole } = renderSection({
        canConfirmFinishedInBrowser: true,
        onConfirmFinishedInBrowser: vi.fn(),
        onFinishInBrowser: () => ({ kind: "opened_application_page" }),
        visibleApplyResult: finishResult,
      });

      fireEvent.click(
        getByRole("button", { name: "Open the Job Finder browser" }),
      );
      await waitFor(() => {
        expect(getByTestId("confirm-finished-in-browser").className).toContain(
          "font-semibold",
        );
      });
    });
  });

  it("offers only Answer the questions when the form is waiting on an answer", () => {
    const onOpenNeedsYou = vi.fn();
    const { container, getByRole, getByTestId, queryByRole } = renderSection({
      onOpenNeedsYou,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "required_human_input",
        blockerSummary:
          'Job Finder stopped on "How many years of Kubernetes do you have?". Nothing saved answers this.',
      }),
    });

    expect(primaryButtonLabels(container)).toEqual(["Answer the questions"]);
    expect(getByTestId("applications-recovery-reason").textContent).toBe(
      "The form asks: How many years of Kubernetes do you have?",
    );
    expect(queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Answer the questions" }));
    expect(onOpenNeedsYou).toHaveBeenCalled();
  });

  it("says the re-pause in one sentence instead of the whole pause paragraph", () => {
    const { getByTestId } = renderSection({
      canConfirmFinishedInBrowser: true,
      confirmFinishedInBrowserStatus: "still_blocked",
      onConfirmFinishedInBrowser: vi.fn(),
      onOpenNeedsYou: vi.fn(),
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "question_grounding_failed",
        blockerSummary: 'Job Finder stopped on "Are you authorised to work?".',
      }),
    });

    expect(getByTestId("confirm-finished-in-browser-status").textContent).toBe(
      "Your answer did not fit this question; choose one of the options in Needs you.",
    );
  });

  it("keeps the chosen apply mode clear while checking an answered step", () => {
    const { getByTestId } = renderSection({
      canConfirmFinishedInBrowser: true,
      confirmFinishedInBrowserStatus: "checking",
      onConfirmFinishedInBrowser: vi.fn(),
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "required_human_input",
      }),
    });

    expect(getByTestId("confirm-finished-in-browser-status").textContent).toBe(
      "Checking this step in the Job Finder browser… When it is complete, Job Finder continues in your chosen apply mode.",
    );
  });
});

it("a rejected original format opens PDF review instead of retrying the same upload", () => {
  const onReviewResumePdf = vi.fn();
  const onStartApplyCopilot = vi.fn();
  const view = renderSection({
    onReviewResumePdf,
    onStartApplyCopilot,
    visibleApplyResult: buildResult({
      state: "failed",
      summary: "Resume upload failed",
      detail: "Upload a nonempty TXT, PDF, DOC or DOCX file.",
    }),
  });
  fireEvent.click(view.getByRole("button", { name: "Review a PDF" }));
  expect(onReviewResumePdf).toHaveBeenCalledWith("job_1");
  expect(onStartApplyCopilot).not.toHaveBeenCalled();
});

it("drops the browser-finish instruction as soon as the same application is submitted", () => {
  const baseProps = {
    canRestageAutoRun: false,
    canRestageQueueRun: false,
    dailyPreparationCapacity: null,
    excludedQueueRecoveryEntries: [],
    isApplyPending: false,
    onStartApplyCopilot: vi.fn(),
    onStartAutoApplyQueue: vi.fn(),
    selectedQueueOutcomeEntries: [],
    selectedQueueRecoveryEntries: [],
    selectedQueueRecoveryJobIds: [],
    selectedRecordJobId: "job_1",
    selectedApplicationRecordId: "application_1",
    selectedRun: null,
    onFinishInBrowser: () => ({ kind: "opened_application_page" as const }),
  };
  const result = buildResult({ state: "awaiting_review" });
  const view = render(
    <ApplicationsDetailPanelRecoveryActionsSection
      {...baseProps}
      visibleApplyResult={result}
    />,
  );
  fireEvent.click(
    view.getByRole("button", { name: "Open the Job Finder browser" }),
  );
  expect(view.getByTestId("manual-field-finish-status")).toBeTruthy();
  view.rerender(
    <ApplicationsDetailPanelRecoveryActionsSection
      {...baseProps}
      visibleApplyResult={{ ...result, state: "submitted" }}
      personSendReceiptSummary="The site confirmed receipt of the application."
    />,
  );
  expect(view.queryByTestId("manual-field-finish-status")).toBeNull();
  expect(
    view.getByTestId("applications-recovery-status-line").textContent,
  ).toBe("Application submitted");
});

it("prints each current batch outcome only once without duplicate recovery lists", () => {
  const result = buildResult({
    summary: "submitted via Submit button",
    state: "blocked",
    latestQuestionCount: 1,
    blockerReason: "required_human_input",
    blockerSummary: "Answer dates",
  });
  const entry = {
    jobId: "job_1",
    label: "Synthetic nurse",
    runResult: result,
    includeInRecovery: false,
  };
  const view = renderSection({
    visibleApplyResult: result,
    selectedRun: ApplyRunSchema.parse({
      id: "run_1",
      mode: "queue_auto",
      state: "paused_for_user_review",
      jobIds: ["job_1"],
      createdAt: result.startedAt,
      updatedAt: result.updatedAt,
      summary: "Waiting",
      detail: "Waiting",
      totalJobs: 1,
    }),
    selectedQueueOutcomeEntries: [entry],
    excludedQueueRecoveryEntries: [entry],
  });
  expect(view.getAllByText("Synthetic nurse")).toHaveLength(1);
  expect(view.queryByText("submitted via Submit button")).toBeNull();
  expect(
    view.queryByText("No jobs from this run still need recovery."),
  ).toBeNull();
  expect(view.container.textContent).toContain(
    "0 sent. 1 application needs your answers or review.",
  );
});

it("a missing prepared page uses Prepare again on its primary button", () => {
  const view = renderSection({
    visibleApplyResult: buildResult({
      state: "failed",
      summary: PREPARED_PAGE_CLOSED_SUMMARY,
    }),
  });
  expect(primaryButtonLabels(view.container)).toEqual(["Prepare again"]);
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
});

it.each([
  ["planned", "Waiting its turn", "Application queued", 0],
  ["planned", "Waiting for a browser tab", "Waiting for a free browser tab", 0],
  ["awaiting_review", "Needs your answers", "Needs your answers", 2],
  ["failed", "Form closed", PREPARED_PAGE_CLOSED_SUMMARY, 0],
] as const)(
  "per-job run outcome uses the actual %s standing: %s",
  (state, label, summary, latestQuestionCount) => {
    const result = buildResult({
      state,
      summary,
      latestQuestionCount,
      blockerReason: latestQuestionCount ? "required_human_input" : null,
      applicationPreparationStartedAt: "2026-09-01T10:00:00.000Z",
    });
    const run = ApplyRunSchema.parse({
      id: "run_1",
      state: "running",
      mode: "queue_auto",
      jobIds: ["job_1"],
      totalJobs: 1,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      summary: "Preparing",
      detail: "Preparing",
    });
    const view = renderSection({
      visibleApplyResult: result,
      selectedRun: run,
      selectedQueueOutcomeEntries: [
        {
          jobId: "job_1",
          label: "Synthetic role",
          runResult: result,
          includeInRecovery: false,
        },
      ],
    });
    const entry = view.getByText("Synthetic role").closest("div.grid");
    expect(entry?.textContent).toContain(label);
    expect(entry?.textContent).not.toContain(
      "Ready for you to finish and send",
    );
    expect(entry?.textContent).not.toContain("Filling in");
  },
);

it("shows the site's captured confirmation reference on the submitted record", () => {
  const result = buildResult({
    state: "submitted",
    summary: "Application received. Reference NW-2048.",
    privacyReceipt: {
      finalSubmitOccurred: true,
      submissionOutcome: {
        outcome: "submitted",
        evidence: [
          {
            id: "confirmation",
            summary: "Application received. Reference NW-2048.",
          },
        ],
      },
    } as unknown as NonNullable<
      Parameters<typeof buildResult>[0]["privacyReceipt"]
    >,
  });
  const view = renderSection({ visibleApplyResult: result });
  expect(
    view.getAllByText("Application received. Reference NW-2048."),
  ).toHaveLength(1);
});

it("shows a person's captured confirmation once", () => {
  const view = renderSection({
    personSendReceiptSummary: "The site confirmed receipt. Reference SYN-1.",
  });
  expect(
    view.getAllByText("The site confirmed receipt. Reference SYN-1."),
  ).toHaveLength(1);
});

it("uses captured receipt evidence once when the run detail says the same confirmation differently", () => {
  const result = buildResult({
    state: "submitted",
    detail: "The employer site confirmed receipt.",
    privacyReceipt: {
      finalSubmitOccurred: true,
      submissionOutcome: {
        outcome: "submitted",
        evidence: [
          { id: "one", summary: "Application received. Reference SYN-2." },
          { id: "two", summary: "Application received. Reference SYN-2." },
        ],
      },
    } as unknown as NonNullable<ApplyResult["privacyReceipt"]>,
  });
  const view = renderSection({ visibleApplyResult: result });
  expect(view.queryByText("The employer site confirmed receipt.")).toBeNull();
  expect(
    view.getAllByText("Application received. Reference SYN-2."),
  ).toHaveLength(1);
});
