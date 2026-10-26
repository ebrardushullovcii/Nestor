import {
  ApplicationAttemptBlockerSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
  type ApplyPageSession,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  describeApplicationBlockerReason,
  handApplicationPageToPersonForAccessStep,
  persistApplicationUserAction,
  terminalizeApplicationAfterPreparedPageLost,
} from "./internal/workspace-application-user-action";
import { reconcileReadyRunAfterApplicationResumption } from "./internal/workspace-application-user-action-resumption";
import { reduceUserActionCommand } from "./user-action-domain";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function taskLocalSignInSession(onSubmitted: () => void): ApplyPageSession {
  let signedIn = false;
  const page = (): RawApplyPage => ({
    url: signedIn
      ? "https://fixture.example/application"
      : "https://fixture.example/sign-in",
    title: signedIn ? "Application" : "Sign in",
    bodyText: signedIn ? "Application form" : "Sign in to continue",
    headings: [],
    controls: signedIn
      ? []
      : [
          {
            index: 0,
            tagName: "input",
            inputType: "email",
            role: "textbox",
            id: "email",
            name: "email",
            label: "Email",
            groupLabel: "",
            placeholder: "Email",
            autocomplete: "username",
            required: true,
            invalid: false,
            validationMessage: "",
            disabled: false,
            readOnly: false,
            visible: true,
            value: "",
            checked: false,
            multiple: false,
            options: [],
            selectedOptionLabel: "",
          },
          {
            index: 1,
            tagName: "input",
            inputType: "password",
            role: "textbox",
            id: "password",
            name: "password",
            label: "Password",
            groupLabel: "",
            placeholder: "Password",
            autocomplete: "current-password",
            required: true,
            invalid: false,
            validationMessage: "",
            disabled: false,
            readOnly: false,
            visible: true,
            value: "",
            checked: false,
            multiple: false,
            options: [],
            selectedOptionLabel: "",
          },
        ],
    actions: signedIn
      ? [
          {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
          },
        ]
      : [
          {
            index: 0,
            label: "Sign in",
            visible: true,
            disabled: false,
            formAction: "https://login.example/session",
            formMethod: "POST",
          },
        ],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  });
  return {
    readPage: () => Promise.resolve(page()),
    navigate: (url) => Promise.resolve({ ok: true, url }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "" }),
    pressKey: (_ref, key) => Promise.resolve({ ok: true, observedValue: key }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "" }),
    wait: () => Promise.resolve(),
    goBack: () => Promise.resolve({ ok: true, url: page().url ?? "" }),
    readText: () => Promise.resolve(page().bodyText),
    fillText: () => Promise.resolve({ ok: true, observedValue: "redacted" }),
    chooseOption: () => Promise.resolve({ ok: true, observedValue: "" }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "" }),
    uploadFile: () => Promise.resolve({ ok: true, observedValue: "" }),
    clickAction: () => {
      signedIn = true;
      onSubmitted();
      return Promise.resolve({ ok: true, observedValue: "signed in" });
    },
    followLink: () => Promise.resolve({ ok: true, url: page().url ?? "" }),
    installPrepareOnlyGuard: () => Promise.resolve(),
    readBlockedAttempt: () => Promise.resolve(null),
    registerPreparedValue: () => Promise.resolve(),
    openIntermediateWriteWindow: () => Promise.resolve(),
    closeIntermediateWriteWindow: () => Promise.resolve(),
    clickAuthorizedFormAction: () => {
      signedIn = true;
      onSubmitted();
      return Promise.resolve({ ok: true, observedValue: "signed in" });
    },
    readIntermediateWriteCount: () => 0,
    checkServiceWorker: () => Promise.resolve(null),
  };
}

test("resumed ready preparation preserves queued jobs and the chosen run mode", () => {
  const at = "2026-09-23T10:00:00.000Z";
  const run = ApplyRunSchema.parse({
    id: "run_queue_login",
    mode: "queue_auto",
    state: "paused_for_user_review",
    jobIds: ["job_login", "job_next"],
    currentJobId: "job_login",
    createdAt: at,
    updatedAt: at,
    summary: "Sign in before continuing.",
    detail: "The first job needs an account session.",
    totalJobs: 2,
    pendingJobs: 2,
  });
  const ready = ApplyJobResultSchema.parse({
    id: "result_login",
    runId: run.id,
    jobId: "job_login",
    state: "awaiting_review",
    summary: "Application ready for review.",
    detail: "The form is filled in.",
    startedAt: at,
    updatedAt: at,
    blockerReason: null,
  });
  const next = ApplyJobResultSchema.parse({
    id: "result_next",
    runId: run.id,
    jobId: "job_next",
    state: "planned",
    summary: "Waiting to start.",
    detail: "This job has not been prepared.",
    startedAt: at,
    updatedAt: at,
  });
  const reconciled = reconcileReadyRunAfterApplicationResumption({
    run,
    results: [ready, next],
    resumedRun: ApplyRunSchema.parse({
      ...run,
      mode: "copilot",
      jobIds: ["job_login"],
      totalJobs: 1,
      summary: ready.summary,
      detail: ready.detail,
      pendingJobs: 1,
    }),
    resumedJobId: "job_login",
    completedAt: at,
    summary: ready.summary,
    detail: ready.detail,
  });
  expect(reconciled).toMatchObject({
    mode: "queue_auto",
    state: "paused_for_user_review",
    jobIds: ["job_login", "job_next"],
    totalJobs: 2,
    pendingJobs: 2,
    currentJobId: "job_login",
    completedAt: null,
  });
  expect(reconciled.summary).not.toContain("Sign in before continuing");
});
describe("application login UserActionRequest adoption", () => {
  test("losing prepared A preserves sibling B running and reconciles the batch", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const occurredAt = "2026-07-30T10:05:00.000Z";
    await harness.repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        id: "application_a",
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "ready_for_review",
        lastActionLabel: "Prepared",
        nextActionLabel: "Review",
        lastUpdatedAt: "2026-07-30T10:02:00.000Z",
        lastAttemptState: "ready",
      }),
    );
    await harness.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_ab",
        mode: "copilot",
        state: "running",
        jobIds: [job.id, "job_b"],
        currentJobId: "job_b",
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:02:00.000Z",
        completedAt: null,
        summary: "A is ready while B is filling.",
        detail: "The batch is still running.",
        totalJobs: 2,
        pendingJobs: 2,
      }),
    );
    await harness.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_a",
        runId: "apply_run_ab",
        jobId: job.id,
        applicationRecordId: "application_a",
        state: "awaiting_review",
        summary: "A is prepared.",
        detail: "A is waiting for review.",
        startedAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:02:00.000Z",
        completedAt: null,
      }),
    );
    await harness.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_b",
        runId: "apply_run_ab",
        jobId: "job_b",
        applicationRecordId: "application_b",
        state: "filling",
        summary: "B is filling.",
        detail: "B still owns the active browser work.",
        startedAt: "2026-07-30T10:03:00.000Z",
        updatedAt: "2026-07-30T10:04:00.000Z",
        completedAt: null,
      }),
    );

    await terminalizeApplicationAfterPreparedPageLost({
      repository: harness.repository,
      runId: "apply_run_ab",
      jobId: job.id,
      applicationRecordId: "application_a",
      resultId: "apply_result_a",
      occurredAt,
      eventId: "event_page_a_lost",
    });

    expect(
      (await harness.repository.listApplyRuns()).find(
        (run) => run.id === "apply_run_ab",
      ),
    ).toMatchObject({
      state: "running",
      currentJobId: "job_b",
      pendingJobs: 1,
      failedJobs: 1,
      completedAt: null,
    });
  });

  test("a protected terminal result cannot change its application record", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    await harness.repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        id: "application_submitted",
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "ready_for_review",
        lastActionLabel: "Submitted",
        nextActionLabel: "View application",
        lastUpdatedAt: "2026-07-30T10:02:00.000Z",
        lastAttemptState: "submitted",
      }),
    );
    await harness.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_submitted",
        mode: "copilot",
        state: "completed",
        jobIds: [job.id],
        currentJobId: null,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:02:00.000Z",
        completedAt: "2026-07-30T10:02:00.000Z",
        summary: "Application submitted.",
        detail: "The terminal outcome is protected.",
        totalJobs: 1,
        pendingJobs: 0,
        submittedJobs: 1,
      }),
    );
    await harness.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_submitted",
        runId: "apply_run_submitted",
        jobId: job.id,
        applicationRecordId: "application_submitted",
        state: "submitted",
        summary: "Application submitted.",
        detail: "The employer confirmed receipt.",
        startedAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:02:00.000Z",
        completedAt: "2026-07-30T10:02:00.000Z",
      }),
    );

    await terminalizeApplicationAfterPreparedPageLost({
      repository: harness.repository,
      runId: "apply_run_submitted",
      jobId: job.id,
      applicationRecordId: "application_submitted",
      resultId: "apply_result_submitted",
      occurredAt: "2026-07-30T10:05:00.000Z",
      eventId: "event_must_not_land",
    });

    expect(
      (await harness.repository.listApplicationRecords()).find(
        (record) => record.id === "application_submitted",
      ),
    ).toMatchObject({
      lastAttemptState: "submitted",
      lastActionLabel: "Submitted",
    });

    await harness.repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        id: "application_uncertain",
        jobId: "job_uncertain",
        title: "Uncertain application",
        company: "Fixture employer",
        status: "ready_for_review",
        lastActionLabel: "Check the employer site",
        nextActionLabel: "Verify whether it was sent",
        lastUpdatedAt: "2026-07-30T10:03:00.000Z",
        lastAttemptState: "failed",
      }),
    );
    await harness.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_uncertain",
        mode: "copilot",
        state: "completed",
        jobIds: ["job_uncertain"],
        currentJobId: null,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:03:00.000Z",
        completedAt: "2026-07-30T10:03:00.000Z",
        summary: "Submission outcome is uncertain.",
        detail: "The application must not be retried automatically.",
        totalJobs: 1,
        pendingJobs: 0,
        failedJobs: 1,
      }),
    );
    await harness.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_uncertain",
        runId: "apply_run_uncertain",
        jobId: "job_uncertain",
        applicationRecordId: "application_uncertain",
        state: "failed",
        summary: "Submission outcome is uncertain.",
        detail: "Check the employer site before doing anything else.",
        startedAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:03:00.000Z",
        completedAt: "2026-07-30T10:03:00.000Z",
        privacyReceipt: {
          generatedAt: "2026-07-30T10:03:00.000Z",
          lineage: {
            runId: "apply_run_uncertain",
            jobId: "job_uncertain",
            resultId: "apply_result_uncertain",
            applicationRecordId: "application_uncertain",
          },
          destination: {
            origin: "https://jobs.example.com",
            safePath: "/apply",
          },
          resume: {
            source: "original_upload",
            sourceDocumentId: "resume_1",
            fileName: "resume.pdf",
            sha256: "a".repeat(64),
          },
          finalSubmitOccurred: false,
          submissionOutcome: {
            id: "outcome_uncertain",
            preflightId: "preflight_uncertain",
            idempotencyKey: "submit_uncertain",
            authorityEnvelopeId: "authority_uncertain",
            authorityRevision: 1,
            runId: "apply_run_uncertain",
            jobId: "job_uncertain",
            resultId: "apply_result_uncertain",
            applicationRecordId: "application_uncertain",
            outcome: "outcome_uncertain",
            attemptedAt: "2026-07-30T10:02:00.000Z",
            verifiedAt: null,
            evidence: [],
            retry: {
              eligible: false,
              blockReason: "outcome_uncertain",
            },
          },
        },
      }),
    );

    await terminalizeApplicationAfterPreparedPageLost({
      repository: harness.repository,
      runId: "apply_run_uncertain",
      jobId: "job_uncertain",
      applicationRecordId: "application_uncertain",
      resultId: "apply_result_uncertain",
      occurredAt: "2026-07-30T10:06:00.000Z",
      eventId: "event_uncertain_must_not_land",
    });
    expect(
      (await harness.repository.listApplicationRecords()).find(
        (record) => record.id === "application_uncertain",
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      lastActionLabel: "Check the employer site",
    });
  });

  test("persists one strict application-scoped request for a login blocker", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "site_login_required",
      summary: "Sign in before continuing.",
      detail: "The application page requires a browser-owned account session.",
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: job.applicationUrl,
    });

    const input = {
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_login",
      resultId: "apply_result_login",
      replayCheckpointId: "apply_checkpoint_login",
      blocker,
      occurredAt: "2026-07-30T10:00:00.000Z",
    } as const;
    await persistApplicationUserAction(input);
    await persistApplicationUserAction(input);

    const requests = await harness.repository.listUserActionRequests();
    expect(requests).toHaveLength(1);
    // The sign-in is watched on the kept page, so the card never asks the
    // person to come back and confirm it.
    expect(requests[0]?.summary).toContain(
      "carries on with this application by itself once you're in",
    );
    expect(
      [requests[0]?.summary, ...(requests[0]?.instructions ?? [])].join(" "),
    ).not.toMatch(/confirm/i);
    expect(requests[0]).toMatchObject({
      kind: "login",
      state: "pending",
      // This fixture intentionally has no employer application URL. The
      // prepare-only login handoff uses the saved canonical listing as the
      // safe same-origin page where the user can sign in before retrying the
      // exact application checkpoint.
      actionUrl: job.canonicalUrl,
      displayOrigin: "https://www.linkedin.com/",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      scope: {
        type: "application",
        runId: "apply_run_login",
        jobId: job.id,
        resultId: "apply_result_login",
        replayCheckpointId: "apply_checkpoint_login",
        source: job.source,
      },
      verification: {
        type: "source_access",
        expectedOrigin: "https://www.linkedin.com/",
      },
    });
  });

  test("opens same-URL application handoffs by exact result binding", async () => {
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const focusApplicationPageBinding = vi.fn(
      (_source: string, resultId: string) =>
        Promise.resolve(resultId !== "apply_result_missing"),
    );
    const openSession = vi.spyOn(baseRuntime, "openSession");
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        focusApplicationPageBinding,
      },
    });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      userActionKind: "captcha",
      summary: "Complete the CAPTCHA yourself.",
      url: job.applicationUrl ?? job.canonicalUrl,
    });

    for (const suffix of ["a", "b"] as const) {
      await persistApplicationUserAction({
        repository: harness.repository,
        applicationRecordId: `application_${suffix}`,
        job,
        runId: `apply_run_${suffix}`,
        resultId: `apply_result_${suffix}`,
        replayCheckpointId: `apply_checkpoint_${suffix}`,
        blocker,
        occurredAt: `2026-07-30T10:0${suffix === "a" ? "0" : "1"}:00.000Z`,
      });
    }
    const requests = await harness.repository.listUserActionRequests();
    for (const request of requests) {
      if (request.scope.type !== "application") {
        throw new Error("Expected application request.");
      }
      await harness.workspaceService.performUserAction({
        commandId: `open_${request.id}`,
        requestId: request.id,
        expectedRevision: request.revision,
        action: "open_page",
      });
    }

    expect(focusApplicationPageBinding.mock.calls).toEqual(
      expect.arrayContaining([
        [job.source, "apply_result_a"],
        [job.source, "apply_result_b"],
      ]),
    );
    expect(openSession).not.toHaveBeenCalled();

    const missingApplicationRecordId = "application_missing";
    await harness.repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        id: missingApplicationRecordId,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "ready_for_review",
        lastActionLabel: "Paused on a step you have to finish.",
        nextActionLabel: "Finish the step in the Job Finder browser.",
        lastUpdatedAt: "2026-07-30T10:02:00.000Z",
        lastAttemptState: "paused",
        consentSummary: { status: "requested" },
      }),
    );
    await harness.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_missing",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [job.id],
        currentJobId: job.id,
        createdAt: "2026-07-30T10:02:00.000Z",
        updatedAt: "2026-07-30T10:02:00.000Z",
        completedAt: null,
        summary: "Waiting for the person.",
        detail: "The prepared page is open.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    );
    await harness.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_missing",
        runId: "apply_run_missing",
        jobId: job.id,
        applicationRecordId: missingApplicationRecordId,
        state: "awaiting_review",
        summary: "Waiting for the person.",
        detail: "The prepared page is open.",
        startedAt: "2026-07-30T10:02:00.000Z",
        updatedAt: "2026-07-30T10:02:00.000Z",
        completedAt: null,
        blockerReason: "required_human_input",
        blockerSummary: "Complete the CAPTCHA yourself.",
      }),
    );
    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: missingApplicationRecordId,
      job,
      runId: "apply_run_missing",
      resultId: "apply_result_missing",
      replayCheckpointId: "apply_checkpoint_missing",
      blocker,
      occurredAt: "2026-07-30T10:02:00.000Z",
    });
    const missing = (await harness.repository.listUserActionRequests()).find(
      (request) =>
        request.scope.type === "application" &&
        request.scope.resultId === "apply_result_missing",
    );
    if (!missing) throw new Error("Expected missing-page request.");
    const afterMissing = await harness.workspaceService.performUserAction({
      commandId: "open_missing_binding",
      requestId: missing.id,
      expectedRevision: missing.revision,
      action: "open_page",
    });
    expect(
      (await harness.repository.getUserActionRequest(missing.id))?.state,
    ).toBe("cancelled");
    expect(
      afterMissing.applicationRecords.find(
        (record) => record.id === missingApplicationRecordId,
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      lastActionLabel: "The prepared application page is no longer open.",
      nextActionLabel: "Try again, or finish it yourself on the job site.",
    });
    expect(
      afterMissing.applyJobResults.find(
        (result) => result.id === "apply_result_missing",
      ),
    ).toMatchObject({
      state: "failed",
      summary: "The prepared application page is no longer open.",
      blockerReason: "unexpected_navigation",
    });
    expect(
      afterMissing.applyRuns.find((run) => run.id === "apply_run_missing"),
    ).toMatchObject({
      state: "completed",
      pendingJobs: 0,
      failedJobs: 1,
    });
  });

  test("a new sign-in or account step hands the kept page to the person; other steps do not", async () => {
    const handApplicationPageToPerson = vi.fn(() => Promise.resolve());
    for (const [code, expected] of [
      ["site_login_required", 1],
      ["missing_candidate_answer", 0],
      ["application_page_unreachable", 0],
    ] as const) {
      handApplicationPageToPerson.mockClear();
      await handApplicationPageToPersonForAccessStep({
        browserRuntime: { handApplicationPageToPerson },
        source: "target_site",
        resultId: "result_1",
        blocker: ApplicationAttemptBlockerSchema.parse({
          code,
          summary: "Blocked.",
          url: "https://jobs.example.com/apply",
        }),
      });
      expect(handApplicationPageToPerson).toHaveBeenCalledTimes(expected);
    }
    // No kept page: nothing to hand over, and nothing breaks.
    await expect(
      handApplicationPageToPersonForAccessStep({
        browserRuntime: {
          handApplicationPageToPerson: () =>
            Promise.reject(new Error("no page")),
        },
        source: "target_site",
        resultId: "result_1",
        blocker: ApplicationAttemptBlockerSchema.parse({
          code: "site_login_required",
          summary: "Sign in.",
          url: "https://jobs.example.com/apply",
        }),
      }),
    ).resolves.toBeUndefined();
  });

  test("arms only the observed sign-in control on the retained application binding", async () => {
    const baseRuntime = createBrowserRuntime();
    const raw = await taskLocalSignInSession(() => undefined).readPage();
    const armApplicationFormAction = vi.fn(() => Promise.resolve());
    const closeApplicationFormAction = vi.fn(() => Promise.resolve());
    const handApplicationPageToPerson = vi.fn(() => Promise.resolve());
    const harness = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime: {
        ...baseRuntime,
        focusApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
        readApplicationPageBinding: vi.fn(() => Promise.resolve(raw)),
        armApplicationFormAction,
        closeApplicationFormAction,
        handApplicationPageToPerson,
      },
    });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "run_exact_login",
      resultId: "result_exact_login",
      replayCheckpointId: "checkpoint_exact_login",
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "site_login_required",
        summary: "Sign in before continuing.",
        url: job.applicationUrl ?? job.canonicalUrl,
      }),
      occurredAt: "2026-07-30T10:00:00.000Z",
    });
    const request = (await harness.repository.listUserActionRequests())[0];
    if (!request) throw new Error("Expected a sign-in request.");
    await harness.workspaceService.performUserAction({
      commandId: "open_exact_login",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "open_page",
    });
    expect(closeApplicationFormAction).toHaveBeenCalledWith(
      job.source,
      "result_exact_login",
    );
    // The person's own posts on the kept page (creating the account,
    // signing in) go through while this step is theirs; the lock comes first.
    expect(handApplicationPageToPerson).toHaveBeenCalledWith(
      job.source,
      "result_exact_login",
    );
    expect(closeApplicationFormAction.mock.invocationCallOrder[0]).toBeLessThan(
      handApplicationPageToPerson.mock.invocationCallOrder[0]!,
    );
    // Confirming the step locks the page again before Job Finder continues.
    const opened = await harness.repository.getUserActionRequest(request.id);
    closeApplicationFormAction.mockClear();
    await harness.workspaceService.performUserAction({
      commandId: "confirm_exact_login",
      requestId: request.id,
      expectedRevision: opened!.revision,
      action: "confirm_done",
    });
    expect(closeApplicationFormAction).toHaveBeenCalledWith(
      job.source,
      "result_exact_login",
    );
    expect(armApplicationFormAction).toHaveBeenCalledWith(job.source, {
      pageBindingKey: "result_exact_login",
      pageUrl: "https://fixture.example/sign-in",
      ref: "a0",
      label: "Sign in",
      formAction: "https://login.example/session",
      formMethod: "POST",
    });
  });

  test.each(["page read", "arm"] as const)(
    "a cancelled sign-in request is closed after a pending %s finishes",
    async (heldPhase) => {
      const baseRuntime = createBrowserRuntime();
      const raw = await taskLocalSignInSession(() => undefined).readPage();
      let releaseRead: (() => void) | undefined;
      let reading: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const heldRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const armApplicationFormAction = vi.fn(async () => {
        if (heldPhase === "arm") {
          reading?.();
          await heldRead;
        }
      });
      const closeApplicationFormAction = vi.fn(() => Promise.resolve());
      const harness = createWorkspaceServiceHarness({
        seed: createSeed(),
        browserRuntime: {
          ...baseRuntime,
          focusApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
          readApplicationPageBinding: vi.fn(async () => {
            if (heldPhase === "page read") {
              reading?.();
              await heldRead;
            }
            return raw;
          }),
          armApplicationFormAction,
          closeApplicationFormAction,
        },
      });
      const job = (await harness.repository.listSavedJobs())[0];
      if (!job) throw new Error("Expected a saved job fixture.");
      await persistApplicationUserAction({
        repository: harness.repository,
        applicationRecordId: `application_${job.id}`,
        job,
        runId: "run_cancelled_login",
        resultId: "result_cancelled_login",
        replayCheckpointId: "checkpoint_cancelled_login",
        blocker: ApplicationAttemptBlockerSchema.parse({
          code: "site_login_required",
          summary: "Sign in before continuing.",
          url: job.applicationUrl ?? job.canonicalUrl,
        }),
        occurredAt: "2026-07-30T10:00:00.000Z",
      });
      const request = (await harness.repository.listUserActionRequests())[0];
      if (!request) throw new Error("Expected a sign-in request.");
      const opening = harness.workspaceService.performUserAction({
        commandId: "open_cancelled_login",
        requestId: request.id,
        expectedRevision: request.revision,
        action: "open_page",
      });
      await started;
      const cancellation = reduceUserActionCommand(
        request,
        {
          commandId: "external_cancel_login",
          requestId: request.id,
          expectedRevision: request.revision,
          action: "cancel",
          reason: "The person closed this step.",
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        },
        "2026-07-30T10:01:00.000Z",
      );
      if (cancellation.status !== "applied")
        throw new Error("Expected cancellation.");
      await harness.repository.commitUserActionTransition({
        request: cancellation.request,
        event: cancellation.event,
      });
      releaseRead?.();
      await opening;
      expect(armApplicationFormAction).toHaveBeenCalledTimes(
        heldPhase === "arm" ? 1 : 0,
      );
      expect(closeApplicationFormAction).toHaveBeenCalledWith(
        job.source,
        "result_cancelled_login",
      );
    },
  );

  test("carries the concrete blocker reason into the Needs-you summary for an unclassified step", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      summary: "The application page could not safely save a prepared field",
      detail:
        "The application site tried to save 'Work authorization' while it was being prepared, but this run did not have permission for that external save. Job Finder stopped and left the application open instead of risking a final submission.",
      url: job.applicationUrl,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_autosave",
      resultId: "apply_result_autosave",
      replayCheckpointId: "apply_checkpoint_autosave",
      blocker,
      occurredAt: "2026-07-30T10:00:00.000Z",
    });

    const [request] = await harness.repository.listUserActionRequests();
    if (!request) throw new Error("Expected the autosave user action.");
    expect(request.kind).toBe("other");
    // The card must say what the step is: the blocker's own summary and
    // detail lead, followed by the prepare-only continuation.
    // The no-submit boundary is stated once per card by the renderer, so the
    // reason keeps the concrete cause without repeating it.
    expect(request.summary).toBe(
      `${blocker.summary}. The application site tried to save 'Work authorization' while it was being prepared, but this run did not have permission for that external save. Job Finder stopped and left the application open. Complete this manual step in the Job Finder browser, then come back here and confirm so Job Finder can check the page again.`,
    );
    expect(request.summary).not.toContain("Complete the described step");
    expect(request.summary).not.toMatch(/risking a final/i);
    // The credentials boundary is owned by the Needs-you page header, not
    // repeated inside every unclassified instruction.
    expect(request.instructions.join(" ")).not.toMatch(/credential/i);
    expect(request.instructions[0]).toBe(
      "Finish this step yourself in the Job Finder browser.",
    );

    // A generic placeholder field name reads as a real field the user could
    // go and find, so it is never quoted back to them.
    expect(
      describeApplicationBlockerReason({
        summary: "The application page could not safely save a prepared field",
        detail:
          "The application site tried to save 'application field' while it was being prepared.",
      }),
    ).toBe(
      // The detail is the same event told more specifically, so the short
      // summary label is dropped instead of opening the card with two
      // near-identical sentences.
      "The application site tried to save a field while it was being prepared.",
    );

    // A detail that genuinely adds a different fact still keeps both.
    expect(
      describeApplicationBlockerReason({
        summary: "Resume attachment needs your help",
        detail:
          "The application site tried to upload the approved resume file, but this run had no permission for that external save.",
      }),
    ).toBe(
      "Resume attachment needs your help. The application site tried to upload the approved resume file, but this run had no permission for that external save.",
    );

    expect(
      describeApplicationBlockerReason({
        summary: "Sign in before continuing.",
        detail: "Sign in before continuing.",
      }),
    ).toBe("Sign in before continuing.");
    expect(
      describeApplicationBlockerReason({
        summary: "Attach a file",
        detail: null,
      }),
    ).toBe("Attach a file.");
  });

  test("persists no Needs-you request when the application page never opened", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "application_page_unreachable",
      summary: "Job Finder could not open the application page.",
      detail:
        "The dedicated browser could not load this employer page, so preparation stopped before the page opened. Nothing was filled, attached, or submitted.",
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: job.applicationUrl,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_unreachable",
      resultId: "apply_result_unreachable",
      replayCheckpointId: "apply_checkpoint_unreachable",
      blocker,
      occurredAt: "2026-07-30T10:00:00.000Z",
    });

    expect(await harness.repository.listUserActionRequests()).toEqual([]);
  });

  test("persists no Needs-you request when the assistant stalls", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      userActionKind: null,
      summary: "The assistant did not answer in time.",
      detail: "Nothing was submitted, and everything completed so far is kept.",
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: job.applicationUrl,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_timeout",
      resultId: "apply_result_timeout",
      resultState: "failed",
      resultStartedAt: "2026-07-30T10:00:00.000Z",
      replayCheckpointId: "apply_checkpoint_timeout",
      blocker,
      occurredAt: "2026-07-30T10:04:00.000Z",
    });

    expect(await harness.repository.listUserActionRequests()).toEqual([]);
  });

  test("keeps only the latest rerun handoff actionable for one job", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      userActionKind: "other",
      summary: "Complete the browser-owned step.",
      url: job.applicationUrl,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_old",
      resultId: "apply_result_old",
      replayCheckpointId: "apply_checkpoint_old",
      blocker,
      occurredAt: "2026-07-30T10:00:00.000Z",
    });
    const oldRequest = (await harness.repository.listUserActionRequests())[0];
    if (!oldRequest) throw new Error("Expected the first user action.");
    const opened = reduceUserActionCommand(
      oldRequest,
      {
        action: "open_page",
        requestId: oldRequest.id,
        commandId: "open-old-application-action",
        expectedRevision: oldRequest.revision,
      },
      "2026-07-30T10:05:00.000Z",
    );
    if (opened.status !== "applied") {
      throw new Error("Expected the old user action to open.");
    }
    await harness.repository.commitUserActionTransition({
      request: opened.request,
      event: opened.event,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_new",
      resultId: "apply_result_new",
      replayCheckpointId: "apply_checkpoint_new",
      blocker,
      occurredAt: "2026-07-30T11:00:00.000Z",
    });

    const requests = await harness.repository.listUserActionRequests();
    const previous = requests.find(
      (request) =>
        request.scope.type === "application" &&
        request.scope.runId === "apply_run_old",
    );
    const latest = requests.find(
      (request) =>
        request.scope.type === "application" &&
        request.scope.runId === "apply_run_new",
    );
    expect(requests).toHaveLength(2);
    if (!previous || !latest) {
      throw new Error("Expected both application action generations.");
    }
    expect(previous).toMatchObject({
      revision: 3,
      state: "superseded",
      openedAt: "2026-07-30T10:05:00.000Z",
      resolvedAt: "2026-07-30T11:00:00.000Z",
    });
    expect(latest).toMatchObject({ revision: 1, state: "pending" });
    expect(
      requests.filter(
        (request) =>
          request.scope.type === "application" &&
          request.scope.jobId === job.id &&
          ![
            "resolved",
            "skipped",
            "cancelled",
            "expired",
            "superseded",
          ].includes(request.state),
      ),
    ).toEqual([latest]);
    expect(
      (
        await harness.repository.listUserActionEvents({
          requestId: previous?.id,
        })
      ).map((event) => event.operation),
    ).toEqual(["created", "open_page", "supersede"]);
  });

  test("does not supersede a blocker owned by a sibling application record", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      summary: "Complete the browser-owned step.",
      url: job.applicationUrl,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: "application_a",
      job,
      runId: "run_a",
      resultId: "result_a",
      replayCheckpointId: "checkpoint_a",
      blocker,
      occurredAt: "2026-07-30T10:00:00.000Z",
    });
    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: "application_b",
      job,
      runId: "run_b",
      resultId: "result_b",
      replayCheckpointId: "checkpoint_b",
      blocker,
      occurredAt: "2026-07-30T11:00:00.000Z",
    });

    expect(
      (await harness.repository.listUserActionRequests())
        .map((request) => ({
          applicationRecordId:
            request.scope.type === "application"
              ? request.scope.applicationRecordId
              : null,
          state: request.state,
        }))
        .sort((left, right) =>
          (left.applicationRecordId ?? "").localeCompare(
            right.applicationRecordId ?? "",
          ),
        ),
    ).toEqual([
      { applicationRecordId: "application_a", state: "pending" },
      { applicationRecordId: "application_b", state: "pending" },
    ]);
  });

  test("supersedes a stale same-job handoff after a newer blocker-free final checkpoint", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      userActionKind: "other",
      summary: "Complete the browser-owned step.",
      url: job.applicationUrl,
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_failed",
      resultId: "apply_result_failed",
      replayCheckpointId: "apply_checkpoint_failed",
      blocker,
      occurredAt: "2026-07-30T10:00:00.000Z",
    });
    const unrelatedJob = { ...job, id: "job_unrelated" };
    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${unrelatedJob.id}`,
      job: unrelatedJob,
      runId: "apply_run_unrelated",
      resultId: "apply_result_unrelated",
      replayCheckpointId: "apply_checkpoint_unrelated",
      blocker,
      occurredAt: "2026-07-30T10:10:00.000Z",
    });
    await harness.repository.createUserActionRequest(
      UserActionRequestSchema.parse({
        id: "source-login-unrelated",
        dedupeKey: "source-login:unrelated",
        revision: 1,
        kind: "login",
        state: "pending",
        requirement: "required",
        scope: {
          type: "discovery_source",
          targetId: "target-linkedin",
          source: "target_site",
        },
        verification: {
          type: "source_access",
          targetId: "target-linkedin",
          blockerFingerprint: "source-login:unrelated",
          expectedOrigin: "https://www.linkedin.com/",
        },
        title: "Sign in to search",
        summary: "Sign in in the Job Finder browser.",
        createdAt: "2026-07-30T10:15:00.000Z",
        updatedAt: "2026-07-30T10:15:00.000Z",
      }),
    );

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_success",
      resultId: "apply_result_success",
      resultState: "awaiting_review",
      resultStartedAt: "2026-07-30T11:00:00.000Z",
      replayCheckpointId: "apply_checkpoint_final",
      blocker: null,
      occurredAt: "2026-07-30T11:05:00.000Z",
    });

    const requests = await harness.repository.listUserActionRequests();
    const staleApplication = requests.find(
      (request) =>
        request.scope.type === "application" && request.scope.jobId === job.id,
    );
    const unrelatedApplication = requests.find(
      (request) =>
        request.scope.type === "application" &&
        request.scope.jobId === unrelatedJob.id,
    );
    const sourceLogin = requests.find(
      (request) => request.scope.type === "discovery_source",
    );
    if (!staleApplication) {
      throw new Error("Expected the stale application handoff history.");
    }
    expect(staleApplication).toMatchObject({
      state: "superseded",
      revision: 2,
      resolvedAt: "2026-07-30T11:05:00.000Z",
    });
    expect(unrelatedApplication).toMatchObject({ state: "pending" });
    expect(sourceLogin).toMatchObject({ state: "pending" });
    expect(
      (
        await harness.repository.listUserActionEvents({
          requestId: staleApplication.id,
        })
      ).map((event) => event.operation),
    ).toEqual(["created", "supersede"]);
  });

  test("does not let an older blocker-free result retire a newer same-job handoff", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_newer_blocker",
      resultId: "apply_result_newer_blocker",
      replayCheckpointId: "apply_checkpoint_newer_blocker",
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "requires_manual_review",
        userActionKind: "other",
        summary: "Complete the newer browser-owned step.",
        url: job.applicationUrl,
      }),
      occurredAt: "2026-07-30T12:00:00.000Z",
    });

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_older_success",
      resultId: "apply_result_older_success",
      resultState: "awaiting_review",
      resultStartedAt: "2026-07-30T11:00:00.000Z",
      replayCheckpointId: "apply_checkpoint_older_final",
      blocker: null,
      occurredAt: "2026-07-30T13:00:00.000Z",
    });

    const requests = await harness.repository.listUserActionRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toBe("pending");
    expect(requests[0]?.scope).toEqual({
      type: "application",
      runId: "apply_run_newer_blocker",
      jobId: job.id,
      applicationRecordId: `application_${job.id}`,
      resultId: "apply_result_newer_blocker",
      replayCheckpointId: "apply_checkpoint_newer_blocker",
      source: job.source,
    });
  });

  test.each([
    ["signup", "Create your account"],
    ["email_verification", "Verify your email"],
    ["mfa", "Complete MFA"],
  ] as const)(
    "persists and deduplicates a safe %s authentication request",
    async (kind, expectedTitleVerb) => {
      const harness = createWorkspaceServiceHarness({ seed: createSeed() });
      const job = (await harness.repository.listSavedJobs())[0];
      if (!job) throw new Error("Expected a saved job fixture.");
      const blocker = ApplicationAttemptBlockerSchema.parse({
        code: "requires_manual_review",
        userActionKind: kind,
        summary: "Complete the browser-owned authentication step.",
        url: job.applicationUrl,
      });
      const input = {
        repository: harness.repository,
        applicationRecordId: `application_${job.id}`,
        job,
        runId: `apply_run_${kind}`,
        resultId: `apply_result_${kind}`,
        replayCheckpointId: `apply_checkpoint_${kind}`,
        blocker,
        occurredAt: "2026-07-30T10:00:00.000Z",
      } as const;

      await persistApplicationUserAction(input);
      await persistApplicationUserAction(input);

      const requests = await harness.repository.listUserActionRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.title).toContain(expectedTitleVerb);
      expect(requests[0]?.dedupeKey).toMatch(
        new RegExp(`^application_${kind}:`),
      );
      expect(requests[0]).toMatchObject({
        kind,
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
        scope: {
          type: "application",
          runId: `apply_run_${kind}`,
          resultId: `apply_result_${kind}`,
          replayCheckpointId: `apply_checkpoint_${kind}`,
        },
        verification: {
          type: "source_access",
          expectedOrigin: "https://www.linkedin.com/",
        },
      });
    },
  );

  test.each([
    "captcha",
    "existing_account_choice",
    "manual_answer",
    "legal_consent",
    "external_redirect",
    "manual_upload",
    "other",
  ] as const)(
    "persists and deduplicates a prepare-only %s request",
    async (kind) => {
      const harness = createWorkspaceServiceHarness({ seed: createSeed() });
      const job = (await harness.repository.listSavedJobs())[0];
      if (!job) throw new Error("Expected a saved job fixture.");

      await persistApplicationUserAction({
        repository: harness.repository,
        applicationRecordId: `application_${job.id}`,
        job,
        runId: `apply_run_${kind}`,
        resultId: `apply_result_${kind}`,
        replayCheckpointId: `apply_checkpoint_${kind}`,
        blocker: ApplicationAttemptBlockerSchema.parse({
          code: "requires_manual_review",
          userActionKind: kind,
          summary: "Complete a non-authentication browser step.",
          url: job.applicationUrl,
        }),
        occurredAt: "2026-07-30T10:00:00.000Z",
      });

      const requests = await harness.repository.listUserActionRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        kind,
        state: "pending",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
        scope: {
          type: "application",
          runId: `apply_run_${kind}`,
          resultId: `apply_result_${kind}`,
          replayCheckpointId: `apply_checkpoint_${kind}`,
        },
        verification: {
          type: "page_blocker_absent",
        },
      });
      expect(requests[0]?.verification).toHaveProperty("blockerFingerprint");
    },
  );








  test("does not create a login action for a non-login application blocker", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");

    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "apply_run_manual",
      resultId: "apply_result_manual",
      replayCheckpointId: null,
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "requires_manual_review",
        summary: "Review a required answer.",
        detail: "A manual answer is required.",
        questionIds: ["question_1"],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl,
      }),
      occurredAt: "2026-07-30T10:00:00.000Z",
    });

    expect(await harness.repository.listUserActionRequests()).toEqual([]);
  });









});

// Gate 3: the app closed while an answered step was being checked. Startup
// failed the batch run first, and the check then left the card on "still
// blocked" asking the person to do what was already done.
describe("a step whose run ended before its check", () => {
});

// R4: "I clicked Cancel this step on both blocked items and each time the page
// said the step was closed, but the header badge stayed on Needs you: 2
// unresolved and the job still showed NEEDS YOU in Applications."
describe("cancelling a browser step releases the application waiting on it", () => {
  test("moves the record out of the awaiting-user state so the count drops", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    const applicationRecordId = `application_${job.id}`;
    await harness.repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        id: applicationRecordId,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "ready_for_review",
        lastActionLabel: "Paused on a step you have to finish.",
        nextActionLabel: "Finish the sign-in step in the Job Finder browser.",
        lastUpdatedAt: "2026-07-30T10:00:00.000Z",
        lastAttemptState: "paused",
        consentSummary: { status: "requested" },
      }),
    );
    await harness.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_cancel",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [job.id],
        currentJobId: job.id,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        completedAt: null,
        summary: "Waiting for the person.",
        detail: "One step needs the person.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    );
    await harness.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_cancel",
        runId: "apply_run_cancel",
        jobId: job.id,
        applicationRecordId,
        state: "awaiting_review",
        summary: "Waiting for the person.",
        detail: "One step needs the person.",
        startedAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        completedAt: null,
        blockerReason: "required_human_input",
        blockerSummary: "Sign in before continuing.",
        latestQuestionCount: 1,
      }),
    );
    await persistApplicationUserAction({
      repository: harness.repository,
      applicationRecordId,
      job,
      runId: "apply_run_cancel",
      resultId: "apply_result_cancel",
      replayCheckpointId: "apply_checkpoint_cancel",
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "site_login_required",
        summary: "Sign in before continuing.",
        detail:
          "The application page requires a browser-owned account session.",
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl,
      }),
      occurredAt: "2026-07-30T10:00:00.000Z",
    });

    const staged = await harness.workspaceService.getWorkspaceSnapshot();
    const request = (await harness.repository.listUserActionRequests())[0];
    if (!request) throw new Error("Expected an application step.");
    expect(
      staged.applicationRecords.find(
        (record) => record.id === applicationRecordId,
      )?.lastAttemptState,
    ).toBe("paused");

    const after = await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: request.id,
      commandId: "cancel_application_step",
      expectedRevision: request.revision,
      reason: "User cancelled the step.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    const released = after.applicationRecords.find(
      (record) => record.id === applicationRecordId,
    );
    expect(released?.lastAttemptState).toBe("cancelled");
    expect(released?.nextActionLabel).toBe(
      "Try again, or finish it yourself on the job site.",
    );
    expect(released?.questionSummary.total).toBe(0);
    expect(
      after.applyJobResults.find(
        (result) => result.id === "apply_result_cancel",
      ),
    ).toMatchObject({
      state: "cancelled",
      summary: "Cancelled by you",
      blockerReason: null,
      blockerSummary: null,
      latestQuestionCount: 0,
    });
    expect(
      after.applyRuns.find((run) => run.id === "apply_run_cancel"),
    ).toMatchObject({
      state: "completed",
      summary: "1 cancelled",
      pendingJobs: 0,
      failedJobs: 0,
    });
    // Nothing is left claiming the person still owes this application a step.
    expect(
      (await harness.repository.listUserActionRequests()).filter(
        (entry) => entry.state !== "cancelled",
      ),
    ).toEqual([]);
    expect(after.applicationRecords.length).toBeGreaterThan(0);
  });
});

