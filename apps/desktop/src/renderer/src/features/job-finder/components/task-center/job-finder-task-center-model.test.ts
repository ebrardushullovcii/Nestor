import type {
  ApplyRunSummary,
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportRun,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  buildJobFinderTaskCenterModel,
  describeTaskCenterCounts,
} from "./job-finder-task-center-model";

function createWorkspace(
  overrides: Partial<JobFinderRendererWorkspaceSnapshot> = {},
): JobFinderRendererWorkspaceSnapshot {
  return {
    applicationRecords: [],
    applyRuns: [],
    discoveryJobs: [],
    latestResumeImportRun: null,
    searchPreferences: {
      discovery: {
        targets: [
          { id: "source_a", label: "Mercury careers" },
          { id: "source_b", label: "Aircall careers" },
        ],
      },
    },
    ...overrides,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createApplyRun(
  overrides: Partial<ApplyRunSummary> = {},
): ApplyRunSummary {
  return {
    id: "apply_current",
    mode: "copilot",
    state: "running",
    jobIds: ["job_1"],
    currentJobId: "job_1",
    createdAt: "2026-07-31T10:00:00.000Z",
    updatedAt: "2026-07-31T10:00:05.000Z",
    completedAt: null,
    totalJobs: 1,
    pendingJobs: 1,
    blockedJobs: 0,
    failedJobs: 0,
    ...overrides,
  } as ApplyRunSummary;
}

function findTask(
  model: ReturnType<typeof buildJobFinderTaskCenterModel>,
  kind:
    | "discovery"
    | "source_check"
    | "resume_import"
    | "apply"
    | "safeguards"
    | "tailored_drafts",
) {
  const task = model.items.find((item) => item.kind === kind);
  expect(task).toBeDefined();
  return task!;
}

describe("buildJobFinderTaskCenterModel", () => {
  test("a queue parked between jobs stays visible without a running badge", () => {
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        activityControl: {
          paused: true,
          pausedAt: "2026-07-31T10:01:00.000Z",
          reason: "Paused by you.",
          pauseBehavior: "finish_current",
        },
        applyRuns: [
          createApplyRun({
            mode: "queue_auto",
            jobIds: ["job_1", "job_2"],
            totalJobs: 2,
            pendingJobs: 1,
          }),
        ],
        applyJobResults: [
          {
            id: "result_1",
            runId: "apply_current",
            jobId: "job_1",
            state: "awaiting_review",
          },
          {
            id: "result_2",
            runId: "apply_current",
            jobId: "job_2",
            state: "planned",
            applicationPreparationStartedAt: null,
            applicationPreparationStartedLocalDate: null,
          },
        ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "apply");
    expect(task.status).toBe("paused");
    expect(task.stageLabel).toBe("Paused before the next application");
    expect(task.canCancel).toBe(true);
    expect(model.activeCount).toBe(0);
  });

  test("names the job being filled after a resume, not the one finished before the pause", () => {
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        activityControl: { paused: false, pausedAt: null, reason: null },
        discoveryJobs: [
          { id: "job_1", company: "Dusk", title: "Frontend" },
          { id: "job_2", company: "Cedar", title: "Frontend" },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["discoveryJobs"],
        applyRuns: [
          createApplyRun({
            mode: "queue_auto",
            jobIds: ["job_1", "job_2"],
            currentJobId: "job_1",
            totalJobs: 2,
            pendingJobs: 1,
          }),
        ],
        applyJobResults: [
          {
            id: "result_1",
            runId: "apply_current",
            jobId: "job_1",
            state: "awaiting_review",
          },
          {
            id: "result_2",
            runId: "apply_current",
            jobId: "job_2",
            state: "filling",
          },
        ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    expect(findTask(model, "apply").sourceLabel).toBe("Cedar · Frontend");
  });

  test("keeps a persisted running import active after navigation clears the local pending flag", () => {
    const run = {
      id: "resume_stale",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "candidate.pdf",
      status: "extracting",
      startedAt: "2026-07-31T09:00:00.000Z",
      completedAt: null,
      candidateCounts: {
        total: 0,
        autoApplied: 0,
        needsReview: 0,
        rejected: 0,
      },
    } as unknown as ResumeImportRun;

    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({ latestResumeImportRun: run }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "resume_import");

    expect(task.status).toBe("active");
    expect(task.stageLabel).toBe("Building profile suggestions");
    expect(task.canCancel).toBe(false);
    expect(task.resumeRoute).toBeNull();
    expect(task.historyEstimateLabel).toBeNull();
  });

  test("shows a resume estimate only from the previous completed import while a new import is active", () => {
    const priorRun = {
      id: "resume_prior",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "prior.pdf",
      status: "review_ready",
      startedAt: "2026-07-30T09:00:00.000Z",
      completedAt: "2026-07-30T09:00:30.000Z",
      timing: { totalMs: 30_000 },
      candidateCounts: {
        total: 12,
        autoApplied: 8,
        needsReview: 4,
        rejected: 0,
      },
    } as unknown as ResumeImportRun;

    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({ latestResumeImportRun: priorRun }),
        isResumeImportPending: true,
        resumeImportProgress: {
          stage: "building_profile",
          message: "Building suggestions",
          occurredAt: "2026-07-31T10:00:04.000Z",
        },
      }),
      "resume_import",
    );

    expect(task.status).toBe("active");
    expect(task.stageLabel).toBe("Building profile suggestions");
    expect(task.countLabel).toBe("Counts available after extraction");
    expect(task.historyEstimateLabel).toBe(
      "about 30s from 1 previous completed import",
    );
  });

  test("keeps a paused apply run cancellable but routes resumption through existing review", () => {
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [
          createApplyRun({
            state: "paused_for_consent",
            totalJobs: 3,
            pendingJobs: 2,
            blockedJobs: 1,
          }),
        ],
      }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "apply");
    expect(model.activeCount).toBe(0);

    expect(task.status).toBe("paused");
    expect(task.stageLabel).toBe("Waiting for your consent");
    expect(task.countLabel).toBe(
      "0 applications · 1 of 3 application tasks finished · 1 blocked · Waiting on you",
    );
    expect(task.canCancel).toBe(true);
    // A consent pause holds a real decision, and settling it lets the run
    // carry on, so the action goes where that decision lives.
    expect(task.resumeRoute).toBe("/job-finder/actions");
    expect(task.resumeActionLabel).toBe("Resolve what needs you");
    expect(task.historyEstimateLabel).toBeNull();
  });

  test("offers the same recovery action after a failed batch left blocked jobs", () => {
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [
          createApplyRun({
            state: "failed",
            jobIds: ["job_1", "job_2"],
            totalJobs: 2,
            pendingJobs: 0,
            blockedJobs: 1,
          }),
        ],
        applyJobResults: [
          {
            id: "result_blocked",
            runId: "apply_current",
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "blocked",
            blockerReason: "required_human_input",
            updatedAt: "2026-07-31T10:00:06.000Z",
          },
          {
            id: "result_done",
            runId: "apply_current",
            jobId: "job_2",
            applicationRecordId: "application_2",
            state: "prepared",
            updatedAt: "2026-07-31T10:00:07.000Z",
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "apply");

    expect(task.status).toBe("failed");
    expect(task.resumeActionLabel).toBe("Prepare remaining jobs");
    expect(task.resumeRoute).toBe("/job-finder/applications");
    expect(task.applyRecoveryJobIds).toEqual(["job_1"]);
  });

  test("keeps Open Applications when a finished batch left nothing to prepare", () => {
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [
          createApplyRun({
            state: "failed",
            jobIds: ["job_1"],
            totalJobs: 1,
            pendingJobs: 0,
          }),
        ],
        applyJobResults: [
          {
            id: "result_done",
            runId: "apply_current",
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "prepared",
            updatedAt: "2026-07-31T10:00:07.000Z",
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "apply");

    expect(task.resumeActionLabel).toBe("Open Applications");
    expect(task.applyRecoveryJobIds).toBeUndefined();
  });

  test("an old paused run whose only job was sent reads finished, not a pause or a final review", () => {
    const run = createApplyRun({
      state: "paused_for_user_review",
      totalJobs: 1,
      pendingJobs: 1,
      summary: "The site wants you signed in first.",
    });
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [run],
        applyJobResults: [
          {
            id: "result_sent",
            runId: run.id,
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "submitted",
            updatedAt: "2026-07-31T10:00:06.000Z",
          },
        ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "apply");
    expect(task.status).toBe("completed");
    expect(task.stageLabel).toBe("Applied");
    expect(task.canCancel).toBe(false);
    expect(task.reviewActionLabel).toBeUndefined();
    expect(model.items.some((item) => item.kind === "safeguards")).toBe(false);
  });

  test("an old paused run whose job was tried again in a newer attempt is finished", () => {
    const run = createApplyRun({
      state: "paused_for_user_review",
      totalJobs: 1,
      pendingJobs: 1,
    });
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [run],
        applyJobResults: [
          {
            id: "result_old",
            runId: run.id,
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "awaiting_review",
            blockerReason: "auth_required",
            updatedAt: "2026-07-31T10:00:06.000Z",
          },
          {
            id: "result_new",
            runId: "apply_other",
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "failed",
            updatedAt: "2026-07-31T10:30:00.000Z",
          },
        ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    expect(findTask(model, "apply").stageLabel).toBe("Finished");
    expect(model.pausedCount).toBe(0);
  });

  test("an outcome to verify does not hide a batch running meanwhile", () => {
    const running = createApplyRun({
      id: "apply_running",
      mode: "queue_auto",
      state: "running",
      jobIds: ["job_2", "job_3"],
      totalJobs: 2,
      pendingJobs: 2,
      updatedAt: "2026-07-31T10:10:00.000Z",
    });
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [running],
        applyJobResults: [
          {
            id: "result_uncertain",
            runId: "apply_old",
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "submitted",
            updatedAt: "2026-07-31T10:00:06.000Z",
            privacyReceipt: {
              submissionOutcome: { outcome: "outcome_uncertain" },
            },
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    const applyItems = model.items.filter((item) => item.kind === "apply");
    expect(applyItems.map((item) => item.title)).toEqual([
      "Manual verification required",
      "Applications",
    ]);
    expect(applyItems[1]?.status).toBe("active");
    expect(applyItems[1]?.canCancel).toBe(true);
    expect(model.activeCount).toBe(1);
  });

  test("clears the paused task after the last application handoff is cancelled", () => {
    const run = createApplyRun({
      state: "paused_for_user_review",
      totalJobs: 1,
      pendingJobs: 1,
    });
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [run],
        applyJobResults: [
          {
            id: "result_cancelled_handoff",
            runId: run.id,
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "awaiting_review",
            updatedAt: "2026-07-31T10:00:06.000Z",
          },
        ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
        applicationRecords: [
          {
            id: "application_1",
            jobId: "job_1",
            lastAttemptState: "unsupported",
          },
        ] as JobFinderRendererWorkspaceSnapshot["applicationRecords"],
        userActionRequests: [
          {
            id: "handoff_1",
            state: "cancelled",
            scope: { type: "application", runId: run.id },
          },
        ] as JobFinderRendererWorkspaceSnapshot["userActionRequests"],
      }),
      isResumeImportPending: false,
    });

    // The run is history now: no pause, no chip, nothing on Safeguards.
    expect(
      model.items.some(
        (item) => item.kind === "apply" && item.status === "paused",
      ),
    ).toBe(false);
    expect(model.items.some((item) => item.kind === "safeguards")).toBe(false);
    expect(model.pausedCount).toBe(0);
  });

  test("shows completed preparation after sign-in instead of a safety pause", () => {
    const run = createApplyRun({
      state: "paused_for_user_review",
      totalJobs: 1,
      pendingJobs: 1,
    });
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({
          applyRuns: [run],
          applyJobResults: [
            {
              id: "result_ready_after_login",
              runId: run.id,
              jobId: run.jobIds[0] ?? "job_1",
              applicationRecordId: "application_1",
              queuePosition: 0,
              state: "awaiting_review",
              summary: "Ready for review",
              detail: "The form is filled in; nothing was sent.",
              startedAt: "2026-07-31T10:00:00.000Z",
              completedAt: null,
              applicationPreparationStartedAt: "2026-07-31T10:00:00.000Z",
              applicationPreparationStartedLocalDate: "2026-07-31",
              blockerReason: null,
              blockerSummary: null,
              listingSignalEvidence: null,

              latestQuestionCount: 0,
              latestAnswerCount: 0,
              pendingConsentRequestCount: 0,
              artifactCount: 0,
              latestCheckpointId: null,
              privacyReceipt: null,
              reviewCard: {
                siteLabel: "Replica board",
                pageUrl: "http://127.0.0.1:47950/employer-a/apply/1",
                answers: [],
                attachments: [],
                letter: null,
                waitingOnYou: [],
                preparedAt: "2026-07-31T10:00:06.000Z",
              },
              updatedAt: "2026-07-31T10:00:06.000Z",
            },
          ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
        }),
        isResumeImportPending: false,
      }),
      "apply",
    );
    expect(task.stageLabel).toBe("Ready for final review");
    expect(task.countLabel).toContain("1 of 1 application tasks finished");
    expect(task.countLabel).not.toContain("will not carry on");
    expect(task.resumeActionLabel).toBe("Open Applications");
    expect(task.reviewRoute).toBeUndefined();
  });

  test("routes a paused sign-in handoff to its answer instead of calling it a safety limit", () => {
    const run = createApplyRun({
      state: "paused_for_user_review",
      pendingJobs: 0,
    });
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({
          applyRuns: [run],
          userActionRequests: [
            {
              id: "sign_in_request",
              state: "page_opened",
              scope: { type: "application", runId: run.id },
            },
          ] as JobFinderRendererWorkspaceSnapshot["userActionRequests"],
        }),
        isResumeImportPending: false,
      }),
      "apply",
    );
    expect(task.stageLabel).toBe("Waiting on you");
    expect(task.countLabel).not.toContain("will not carry on");
    expect(task.resumeRoute).toBe("/job-finder/actions");
    expect(task.resumeActionLabel).toBe("Resolve what needs you");
    expect(task.applyRecoveryJobIds).toBeUndefined();
  });

  test("does not name a job the person took over as the one being applied to", () => {
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({
          applyRuns: [
            createApplyRun({
              state: "running",
              jobIds: ["job_1", "job_2"],
              currentJobId: "job_1",
              totalJobs: 2,
              pendingJobs: 1,
            }),
          ],
          applyJobResults: [
            {
              id: "result_taken_over",
              runId: "apply_current",
              jobId: "job_1",
              state: "failed",
              summary: "You took over this application.",
              startedAt: "2026-07-31T10:00:00.000Z",
              updatedAt: "2026-07-31T10:05:00.000Z",
            },
            {
              id: "result_next",
              runId: "apply_current",
              jobId: "job_2",
              state: "planned",
              startedAt: "2026-07-31T10:00:00.000Z",
              updatedAt: "2026-07-31T10:00:00.000Z",
            },
          ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
          discoveryJobs: [
            { id: "job_1", title: "Backend Engineer", company: "Willow" },
            { id: "job_2", title: "Data Engineer", company: "Meadow" },
          ] as unknown as JobFinderRendererWorkspaceSnapshot["discoveryJobs"],
        }),
        isResumeImportPending: false,
      }),
      "apply",
    );
    expect(task.sourceLabel).toBe("Meadow · Data Engineer");
  });

  test("does not count a job a later run took up again", () => {
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({
          applyRuns: [
            createApplyRun({
              state: "completed",
              jobIds: ["job_1", "job_2"],
              totalJobs: 2,
              pendingJobs: 0,
              failedJobs: 1,
              submittedJobs: 1,
              updatedAt: "2026-07-31T11:00:00.000Z",
            }),
          ],
          applyJobResults: [
            {
              id: "result_taken_over",
              runId: "apply_current",
              jobId: "job_1",
              state: "failed",
              startedAt: "2026-07-31T10:00:00.000Z",
              updatedAt: "2026-07-31T10:05:00.000Z",
            },
            {
              id: "result_sent",
              runId: "apply_current",
              jobId: "job_2",
              state: "submitted",
              startedAt: "2026-07-31T10:01:00.000Z",
              updatedAt: "2026-07-31T10:06:00.000Z",
            },
            {
              id: "result_carried_on",
              runId: "apply_later",
              jobId: "job_1",
              state: "submitted",
              startedAt: "2026-07-31T10:20:00.000Z",
              updatedAt: "2026-07-31T10:30:00.000Z",
            },
          ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
        }),
        isResumeImportPending: false,
      }),
      "apply",
    );
    expect(task.countLabel).not.toContain("need attention");
    expect(task.stageLabel).not.toBe("Some applications need attention");
    expect(task.resumeActionLabel).not.toBe("Prepare remaining jobs");
  });

  test.each([
    [{ failedJobs: 1 }, "Some applications need attention"],
    [{ blockedJobs: 1 }, "Some applications need attention"],
    [{ submittedJobs: 1 }, "Applied"],
  ] as const)(
    "reports the outcome of completed application tasks %j",
    (counts, stageLabel) => {
      const task = findTask(
        buildJobFinderTaskCenterModel({
          workspace: createWorkspace({
            applyRuns: [
              createApplyRun({ state: "completed", pendingJobs: 0, ...counts }),
            ],
          }),
          isResumeImportPending: false,
        }),
        "apply",
      );
      expect(task.stageLabel).toBe(stageLabel);
      expect(task.stageLabel).not.toBe("Ready for final review");
    },
  );

  test.each([
    ["draft", "active", "Ready to start"],
    ["awaiting_submit_approval", "active", "Waiting for your approval"],
    ["running", "active", "Working through application"],
    ["paused_for_user_review", "paused", "Paused by a safety limit"],
    ["paused_for_consent", "paused", "Waiting for your consent"],
    ["completed", "completed", "Finished"],
    ["cancelled", "cancelled", "Application stopped"],
    ["failed", "failed", "Application needs attention"],
  ] as const)(
    "presents apply state %s as a user goal without changing its technical status",
    (state, status, stageLabel) => {
      const task = findTask(
        buildJobFinderTaskCenterModel({
          workspace: createWorkspace({
            applyRuns: [createApplyRun({ state })],
          }),
          isResumeImportPending: false,
        }),
        "apply",
      );

      expect(task).toMatchObject({
        id: "apply_current",
        title: "Applications",
        status,
        stageLabel,
      });
    },
  );

  test("uses Applications as the queue-mode goal and fallback source without submission claims", () => {
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({
          applyRuns: [
            createApplyRun({
              mode: "queue_auto",
              currentJobId: null,
              jobIds: [],
            }),
          ],
        }),
        isResumeImportPending: false,
      }),
      "apply",
    );
    const presentation = [
      task.title,
      task.stageLabel,
      task.sourceLabel,
      task.countLabel,
      task.historyEstimateLabel,
      task.resumeActionLabel,
    ]
      .filter((label): label is string => label !== null)
      .join(" ");

    expect(task.title).toBe("Applications");
    expect(task.sourceLabel).toBe("Applications");
    expect(presentation).not.toMatch(
      /application queue|application preparation|preparing employer form|preparation completed|\brun\b|submit|submitted|verified/i,
    );
  });

  test("omits ETA for an active task when no compatible completed history exists", () => {
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({ applyRuns: [createApplyRun()] }),
        isResumeImportPending: false,
      }),
      "apply",
    );

    expect(task.status).toBe("active");
    expect(task.historyEstimateLabel).toBeNull();
  });

  test("routes an uncertain outcome to non-cancellable employer-site verification", () => {
    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({
          applyRuns: [
            createApplyRun({
              state: "completed",
              completedAt: "2026-08-28T10:01:00.000Z",
            }),
          ],
          applyJobResults: [
            {
              id: "result_uncertain",
              runId: "apply_current",
              jobId: "job_1",
              updatedAt: "2026-08-28T10:01:00.000Z",
              privacyReceipt: {
                submissionOutcome: { outcome: "outcome_uncertain" },
              },
            } as JobFinderRendererWorkspaceSnapshot["applyJobResults"][number],
          ],
        }),
        isResumeImportPending: false,
      }),
      "apply",
    );

    expect(task).toMatchObject({
      title: "Manual verification required",
      status: "paused",
      stageLabel: "Verify on the employer site",
      canCancel: false,
      cancelKind: null,
      resumeRoute: "/job-finder/applications",
      resumeActionLabel: "Verify outcome",
    });
    expect(task.countLabel).toMatch(/automatic retry is blocked/i);
  });

  test("ignores superseded uncertainty but preserves another record for the same job", () => {
    const result = (
      id: string,
      applicationRecordId: string,
      updatedAt: string,
      outcome: "outcome_uncertain" | "submitted",
    ) =>
      ({
        id,
        applicationRecordId,
        jobId: "shared_job",
        updatedAt,
        privacyReceipt: { submissionOutcome: { outcome } },
      }) as JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
    const superseded = result(
      "old_uncertain",
      "application_one",
      "2026-08-28T10:01:00.000Z",
      "outcome_uncertain",
    );
    const submitted = result(
      "new_submitted",
      "application_one",
      "2026-08-28T10:02:00.000Z",
      "submitted",
    );
    const current = result(
      "current_uncertain",
      "application_two",
      "2026-08-28T10:03:00.000Z",
      "outcome_uncertain",
    );
    const build = (
      results: JobFinderRendererWorkspaceSnapshot["applyJobResults"],
    ) =>
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({ applyJobResults: results }),
        isResumeImportPending: false,
      });

    expect(
      build([superseded, submitted]).items.some(
        (item) => item.kind === "apply",
      ),
    ).toBe(false);
    expect(findTask(build([superseded, submitted, current]), "apply").id).toBe(
      "submission-verification_current_uncertain",
    );
  });
});

describe("describeTaskCenterCounts", () => {
  test("never renders a zero beside a real count", () => {
    expect(describeTaskCenterCounts({ activeCount: 2, pausedCount: 0 })).toBe(
      "2 running",
    );
    // Paused work is the person's queue and Needs you already counts it.
    expect(describeTaskCenterCounts({ activeCount: 0, pausedCount: 3 })).toBe(
      null,
    );
    expect(describeTaskCenterCounts({ activeCount: 2, pausedCount: 3 })).toBe(
      "2 running",
    );
    expect(describeTaskCenterCounts({ activeCount: 0, pausedCount: 0 })).toBe(
      null,
    );
  });
});

test("counts cancellation separately while the other application still needs the person", () => {
  const run = createApplyRun({
    state: "paused_for_user_review",
    totalJobs: 2,
    pendingJobs: 1,
    jobIds: ["job_1", "job_2"],
  });
  const workspace = createWorkspace({
    applyRuns: [run],
    applyJobResults: [
      {
        id: "cancelled_result",
        runId: run.id,
        jobId: "job_1",
        state: "cancelled",
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
      {
        id: "paused_result",
        runId: run.id,
        jobId: "job_2",
        state: "awaiting_review",
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
    userActionRequests: [
      {
        id: "other_step",
        state: "pending",
        scope: { type: "application", runId: run.id, jobId: "job_2" },
      },
    ] as JobFinderRendererWorkspaceSnapshot["userActionRequests"],
  });
  const task = buildJobFinderTaskCenterModel({
    workspace,
    isResumeImportPending: false,
  }).items.find((item) => item.kind === "apply");
  expect(task).toMatchObject({
    status: "paused",
    stageLabel: "Waiting on you",
  });
  expect(task?.countLabel).toContain("1 cancelled");
  expect(task?.countLabel).not.toMatch(/failed|need attention/i);
});

test.each([
  ["submitted", "cancelled", "Finished"],
  ["submitted", "skipped", "Finished"],
  ["skipped", "cancelled", "Finished"],
  ["submitted", "submitted", "Applied"],
  ["cancelled", "cancelled", "Cancelled by you"],
  ["failed", "cancelled", "Some applications need attention"],
  ["blocked", "cancelled", "Some applications need attention"],
  ["awaiting_review", "cancelled", "Ready for final review"],
] as const)(
  "labels a completed %s + %s batch as %s",
  (first, second, label) => {
    const states = [first, second];
    const run = createApplyRun({
      state: "completed",
      jobIds: ["job_1", "job_2"],
      totalJobs: 2,
      pendingJobs: 0,
      submittedJobs: states.filter((state) => state === "submitted").length,
      failedJobs: states.filter((state) => state === "failed").length,
      blockedJobs: states.filter((state) => state === "blocked").length,
    });
    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({
        applyRuns: [run],
        applyJobResults: states.map((state, index) => ({
          id: `result_${index}`,
          runId: run.id,
          jobId: run.jobIds[index],
          applicationRecordId: `application_${index}`,
          state,
          startedAt: "2026-10-01T10:00:00.000Z",
          updatedAt: "2026-10-01T10:01:00.000Z",
        })) as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
      isResumeImportPending: false,
    });
    expect(findTask(model, "apply").stageLabel).toBe(label);
  },
);

test("keeps other running batches visible when the newest batch was cancelled", () => {
  const model = buildJobFinderTaskCenterModel({
    workspace: createWorkspace({
      applyRuns: [
        createApplyRun({
          id: "cancelled",
          state: "cancelled",
          pendingJobs: 0,
          updatedAt: "2026-07-31T11:00:00Z",
        }),
        createApplyRun({ id: "running_a" }),
        createApplyRun({ id: "running_b" }),
      ],
    }),
    isResumeImportPending: false,
  });
  expect(model.activeCount).toBe(2);
  expect(
    model.items
      .filter((item) => item.status === "active")
      .map((item) => item.id),
  ).toEqual(["running_a", "running_b"]);
});
