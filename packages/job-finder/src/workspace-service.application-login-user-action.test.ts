import {
  ApplicationAttemptSchema,
  ApplicationAttemptBlockerSchema,
  ApplicationRecordSchema,
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplyExecutionResultSchema,
  UserActionRequestSchema,
  type ApplyPageSession,
  type RawApplyPage,
} from "@nestor/contracts";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { describe, expect, test, vi } from "vitest";

import {
  describeApplicationBlockerReason,
  handApplicationPageToPersonForAccessStep,
  persistApplicationUserAction,
  terminalizeApplicationAfterPreparedPageLost,
} from "./internal/workspace-application-user-action";
import { reconcileReadyRunAfterApplicationResumption } from "./internal/workspace-application-user-action-resumption";
import { reduceUserActionCommand } from "./user-action-domain";
import * as submissionRunStep from "./internal/apply-submission-run-step";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
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
  test("adopts a real Apply Copilot login result with exact run and result lineage", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "Sign in to continue",
          detail: "The application page requires a browser-owned session.",
          blocker: {
            code: "site_login_required",
            summary: "Sign in to continue",
            detail: "The application page requires a browser-owned session.",
            questionIds: [],
            sourceDebugEvidenceRefIds: [],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const snapshot =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const run = snapshot.applyRuns[0];
    const result = snapshot.applyJobResults[0];

    expect(run).toBeTruthy();
    expect(result).toBeTruthy();
    expect(snapshot.userActionRequests).toHaveLength(1);
    expect(snapshot.userActionRequests[0]).toMatchObject({
      kind: "login",
      state: "pending",
      scope: {
        type: "application",
        runId: run?.id,
        jobId: "job_ready",
        resultId: result?.id,
        replayCheckpointId: result?.latestCheckpointId,
      },
      verification: {
        type: "source_access",
        targetId: null,
        expectedOrigin: "https://www.linkedin.com/",
      },
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    expect(executeApplicationFlow).toHaveBeenCalledOnce();
    const executionCall = executeApplicationFlow.mock.calls[0] as unknown as
      | Parameters<BrowserSessionRuntime["executeApplicationFlow"]>
      | undefined;
    expect(executionCall?.[0]).toBe("target_site");
    expect(executionCall?.[1]).toMatchObject({
      applicationPageBindingKey: result?.id,
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
    });
    expect(executionCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("uses task-local application credentials once without persisting either value", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    let signInSubmitted = false;
    let releaseApplicationPreparation!: () => void;
    const applicationPreparationReleased = new Promise<void>((resolve) => {
      releaseApplicationPreparation = resolve;
    });
    let markApplicationPreparationStarted!: () => void;
    const applicationPreparationStarted = new Promise<void>((resolve) => {
      markApplicationPreparationStarted = resolve;
    });
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount === 1) {
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "Sign in to continue",
            detail: "The exact application page requires sign-in.",
            blocker: {
              code: "site_login_required",
              summary: "Sign in to continue",
              detail: "The exact application page requires sign-in.",
              questionIds: [],
              sourceDebugEvidenceRefIds: [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }

        if (!input.prepareTaskLocalCredentials) {
          throw new Error("Expected the exact task-local sign-in callback.");
        }
        const session = taskLocalSignInSession(() => {
          signInSubmitted = true;
        });
        await input.prepareTaskLocalCredentials({ session });
        markApplicationPreparationStarted();
        await applicationPreparationReleased;
        return input.prepareApplicationForm({
          session,
          currentUrl: "https://fixture.example/application",
          startedAt: "2026-09-22T02:00:00.000Z",
        });
      },
    );
    const baseAiClient = createAiClient();
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
      aiClient: {
        ...baseAiClient,
        chatWithTools: () =>
          Promise.resolve({
            toolCalls: [
              {
                id: "finish-prepared-application",
                type: "function" as const,
                function: {
                  name: "finish",
                  arguments: JSON.stringify({
                    reason: "The signed-in application is ready for review.",
                  }),
                },
              },
            ],
          }),
      },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const blockedRecord = blocked.applicationRecords[0];
    if (!blockedRecord)
      throw new Error("Expected a blocked application record.");
    await harness.repository.upsertApplicationRecord({
      ...blockedRecord,
      automationMode: "confirm_before_submit",
    });
    const request = blocked.userActionRequests[0];
    if (
      !request ||
      request.scope.type !== "application" ||
      !request.scope.applicationRecordId
    ) {
      throw new Error("Expected an exact application login request.");
    }
    const identifier = "fixture-person-task-local@example.test";
    const password = "test-secret-task-local-value";

    const resumedPromise = harness.workspaceService.performUserAction({
      action: "submit_task_local_credentials",
      requestId: request.id,
      commandId: "command-task-local-sign-in",
      expectedRevision: request.revision,
      identifier,
      password,
      taskLocalUseAuthorized: true,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    await applicationPreparationStarted;

    // Renderer polling while the application is still preparing must join
    // the exact application resumption. It must not run generic source-access
    // verification against the same request revision.
    const concurrentSnapshotPromise =
      harness.workspaceService.getWorkspaceSnapshot();
    await Promise.resolve();
    expect(
      (await harness.repository.getUserActionRequest(request.id))?.state,
    ).toBe("verifying");
    releaseApplicationPreparation();
    const [resumed, concurrentSnapshot] = await Promise.all([
      resumedPromise,
      concurrentSnapshotPromise,
    ]);

    expect({
      signInSubmitted,
      executionCount,
      callbackPresent: Boolean(
        executeApplicationFlow.mock.calls[1]?.[1].prepareTaskLocalCredentials,
      ),
      requestState: resumed.userActionRequests[0]?.state,
      attemptSummary: resumed.applicationAttempts.at(-1)?.summary,
      attemptDetail: resumed.applicationAttempts.at(-1)?.detail,
      attemptState: resumed.applicationAttempts.at(-1)?.state,
      recordAttemptState: resumed.applicationRecords[0]?.lastAttemptState,
      resultState: resumed.applyJobResults[0]?.state,
    }).toEqual({
      signInSubmitted: true,
      executionCount: 2,
      callbackPresent: true,
      requestState: "resolved",
      attemptSummary:
        "The browser step is complete and this application is ready for you.",
      attemptDetail:
        "Job Finder verified the exact step on the retained application page and continued the form without sending it.",
      attemptState: "ready",
      recordAttemptState: "ready",
      resultState: "awaiting_review",
    });
    expect(resumed.applicationAttempts.at(-1)?.agentTiming?.modelTurns).toBe(1);
    expect(resumed.applicationAttempts.at(-1)?.agentTiming?.pageReads).toBe(2);
    expect(resumed.applyJobResults[0]?.agentTiming).toEqual(
      resumed.applicationAttempts.at(-1)?.agentTiming,
    );
    expect(resumed.applyJobResults[0]?.reviewCard).toMatchObject({
      pageUrl: "https://fixture.example/application",
      waitingOnYou: [],
    });
    expect(resumed.applyRuns[0]).toMatchObject({
      mode: "copilot",
      state: "paused_for_user_review",
      currentJobId: "job_ready",
      pendingJobs: 1,
      completedAt: null,
      summary: resumed.applyJobResults[0]?.summary,
      detail: resumed.applyJobResults[0]?.detail,
    });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    expect(concurrentSnapshot.userActionRequests[0]?.state).toBe("resolved");
    expect(resumed.applicationRecords[0]?.automationMode).toBe(
      "confirm_before_submit",
    );
    const persisted = {
      request: await harness.repository.getUserActionRequest(request.id),
      events: await harness.repository.listUserActionEvents({
        requestId: request.id,
      }),
      answers: await harness.repository.listApplicationAnswerRecords({
        applicationRecordId: request.scope.applicationRecordId,
      }),
      snapshot: resumed,
    };
    expect(JSON.stringify(persisted)).not.toContain(identifier);
    expect(JSON.stringify(persisted)).not.toContain(password);
    expect(persisted.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "command-task-local-sign-in",
          operation: "submit_task_local_credentials",
        }),
      ]),
    );
  });

  test("persists a question discovered after task-local sign-in so one answer can continue it", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount === 1) {
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "Sign in to continue",
            detail: "The exact application page requires sign-in.",
            blocker: {
              code: "site_login_required",
              summary: "Sign in to continue",
              detail: "The exact application page requires sign-in.",
              questionIds: [],
              sourceDebugEvidenceRefIds: [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }
        if (executionCount === 2) {
          if (!input.prepareTaskLocalCredentials) {
            throw new Error("Expected the exact task-local sign-in callback.");
          }
          await input.prepareTaskLocalCredentials({
            session: taskLocalSignInSession(() => undefined),
          });
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "One source answer is required",
            detail: "Choose how this job was found.",
            questions: [
              {
                id: "question_job_source",
                prompt: "How did you hear about this job?",
                kind: "other",
                answerControlType: "single_choice",
                isRequired: true,
                detectedAt: "2026-09-22T02:00:00.000Z",
                answerOptions: ["Job board", "Company website", "Referral"],
                suggestedAnswers: [],
                submittedAnswer: null,
                status: "detected",
              },
            ],
            blocker: {
              code: "missing_candidate_answer",
              userActionKind: "manual_answer",
              summary: "Choose how this job was found.",
              detail: "The answer is not in the profile.",
              questionIds: ["question_job_source"],
              sourceDebugEvidenceRefIds: [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }
        expect(
          input.profile.answerBank.customAnswers.map((answer) => answer.answer),
        ).toContain("Job board");
        return baseResult;
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const blockedRecord = blocked.applicationRecords[0];
    if (!blockedRecord)
      throw new Error("Expected a blocked application record.");
    await harness.repository.upsertApplicationRecord({
      ...blockedRecord,
      automationMode: "confirm_before_submit",
    });
    const loginRequest = blocked.userActionRequests.find(
      (request) => request.kind === "login",
    );
    if (!loginRequest) throw new Error("Expected a login request.");

    const afterSignIn = await harness.workspaceService.performUserAction({
      action: "submit_task_local_credentials",
      requestId: loginRequest.id,
      commandId: "command-task-local-sign-in-before-question",
      expectedRevision: loginRequest.revision,
      identifier: "fixture-person@example.test",
      password: "fixture-task-secret",
      taskLocalUseAuthorized: true,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    const answerRequest = afterSignIn.userActionRequests.find(
      (request) => request.kind === "manual_answer",
    );
    if (
      !answerRequest ||
      answerRequest.scope.type !== "application" ||
      !answerRequest.scope.resultId
    ) {
      throw new Error("Expected a manual-answer request after sign-in.");
    }
    expect(afterSignIn.applicationRecords[0]?.automationMode).toBe(
      "confirm_before_submit",
    );
    expect(
      await harness.repository.listApplicationQuestionRecords({
        resultId: answerRequest.scope.resultId,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prompt: "How did you hear about this job?",
          status: "detected",
        }),
      ]),
    );

    const resumed = await harness.workspaceService.performUserAction({
      commandId: "submit-source-answer",
      requestId: answerRequest.id,
      expectedRevision: answerRequest.revision,
      action: "submit_manual_answer",
      answer: "Job board",
      saveForFuture: true,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(3);
    expect(resumed.applicationRecords[0]?.automationMode).toBe(
      "confirm_before_submit",
    );
    expect(
      resumed.userActionRequests.find(
        (request) => request.id === answerRequest.id,
      )?.state,
    ).toBe("resolved");
    expect(
      await harness.repository.listApplicationAnswerRecords({
        resultId: answerRequest.scope.resultId,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: answerRequest.id,
          text: "Job board",
        }),
      ]),
    );
  });

  test.each([
    { outcome: "confirmed", confirmed: true, cancelled: false },
    { outcome: "cancelled", confirmed: true, cancelled: true },
    { outcome: "uncertain", confirmed: false, cancelled: false },
  ])(
    "reconciles a resumed send only when confirmed, preserving cancellation: $outcome",
    async ({ confirmed, cancelled }) => {
      const seed = createSeed();
      seed.settings.resumeApplicationMode = "original_resume";
      seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
      const baseRuntime = createBrowserRuntime();
      let executionCount = 0;
      const executeApplicationFlow: BrowserSessionRuntime["executeApplicationFlow"] =
        async (source, input) => {
          const baseResult = await baseRuntime.executeApplicationFlow(
            source,
            input,
          );
          executionCount += 1;
          if (executionCount > 1) {
            if (!input.prepareTaskLocalCredentials)
              throw new Error("Expected sign-in callback.");
            await input.prepareTaskLocalCredentials({
              session: taskLocalSignInSession(() => undefined),
            });
            return baseResult;
          }
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            blocker: {
              code: "site_login_required",
              summary: "Sign in to continue",
              detail: "The exact application needs sign-in.",
              questionIds: [],
              sourceDebugEvidenceRefIds: [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        };
      const harness = createWorkspaceServiceHarness({
        seed,
        browserRuntime: { ...baseRuntime, executeApplicationFlow },
      });
      const blocked =
        await harness.workspaceService.startApplyCopilotRun("job_ready");
      const request = blocked.userActionRequests[0];
      if (!request) throw new Error("Expected a login request.");
      // The submission runtime owns the durable result; this regression tests
      // its caller's reconciliation after that runtime confirms receipt.
      const send = vi
        .spyOn(submissionRunStep, "sendPreparedApplicationIfAllowed")
        .mockImplementationOnce(async ({ lineage }) => {
          const result = (
            await harness.repository.listApplyJobResults({
              runId: lineage.runId,
            })
          ).find((entry) => entry.id === lineage.resultId);
          const run = (
            await harness.repository.listApplyRuns({ id: lineage.runId })
          )[0];
          if (!result || !run)
            throw new Error("Expected exact resumed lineage.");
          const now = new Date().toISOString();
          await harness.repository.upsertApplyJobResult(
            ApplyJobResultSchema.parse({
              ...result,
              state: confirmed ? "submitted" : "failed",
              privacyReceipt:
                confirmed && result.privacyReceipt
                  ? { ...result.privacyReceipt, finalSubmitOccurred: true }
                  : result.privacyReceipt,
              updatedAt: now,
              completedAt: now,
            }),
          );
          if (cancelled) {
            await harness.repository.upsertApplyRun(
              ApplyRunSchema.parse({
                ...run,
                state: "cancelled",
                updatedAt: now,
                completedAt: now,
              }),
            );
          }
          return {
            sent: true,
            confirmedSubmitted: confirmed,
            pageClosed: false,
            summary: "Application submitted",
            detail: "The employer confirmed receipt.",
            nextActionLabel: "View application",
          };
        });
      try {
        const resumed = await harness.workspaceService.performUserAction({
          action: "submit_task_local_credentials",
          requestId: request.id,
          identifier: "fixture@example.test",
          password: "synthetic-test-secret",
          taskLocalUseAuthorized: true,
          commandId: `confirm-login-send-${cancelled}`,
          expectedRevision: request.revision,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        });
        expect(send).toHaveBeenCalledOnce();
        expect(resumed.applyJobResults[0]?.state).toBe(
          confirmed ? "submitted" : "failed",
        );
        if (confirmed) {
          expect(resumed.applicationRecords[0]?.lastAttemptState).toBe(
            "submitted",
          );
        } else {
          expect(resumed.applicationRecords[0]?.lastAttemptState).not.toBe(
            "submitted",
          );
        }
        const run = resumed.applyRuns.find(
          (entry) => entry.id === blocked.applyRuns[0]?.id,
        );
        if (cancelled) {
          expect(run?.state).toBe("cancelled");
        } else if (!confirmed) {
          expect(run?.submittedJobs).toBe(0);
          expect(run?.state).not.toBe("completed");
        } else {
          expect(run).toMatchObject({
            state: "completed",
            currentJobId: null,
            pendingJobs: 0,
            submittedJobs: 1,
            failedJobs: 0,
            blockedJobs: 0,
          });
          expect(run?.completedAt).toBeTruthy();
        }
      } finally {
        send.mockRestore();
      }
    },
  );

  test("resolves the sign-in step when later application preparation fails", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount === 1) {
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "Sign in to continue",
            detail: "The exact application page requires sign-in.",
            blocker: {
              code: "site_login_required",
              summary: "Sign in to continue",
              detail: "The exact application page requires sign-in.",
              questionIds: [],
              sourceDebugEvidenceRefIds: [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }
        if (!input.prepareTaskLocalCredentials) {
          throw new Error("Expected the exact task-local sign-in callback.");
        }
        await input.prepareTaskLocalCredentials({
          session: taskLocalSignInSession(() => undefined),
        });
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "failed",
          summary: "Application preparation timed out",
          detail: "The form remained open and can be tried again.",
          blocker: null,
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request) throw new Error("Expected a login request.");

    const resumed = await harness.workspaceService.performUserAction({
      action: "submit_task_local_credentials",
      requestId: request.id,
      commandId: "command-task-local-sign-in-then-failure",
      expectedRevision: request.revision,
      identifier: "fixture-person@example.test",
      password: "synthetic-test-secret",
      taskLocalUseAuthorized: true,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    expect(resumed.applyJobResults[0]?.state).toBe("failed");
    expect(resumed.applyJobResults[0]?.summary).toBe(
      "Application preparation timed out",
    );
  });
  test("synthesizes an exact resumable checkpoint when a blocker omits runtime checkpoints", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount > 1) return baseResult;

        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "Complete the CAPTCHA",
          detail: "The employer requires a browser-owned human check.",
          checkpoints: [],
          blocker: {
            code: "requires_manual_review",
            userActionKind: "captcha",
            summary: "Complete the CAPTCHA yourself.",
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request || request.scope.type !== "application") {
      throw new Error("Expected a resumable CAPTCHA action.");
    }
    const replayCheckpointId = request.scope.replayCheckpointId;
    const fallbackCheckpoint = (
      await harness.repository.listApplicationReplayCheckpoints()
    ).find((checkpoint) => checkpoint.id === replayCheckpointId);

    expect(request).toMatchObject({
      kind: "captcha",
      state: "pending",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      scope: {
        runId: blocked.applyRuns[0]?.id,
        jobId: "job_ready",
        resultId: blocked.applyJobResults[0]?.id,
        replayCheckpointId: blocked.applyJobResults[0]?.latestCheckpointId,
      },
    });
    expect(fallbackCheckpoint).toMatchObject({
      label: "Browser action required",
      jobState: "awaiting_review",
    });

    const resumed = await harness.workspaceService.performUserAction({
      commandId: "confirm_fallback_checkpoint_captcha",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(executeApplicationFlow.mock.calls[1]?.[1]).toMatchObject({
      applicationPageBindingKey: request.scope.resultId,
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
      recoveryContext: {
        previousRunId: request.scope.runId,
        previousResultId: request.scope.resultId,
        latestCheckpoint: {
          label: "Browser action required",
        },
      },
    });
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
  });

  test.each([
    ["login", "site_login_required", undefined],
    ["captcha", "requires_manual_review", "captcha"],
    ["manual_answer", "missing_candidate_answer", "manual_answer"],
    ["manual_upload", "missing_resume", "manual_upload"],
    ["legal_consent", "missing_consent", "legal_consent"],
  ] as const)(
    "keeps an empty-checkpoint %s blocker durably resumable",
    async (expectedKind, code, userActionKind) => {
      const seed = createSeed();
      seed.settings.resumeApplicationMode = "original_resume";
      seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
      const baseRuntime = createBrowserRuntime();
      const executeApplicationFlow = vi.fn(
        async (
          source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
          input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
        ) => {
          const baseResult = await baseRuntime.executeApplicationFlow(
            source,
            input,
          );
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "Browser action required",
            detail: "A browser-owned step needs the candidate.",
            checkpoints: [],
            blocker: {
              code,
              ...(userActionKind ? { userActionKind } : {}),
              summary: "Complete the browser-owned step.",
              questionIds:
                expectedKind === "manual_answer" ? ["question_required"] : [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        },
      );
      const harness = createWorkspaceServiceHarness({
        seed,
        browserRuntime: { ...baseRuntime, executeApplicationFlow },
      });

      const snapshot =
        await harness.workspaceService.startApplyCopilotRun("job_ready");
      const result = snapshot.applyJobResults[0];
      const request = snapshot.userActionRequests[0];
      const checkpoints =
        await harness.repository.listApplicationReplayCheckpoints();

      expect(result?.latestCheckpointId).toBeTruthy();
      expect(request).toMatchObject({
        kind: expectedKind,
        state: "pending",
        submitAuthorized: false,
        accountCreationAuthorized: false,
        scope: {
          type: "application",
          runId: snapshot.applyRuns[0]?.id,
          jobId: "job_ready",
          resultId: result?.id,
          replayCheckpointId: result?.latestCheckpointId,
        },
      });
      expect(
        checkpoints.find(
          (checkpoint) => checkpoint.id === result?.latestCheckpointId,
        ),
      ).toMatchObject({
        runId: snapshot.applyRuns[0]?.id,
        jobId: "job_ready",
        resultId: result?.id,
        label: "Browser action required",
      });
    },
  );

  test.each([false, true])(
    "names the file an upload step needs (cover letter=%s)",
    async (letter) => {
      const seed = createSeed();
      seed.settings.resumeApplicationMode = "original_resume";
      seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
      const baseRuntime = createBrowserRuntime();
      const harness = createWorkspaceServiceHarness({
        seed,
        browserRuntime: {
          ...baseRuntime,
          executeApplicationFlow: async (source, input) =>
            ApplyExecutionResultSchema.parse({
              ...(await baseRuntime.executeApplicationFlow(source, input)),
              state: "paused",
              summary: "Browser action required",
              detail: letter
                ? "This form requires a letter, but your settings say Job Finder should not write one."
                : "Job Finder filled in what it could and needs your answers to 1 question.",
              questions: [
                {
                  id: "question_transcript",
                  prompt: letter
                    ? "Application — Cover letter upload *"
                    : "Academic transcript",
                  kind: "other",
                  answerControlType: "file",
                  isRequired: true,
                  detectedAt: "2026-07-30T10:00:00.000Z",
                  answerOptions: [],
                  suggestedAnswers: [],
                  submittedAnswer: null,
                  status: "detected",
                },
              ],
              blocker: {
                code: "missing_candidate_answer",
                userActionKind: "manual_upload",
                summary: letter
                  ? "This form requires a letter, but your settings say Job Finder should not write one."
                  : "Job Finder filled in what it could and needs your answers to 1 question.",
                questionIds: ["question_transcript"],
                url: input.job.applicationUrl ?? input.job.canonicalUrl,
              },
            }),
        },
      });

      const snapshot =
        await harness.workspaceService.startApplyCopilotRun("job_ready");
      const request = snapshot.userActionRequests[0];

      expect(request?.kind).toBe("manual_upload");
      expect(request?.title).toMatch(
        letter
          ? /^Add your cover letter to continue/u
          : /^Add your academic transcript to continue/u,
      );
      expect(request?.summary).toMatch(
        letter
          ? /settings say Job Finder should not write one.*form asks for your cover letter/u
          : /form asks for your academic transcript\. Add or restore it in Profile › Files/u,
      );
    },
  );

  test("rejects a submitted result reported through the prepare-only production path", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "submitted",
          submittedAt: "2026-07-30T10:00:00.000Z",
          outcome: "submitted",
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    await expect(
      harness.workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/Preparation never sends anything/iu);
    expect(executeApplicationFlow).toHaveBeenCalledOnce();
    const executionCall = executeApplicationFlow.mock.calls[0] as unknown as
      | Parameters<BrowserSessionRuntime["executeApplicationFlow"]>
      | undefined;
    expect(executionCall?.[0]).toBe("target_site");
    expect(executionCall?.[1]).toMatchObject({
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
    });
    expect(executionCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(await harness.repository.listApplyRuns()).toEqual([
      expect.objectContaining({
        state: "failed",
        currentJobId: "job_ready",
        failedJobs: 1,
        submittedJobs: 0,
      }),
    ]);
    expect(await harness.repository.listApplyJobResults()).toEqual([
      expect.objectContaining({
        jobId: "job_ready",
        state: "failed",
        summary: "Application preparation failed.",
      }),
    ]);
  });

  test("prepares jobs two through five in one batch when job one needs browser login", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const sourceJob = seed.savedJobs[0];
    if (!sourceJob) throw new Error("Expected a saved job fixture.");
    seed.savedJobs = [
      {
        ...sourceJob,
        id: "job_queue_login",
        sourceJobId: "queue_login",
        canonicalUrl: "https://www.linkedin.com/jobs/view/queue_login",
        applicationUrl: "https://www.linkedin.com/jobs/view/queue_login/apply",
        title: "Staff Product Designer",
      },
      {
        ...sourceJob,
        id: "job_queue_review",
        sourceJobId: "queue_review",
        canonicalUrl: "https://www.linkedin.com/jobs/view/queue_review",
        applicationUrl: "https://www.linkedin.com/jobs/view/queue_review/apply",
        title: "Principal Product Designer",
      },
      ...[3, 4, 5].map((position) => ({
        ...sourceJob,
        id: `job_queue_review_${position}`,
        sourceJobId: `queue_review_${position}`,
        canonicalUrl: `https://www.linkedin.com/jobs/view/queue_review_${position}`,
        applicationUrl: `https://www.linkedin.com/jobs/view/queue_review_${position}/apply`,
        title: `Product Designer ${position}`,
      })),
    ];

    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (input.job.id !== "job_queue_login") {
          return baseResult;
        }

        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "Sign in to continue",
          detail: "The application page requires a browser-owned session.",
          blocker: {
            code: "site_login_required",
            summary: "Sign in to continue",
            detail: "The application page requires a browser-owned session.",
            questionIds: [],
            sourceDebugEvidenceRefIds: [],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const staged = await harness.workspaceService.startAutoApplyQueueRun([
      "job_queue_login",
      "job_queue_review",
      "job_queue_review_3",
      "job_queue_review_4",
      "job_queue_review_5",
    ]);
    const runId = staged.applyRuns.find((run) => run.mode === "queue_auto")?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    const snapshot = await harness.workspaceService.approveApplyRun(runId);
    const loginResult = snapshot.applyJobResults.find(
      (result) => result.runId === runId && result.jobId === "job_queue_login",
    );
    const reviewResult = snapshot.applyJobResults.find(
      (result) => result.runId === runId && result.jobId === "job_queue_review",
    );
    const applicationRequests = snapshot.userActionRequests.filter(
      (request) => request.scope.type === "application",
    );

    expect(
      executeApplicationFlow.mock.calls.map(([, input]) => ({
        jobId: input.job.id,
        mode: input.mode,
        accountCreationAuthorized: input.accountCreationAuthorized,
        submitAuthorized: input.submitAuthorized,
      })),
    ).toEqual([
      {
        jobId: "job_queue_login",
        mode: "prepare_only",
        accountCreationAuthorized: false,
        submitAuthorized: false,
      },
      {
        jobId: "job_queue_review",
        mode: "prepare_only",
        accountCreationAuthorized: false,
        submitAuthorized: false,
      },
      ...[3, 4, 5].map((position) => ({
        jobId: `job_queue_review_${position}`,
        mode: "prepare_only" as const,
        accountCreationAuthorized: false,
        submitAuthorized: false,
      })),
    ]);
    expect(loginResult).toMatchObject({
      state: "awaiting_review",
      blockerReason: "auth_required",
    });
    expect(loginResult?.latestCheckpointId).toBeTruthy();
    expect(reviewResult).toMatchObject({
      state: "awaiting_review",
      blockerReason: null,
    });
    expect(
      snapshot.applyRuns.find((candidate) => candidate.id === runId),
    ).toMatchObject({
      totalJobs: 5,
      pendingJobs: 0,
      state: "completed",
    });
    expect(
      snapshot.applyJobResults.filter((result) => result.runId === runId),
    ).toHaveLength(5);
    expect(applicationRequests).toEqual([
      expect.objectContaining({
        kind: "login",
        state: "pending",
        scope: {
          type: "application",
          runId,
          jobId: "job_queue_login",
          applicationRecordId: loginResult?.applicationRecordId,
          resultId: loginResult?.id,
          replayCheckpointId: loginResult?.latestCheckpointId,
          source: "target_site",
        },
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    ]);
  });
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
  test("lets two WorkspaceService instances share one durable resumption execution", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    let markRetryStarted: () => void = () => undefined;
    let releaseRetry: () => void = () => undefined;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount === 1) {
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "Sign in to continue",
            detail: "The application page requires a browser-owned session.",
            blocker: {
              code: "site_login_required",
              summary: "Sign in to continue",
              detail: "The application page requires a browser-owned session.",
              questionIds: [],
              sourceDebugEvidenceRefIds: [],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }
        markRetryStarted();
        await retryRelease;
        return baseResult;
      },
    );
    const inspectSourceAccess = vi.fn(() =>
      Promise.resolve({
        state: "authenticated" as const,
        currentOrigin: "https://www.linkedin.com/",
        checkedAt: "2026-07-30T10:30:00.000Z",
        signals: ["account_menu_control" as const],
      }),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request || request.scope.type !== "application") {
      throw new Error("Expected an application login request.");
    }

    const concurrentService = createJobFinderWorkspaceService({
      repository: harness.repository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: harness.aiClient,
      documentManager: harness.documentManager,
      exportFileVerifier: harness.exportFileVerifier,
      researchAdapter: harness.researchAdapter,
    });
    const resumedPromise = harness.workspaceService.performUserAction({
      commandId: "confirm_application_login",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });
    await retryStarted;
    const concurrentSnapshot = await concurrentService.performUserAction({
      commandId: "confirm_application_login_duplicate",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });
    releaseRetry();
    const resumed = await resumedPromise;

    expect(concurrentSnapshot.userActionRequests[0]?.state).toBe("resolved");
    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    const retryInput = executeApplicationFlow.mock.calls[1]?.[1];
    expect(retryInput?.mode).toBe("prepare_only");
    expect(retryInput?.idempotencyKey).toContain(request.id);
    expect(retryInput?.accountCreationAuthorized).toBe(false);
    expect(retryInput?.submitAuthorized).toBe(false);
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    expect(resumed.applyJobResults[0]?.jobId).toBe(request.scope.jobId);
    expect(resumed.applyJobResults[0]?.lastUserActionResumptionId).toContain(
      request.id,
    );
    expect(resumed.applyJobResults[0]?.state).toBe("awaiting_review");
    expect(resumed.applyRuns[0]).toMatchObject({
      mode: "copilot",
      state: "paused_for_user_review",
      pendingJobs: 1,
      summary: resumed.applyJobResults[0]?.summary,
      detail: resumed.applyJobResults[0]?.detail,
    });
    const resumptionAttempt = resumed.applicationAttempts.find(
      (attempt) => attempt.userActionResumption?.requestId === request.id,
    );
    expect(resumptionAttempt?.completedAt).toBeTruthy();
    expect(resumptionAttempt?.userActionResumption).toEqual({
      requestId: request.id,
      requestRevision: 3,
      verificationEventId: `verification:${request.id}:r2`,
      runId: request.scope.runId,
      jobId: request.scope.jobId,
      resultId: request.scope.resultId,
      replayCheckpointId: request.scope.replayCheckpointId,
    });
    expect(
      executeApplicationFlow.mock.calls.every(
        ([, input]) =>
          input.mode === "prepare_only" && input.submitAuthorized === false,
      ),
    ).toBe(true);

    if (!resumptionAttempt) {
      throw new Error("Expected a completed resumption attempt.");
    }
    await harness.repository.upsertApplicationAttempt({
      ...resumptionAttempt,
      completedAt: null,
    });
    const restartExecuteApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const restartedService = createJobFinderWorkspaceService({
      repository: harness.repository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow: restartExecuteApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: harness.aiClient,
      documentManager: harness.documentManager,
      exportFileVerifier: harness.exportFileVerifier,
      researchAdapter: harness.researchAdapter,
    });

    const recovered = await restartedService.getWorkspaceSnapshot();
    const recoveredAttempt = recovered.applicationAttempts.find(
      (attempt) => attempt.id === resumptionAttempt.id,
    );
    expect(restartExecuteApplicationFlow).not.toHaveBeenCalled();
    expect(recoveredAttempt?.completedAt).toBeTruthy();
    expect(recoveredAttempt?.checkpoints).toEqual(
      resumptionAttempt.checkpoints,
    );
    expect(recoveredAttempt?.questions).toEqual(resumptionAttempt.questions);
  });

  test("does not overwrite a concurrently changed result after browser execution", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    let markRetryStarted: () => void = () => undefined;
    let releaseRetry: () => void = () => undefined;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount === 1) {
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "Sign in to continue",
            detail: "The application page requires a browser-owned session.",
            blocker: {
              code: "site_login_required",
              summary: "Sign in to continue",
              detail: "The application page requires a browser-owned session.",
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }
        markRetryStarted();
        await retryRelease;
        return baseResult;
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess: () =>
          Promise.resolve({
            state: "authenticated" as const,
            currentOrigin: "https://www.linkedin.com/",
            checkedAt: "2026-07-30T10:30:00.000Z",
            signals: ["account_menu_control" as const],
          }),
      },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request) throw new Error("Expected an application login request.");

    const resume = harness.workspaceService.performUserAction({
      commandId: "confirm_application_login_with_concurrent_result",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });
    await retryStarted;

    const currentResult = (await harness.repository.listApplyJobResults())[0];
    if (!currentResult) throw new Error("Expected an apply result.");
    await harness.repository.upsertApplyJobResult({
      ...currentResult,
      summary: "Concurrent owner preserved this result",
      detail: "A separate flow updated this result while resumption ran.",
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
    releaseRetry();
    const snapshot = await resume;

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(snapshot.applyJobResults[0]).toMatchObject({
      summary: "Concurrent owner preserved this result",
      detail: "A separate flow updated this result while resumption ran.",
    });
    expect(
      snapshot.applyJobResults[0]?.lastUserActionResumptionId,
    ).toBeUndefined();
    expect(
      snapshot.applicationAttempts.find(
        (attempt) => attempt.userActionResumption?.requestId === request.id,
      ),
    ).toMatchObject({
      state: "unsupported",
      summary:
        "Application retry result was not saved because the result changed",
    });
  });
  test("does not execute when the verified checkpoint lineage became stale", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "Sign in to continue",
          detail: "The application page requires a browser-owned session.",
          blocker: {
            code: "site_login_required",
            summary: "Sign in to continue",
            detail: "The application page requires a browser-owned session.",
            questionIds: [],
            sourceDebugEvidenceRefIds: [],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess: vi.fn(() =>
          Promise.resolve({
            state: "authenticated" as const,
            currentOrigin: "https://www.linkedin.com/",
            checkedAt: "2026-07-30T10:30:00.000Z",
            signals: ["account_menu_control" as const],
          }),
        ),
      },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    const result = blocked.applyJobResults[0];
    if (!request || request.scope.type !== "application" || !result) {
      throw new Error("Expected an application login lineage.");
    }
    await harness.repository.upsertApplyJobResult({
      ...result,
      latestCheckpointId: "checkpoint_replaced_elsewhere",
      updatedAt: "2026-07-30T11:00:00.000Z",
    });

    const snapshot = await harness.workspaceService.performUserAction({
      commandId: "confirm_stale_application_login",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(snapshot.applicationAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "unsupported",
          summary: "Application retry skipped because its checkpoint changed",
        }),
      ]),
    );
    expect(snapshot.applyJobResults[0]?.latestCheckpointId).toBe(
      "checkpoint_replaced_elsewhere",
    );
  });

  test("continuing a new attempt uses this application's earlier currency instead of a library-seeded copy", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "/tmp/synthetic-resume.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const base = await baseRuntime.executeApplicationFlow(source, input);
        executionCount += 1;
        return executionCount === 1
          ? ApplyExecutionResultSchema.parse({
              ...base,
              state: "paused",
              questions: [
                {
                  id: "authorization",
                  prompt: "Are you authorized to work here?",
                  kind: "work_authorization",
                  isRequired: true,
                  detectedAt: "2026-10-01T10:00:00.000Z",
                  status: "detected",
                },
              ],
              blocker: {
                code: "missing_candidate_answer",
                userActionKind: "manual_answer",
                summary: "Answer work authorization",
                detail: "Answer this question",
                questionIds: ["authorization"],
                sourceDebugEvidenceRefIds: [],
                url: input.job.applicationUrl ?? input.job.canonicalUrl,
              },
            })
          : base;
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0]!;
    if (
      request.scope.type !== "application" ||
      !request.scope.applicationRecordId ||
      !request.scope.resultId
    )
      throw new Error("Expected an application request");
    const scope = request.scope;
    const currencyId = `apply_question_${scope.applicationRecordId}_currency`;
    const own = ApplicationAnswerRecordSchema.parse({
      id: "own_previous_currency",
      runId: "previous_run",
      resultId: "previous_result",
      jobId: scope.jobId,
      applicationRecordId: scope.applicationRecordId,
      questionId: currencyId,
      revision: 1,
      status: "filled",
      text: "GBP",
      value: { type: "text", value: "GBP" },
      sourceKind: "user",
      sourceId: "previous_manual_request",
      createdAt: "2026-10-01T09:00:00.000Z",
    });
    const library = ApplicationAnswerRecordSchema.parse({
      ...own,
      id: "seeded_other_currency",
      runId: scope.runId,
      resultId: scope.resultId,
      revision: 2,
      status: "suggested",
      text: "EUR",
      value: { type: "text", value: "EUR" },
      sourceId: "answerLibrary.other_job_currency",
      createdAt: "2026-10-01T10:00:00.000Z",
    });
    await harness.repository.upsertApplicationAnswerRecord(own);
    await harness.repository.upsertApplicationAnswerRecord(library);
    await harness.repository.upsertApplicationQuestionRecord(
      ApplicationQuestionRecordSchema.parse({
        id: currencyId,
        runId: scope.runId,
        resultId: scope.resultId,
        jobId: scope.jobId,
        applicationRecordId: scope.applicationRecordId,
        prompt: "Currency",
        kind: "salary_expectation",
        isRequired: false,
        detectedAt: "2026-10-01T10:00:00.000Z",
        selectedAnswerId: library.id,
        status: "detected",
      }),
    );
    await harness.repository.commitProfileUpdate((profile) => ({
      ...profile,
      answerBank: {
        ...profile.answerBank,
        customAnswers: [
          {
            id: "other_job_currency",
            question: "Currency",
            label: "Currency",
            kind: "other",
            answer: "EUR",
            roleFamilies: [],
            proofEntryIds: [],
          },
        ],
      },
    }));
    const question = (
      await harness.repository.listApplicationQuestionRecords()
    ).find((entry) => entry.prompt === "Are you authorized to work here?")!;
    await harness.workspaceService.performUserAction({
      commandId: "continue_with_own_currency",
      answer: "Yes",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "submit_manual_answer",
      answers: [{ questionId: question.id, answer: "Yes" }],
      saveForFuture: false,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    const continued = executeApplicationFlow.mock.calls[1]![1];
    const currency = continued.profile.answerBank.customAnswers.find(
      (entry) => entry.question === "Currency",
    );
    expect(currency?.answer).toBe("GBP");
    expect(currency?.id).toContain("application_");
    expect(continued.instructions).toContain('Answer to "Currency": GBP');
    expect(continued.instructions).not.toContain('Answer to "Currency": EUR');
  });

  test("a pause with several questions asks for the questions in its title", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const question = (id: string, prompt: string) => ({
      id,
      prompt,
      kind: "other",
      answerControlType: "text",
      isRequired: true,
      detectedAt: "2026-07-30T10:00:00.000Z",
      answerOptions: [],
      suggestedAnswers: [],
      submittedAnswer: null,
      status: "detected",
    });
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) =>
        ApplyExecutionResultSchema.parse({
          ...(await baseRuntime.executeApplicationFlow(source, input)),
          state: "paused",
          summary: "Two answers need you",
          detail: "Answer these questions.",
          questions: [
            question("question_start", "When could you start?"),
            question("question_notice", "What is your notice period?"),
          ],
          blocker: {
            code: "missing_candidate_answer",
            userActionKind: "manual_answer",
            summary: "Answer two questions.",
            detail: "The answers stay in the browser.",
            questionIds: ["question_start", "question_notice"],
            sourceDebugEvidenceRefIds: [],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        }),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    expect(blocked.userActionRequests[0]?.title).toMatch(
      /^Answer the required questions to continue the .+ application$/u,
    );
  });

  test("retries with the exact persisted manual answer and remains restart-idempotent", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return executionCount === 1
          ? ApplyExecutionResultSchema.parse({
              ...baseResult,
              state: "paused",
              summary: "A required answer needs you",
              detail: "Answer this question in the browser.",
              questions: [
                {
                  id: "question_work_authorization",
                  prompt: "Are you authorized to work in this location?",
                  kind: "work_authorization",
                  answerControlType: "text",
                  isRequired: true,
                  detectedAt: "2026-07-30T10:00:00.000Z",
                  answerOptions: [],
                  suggestedAnswers: [],
                  submittedAnswer: null,
                  status: "detected",
                },
              ],
              blocker: {
                code: "missing_candidate_answer",
                userActionKind: "manual_answer",
                summary: "Answer the work authorization question.",
                detail: "The answer stays in the browser.",
                questionIds: ["question_work_authorization"],
                sourceDebugEvidenceRefIds: [],
                url: input.job.applicationUrl ?? input.job.canonicalUrl,
              },
            })
          : baseResult;
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const blockedRecord = blocked.applicationRecords[0];
    if (!blockedRecord)
      throw new Error("Expected a blocked application record.");
    await harness.repository.upsertApplicationRecord({
      ...blockedRecord,
      automationMode: "autonomous_submit",
    });
    const request = blocked.userActionRequests[0];
    if (
      !request ||
      request.scope.type !== "application" ||
      !request.scope.applicationRecordId
    ) {
      throw new Error("Expected a manual application action.");
    }

    // The approved date edit happens while the application is paused. The
    // continuation must read the current profile, rather than its old snapshot.
    await harness.repository.commitProfileUpdate((profile) => ({
      ...profile,
      experiences: [
        {
          ...profile.experiences[0]!,
          companyName: "Signal Systems",
          startDate: "January 2014",
          endDate: null,
          isCurrent: true,
        },
      ],
    }));
    // An answer the person gave at an earlier pause of the same preparation
    // belongs to that pause's summary, not this one.
    const pausedQuestion = (
      await harness.repository.listApplicationQuestionRecords({
        applicationRecordId: request.scope.applicationRecordId,
      })
    )[0]!;
    const earlierQuestion = ApplicationQuestionRecordSchema.parse({
      ...pausedQuestion,
      id: `${pausedQuestion.id}_earlier`,
      prompt: "What is your expected salary?",
    });
    await harness.repository.upsertApplicationQuestionRecord(earlierQuestion);
    await harness.repository.upsertApplicationAnswerRecord(
      ApplicationAnswerRecordSchema.parse({
        id: "earlier_pause_salary",
        runId: earlierQuestion.runId,
        resultId: earlierQuestion.resultId,
        jobId: earlierQuestion.jobId,
        applicationRecordId: earlierQuestion.applicationRecordId,
        questionId: earlierQuestion.id,
        revision: 1,
        status: "suggested",
        text: "50000",
        value: { type: "text", value: "50000" },
        sourceKind: "user",
        sourceId: "earlier_manual_request",
        createdAt: "2026-10-01T09:00:00.000Z",
      }),
    );
    const resumed = await harness.workspaceService.performUserAction({
      commandId: "submit_manual_answer_complete",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "submit_manual_answer",
      answer: "Yes, I am authorized to work in this location.",
      saveForFuture: false,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(
      executeApplicationFlow.mock.calls[1]?.[1].profile.experiences,
    ).toEqual([
      expect.objectContaining({
        companyName: "Signal Systems",
        startDate: "January 2014",
        isCurrent: true,
      }),
    ]);
    const savedAnswers = await harness.repository.listApplicationAnswerRecords({
      applicationRecordId: request.scope.applicationRecordId,
    });
    const savedQuestions =
      await harness.repository.listApplicationQuestionRecords({
        applicationRecordId: request.scope.applicationRecordId,
      });
    expect(
      savedQuestions.find((question) => question.id === pausedQuestion.id),
    ).toMatchObject({
      selectedAnswerId: savedAnswers.find(
        (answer) => answer.questionId === pausedQuestion.id,
      )!.id,
      submittedAnswer: "Yes, I am authorized to work in this location.",
      status: "answered",
    });
    expect(
      (await harness.repository.getUserActionRequest(request.id))?.summary,
    ).toBe(
      "You answered “Are you authorized to work in this location?” in the app.",
    );
    expect(request.kind).toBe("manual_answer");
    expect(request.verification.type).toBe("page_blocker_absent");
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(executeApplicationFlow.mock.calls[1]?.[1]).toMatchObject({
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
    });
    expect(
      executeApplicationFlow.mock.calls[1]?.[1].profile.answerBank
        .customAnswers,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          answer: "Yes, I am authorized to work in this location.",
        }),
      ]),
    );
    expect(
      (
        await harness.repository.listApplicationAnswerRecords({
          applicationRecordId: request.scope.applicationRecordId,
        })
      ).filter((answer) => answer.id !== "earlier_pause_salary"),
    ).toEqual([
      expect.objectContaining({
        applicationRecordId: request.scope.applicationRecordId,
        resultId: request.scope.resultId,
        sourceId: request.id,
        text: "Yes, I am authorized to work in this location.",
      }),
    ]);
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    expect(resumed.applicationRecords[0]?.automationMode).toBe(
      "autonomous_submit",
    );
    expect(resumed.applyJobResults[0]?.lastUserActionResumptionId).toContain(
      request.id,
    );

    const restartExecuteApplicationFlow = vi.fn(
      baseRuntime.executeApplicationFlow.bind(baseRuntime),
    );
    const restartedService = createJobFinderWorkspaceService({
      repository: harness.repository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow: restartExecuteApplicationFlow,
      },
      aiClient: harness.aiClient,
      documentManager: harness.documentManager,
      exportFileVerifier: harness.exportFileVerifier,
      researchAdapter: harness.researchAdapter,
    });
    const restarted = await restartedService.getWorkspaceSnapshot();
    expect(restartExecuteApplicationFlow).not.toHaveBeenCalled();
    expect(restarted.userActionRequests[0]?.state).toBe("resolved");
  });

  test("an answered step whose check an earlier run of the app left unfinished carries on", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return executionCount === 1
          ? ApplyExecutionResultSchema.parse({
              ...baseResult,
              state: "paused",
              summary: "A required answer needs you",
              detail: "Answer this question in the browser.",
              questions: [
                {
                  id: "question_work_authorization",
                  prompt: "Are you authorized to work in this location?",
                  kind: "work_authorization",
                  answerControlType: "text",
                  isRequired: true,
                  detectedAt: "2026-07-30T10:00:00.000Z",
                  answerOptions: [],
                  suggestedAnswers: [],
                  submittedAnswer: null,
                  status: "detected",
                },
              ],
              blocker: {
                code: "missing_candidate_answer",
                userActionKind: "manual_answer",
                summary: "Answer the work authorization question.",
                detail: "The answer stays in the browser.",
                questionIds: ["question_work_authorization"],
                sourceDebugEvidenceRefIds: [],
                url: input.job.applicationUrl ?? input.job.canonicalUrl,
              },
            })
          : baseResult;
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (
      !request ||
      request.scope.type !== "application" ||
      !request.scope.applicationRecordId ||
      !request.scope.resultId
    ) {
      throw new Error("Expected a manual application action.");
    }
    // An earlier run of the app claimed this step's check and quit before it
    // ran (a restart while it waited for its site): the attempt is still in
    // progress in the store, and nothing in this process is running it.
    await harness.repository.upsertApplicationAttempt(
      ApplicationAttemptSchema.parse({
        id: `application_user_action_resume_${request.id}_r3`,
        jobId: request.scope.jobId,
        applicationRecordId: request.scope.applicationRecordId,
        state: "in_progress",
        summary: "Checking the completed browser step once",
        detail: "Scheduled before the app was restarted.",
        startedAt: "2026-07-30T10:05:00.000Z",
        updatedAt: "2026-07-30T10:05:00.000Z",
        completedAt: null,
        outcome: null,
        nextActionLabel: null,
        userActionResumption: {
          requestId: request.id,
          requestRevision: 3,
          verificationEventId: `verification:${request.id}:r2`,
          runId: request.scope.runId,
          jobId: request.scope.jobId,
          resultId: request.scope.resultId,
          replayCheckpointId: request.scope.replayCheckpointId,
        },
      }),
    );

    const resumed = await harness.workspaceService.performUserAction({
      commandId: "submit_manual_answer_after_restart",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "submit_manual_answer",
      answer: "Yes, I am authorized to work in this location.",
      saveForFuture: false,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    const attempt = resumed.applicationAttempts.find(
      (entry) => entry.id === `application_user_action_resume_${request.id}_r3`,
    );
    expect(attempt?.completedAt).toBeTruthy();
    expect(attempt?.state).not.toBe("in_progress");
  });

  test("offers retry immediately after a failed answer continuation", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        executionCount += 1;
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: executionCount === 1 ? "paused" : "failed",
          summary:
            executionCount === 1
              ? "A required answer needs you"
              : "The prepared page is no longer open.",
          detail: "Nothing was sent.",
          blocker:
            executionCount === 1
              ? {
                  code: "missing_candidate_answer",
                  userActionKind: "manual_answer",
                  summary: "Answer the work authorization question.",
                  questionIds: ["question_work_authorization"],
                  url: input.job.applicationUrl ?? input.job.canonicalUrl,
                }
              : null,
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request) throw new Error("Expected a manual application action.");
    const originalResult = blocked.applyJobResults[0];
    const originalRun = blocked.applyRuns.find(
      (run) => run.id === originalResult?.runId,
    );
    if (!originalResult || !originalRun)
      throw new Error("Expected apply lineage.");
    const checked = await harness.workspaceService.performUserAction({
      commandId: "confirm_answer_with_closed_page",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(
      checked.userActionRequests.find((entry) => entry.id === request.id)
        ?.state,
    ).toBe("superseded");
    const failedResult = checked.applyJobResults.find(
      (result) => result.id === originalResult.id,
    );
    expect(failedResult?.state).toBe("failed");
    expect(
      checked.applyRuns.find((run) => run.id === originalRun.id),
    ).toMatchObject({
      state: "completed",
      failedJobs: 1,
      pendingJobs: 0,
    });
    expect(checked.applicationRecords[0]?.lastAttemptState).toBe("failed");
    expect(failedResult?.lastUserActionResumptionId).toContain(request.id);
  });

  test("keeps the action blocked when the same stable blocker rerenders with different prose", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary:
            executionCount === 1
              ? "A required answer needs you"
              : "The required answer is still missing",
          detail:
            executionCount === 1
              ? "Answer this question in the browser."
              : "The page rerendered with new explanatory text.",
          blocker: {
            code: "missing_candidate_answer",
            userActionKind: "manual_answer",
            summary:
              executionCount === 1
                ? "Answer the work authorization question."
                : "Work authorization still requires an answer.",
            detail: `Browser-only wording revision ${executionCount}.`,
            questionIds: ["question_work_authorization"],
            sourceDebugEvidenceRefIds: [`evidence_${executionCount}`],
            url: `${input.job.applicationUrl ?? input.job.canonicalUrl}?render=${executionCount}`,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request) throw new Error("Expected a manual application action.");

    const checked = await harness.workspaceService.performUserAction({
      commandId: "confirm_manual_answer_still_blocked",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(checked.userActionRequests[0]?.state).toBe("still_blocked");
    expect(checked.applyJobResults[0]?.lastUserActionResumptionId).toBeFalsy();
    expect(
      checked.applicationAttempts.find(
        (attempt) => attempt.userActionResumption?.requestId === request.id,
      ),
    ).toMatchObject({
      summary: "Browser step is still blocking this application",
    });
  });

  test("resolves the exact blocker and persists a newly encountered application blocker", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        const first = executionCount === 1;
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: first
            ? "A required answer needs you"
            : "A file upload now needs you",
          detail: first
            ? "Answer this question in the browser."
            : "Attach the requested file in the browser.",
          blocker: first
            ? {
                code: "missing_candidate_answer",
                userActionKind: "manual_answer",
                summary: "Answer the work authorization question.",
                questionIds: ["question_work_authorization"],
                url: input.job.applicationUrl ?? input.job.canonicalUrl,
              }
            : {
                code: "missing_resume",
                userActionKind: "manual_upload",
                summary: "Attach the required resume file.",
                questionIds: [],
                url: `${input.job.applicationUrl ?? input.job.canonicalUrl}/upload`,
              },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const firstRequest = blocked.userActionRequests[0];
    if (!firstRequest) throw new Error("Expected a manual application action.");

    const resumed = await harness.workspaceService.performUserAction({
      commandId: "confirm_manual_answer_reveals_upload",
      requestId: firstRequest.id,
      expectedRevision: firstRequest.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(resumed.userActionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstRequest.id,
          kind: "manual_answer",
          state: "resolved",
        }),
        expect.objectContaining({
          kind: "manual_upload",
          state: "pending",
        }),
      ]),
    );
    const nextRequest = resumed.userActionRequests.find(
      (request) => request.kind === "manual_upload",
    );
    expect(nextRequest?.verification.type).toBe("page_blocker_absent");
    expect(resumed.applyJobResults[0]?.lastUserActionResumptionId).toContain(
      firstRequest.id,
    );
  });

  test("keeps a prepare-only action blocked when its exact checkpoint lineage is stale", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "A required answer needs you",
          detail: "Answer this question in the browser.",
          blocker: {
            code: "missing_candidate_answer",
            userActionKind: "manual_answer",
            summary: "Answer the work authorization question.",
            questionIds: ["question_work_authorization"],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    const result = blocked.applyJobResults[0];
    if (!request || !result) {
      throw new Error("Expected a manual application lineage.");
    }
    await harness.repository.upsertApplyJobResult({
      ...result,
      latestCheckpointId: "checkpoint_replaced_before_manual_retry",
      updatedAt: "2026-07-30T11:00:00.000Z",
    });

    const checked = await harness.workspaceService.performUserAction({
      commandId: "confirm_manual_answer_with_stale_checkpoint",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(checked.userActionRequests[0]?.state).toBe("still_blocked");
    expect(checked.applyJobResults[0]?.latestCheckpointId).toBe(
      "checkpoint_replaced_before_manual_retry",
    );
    expect(
      checked.applicationAttempts.find(
        (attempt) => attempt.userActionResumption?.requestId === request.id,
      ),
    ).toMatchObject({
      state: "unsupported",
      summary: "Application retry skipped because its checkpoint changed",
    });
  });
});

// Gate 3: the app closed while an answered step was being checked. Startup
// failed the batch run first, and the check then left the card on "still
// blocked" asking the person to do what was already done.
describe("a step whose run ended before its check", () => {
  test("closes the step and leaves Could not apply with Try again", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "A required answer needs you",
          detail: "Answer this question in the browser.",
          blocker: {
            code: "missing_candidate_answer",
            userActionKind: "manual_answer",
            summary: "Answer the work authorization question.",
            questionIds: ["question_work_authorization"],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    const run = blocked.applyRuns[0];
    if (!request || request.scope.type !== "application" || !run)
      throw new Error("Expected a manual application step.");
    const applicationRecordId = request.scope.applicationRecordId;
    await harness.repository.upsertApplyRun({
      ...run,
      state: "failed",
      summary: "Automatic apply stopped because the app closed",
      completedAt: "2026-07-30T11:00:00.000Z",
      updatedAt: "2026-07-30T11:00:00.000Z",
    });

    const checked = await harness.workspaceService.performUserAction({
      commandId: "confirm_manual_answer_after_run_failed",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(checked.userActionRequests[0]?.state).toBe("cancelled");
    expect(checked.applyJobResults[0]).toMatchObject({
      state: "failed",
      summary: "The prepared application page is no longer open.",
    });
    expect(
      checked.applicationRecords.find(
        (record) => record.id === applicationRecordId,
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      nextActionLabel: "Try again, or finish it yourself on the job site.",
    });
  });
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

test("Prepare again inherits only the latest cancelled draft for this application's same questions", async () => {
  const harness = createWorkspaceServiceHarness({ seed: createSeed() });
  const job = (await harness.repository.listSavedJobs())[0]!;
  const base = {
    repository: harness.repository,
    applicationRecordId: `application_${job.id}`,
    job,
    blocker: ApplicationAttemptBlockerSchema.parse({
      code: "requires_manual_review",
      userActionKind: "manual_answer",
      summary: "Answer the dates",
      questionIds: ["start", "interview"],
      url: job.applicationUrl,
    }),
  };
  await persistApplicationUserAction({
    ...base,
    runId: "before_restart",
    resultId: "before_restart",
    replayCheckpointId: "before_restart",
    occurredAt: "2026-10-01T10:00:00.000Z",
  });
  const original = (await harness.repository.listUserActionRequests())[0]!;
  const draft = {
    answers: { Start: "Monday", Interview: "Tuesday" },
    saveForFuture: false,
  };
  await harness.repository.saveUserActionAnswerDraft({
    requestId: original.id,
    expectedRevision: original.revision,
    draft,
    editedAt: 10,
  });
  // The restart cancellation began before the keystroke save returned.
  const transition = reduceUserActionCommand(
    original,
    {
      requestId: original.id,
      commandId: "restart",
      expectedRevision: original.revision,
      action: "cancel",
    },
    "2026-10-01T11:00:00.000Z",
  );
  if (transition.status !== "applied") throw new Error("Expected cancellation");
  await harness.repository.commitUserActionTransition({
    request: transition.request,
    event: transition.event,
  });
  await persistApplicationUserAction({
    ...base,
    runId: "after_restart",
    resultId: "after_restart",
    replayCheckpointId: "after_restart",
    occurredAt: "2026-10-01T12:00:00.000Z",
  });
  expect(
    (await harness.repository.listUserActionRequests()).find(
      (entry) =>
        entry.scope.type === "application" &&
        entry.scope.runId === "after_restart",
    )?.answerDraft,
  ).toEqual(draft);
  await persistApplicationUserAction({
    ...base,
    blocker: { ...base.blocker, questionIds: ["different"] },
    runId: "different",
    resultId: "different",
    replayCheckpointId: "different",
    occurredAt: "2026-10-01T13:00:00.000Z",
  });
  expect(
    (await harness.repository.listUserActionRequests()).find(
      (entry) =>
        entry.scope.type === "application" && entry.scope.runId === "different",
    )?.answerDraft,
  ).toBeUndefined();
});
