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
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApplyRunDetails,
  ApplyRunSummary,
  ApplyJobResultSummary,
  ApplicationAttempt,
  ApplicationRecord,
  BrowserVisualEvidenceSummary,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  ApplyRunDetailsSchema,
  UserActionRequestSchema,
  ApplicationPrivacyReceiptSchema,
  ApplicationAttemptSchema,
  ApplyRunSchema,
  ApplyJobResultSchema,
  ApplicationCrmSettingsSchema,
  ApplicationRecordSchema,
} from "@nestor/contracts";
import { ApplicationsScreen } from "./applications-screen";
import type { ApplicationsDetailPanel } from "./applications-detail-panel";
import { ApplicationsDetailPanelAttemptSection } from "./applications-detail-panel-attempt-section";
import type { ApplicationsDetailPanelRecoverySections } from "./applications-detail-panel-recovery-sections";

describe("ApplicationsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function createVisualEvidence(
    overrides: Partial<BrowserVisualEvidenceSummary> = {},
  ): BrowserVisualEvidenceSummary {
    return {
      snapshotId: "visual_snapshot_apply_1",
      observationSetId: "visual_observation_apply_1",
      summary: "Visible resume upload and disabled final submit button.",
      capturedAt: "2026-03-20T10:04:30.000Z",
      storagePath: null,
      retention: "temporary",
      redactionLevel: "sensitive",
      confidence: 0.76,
      reconciliationStatus: "not_compared",
      ...overrides,
    };
  }

  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  function createTrackedApplication(
    overrides: Record<string, unknown> = {},
  ): ApplicationRecord {
    return ApplicationRecordSchema.parse({
      id: "application_beta",
      jobId: "job_beta",
      title: "Backend Engineer",
      company: "Beta",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        stage: "ready_for_approval",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
      },
      ...overrides,
    });
  }

  function stubCandidateAssetsBridge() {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
  }

  function buildCrmScreenProps(input: {
    applicationRecords: readonly ApplicationRecord[];
    onSelectRecord: (recordId: string) => void;
    selectedRecord: ApplicationRecord | null;
    includeTrackerControls?: boolean;
  }) {
    const { includeTrackerControls = true } = input;
    return {
      applicationAttempts: [],
      applicationRecords: input.applicationRecords,
      applyRuns: [],
      applyJobResults: [],
      discoveryJobs: [],
      isApplyPending: false,
      isApplyRequestPending: () => false,
      isApplyRunPending: () => false,
      onApproveApplyRun: vi.fn(),
      onCancelApplyRun: vi.fn(),
      onGetApplyRunDetails: vi.fn(),
      onExportApplicationPacket: vi.fn(),
      onResolveApplyConsentRequest: vi.fn(),
      onSaveApplicationAnswer: vi.fn(() =>
        Promise.reject(new Error("unused in this scenario")),
      ),
      onClearApplicationAnswer: vi.fn(() =>
        Promise.reject(new Error("unused in this scenario")),
      ),
      onRevokeApplyRunApproval: vi.fn(),
      onStartAutoApplyQueue: vi.fn(),
      onStartApplyCopilot: vi.fn(),
      onStartAutoApply: vi.fn(),
      onSelectRecord: input.onSelectRecord,
      selectedApplyRunId: null,
      selectedAttempt: null as ApplicationAttempt | null,
      selectedRecord: input.selectedRecord,
      ...(includeTrackerControls
        ? {
            crmSettings: ApplicationCrmSettingsSchema.parse({}),
            onMutateApplicationCrm: vi.fn(() => Promise.resolve()),
            onExportApplicationCrm: vi.fn(() => Promise.resolve()),
          }
        : {}),
    };
  }

  it("uses the same elapsed clock in the list and detail", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const record = createTrackedApplication({
      lastAttemptState: "in_progress",
      crm: null,
    });
    const at = "2026-10-05T10:00:00.000Z";
    const result = ApplyJobResultSchema.parse({
      id: "clock-result",
      runId: "clock-run",
      jobId: record.jobId,
      applicationRecordId: record.id,
      state: "filling",
      summary: "Filling in application",
      detail: "Reading the form",
      startedAt: at,
      updatedAt: at,
    });
    const run = ApplyRunSchema.parse({
      id: "clock-run",
      state: "running",
      jobIds: [record.jobId],
      createdAt: at,
      updatedAt: at,
      summary: "Preparing",
      detail: "Reading the form",
    });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(Date.parse("2026-10-05T10:01:30.000Z"))
      .mockReturnValue(Date.parse("2026-10-05T10:02:30.000Z"));
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [record],
            onSelectRecord: vi.fn(),
            selectedRecord: record,
            includeTrackerControls: false,
          })}
          applyRuns={[run]}
          applyJobResults={[result]}
          onGetApplyRunDetails={vi
            .fn()
            .mockResolvedValue(ApplyRunDetailsSchema.parse({ run, result }))}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getAllByText(/Preparing \(1 min\)/u).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Preparing \(2 min\)/u)).toBeNull();
    vi.restoreAllMocks();
  });

  it("opens the page bound to the selected result when an older result has the same URL", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const at = "2026-10-04T10:00:00.000Z";
    const record = createTrackedApplication({
      lastAttemptState: "ready",
      automationMode: "confirm_before_submit",
      crm: null,
    });
    const run = ApplyRunSchema.parse({
      id: "run_current",
      mode: "queue_auto",
      state: "completed",
      jobIds: [record.jobId],
      createdAt: at,
      updatedAt: at,
      completedAt: at,
      summary: "Prepared",
      detail: "Ready for review",
      totalJobs: 1,
    });
    const result = ApplyJobResultSchema.parse({
      id: "result_current",
      runId: run.id,
      applicationRecordId: record.id,
      jobId: record.jobId,
      state: "awaiting_review",
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      summary: "Prepared",
      detail: "Ready for review",
    });
    const url = "https://apply.synthetic.example/form";
    const details = ApplyRunDetailsSchema.parse({
      run,
      result,
      results: [result],
      reviewCard: {
        siteLabel: "Synthetic careers",
        pageUrl: url,
        answers: [],
        attachments: [],
        letter: null,
        waitingOnYou: [],
        preparedAt: at,
      },
    });
    const base = buildCrmScreenProps({
      applicationRecords: [record],
      selectedRecord: record,
      onSelectRecord: vi.fn(),
    });
    base.onGetApplyRunDetails.mockResolvedValue(details);
    const onFinishInBrowser = vi.fn(() =>
      Promise.resolve({ kind: "opened_application_page" as const }),
    );
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...base}
          selectedApplyRunId={run.id}
          onSubmitPreparedApplication={vi.fn(async () => {})}
          applyRuns={[run]}
          applyJobResults={[
            {
              ...result,
              id: "result_old",
              state: "submitted",
              updatedAt: "2026-10-03T10:00:00.000Z",
            },
            result,
          ]}
          onFinishInBrowser={onFinishInBrowser}
        />
      </MemoryRouter>,
    );
    const command = vi.fn(() => Promise.resolve());
    vi.stubGlobal("nestor", {
      ...(window as unknown as { nestor?: object }).nestor,
      browser: { command },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open this page" }),
    );
    await waitFor(() =>
      expect(onFinishInBrowser).toHaveBeenCalledWith(
        {
          jobId: record.jobId,
          resultId: result.id,
          runId: run.id,
          applicationRecordId: record.id,
          destinationUrl: url,
        },
        expect.any(Function),
      ),
    );
    // The bound tab is focused first, then the browser is shown (it may be
    // minimized while the person reads the record).
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: "open" }));
  });

  it("hides completed run furniture after all records are marked Applied", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const at = "2026-10-04T10:00:00.000Z";
    const records = Array.from({ length: 5 }, (_, index) =>
      createTrackedApplication({
        id: `application_${index}`,
        jobId: `job_${index}`,
        status: "approved",
        lastAttemptState: "ready",
        crm: null,
      }),
    );
    const run = ApplyRunSchema.parse({
      id: "run_history",
      mode: "queue_auto",
      state: "completed",
      jobIds: records.map((record) => record.jobId),
      createdAt: at,
      updatedAt: at,
      completedAt: at,
      summary: "Prepared five applications",
      detail: "Local preparations only",
      totalJobs: 5,
    });
    const results = records.map((record) =>
      ApplyJobResultSchema.parse({
        id: `result_${record.id}`,
        runId: run.id,
        applicationRecordId: record.id,
        jobId: record.jobId,
        state: "awaiting_review",
        startedAt: at,
        updatedAt: at,
        completedAt: at,
        summary: "Prepared",
        detail: "Ready for the person",
      }),
    );
    const base = buildCrmScreenProps({
      applicationRecords: records,
      selectedRecord: null,
      onSelectRecord: vi.fn(),
    });
    base.onGetApplyRunDetails.mockImplementation(
      () => new Promise<ApplyRunDetails>(() => {}),
    );
    const view = render(
      <MemoryRouter>
        <ApplicationsScreen
          {...base}
          applyRuns={[run]}
          applyJobResults={results}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Latest automatic run")).toBeNull();
    const tracked = records.map((record) => ({
      ...record,
      crm: {
        ...ApplicationRecordSchema.parse({
          ...record,
          crm: { stage: "applied", stageSource: "user", stageChangedAt: at },
        }).crm!,
      },
    }));
    view.rerender(
      <MemoryRouter>
        <ApplicationsScreen
          {...base}
          applicationRecords={tracked}
          applyRuns={[run]}
          applyJobResults={results}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Latest automatic run")).toBeNull();
    expect(screen.queryByText(/5 prepared/)).toBeNull();
    expect(screen.queryByText(/5 skipped/)).toBeNull();
  });

  it("restores one-use answer drafts and their save choice in Applications after Prepare again", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const record = createTrackedApplication({ lastAttemptState: "paused" });
    const at = "2026-10-04T10:00:00.000Z";
    const request = UserActionRequestSchema.parse({
      id: "new_request",
      revision: 1,
      dedupeKey: "new",
      kind: "manual_answer",
      state: "awaiting_user",
      scope: {
        type: "application",
        runId: "new_run",
        jobId: record.jobId,
        applicationRecordId: record.id,
        source: "target_site",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: "salary",
      },
      title: "Answer the questions",
      summary: "Answers needed",
      createdAt: at,
      updatedAt: at,
    });
    const previous = UserActionRequestSchema.parse({
      ...request,
      id: "old_request",
      dedupeKey: "old",
      state: "superseded",
      scope: { ...request.scope, runId: "old_run" },
    });
    const questions = [
      {
        id: "q_pay",
        prompt: "Expected salary",
        kind: "salary_expectation" as const,
        answerControlType: "text" as const,
        answerOptions: [],
        suggestedAnswers: [],
        status: "detected" as const,
        detectedAt: at,
      },
    ];
    const attempt = ApplicationAttemptSchema.parse({
      id: "attempt",
      blocker: {
        code: "missing_candidate_answer",
        userActionKind: "manual_answer",
        summary: "Answer needed",
        detail: "Pay is left to you",
        questionIds: ["q_pay"],
        sourceDebugEvidenceRefIds: [],
        url: "http://127.0.0.1:47950/apply",
      },
      completedAt: null,
      summary: "Answer needed",
      detail: "Answer needed",
      applicationRecordId: record.id,
      jobId: record.jobId,
      outcome: "ready_for_review",
      state: "paused",
      startedAt: at,
      createdAt: at,
      updatedAt: at,
      questions,
      nextActionLabel: "Answer",
    });
    const result = ApplyJobResultSchema.parse({
      id: "result",
      runId: "new_run",
      jobId: record.jobId,
      applicationRecordId: record.id,
      state: "blocked",
      summary: "Answer needed",
      detail: "Answer needed",
      startedAt: at,
      updatedAt: at,
      blockerReason: "required_human_input",
      latestQuestionCount: 1,
    });
    const run = ApplyRunSchema.parse({
      id: "new_run",
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: [record.jobId],
      createdAt: at,
      updatedAt: at,
      summary: "Answer needed",
      detail: "Answer needed",
      totalJobs: 1,
    });
    const onGetApplyRunDetails = vi.fn((query: { runId: string }) =>
      Promise.resolve(
        ApplyRunDetailsSchema.parse({
          run,
          result,
          results: [result],
          questionRecords: [],
          answerRecords:
            query.runId === "old_run"
              ? [
                  {
                    id: "old_answer",
                    runId: "old_run",
                    jobId: record.jobId,
                    resultId: "old_result",
                    status: "suggested",
                    applicationRecordId: record.id,
                    questionId: `apply_question_${record.id}_q_pay`,
                    text: "90000 EUR",
                    sourceKind: "user",
                    saveScope: "application_once",
                    revision: 1,
                    createdAt: at,
                  },
                ]
              : [],
          consentRequests: [],
          checkpoints: [],
          artifactRefs: [],
        }),
      ),
    );
    const onPerformUserAction = vi.fn();
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [record],
            selectedRecord: record,
            onSelectRecord: vi.fn(),
          })}
          applicationAttempts={[attempt]}
          selectedAttempt={attempt}
          applyRuns={[run]}
          applyJobResults={[result]}
          selectedApplyRunId={run.id}
          userActionRequests={[previous, request]}
          onGetApplyRunDetails={onGetApplyRunDetails}
          onPerformUserAction={onPerformUserAction}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Expected salary")).toHaveProperty(
        "value",
        "90000 EUR",
      ),
    );
    expect(
      screen.getByLabelText("Save this answer for next time"),
    ).toHaveProperty("checked", false);
    fireEvent.click(
      screen.getByRole("button", { name: "Answer and continue" }),
    );
    await waitFor(() =>
      expect(onPerformUserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: request.id,
          answer: "90000 EUR",
          saveForFuture: false,
        }),
      ),
    );
    expect(onGetApplyRunDetails).toHaveBeenCalledWith({
      runId: "old_run",
      jobId: record.jobId,
      applicationRecordId: record.id,
    });
  });

  it("does not count waiting forms or a contradictory receipt as sent", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const result = ApplyJobResultSchema.parse({
      id: "result_count",
      applicationRecordId: "record_count",
      runId: "run_count",
      jobId: "job_count",
      state: "submitted",
      summary: "Submitted",
      detail: "Synthetic",
      startedAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      privacyReceipt: ApplicationPrivacyReceiptSchema.parse({
        generatedAt: "2026-08-20T10:00:00.000Z",
        lineage: {
          runId: "run_count",
          jobId: "job_count",
          resultId: "result_count",
          applicationRecordId: "record_count",
        },
        destination: { origin: "http://127.0.0.1:47950", safePath: "/apply" },
        resume: {
          source: "original_upload",
          sourceDocumentId: "synthetic",
          exportArtifactId: null,
          fileName: "synthetic.pdf",
          sha256: "a".repeat(64),
        },
        finalSubmitOccurred: false,
      }),
    });
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [
              createTrackedApplication({
                id: "record_count",
                jobId: "job_count",
              }),
              createTrackedApplication({
                id: "record_waiting",
                jobId: "job_waiting",
              }),
            ],
            onSelectRecord: vi.fn(),
            selectedRecord: null,
            includeTrackerControls: false,
          })}
          onGetApplyRunDetails={() =>
            Promise.reject(new Error("Synthetic history unavailable"))
          }
          applyRuns={[
            ApplyRunSchema.parse({
              id: "run_count",
              mode: "queue_auto",
              state: "running",
              jobIds: ["job_count", "job_waiting"],
              totalJobs: 2,
              createdAt: result.startedAt,
              updatedAt: result.updatedAt,
              summary: "Running",
              detail: "Synthetic",
            }),
          ]}
          applyJobResults={[
            result,
            ApplyJobResultSchema.parse({
              ...result,
              id: "result_waiting",
              applicationRecordId: "record_waiting",
              jobId: "job_waiting",
              state: "awaiting_review",
              privacyReceipt: null,
            }),
          ]}
          // The waiting form has an open question, so the run summary shows
          // (ADR 0027: a form that is only ready to send is not attention).
          userActionRequests={
            [
              {
                id: "question_waiting",
                state: "awaiting_user",
                scope: {
                  type: "application",
                  runId: "run_count",
                  jobId: "job_waiting",
                  applicationRecordId: "record_waiting",
                },
              },
            ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"]
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/^Last automatic run: /)).toBeTruthy();
    expect(screen.queryByText("1 sent")).toBeNull();
    expect(screen.queryByText("2 finished")).toBeNull();
  });

  it("leads an Ask-mode ready application straight to its review", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const record = createTrackedApplication({
      automationMode: "confirm_before_submit",
      lastAttemptState: "ready",
    });
    const at = "2026-10-05T10:00:00.000Z";
    const result = ApplyJobResultSchema.parse({
      id: "ready_result",
      runId: "ready_run",
      jobId: record.jobId,
      applicationRecordId: record.id,
      state: "awaiting_review",
      summary: "Ready to send",
      detail: "Form filled",
      startedAt: at,
      updatedAt: at,
    });
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [record],
            selectedRecord: record,
            onSelectRecord: vi.fn(),
          })}
          applyJobResults={[result]}
          onFinishInBrowser={vi.fn()}
          onGetApplyRunDetails={vi.fn(
            () => new Promise<ApplyRunDetails>(() => {}),
          )}
        />
      </MemoryRouter>,
    );
    expect(
      within(
        screen.getByTestId("applications-recovery-primary-action"),
      ).getByRole("button", { name: "Review before sending" }),
    ).toBeTruthy();
    expect(
      within(
        screen.getByTestId("applications-recovery-secondary-action-list"),
      ).getByRole("button", { name: "Open the Job Finder browser" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Review before sending" }),
    );
    expect(
      document.activeElement?.hasAttribute("data-application-review-target"),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
  });
  it("retries all fourteen applications with one press (ADR 0058)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const records = Array.from({ length: 14 }, (_, i) =>
      createTrackedApplication({
        id: `app_${i}`,
        jobId: `job_${i}`,
        lastAttemptState: "failed",
        lastActionLabel: "Could not apply",
      }),
    );
    const onStartAutoApplyQueue = vi.fn();
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: records,
            onSelectRecord: vi.fn(),
            selectedRecord: records[0] ?? null,
          })}
          applyJobResults={records.map((record, i) =>
            ApplyJobResultSchema.parse({
              id: `result_${i}`,
              runId: "failed_run",
              jobId: record.jobId,
              applicationRecordId: record.id,
              state: "failed",
              summary: "Could not apply",
              detail: "Page unavailable",
              blockerReason: "application_page_unreachable",
              startedAt: "2026-10-05T10:00:00.000Z",
              updatedAt: "2026-10-05T10:00:00.000Z",
            }),
          )}
          onStartAutoApplyQueue={onStartAutoApplyQueue}
          onGetApplyRunDetails={vi.fn(
            () => new Promise<ApplyRunDetails>(() => {}),
          )}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("14 applications need another try")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Try again for all 14" }),
    );
    expect(onStartAutoApplyQueue).toHaveBeenCalledWith(
      records.map((record) => record.jobId),
      "prepare_only",
    );
  });
  it.each([false, true])(
    "retries only failures with the saved Send mode (cancelled sibling: %s)",
    (includeCancelled) => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      const first = createTrackedApplication({
        id: "application_retry_a",
        jobId: "job_retry_a",
        lastAttemptState: "failed",
        lastActionLabel: "Could not apply",
      });
      const second = createTrackedApplication({
        id: "application_retry_b",
        jobId: "job_retry_b",
        lastAttemptState: "failed",
        lastActionLabel: "Could not apply",
      });
      const failedResult = (
        record: ApplicationRecord,
        index: number,
      ): ApplyJobResultSummary => ({
        id: `result_retry_${index}`,
        runId: "run_retry_failed",
        jobId: record.jobId,
        applicationRecordId: record.id,
        queuePosition: index,
        state: "failed",
        summary: "Could not apply",
        detail: "The application could not be prepared.",
        startedAt: "2026-09-22T16:00:00.000Z",
        updatedAt: `2026-09-22T16:0${index + 1}:00.000Z`,
        completedAt: `2026-09-22T16:0${index + 1}:00.000Z`,
        blockerReason: "application_page_unreachable",
        blockerSummary: "The application could not be prepared.",
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
      });
      const onStartAutoApplyQueue = vi.fn();
      const cancelled = createTrackedApplication({
        id: "application_cancelled",
        jobId: "job_cancelled",
        lastAttemptState: "cancelled",
        lastActionLabel: "Cancelled by you",
      });
      const cancelledResult: ApplyJobResultSummary = {
        ...failedResult(cancelled, 2),
        state: "cancelled",
        summary: "Cancelled by you",
        blockerReason: null,
        blockerSummary: null,
      };

      render(
        <MemoryRouter>
          <ApplicationsScreen
            {...buildCrmScreenProps({
              applicationRecords: [
                first,
                second,
                ...(includeCancelled ? [cancelled] : []),
              ],
              onSelectRecord: vi.fn(),
              selectedRecord: first,
            })}
            applicationAutomationMode="autonomous_submit"
            applyJobResults={[
              failedResult(first, 0),
              failedResult(second, 1),
              ...(includeCancelled ? [cancelledResult] : []),
            ]}
            onGetApplyRunDetails={vi.fn(
              () => new Promise<ApplyRunDetails>(() => {}),
            )}
            onStartAutoApplyQueue={onStartAutoApplyQueue}
          />
        </MemoryRouter>,
      );

      const retryItem = screen.getByText("2 applications need another try");
      // A bulk follow-up for the list is an item on the header status line.
      expect(retryItem.closest("[data-page-header-status]")).toBeTruthy();
      expect(
        retryItem.closest("[data-page-status-item]")?.getAttribute("data-tone"),
      ).toBe("warning");
      fireEvent.click(
        screen.getByRole("button", { name: "Try again for all 2" }),
      );
      expect(onStartAutoApplyQueue).toHaveBeenCalledWith(
        ["job_retry_a", "job_retry_b"],
        "autonomous_submit",
      );
    },
  );

  it("shows the newest retry rather than an abandoned run's skipped count", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const a = createTrackedApplication({
      id: "a",
      jobId: "job_a",
      lastAttemptState: "paused",
    });
    const b = createTrackedApplication({
      id: "b",
      jobId: "job_b",
      lastAttemptState: "in_progress",
    });
    const old = ApplyRunSchema.parse({
      id: "old",
      mode: "queue_auto",
      state: "cancelled",
      jobIds: [a.jobId, b.jobId],
      createdAt: "2026-10-02T09:00:00.000Z",
      updatedAt: "2026-10-02T11:00:00.000Z",
      summary: "Stopped",
      detail: "Stopped",
      totalJobs: 2,
    });
    const latest = ApplyRunSchema.parse({
      ...old,
      id: "latest",
      state: "running",
      createdAt: "2026-10-02T10:00:00.000Z",
      updatedAt: "2026-10-02T10:01:00.000Z",
    });
    const result = (
      record: ApplicationRecord,
      runId: string,
      state: "skipped" | "blocked" | "filling",
    ) =>
      ApplyJobResultSchema.parse({
        id: `${runId}_${record.id}`,
        runId,
        jobId: record.jobId,
        applicationRecordId: record.id,
        state,
        summary: "Application",
        detail: "Application",
        startedAt: runId === "old" ? old.createdAt : latest.createdAt,
        updatedAt: runId === "old" ? old.updatedAt : latest.updatedAt,
      });
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [a, b],
            selectedRecord: a,
            onSelectRecord: vi.fn(),
          })}
          onGetApplyRunDetails={vi.fn(() =>
            Promise.reject(new Error("No review details in this fixture")),
          )}
          applyRuns={[old, latest]}
          applyJobResults={[
            result(a, "old", "skipped"),
            result(b, "old", "skipped"),
            result(a, "latest", "blocked"),
            result(b, "latest", "filling"),
          ]}
          userActionRequests={
            [
              {
                id: "question",
                state: "awaiting_user",
                scope: {
                  type: "application",
                  runId: "latest",
                  jobId: a.jobId,
                  applicationRecordId: a.id,
                },
              },
            ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"]
          }
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText("Last automatic run: 2 jobs, 1 needs you"),
    ).toBeTruthy();
  });
  it.each(["failed", "awaiting_review"] as const)(
    "tracks a stopped %s attempt even before all stored fields were synchronized",
    (state) => {
      vi.stubGlobal("ResizeObserver", ResizeObserverMock);
      stubCandidateAssetsBridge();
      const record = createTrackedApplication({
        lastAttemptState: state === "failed" ? "ready" : "failed",
        lastUpdatedAt: "2026-10-02T11:00:00.000Z",
        crm: {
          stage: "ready_for_approval",
          stageSource: "activity",
          stageChangedAt: "2026-10-02T09:00:00.000Z",
        },
      });
      const result = ApplyJobResultSchema.parse({
        id: "closed",
        jobId: record.jobId,
        applicationRecordId: record.id,
        runId: "closed_run",
        state,
        summary: "Listing closed",
        detail: "The posting is closed",
        startedAt: "2026-10-02T09:00:00.000Z",
        updatedAt: "2026-10-02T10:00:00.000Z",
      });
      render(
        <MemoryRouter>
          <ApplicationsScreen
            {...buildCrmScreenProps({
              applicationRecords: [record],
              selectedRecord: record,
              onSelectRecord: vi.fn(),
            })}
            applyJobResults={[result]}
            onGetApplyRunDetails={vi.fn(() =>
              Promise.reject(new Error("No retained details")),
            )}
          />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
      expect(
        screen.getByRole<HTMLSelectElement>("combobox", { name: "Stage" })
          .value,
      ).toBe("failed");
    },
  );
  it("keeps an open review when another application changes in the background", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const a = createTrackedApplication({
      id: "a",
      jobId: "job_a",
      title: "Job A",
    });
    const b = createTrackedApplication({
      id: "b",
      jobId: "job_b",
      title: "Job B",
    });
    const onSelectRecord = vi.fn();
    const props = buildCrmScreenProps({
      applicationRecords: [a, b],
      selectedRecord: a,
      onSelectRecord,
    });
    const view = render(
      <MemoryRouter>
        <ApplicationsScreen {...props} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "Draft in progress" },
    });
    view.rerender(
      <MemoryRouter>
        <ApplicationsScreen
          {...props}
          applicationRecords={[{ ...b, lastAttemptState: "paused" }, a]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Tags").value).toBe(
      "Draft in progress",
    );
    expect(onSelectRecord).not.toHaveBeenCalled();
  });
  it("shows action-led first-run CTAs when there are no applications yet", () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[]}
          applyRuns={[]}
          applyJobResults={[]}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={vi.fn()}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Nothing applied to yet")).toBeTruthy();
    expect(
      screen.getByText(
        /Press Apply on a shortlisted job and it shows up here/i,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Application details will appear here"),
    ).toBeNull();

    const shortlistedLinks = screen.getAllByRole("link", {
      name: "Open Shortlisted",
    });
    expect(shortlistedLinks).toHaveLength(2);
    for (const link of shortlistedLinks) {
      expect(link.getAttribute("href")).toBe("/job-finder/review-queue");
    }
    expect(
      screen.getByRole("link", { name: "Find jobs" }).getAttribute("href"),
    ).toBe("/job-finder/discovery");
    expect(screen.queryByRole("button", { name: /needs action/i })).toBeNull();

    // With nothing to track, the tracker is not offered at all.
    expect(screen.queryByRole("button", { name: "Open tracker" })).toBeNull();
  });

  it("keeps workspace modes directly under the title and renders notices below them", () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const view = render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[]}
          applyRuns={[]}
          applyJobResults={[]}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={vi.fn()}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    const stack = view.container.querySelector("[data-page-header-stack]");
    const subnav = view.container.querySelector("[data-page-header-subnav]");
    const dividers = view.container.querySelectorAll(
      "[data-page-header-divider]",
    );
    // No safeguard holds are announced here any more.
    expect(
      screen.queryByText(/safeguard holds? (is|are) pausing/),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Active safeguards" }),
    ).toBeNull();

    expect(dividers).toHaveLength(1);
    expect(stack?.className).toContain("mb-(--gap-page-header-body)");

    // Preparation is the product: there is no Preparation/Stages tab pair,
    // and with no applications yet there is nothing to track either.
    expect(subnav).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Applications workspace view" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Stages" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open tracker" })).toBeNull();
    expect(
      document.getElementById("applications-workspace-content"),
    ).toBeTruthy();
  });

  it.each(["blocked", "failed"] as const)(
    "shows the attention banner with the right tone for %s results",
    (attentionState) => {
      class ResizeObserverMock {
        observe() {}
        disconnect() {}
      }

      vi.stubGlobal("ResizeObserver", ResizeObserverMock);

      const finishedRun: ApplyRunSummary = {
        id: "apply_run_finished",
        campaignId: null,
        mode: "queue_auto",
        state: "failed",
        jobIds: ["job_finished"],
        currentJobId: null,
        submitApprovalId: null,
        visualCheckpointsEnabled: false,
        createdAt: "2026-08-20T09:55:00.000Z",
        updatedAt: "2026-08-20T10:00:00.000Z",
        completedAt: "2026-08-20T10:00:00.000Z",
        summary: "Finished with failures.",
        detail: "The queue stopped before every job was tried.",
        totalJobs: 1,
        pendingJobs: 0,
        submittedJobs: 0,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 1,
      };
      const buildProps = (state: ApplyRunSummary["state"]) => ({
        applicationAttempts: [],
        applicationRecords: [],
        applyRuns: [{ ...finishedRun, state }],
        applyJobResults: [],
        discoveryJobs: [],
        isApplyPending: false,
        isApplyRequestPending: () => false,
        isApplyRunPending: () => false,
        onApproveApplyRun: vi.fn(),
        onCancelApplyRun: vi.fn(),
        onGetApplyRunDetails: vi.fn(
          () => new Promise<ApplyRunDetails>(() => {}),
        ),
        onExportApplicationPacket: vi.fn(),
        onResolveApplyConsentRequest: vi.fn(),
        onSaveApplicationAnswer: vi.fn(() =>
          Promise.reject(new Error("unused in this scenario")),
        ),
        onClearApplicationAnswer: vi.fn(() =>
          Promise.reject(new Error("unused in this scenario")),
        ),
        onRevokeApplyRunApproval: vi.fn(),
        onSelectRecord: vi.fn(),
        onStartApplyCopilot: vi.fn(),
        onStartAutoApply: vi.fn(),
        onStartAutoApplyQueue: vi.fn(),
        selectedApplyRunId: null,
        selectedAttempt: null,
        selectedRecord: null,
      });

      // With zero results there are no attention cases, so the run is history:
      // the banner is not page furniture and does not reappear as a fresh event
      // every time the user comes back from the tracker. The run stays visible
      // in the record's own run history.
      for (const rawState of ["failed", "cancelled"] as const) {
        render(
          <MemoryRouter>
            <ApplicationsScreen {...buildProps(rawState)} />
          </MemoryRouter>,
        );

        expect(screen.queryByText("Latest automatic run")).toBeNull();
        expect(screen.queryByText(rawState)).toBeNull();

        cleanup();
      }

      // When it does need attention it says so, and it counts the cases rather
      // than naming a run state.
      render(
        <MemoryRouter>
          <ApplicationsScreen
            {...buildProps("failed")}
            applyRuns={[
              ...buildProps("failed").applyRuns,
              {
                ...finishedRun,
                id: "retry_run",
                mode: "copilot",
                jobIds: ["job_retried"],
                createdAt: "2026-08-20T10:01:00.000Z",
              },
            ]}
            applicationRecords={[
              ApplicationRecordSchema.parse({
                id: "retried_application",
                jobId: "job_retried",
                title: "Retried job",
                company: "Replica",
                status: "drafting",
                lastActionLabel: "Preparing again",
                nextActionLabel: "Wait",
                lastUpdatedAt: "2026-08-20T10:01:00.000Z",
              }),
            ]}
            applyJobResults={[
              ApplyJobResultSchema.parse({
                id: "old_failure",
                runId: "apply_run_finished",
                jobId: "job_retried",
                applicationRecordId: "retried_application",
                state: "failed",
                summary: "Failed earlier",
                detail: "Try again",
                startedAt: "2026-08-20T09:56:00.000Z",
                updatedAt: "2026-08-20T10:00:00.000Z",
              }),
              ApplyJobResultSchema.parse({
                id: "retry_result",
                runId: "retry_run",
                jobId: "job_retried",
                applicationRecordId: "retried_application",
                state: "filling",
                summary: "Preparing again",
                detail: "Retry running",
                startedAt: "2026-08-20T10:01:00.000Z",
                updatedAt: "2026-08-20T10:01:00.000Z",
              }),
              {
                id: "apply_result_attention",
                runId: "apply_run_finished",
                jobId: "job_finished",
                applicationRecordId: null,
                queuePosition: 0,
                state: attentionState,
                summary: "Blocked before review.",
                detail: "The run stopped before the job was prepared.",
                startedAt: "2026-08-20T09:56:00.000Z",
                updatedAt: "2026-08-20T10:00:00.000Z",
                completedAt: "2026-08-20T10:00:00.000Z",
                blockerReason: "required_human_input",
                blockerSummary: "The job site needs you to finish a step.",
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
              },
            ]}
            // The banner counts this run's share of the Needs you population
            // rather than its own result states, so the fixture carries the
            // open request that makes the blocked job something to act on.
            userActionRequests={
              [
                {
                  id: "old_failure_request",
                  state: "awaiting_user",
                  scope: {
                    type: "application",
                    runId: "apply_run_finished",
                    jobId: "job_retried",
                    applicationRecordId: "retried_application",
                  },
                },
                {
                  id: "request_finished",
                  state: "awaiting_user",
                  scope: {
                    type: "application",
                    runId: "apply_run_finished",
                    jobId: "job_finished",
                    applicationRecordId: null,
                  },
                },
              ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"]
            }
          />
        </MemoryRouter>,
      );
      // The run summary is a neutral item; the failure itself is reported
      // by the row and the retry item, not by tinting the summary.
      const runItem = screen.getByText(
        "Last automatic run: 1 job, 1 needs you",
      );
      expect(
        runItem.closest("[data-page-status-item]")?.getAttribute("data-tone"),
      ).toBe("neutral");
      expect(screen.getByRole("button", { name: "Show them" })).toBeTruthy();
      expect(screen.queryByText("failed")).toBeNull();
    },
  );

  it("does not show the pause banner for a contradictory answer advisory", () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);


    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[]}
          applyRuns={[]}
          applyJobResults={[]}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={vi.fn()}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/safeguard holds? (is|are) pausing/)).toBeNull();
  });

  it("loads details for a newly selected historical apply run", async () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const selectedRecord: ApplicationRecord = {
      id: "application_1",
      jobId: "job_ready",
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Resume approved",
      nextActionLabel: "Start apply copilot",
      lastUpdatedAt: "2026-03-20T10:05:00.000Z",
      lastAttemptState: "submitted",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: {
        status: "none",
        pendingCount: 0,
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };
    const applyRuns: ApplyRunSummary[] = [
      {
        id: "apply_run_latest",
        campaignId: null,
        mode: "copilot",
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        submitApprovalId: null,
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        completedAt: "2026-03-20T10:05:00.000Z",
        summary: "Latest run",
        detail: "Latest safe run finished.",
        totalJobs: 1,
        pendingJobs: 0,
        submittedJobs: 1,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      },
      {
        id: "apply_run_older",
        campaignId: null,
        mode: "copilot",
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        submitApprovalId: null,
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T09:54:00.000Z",
        updatedAt: "2026-03-20T09:55:00.000Z",
        completedAt: "2026-03-20T09:55:00.000Z",
        summary: "Older run",
        detail: "Older safe run finished.",
        totalJobs: 1,
        pendingJobs: 0,
        submittedJobs: 1,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      },
    ];
    const applyJobResults: ApplyJobResultSummary[] = [
      {
        id: "apply_result_latest",
        runId: "apply_run_latest",
        jobId: "job_ready",
        applicationRecordId: selectedRecord.id,
        queuePosition: 0,
        state: "submitted",
        summary: "Latest application summary",
        detail: "Latest application detail",
        startedAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        completedAt: "2026-03-20T10:05:00.000Z",
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
      },
      {
        id: "apply_result_older",
        runId: "apply_run_older",
        jobId: "job_ready",
        applicationRecordId: selectedRecord.id,
        queuePosition: 0,
        state: "blocked",
        summary: "Older application summary",
        detail: "Older application detail",
        startedAt: "2026-03-20T09:54:00.000Z",
        updatedAt: "2026-03-20T09:55:00.000Z",
        completedAt: "2026-03-20T09:55:00.000Z",
        blockerReason: "required_human_input",
        blockerSummary: "Needed manual follow-up",
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
      },
    ];
    const otherRecordForSameJob: ApplicationRecord = {
      ...selectedRecord,
      id: "application_ready_other",
      lastActionLabel: "Separate application record",
      lastUpdatedAt: "2026-03-20T10:06:00.000Z",
    };
    applyJobResults.push({
      ...applyJobResults[0]!,
      id: "apply_result_other_record",
      applicationRecordId: otherRecordForSameJob.id,
      summary: "Other record must stay isolated",
      state: "failed",
      updatedAt: "2026-03-20T10:06:00.000Z",
    });
    const onGetApplyRunDetails = vi.fn(
      (input: { runId: string }): Promise<ApplyRunDetails> =>
        Promise.resolve({
          run:
            applyRuns.find((entry) => entry.id === input.runId) ??
            applyRuns[0]!,
          result:
            applyJobResults.find((entry) => entry.runId === input.runId) ??
            null,
          results: applyJobResults.filter(
            (entry) => entry.runId === input.runId,
          ),
          submitApproval: null,
          questionRecords: [],
          answerRecords: [],
          artifactRefs: [],
          checkpoints: [],
          consentRequests: [],
          reviewCard: null,
        }),
    );

    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[selectedRecord, otherRecordForSameJob]}
          applyRuns={applyRuns}
          applyJobResults={applyJobResults}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={onGetApplyRunDetails}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={selectedRecord}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(onGetApplyRunDetails).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Other record must stay isolated")).toBeNull();
    expect(
      screen.getByRole("link", { name: /prepare interview/i }),
    ).toBeTruthy();

    const olderRunButton = screen.getByTitle("apply_run_older");

    fireEvent.click(olderRunButton);

    await waitFor(() => {
      expect(onGetApplyRunDetails).toHaveBeenCalledTimes(2);
    });
    expect(onGetApplyRunDetails).toHaveBeenLastCalledWith({
      runId: "apply_run_older",
      jobId: "job_ready",
      applicationRecordId: selectedRecord.id,
    });
  });

  it("opens the newest attempt, not the most recently updated older run", async () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const selectedRecord: ApplicationRecord = {
      id: "application_1",
      jobId: "job_ready",
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Resume approved",
      nextActionLabel: "Start apply copilot",
      lastUpdatedAt: "2026-03-20T10:05:00.000Z",
      lastAttemptState: "submitted",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: {
        status: "none",
        pendingCount: 0,
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };
    const applyRuns: ApplyRunSummary[] = [
      {
        id: "apply_run_latest",
        campaignId: null,
        mode: "copilot",
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        submitApprovalId: null,
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        completedAt: "2026-03-20T10:05:00.000Z",
        summary: "Latest run",
        detail: "Latest safe run finished.",
        totalJobs: 1,
        pendingJobs: 0,
        submittedJobs: 1,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      },
      {
        id: "apply_run_older",
        campaignId: null,
        mode: "copilot",
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        submitApprovalId: null,
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T09:54:00.000Z",
        updatedAt: "2026-03-20T09:55:00.000Z",
        completedAt: "2026-03-20T09:55:00.000Z",
        summary: "Older run",
        detail: "Older safe run finished.",
        totalJobs: 1,
        pendingJobs: 0,
        submittedJobs: 1,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      },
    ];
    const applyJobResults: ApplyJobResultSummary[] = [
      {
        id: "apply_result_latest",
        runId: "apply_run_latest",
        jobId: "job_ready",
        applicationRecordId: selectedRecord.id,
        queuePosition: 0,
        state: "submitted",
        summary: "Latest application summary",
        detail: "Latest application detail",
        startedAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        completedAt: "2026-03-20T10:05:00.000Z",
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
      },
      {
        id: "apply_result_older",
        runId: "apply_run_older",
        jobId: "job_ready",
        applicationRecordId: selectedRecord.id,
        queuePosition: 0,
        state: "blocked",
        summary: "Older application summary",
        detail: "Older application detail",
        startedAt: "2026-03-20T09:54:00.000Z",
        updatedAt: "2026-03-20T09:55:00.000Z",
        completedAt: "2026-03-20T09:55:00.000Z",
        blockerReason: "required_human_input",
        blockerSummary: "Needed manual follow-up",
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
      },
    ];
    const otherRecordForSameJob: ApplicationRecord = {
      ...selectedRecord,
      id: "application_ready_other",
      lastActionLabel: "Separate application record",
      lastUpdatedAt: "2026-03-20T10:06:00.000Z",
    };
    applyJobResults.push({
      ...applyJobResults[0]!,
      id: "apply_result_other_record",
      applicationRecordId: otherRecordForSameJob.id,
      summary: "Other record must stay isolated",
      state: "failed",
      updatedAt: "2026-03-20T10:06:00.000Z",
    });
    const onGetApplyRunDetails = vi.fn(
      (input: { runId: string }): Promise<ApplyRunDetails> =>
        Promise.resolve({
          run:
            applyRuns.find((entry) => entry.id === input.runId) ??
            applyRuns[0]!,
          result:
            applyJobResults.find((entry) => entry.runId === input.runId) ??
            null,
          results: applyJobResults.filter(
            (entry) => entry.runId === input.runId,
          ),
          submitApproval: null,
          questionRecords: [],
          answerRecords: [],
          artifactRefs: [],
          checkpoints: [],
          consentRequests: [],
          reviewCard: null,
        }),
    );

    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[selectedRecord, otherRecordForSameJob]}
          applyRuns={applyRuns}
          applyJobResults={applyJobResults}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={onGetApplyRunDetails}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId="apply_run_older"
          selectedAttempt={null}
          selectedRecord={selectedRecord}
        />
      </MemoryRouter>,
    );

    // The workspace-wide selection is the most recently updated run, which
    // after a retry is often the older batch. The record still shows (and
    // "Open the Job Finder browser" targets) its newest attempt.
    await waitFor(() => {
      expect(onGetApplyRunDetails).toHaveBeenCalledTimes(1);
    });
    expect(onGetApplyRunDetails).toHaveBeenLastCalledWith({
      runId: "apply_run_latest",
      jobId: "job_ready",
      applicationRecordId: selectedRecord.id,
    });
  });

  it("counts and associates legacy null-lineage run history with the matching application record", async () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();

    const legacyRecord = ApplicationRecordSchema.parse({
      id: "application_legacy_lineage",
      jobId: "job_legacy",
      title: "Legacy Lineage Engineer",
      company: "Heritage Systems",
      status: "submitted",
      lastActionLabel: "Submitted via safe run",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-20T10:00:00.000Z",
      lastAttemptState: "submitted",
    });
    const legacyRun: ApplyRunSummary = {
      id: "apply_run_legacy",
      campaignId: "campaign_active",
      mode: "copilot",
      state: "completed",
      jobIds: ["job_legacy"],
      currentJobId: null,
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: "2026-08-20T09:55:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:00.000Z",
      summary: "Legacy run",
      detail: "Completed before application records existed.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 1,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    };
    const legacyResult: ApplyJobResultSummary = {
      id: "apply_result_legacy",
      runId: legacyRun.id,
      jobId: "job_legacy",
      applicationRecordId: null,
      queuePosition: 0,
      state: "submitted",
      summary: "Prepared and submitted the application form.",
      detail: "Legacy result stored before application records existed.",
      startedAt: "2026-08-20T09:56:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:00.000Z",
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
    };
    const legacyAttempt = ApplicationAttemptSchema.parse({
      id: "attempt_legacy",
      jobId: "job_legacy",
      applicationRecordId: null,
      state: "submitted",
      summary: "Legacy attempt prepared every required answer.",
      detail: "Legacy attempt stored before application records existed.",
      startedAt: "2026-08-20T09:56:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:00.000Z",
      outcome: "submitted",
      nextActionLabel: null,
    });
    const onGetApplyRunDetails = vi.fn(
      (): Promise<ApplyRunDetails> =>
        Promise.resolve({
          run: legacyRun,
          result: legacyResult,
          results: [legacyResult],
          submitApproval: null,
          questionRecords: [],
          answerRecords: [],
          artifactRefs: [],
          checkpoints: [],
          consentRequests: [],
          reviewCard: null,
        }),
    );

    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[legacyAttempt]}
          applicationRecords={[legacyRecord]}
          applyRuns={[legacyRun]}
          applyJobResults={[legacyResult]}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={onGetApplyRunDetails}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={legacyRecord}
        />
      </MemoryRouter>,
    );

    // One application, so the list has no filter chips to count it.
    expect(
      within(screen.getByRole("list", { name: "Applications" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    // Association is proven by the run's own sentence below; the recovery
    // section no longer repeats a saved-run count above its one action.
    expect(screen.queryByText(/runs? saved/i)).toBeNull();
    expect(
      screen.getByText("Legacy attempt prepared every required answer."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onGetApplyRunDetails).toHaveBeenCalledTimes(1);
    });
    expect(onGetApplyRunDetails).toHaveBeenCalledWith({
      runId: "apply_run_legacy",
      jobId: "job_legacy",
      applicationRecordId: "application_legacy_lineage",
    });
    expect(
      screen.queryByText(/Unassigned legacy preparation history/i),
    ).toBeNull();
  });

  it("keeps legacy null-lineage history unassigned when two records share the job", () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();

    const firstRecord = ApplicationRecordSchema.parse({
      id: "application_shared_first",
      jobId: "job_shared",
      title: "Shared Job Engineer",
      company: "Ambiguous Co",
      status: "submitted",
      lastActionLabel: "Prepared",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-20T10:00:00.000Z",
      lastAttemptState: "submitted",
    });
    const secondRecord = ApplicationRecordSchema.parse({
      ...firstRecord,
      id: "application_shared_second",
      lastUpdatedAt: "2026-08-21T10:00:00.000Z",
    });
    const sharedRun: ApplyRunSummary = {
      id: "apply_run_shared",
      campaignId: "campaign_active",
      mode: "copilot",
      state: "completed",
      jobIds: ["job_shared"],
      currentJobId: null,
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: "2026-08-20T09:55:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:00.000Z",
      summary: "Shared run",
      detail: "Legacy result cannot be attributed to one record.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 1,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    };
    const sharedResult: ApplyJobResultSummary = {
      id: "apply_result_shared",
      runId: sharedRun.id,
      jobId: "job_shared",
      applicationRecordId: null,
      queuePosition: 0,
      state: "submitted",
      summary: "Prepared and submitted the application form.",
      detail: "Ownership is ambiguous between two records.",
      startedAt: "2026-08-20T09:56:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:00.000Z",
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
    };

    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[firstRecord, secondRecord]}
          applyRuns={[sharedRun]}
          applyJobResults={[sharedResult]}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={vi.fn()}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={firstRecord}
        />
      </MemoryRouter>,
    );

    expect(
      within(screen.getByRole("list", { name: "Applications" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);
    expect(screen.queryByText(/runs? saved/i)).toBeNull();
    expect(screen.queryByTitle("apply_run_shared")).toBeNull();
    expect(
      screen.getByText(/Unassigned legacy preparation history/i),
    ).toBeTruthy();
  });

  it("renders persisted apply visual evidence in the review panel", async () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const visualEvidence = createVisualEvidence();
    const selectedRecord: ApplicationRecord = {
      id: "application_visual",
      jobId: "job_visual",
      title: "Senior Platform Engineer",
      company: "Visual Systems",
      status: "ready_for_review",
      lastActionLabel: "Apply copilot paused before final submit",
      nextActionLabel:
        "Review the prepared application and submit manually when ready",
      lastUpdatedAt: "2026-03-20T10:05:00.000Z",
      lastAttemptState: "paused",
      questionSummary: {
        total: 1,
        required: 1,
        answered: 1,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: {
        status: "approved",
        pendingCount: 0,
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: "https://jobs.example.com/apply",
        checkpointCount: 1,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };
    const applyRun: ApplyRunSummary = {
      id: "apply_run_visual",
      campaignId: null,
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: ["job_visual"],
      currentJobId: "job_visual",
      submitApprovalId: null,
      visualCheckpointsEnabled: true,
      createdAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:05:00.000Z",
      completedAt: null,
      summary: "Apply copilot paused before final submit",
      detail: "Safe non-submitting apply paused for user review.",
      totalJobs: 1,
      pendingJobs: 1,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    };
    const applyResult: ApplyJobResultSummary = {
      id: "apply_result_visual",
      runId: applyRun.id,
      jobId: "job_visual",
      applicationRecordId: selectedRecord.id,
      queuePosition: 0,
      state: "awaiting_review",
      summary: "Apply copilot paused before final submit",
      detail: "Safe non-submitting apply paused for user review.",
      startedAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:05:00.000Z",
      completedAt: null,
      blockerReason: null,
      blockerSummary: null,
      listingSignalEvidence: null,
      visualObservationSets: [],
      visualCheckpoints: [
        {
          id: "apply_visual_checkpoint_1",
          label: "Apply page visual checkpoint",
          purpose: "apply_checkpoint",
          snapshotId: visualEvidence.snapshotId,
          observationSetId: visualEvidence.observationSetId,
          summary: visualEvidence.summary,
          capturedAt: visualEvidence.capturedAt,
          retained: false,
          storagePath: null,
          blockers: [],
          fieldControls: ["Resume upload control is visible."],
          validationErrors: [],
          buttonStates: ["Final submit button appears disabled."],
          questionContextIds: [],
          reconciliations: [],
        },
      ],
      latestQuestionCount: 1,
      latestAnswerCount: 1,
      pendingConsentRequestCount: 0,
      artifactCount: 1,
      latestCheckpointId: "apply_checkpoint_visual",
      privacyReceipt: null,
      reviewCard: null,
    };
    const onGetApplyRunDetails = vi.fn(
      (): Promise<ApplyRunDetails> =>
        Promise.resolve({
          run: applyRun,
          result: applyResult,
          results: [applyResult],
          submitApproval: null,
          questionRecords: [
            {
              id: "apply_question_visual",
              runId: applyRun.id,
              jobId: "job_visual",
              applicationRecordId: selectedRecord.id,
              resultId: applyResult.id,
              prompt: "Upload resume",
              kind: "resume",
              answerControlType: "file",
              isRequired: true,
              detectedAt: "2026-03-20T10:04:10.000Z",
              answerOptions: [],
              suggestedAnswers: [],
              selectedAnswerId: null,
              submittedAnswer: "/tmp/resume.pdf",
              status: "submitted",
              pageUrl: "https://jobs.example.com/apply",
              visualContext: visualEvidence,
            },
          ],
          answerRecords: [],
          artifactRefs: [
            {
              id: "apply_artifact_visual",
              runId: applyRun.id,
              jobId: "job_visual",
              applicationRecordId: selectedRecord.id,
              resultId: applyResult.id,
              questionId: null,
              kind: "checkpoint",
              label: "Prepared application for final review",
              createdAt: "2026-03-20T10:04:30.000Z",
              storagePath: null,
              url: "https://jobs.example.com/apply",
              textSnippet: "Stopped before final submit.",
              visualEvidence,
            },
          ],
          checkpoints: [
            {
              id: "apply_checkpoint_visual",
              runId: applyRun.id,
              jobId: "job_visual",
              applicationRecordId: selectedRecord.id,
              resultId: applyResult.id,
              createdAt: "2026-03-20T10:04:30.000Z",
              label: "Prepared application for final review",
              detail: "Stopped before final submit.",
              url: "https://jobs.example.com/apply",
              jobState: "awaiting_review",
              artifactRefIds: ["apply_artifact_visual"],
              visualEvidence: [visualEvidence],
              visualReconciliations: [],
            },
          ],
          consentRequests: [],
          reviewCard: null,
        }),
    );

    render(
      <MemoryRouter>
        <ApplicationsScreen
          applicationAttempts={[]}
          applicationRecords={[selectedRecord]}
          applyRuns={[applyRun]}
          applyJobResults={[applyResult]}
          discoveryJobs={[]}
          isApplyPending={false}
          isApplyRequestPending={() => false}
          isApplyRunPending={() => false}
          onApproveApplyRun={vi.fn()}
          onCancelApplyRun={vi.fn()}
          onGetApplyRunDetails={onGetApplyRunDetails}
          onExportApplicationPacket={vi.fn()}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onClearApplicationAnswer={vi.fn(() =>
            Promise.reject(new Error("unused in this scenario")),
          )}
          onRevokeApplyRunApproval={vi.fn()}
          onSelectRecord={vi.fn()}
          onStartApplyCopilot={vi.fn()}
          onStartAutoApplyQueue={vi.fn()}
          selectedApplyRunId={null}
          selectedAttempt={null}
          selectedRecord={selectedRecord}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Screenshots of the form")).toBeTruthy();
    });
    expect(
      screen.getAllByText(
        /Visible resume upload and disabled final submit button/i,
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Resume upload control is visible/i)).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /prepare interview/i }),
    ).toBeNull();
  });

  it("shows persisted preparation stage timings for the selected attempt", () => {
    const selectedAttempt: ApplicationAttempt = {
      id: "attempt_timing",
      jobId: "job_timing",
      applicationRecordId: "application_timing",
      state: "paused",
      summary: "Application paused safely",
      detail: "Manual review is required.",
      startedAt: "2026-07-30T06:56:00.000Z",
      updatedAt: "2026-07-30T06:56:08.000Z",
      completedAt: "2026-07-30T06:56:08.000Z",
      outcome: null,
      checkpoints: [],
      questions: [],
      blocker: null,
      listingSignalEvidence: null,
      consentDecisions: [],
      replay: {
        sourceInstructionArtifactId: null,
        sourceDebugEvidenceRefIds: [],
        lastUrl: "https://jobs.example.com/apply",
        checkpointUrls: ["https://jobs.example.com/apply"],
      },
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
      nextActionLabel: "Review the conflicting fields manually",
      executionTimings: [
        {
          stage: "browser_preparation",
          startedAt: "2026-07-30T06:56:00.000Z",
          completedAt: "2026-07-30T06:56:02.000Z",
          durationMs: 2_000,
        },
        {
          stage: "form_preparation",
          startedAt: "2026-07-30T06:56:02.000Z",
          completedAt: "2026-07-30T06:56:08.000Z",
          durationMs: 6_000,
        },
        {
          stage: "total",
          startedAt: "2026-07-30T06:56:00.000Z",
          completedAt: "2026-07-30T06:56:08.000Z",
          durationMs: 8_000,
        },
      ],
    };

    render(
      <ApplicationsDetailPanelAttemptSection
        selectedAttempt={selectedAttempt}
      />,
    );

    expect(screen.getByText("Preparation timing")).toBeTruthy();
    expect(screen.getByText("Browser setup: 2s")).toBeTruthy();
    expect(screen.getByText("Form preparation: 6s")).toBeTruthy();
    expect(screen.getByText("Total: 8s")).toBeTruthy();
  });


  it("hides CRM tracking controls while search hides the selected application and restores them when the search clears", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const acme = createTrackedApplication({
      id: "application_acme",
      jobId: "job_acme",
      title: "Frontend Engineer",
      company: "Acme",
    });
    const beta = createTrackedApplication({});
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [acme, beta],
            onSelectRecord,
            selectedRecord: beta,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(await screen.findByRole("combobox", { name: "Stage" })).toBeTruthy();
    expect(screen.getByText("Backend Engineer · Beta")).toBeTruthy();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      { target: { value: "nothing-matches-this-search" } },
    );
    expect(
      await screen.findByText("No application selected in this view"),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Export this application (CSV)" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Export this application (JSON)" }),
    ).toBeNull();
    expect(onSelectRecord).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      { target: { value: "" } },
    );
    expect(await screen.findByRole("combobox", { name: "Stage" })).toBeTruthy();
    expect(screen.getByText("Backend Engineer · Beta")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export this application (CSV)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export this application (JSON)" }),
    ).toBeTruthy();
    expect(onSelectRecord).not.toHaveBeenCalled();
  });

  it("hides CRM tracking controls when the lifecycle view has zero matches and restores them via Show all applications", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const tracked = createTrackedApplication({});
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            onSelectRecord,
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(await screen.findByRole("combobox", { name: "Stage" })).toBeTruthy();

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Show" }));
    fireEvent.click(screen.getByRole("option", { name: "Offers" }));
    expect(
      await screen.findByText("No application selected in this view"),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Export this application (CSV)" }),
    ).toBeNull();
    expect(onSelectRecord).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Show all applications" }),
    );
    expect(await screen.findByRole("combobox", { name: "Stage" })).toBeTruthy();
    expect(screen.getByText("Backend Engineer · Beta")).toBeTruthy();
    expect(onSelectRecord).not.toHaveBeenCalled();
  });

  it("keeps CRM tracking controls for a matching selection that sits on another pagination page", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const records = Array.from({ length: 120 }, (_, index) =>
      createTrackedApplication({
        id: `application_${index}`,
        jobId: `job_${index}`,
        title: `Backend Engineer ${index}`,
      }),
    );
    const selected = records[110]!;
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: records,
            onSelectRecord,
            selectedRecord: selected,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(await screen.findByRole("combobox", { name: "Stage" })).toBeTruthy();
    expect(screen.getByText("Backend Engineer 110 · Beta")).toBeTruthy();
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();

    expect(screen.getByRole("combobox", { name: "Stage" })).toBeTruthy();
    expect(screen.getByText("Backend Engineer 110 · Beta")).toBeTruthy();
    expect(screen.getByText("1–50 of 120")).toBeTruthy();
    expect(onSelectRecord).not.toHaveBeenCalled();
  });

  it("keeps the stage tracker off the primary Applications surface", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const tracked = createTrackedApplication({});
    const onWorkspaceViewChange = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          onWorkspaceViewChange={onWorkspaceViewChange}
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            onSelectRecord: vi.fn(),
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    // One list, one state per application: no peer Preparation/Stages tabs,
    // no view switcher, and no export controls beside a single record.
    for (const name of [
      "Preparation",
      "Stages",
      "Table",
      "Kanban",
      "Calendar",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "Export this application (CSV)" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Export this application (JSON)" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Saved views" })).toBeNull();

    // The tracker is a named destination reached explicitly, and the route
    // owns the mode so it keeps a link.
    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(onWorkspaceViewChange).toHaveBeenCalledWith("crm");
    expect(screen.getByRole("heading", { name: "Tracker" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Back to Applications" }),
    ).toBeTruthy();
  });

  it("shows a truthful zero-record right pane in the Stages view without claiming a filtered selection", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          workspaceView="crm"
          {...buildCrmScreenProps({
            applicationRecords: [],
            onSelectRecord,
            selectedRecord: null,
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("No applications to track yet")).toBeTruthy();
    expect(
      screen.queryByText("No application selected in this view"),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();
    expect(onSelectRecord).not.toHaveBeenCalled();
  });

  it("offers no filter recovery advice when tracking tools are unavailable", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const tracked = createTrackedApplication({});

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            includeTrackerControls: false,
            onSelectRecord: vi.fn(),
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(screen.getByText("Tracking tools unavailable")).toBeTruthy();
    expect(
      screen.queryByText(/Show all applications will bring it back/),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();
  });

  it("restores the CRM editor synchronously across Preparation and Stages switches", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const tracked = createTrackedApplication({});
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            onSelectRecord,
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to Applications" }),
    );
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeTruthy();
    expect(screen.getByText("Backend Engineer · Beta")).toBeTruthy();
    expect(onSelectRecord).not.toHaveBeenCalled();
  });

  it("marks exactly the two bounded preparation panes and keeps the workspace wrapper unmarked", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const tracked = createTrackedApplication({});

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            onSelectRecord: vi.fn(),
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    // Preparation mode: the records list and the detail panel own scrolling;
    // the workspace grid itself never becomes a scroll region owner.
    const regions = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-locked-pane-scroll-region]",
      ),
    );
    expect(regions).toHaveLength(2);
    expect(
      document
        .getElementById("applications-workspace-content")
        ?.hasAttribute("data-locked-pane-scroll-region"),
    ).toBe(false);
    expect(
      screen
        .getByRole("list", { name: "Applications" })
        .hasAttribute("data-locked-pane-scroll-region"),
    ).toBe(true);
    for (const region of regions) {
      expect(
        region.querySelectorAll("[data-locked-pane-scroll-region]"),
      ).toHaveLength(0);
    }

    // The list fills its column, the same frame as Find jobs and Shortlisted.
    const listPanel = screen
      .getByRole("list", { name: "Applications" })
      .closest("section");
    expect(listPanel?.className).toContain("xl:h-full");
    expect(listPanel?.className).not.toContain("xl:sticky");
  });

  it("reveals the stacked detail panel after selecting an application at compact width", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    const tracked = createTrackedApplication({});
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            onSelectRecord,
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    const detail = document.getElementById("applications-detail-content");
    expect(detail).toBeTruthy();
    const scrollIntoView = vi.fn();
    Object.defineProperty(detail, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View details for Backend Engineer at Beta",
      }),
    );

    expect(onSelectRecord).toHaveBeenCalledWith(tracked.id);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("marks the tracker table scroller plus the CRM detail wrapper in Stages mode without nesting markers", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const tracked = createTrackedApplication({});

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [tracked],
            onSelectRecord: vi.fn(),
            selectedRecord: tracked,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(await screen.findByRole("combobox", { name: "Stage" })).toBeTruthy();

    // Stages mode: the leaf table body and the screen-level CRM detail
    // wrapper are the only bounded scroll owners.
    const regions = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-locked-pane-scroll-region]",
      ),
    );
    expect(regions).toHaveLength(2);
    expect(
      document
        .getElementById("applications-workspace-content")
        ?.hasAttribute("data-locked-pane-scroll-region"),
    ).toBe(false);
    expect(
      document
        .getElementById("application-tracker-heading")
        ?.closest("section")
        ?.hasAttribute("data-locked-pane-scroll-region"),
    ).toBe(false);

    const tableView = screen.getByRole("table", {
      name: "Application tracker",
    });
    const stageSelect = screen.getByRole("combobox", { name: "Stage" });
    const tableRegion = regions.find((region) => region.contains(tableView));
    const detailRegion = regions.find((region) => region.contains(stageSelect));
    expect(tableRegion).toBeTruthy();
    expect(detailRegion).toBeTruthy();
    expect(tableRegion).not.toBe(detailRegion);
    for (const region of regions) {
      expect(
        region.querySelectorAll("[data-locked-pane-scroll-region]"),
      ).toHaveLength(0);
    }

    // Search states that cannot overflow keep both sides unmarked, then the
    // owners return when the full view is restored.
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      { target: { value: "nothing-matches-this-search" } },
    );
    expect(
      await screen.findByText("No application selected in this view"),
    ).toBeTruthy();
    expect(
      document.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(0);

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      { target: { value: "" } },
    );
    expect(
      await screen.findByRole("table", { name: "Application tracker" }),
    ).toBeTruthy();
    expect(
      document.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(2);
  });

  it("preserves a selected application hidden by the Preparation filter", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const submitted = createTrackedApplication({
      id: "application_submitted",
      jobId: "job_submitted",
      status: "submitted",
      personSendReceipt: {
        observedAt: "2026-08-15T10:00:00.000Z",
        origin: "https://example.test",
        safePath: "/confirmation",
        summary: "The site confirmed receipt of the application.",
      },
      title: "Staff Engineer",
    });
    const selected = createTrackedApplication({
      id: "application_selected",
      jobId: "job_selected",
      status: "drafting",
      title: "Product Manager",
    });
    const onSelectRecord = vi.fn();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [submitted, selected],
            onSelectRecord,
            selectedRecord: selected,
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Submitted/ }));
    expect(onSelectRecord).not.toHaveBeenCalled();
    expect(
      screen.getByText("Selected application not shown by this filter"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(onSelectRecord).not.toHaveBeenCalled();
    expect(screen.getAllByText("Product Manager").length).toBeGreaterThan(0);
  });

  it("renders a route-owned refusal as a visible accessible status", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();

    render(
      <MemoryRouter>
        <ApplicationsScreen
          actionMessage="The requested Job Finder action failed."
          {...buildCrmScreenProps({
            applicationRecords: [],
            onSelectRecord: vi.fn(),
            selectedRecord: null,
          })}
        />
      </MemoryRouter>,
    );

    const status = screen.getByTestId("applications-route-action-status");
    // Refusals and errors arrive through the same route-scoped channel as
    // successes; the surface stays a polite status region either way.
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("The requested Job Finder action failed.");

    cleanup();
    render(
      <MemoryRouter>
        <ApplicationsScreen
          actionMessage="No jobs selected for auto-apply queue."
          {...buildCrmScreenProps({
            applicationRecords: [],
            onSelectRecord: vi.fn(),
            selectedRecord: null,
          })}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("applications-route-action-status").textContent,
    ).toBe("No jobs selected for auto-apply queue.");
  });
  it("shows a rejected submit's exact message, correction action and one Not sent badge", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const record = createTrackedApplication({
      id: "application_rejected",
      jobId: "job_rejected",
      status: "ready_for_review",
      lastAttemptState: "ready",
      automationMode: "confirm_before_submit",
      crm: undefined,
    });
    const result = ApplyJobResultSchema.parse({
      id: "result_rejected",
      runId: "run_rejected",
      jobId: record.jobId,
      applicationRecordId: record.id,
      state: "awaiting_review",
      startedAt: record.lastUpdatedAt,
      updatedAt: record.lastUpdatedAt,
      summary: "Application prepared",
      detail: "Ready for you to read over and send",
      privacyReceipt: null,
    });
    result.privacyReceipt = ApplicationPrivacyReceiptSchema.parse({
      generatedAt: record.lastUpdatedAt,
      lineage: {
        runId: result.runId,
        jobId: record.jobId,
        resultId: result.id,
        applicationRecordId: record.id,
      },
      destination: { origin: "http://127.0.0.1:47950", safePath: "/apply" },
      resume: {
        source: "original_upload",
        sourceDocumentId: "synthetic",
        exportArtifactId: null,
        fileName: "synthetic.pdf",
        sha256: "a".repeat(64),
      },
      finalSubmitOccurred: false,
      submissionOutcome: {
        id: "outcome",
        preflightId: "preflight",
        idempotencyKey: "send",
        authorityEnvelopeId: "authority",
        authorityRevision: 1,
        runId: result.runId,
        jobId: record.jobId,
        resultId: result.id,
        applicationRecordId: record.id,
        outcome: "not_submitted",
        attemptedAt: record.lastUpdatedAt,
        verifiedAt: record.lastUpdatedAt,
        evidence: [],
        retry: { eligible: true, blockReason: null },
        browserAction: {
          reason: "form_validation_failed",
          detail: "Select at least one skill.",
        },
      },
    });
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [record],
            onSelectRecord: vi.fn(),
            selectedRecord: record,
            includeTrackerControls: false,
          })}
          applyJobResults={[result]}
          onGetApplyRunDetails={vi.fn(
            () => new Promise<ApplyRunDetails>(() => {}),
          )}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Select at least one skill.")).toBeTruthy();
    expect(
      screen
        .getAllByText("Not sent")
        .filter((node) => node.getAttribute("data-variant") === "status"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Correct the fields in the browser" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("Ready for you to read over and send"),
    ).toBeNull();
    expect(
      screen.getByText("Ready to send", { selector: "[data-variant=status]" }),
    ).toBeTruthy();
  });

  it("receipt-confirmed Applied rows replace a stale Prepare again next step", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubCandidateAssetsBridge();
    const record = createTrackedApplication({
      nextActionLabel: "Prepare again",
      lastAttemptState: "submitted",
      status: "submitted",
      personSendReceipt: {
        observedAt: "2026-08-15T10:00:00.000Z",
        origin: "https://example.test",
        safePath: "/confirmation",
        summary: "The site confirmed receipt of the application.",
      },
      crm: undefined,
    });
    render(
      <MemoryRouter>
        <ApplicationsScreen
          {...buildCrmScreenProps({
            applicationRecords: [record],
            onSelectRecord: vi.fn(),
            selectedRecord: record,
            includeTrackerControls: false,
          })}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: /Backend Engineer.*Beta/ })
        .textContent,
    ).toContain("View application");
    expect(
      screen.getByRole("button", { name: /Backend Engineer.*Beta/ })
        .textContent,
    ).not.toContain("Prepare again");
  });
});

/**
 * The hand-off outcome is produced by the leaf recovery section and consumed
 * there to decide what the status beside the control claims. Every panel it
 * passes through has to declare the same return type: while these three
 * declared `=> void`, the outcome was still forwarded at runtime but the
 * declared contract said nothing came back, so the only thing stopping a
 * status-less hand-off was that nobody had written a void-returning handler
 * yet. These assertions read the reported outcome back out of each declared
 * prop type; against a `=> void` declaration each one is a type error.
 */
describe("browser hand-off outcome contract", () => {
  type ReportedOutcome<Handler> = Handler extends (
    ...args: never[]
  ) => infer Result
    ? Result
    : never;

  it("keeps the reported outcome in the declared type at every pass-through hop", () => {
    const screenOutcome: ReportedOutcome<
      NonNullable<
        ComponentProps<typeof ApplicationsScreen>["onFinishInBrowser"]
      >
    > = { kind: "opened_application_page" };
    const detailPanelOutcome: ReportedOutcome<
      NonNullable<
        ComponentProps<typeof ApplicationsDetailPanel>["onFinishInBrowser"]
      >
    > = { kind: "opened_browser_only" };
    const recoverySectionsOutcome: ReportedOutcome<
      NonNullable<
        ComponentProps<
          typeof ApplicationsDetailPanelRecoverySections
        >["onFinishInBrowser"]
      >
    > = { kind: "failed", reason: "The browser runtime is disabled" };

    expect(screenOutcome).toEqual({ kind: "opened_application_page" });
    expect(detailPanelOutcome).toEqual({ kind: "opened_browser_only" });
    expect(recoverySectionsOutcome).toEqual({
      kind: "failed",
      reason: "The browser runtime is disabled",
    });
  });
});
