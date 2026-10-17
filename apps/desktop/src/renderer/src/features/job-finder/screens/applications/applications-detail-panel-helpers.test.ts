import type {
  ApplicationPrivacyReceipt,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  applyResultIsFieldSavePause,
  applyResultIsServiceWorkerBlocked,
  applyResultNeedsManualFieldFinish,
  applyResultNeedsResumeAttachment,
  applicationRecordLooksSiteBlocked,
  FIELD_SAVE_PAUSE_GUIDANCE,
  FIELD_SAVE_PAUSE_NEXT_STEP,
  findActionableApplicationAnswerRequest,
  formatApplyRunModeLabel,
  formatApplyRunStateLabel,
  getApplyBlockedAttemptDetail,
  getApplyResultDestinationUrl,
  getCustomerFacingApplyText,
  getManualFieldFinishGuidance,
  getManualFieldFinishNextStep,
  getManualFieldFinishReason,
  getQueueStateExplanation,
  buildQueueEntries,
  applyRunJobNeedsPreparation,
  getQueueRecoveryTone,
  getVerifiedExternalWriteRecoveryText,
  applicationNeedsPrimaryRecovery,
  MANUAL_FIELD_CONFLICT_REASON,
  MANUAL_FIELD_FINISH_GUIDANCE,
  MANUAL_FIELD_FINISH_NEXT_STEP,
  SITE_BLOCKED_AUTOMATIC_PREP_GUIDANCE,
  SITE_BLOCKED_AUTOMATIC_PREP_LIST_NEXT_STEP,
  SITE_BLOCKED_AUTOMATIC_PREP_NEXT_STEP,
} from "./applications-detail-panel-helpers";

describe("findActionableApplicationAnswerRequest", () => {
  const request = {
    id: "request_current",
    kind: "manual_answer",
    state: "pending",
    scope: {
      type: "application",
      runId: "run_current",
      jobId: "job_1",
      applicationRecordId: "record_1",
    },
  } as unknown as NonNullable<
    JobFinderRendererWorkspaceSnapshot["userActionRequests"]
  >[number];

  const run = (
    state: JobFinderRendererWorkspaceSnapshot["applyRuns"][number]["state"],
  ) =>
    ({
      id: "run_current",
      state,
    }) as JobFinderRendererWorkspaceSnapshot["applyRuns"][number];

  it("keeps a cancelled run's stale answer request out of Applications", () => {
    expect(
      findActionableApplicationAnswerRequest({
        applicationRecordId: "record_1",
        jobId: "job_1",
        requests: [request],
        run: run("cancelled"),
      }),
    ).toBeNull();
  });

  it("returns only the live request for the visible run and record", () => {
    const stale = {
      ...request,
      id: "request_old",
      scope: { ...request.scope, runId: "run_old" },
    };

    expect(
      findActionableApplicationAnswerRequest({
        applicationRecordId: "record_1",
        jobId: "job_1",
        requests: [stale, request],
        run: run("paused_for_user_review"),
      })?.id,
    ).toBe("request_current");
  });
});

function createReceipt(
  externalWrites: ApplicationPrivacyReceipt["externalWrites"],
): ApplicationPrivacyReceipt {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-16T10:01:00.000Z",
    lineage: {
      applicationRecordId: "application-1",
      runId: "run_receipt",
      jobId: "job_receipt",
      resultId: "result_receipt",
    },
    destination: {
      origin: "https://example.com",
      safePath: "/apply",
    },
    resume: {
      source: "original_upload",
      sourceDocumentId: "resume_source",
      exportArtifactId: null,
      fileName: "resume.pdf",
      sha256: null,
    },
    stayedLocal: [],
    modelUse: [],
    externalWrites,
    accountCreationAuthorized: false,
    finalSubmitAuthorized: false,
    finalSubmitOccurred: false,
    submissionOutcome: null,
  };
}

describe("getCustomerFacingApplyText", () => {
  it("uses a plain source label in retained answer history", () => {
    expect(
      getCustomerFacingApplyText(
        'Answered "Currency" from chosen on the form.',
      ),
    ).toBe('Answered "Currency" from a choice Job Finder made on the form.');
  });

  it("keeps transport implementation language out of retained customer history", () => {
    const resumeMessage = getCustomerFacingApplyText(
      "Prepare-only guard blocked a POST xhr attempt while the resume upload was running.",
    );
    const genericMessage = getCustomerFacingApplyText(
      "Prepare-only guard blocked a mutating page action.",
    );

    expect(resumeMessage).toContain("The resume file could not be attached.");
    expect(genericMessage).toBe(
      "The application page would not keep what Job Finder filled in.",
    );
    expect(`${resumeMessage} ${genericMessage}`).not.toMatch(
      /POST|XHR|mutating page action/i,
    );
  });

  it("says the stop in one sentence with no write bookkeeping stitched on", () => {
    const message = getCustomerFacingApplyText(
      "Prepare-only guard blocked a mutating page action.",
    );

    expect(message).toBe(
      "The application page would not keep what Job Finder filled in.",
    );
    expect(message).not.toMatch(
      /verified writes|site behavior to report|submit click/i,
    );
    expect(message).not.toMatch(/fields? (?:were )?saved|fields? remain/i);
  });

  it("makes no saved or retained-field claim for a zero-write receipt", () => {
    expect(getVerifiedExternalWriteRecoveryText(createReceipt([]))).toBe(
      "Nothing was written to the employer page in this run.",
    );
  });

  it("describes only verified receipt write categories", () => {
    const receipt = createReceipt([
      {
        category: "profile_field",
        fieldLabel: "Email",
        occurredAt: "2026-07-16T10:00:00.000Z",
        artifactRefId: null,
        verified: true,
      },
      {
        category: "application_answer",
        fieldLabel: "Work authorization",
        occurredAt: "2026-07-16T10:00:30.000Z",
        artifactRefId: null,
        verified: true,
      },
      {
        category: "resume_attachment",
        fieldLabel: "Resume",
        occurredAt: "2026-07-16T10:00:45.000Z",
        artifactRefId: null,
        verified: false,
      },
    ]);

    expect(getVerifiedExternalWriteRecoveryText(receipt)).toBe(
      "Job Finder filled profile fields, application answers on the employer page. Check the page to see what the site kept.",
    );
  });

  it("preserves already customer-readable messages", () => {
    expect(
      getCustomerFacingApplyText("Resume attachment needs your help"),
    ).toBe("Resume attachment needs your help");
  });

  it("rewrites service-worker jargon into the finish-first site-block next step", () => {
    expect(
      getCustomerFacingApplyText(
        "A LinkedIn service worker blocked automated preparation.",
      ),
    ).toBe(SITE_BLOCKED_AUTOMATIC_PREP_NEXT_STEP);
    expect(
      getCustomerFacingApplyText(
        "Service worker interference on this job site.",
      ),
    ).not.toMatch(/service worker/i);
  });
});

describe("applyResultNeedsResumeAttachment", () => {
  function createResult(input: {
    detail: string;
    state: "awaiting_review" | "blocked" | "completed" | "failed";
    blockerReason?: string | null;
  }) {
    return {
      state: input.state,
      blockerReason: input.blockerReason ?? null,
      detail: input.detail,
      summary: input.detail,
      blockerSummary: null,
    } as JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
  }

  it("detects only a current failed or blocked resume attachment", () => {
    expect(
      applyResultNeedsResumeAttachment(
        createResult({
          state: "blocked",
          detail:
            "The approved CV could not be attached. Retry the attachment.",
        }),
      ),
    ).toBe(true);
    expect(
      applyResultNeedsResumeAttachment(
        createResult({
          state: "completed",
          detail: "The approved CV was attached.",
        }),
      ),
    ).toBe(false);
    expect(
      applyResultNeedsResumeAttachment(
        createResult({
          state: "failed",
          detail: "The cover letter could not be saved.",
        }),
      ),
    ).toBe(false);
  });

  it("offers the CV retry CTA for an awaiting_review result stopped by a required human decision", () => {
    expect(
      applyResultNeedsResumeAttachment(
        createResult({
          state: "awaiting_review",
          blockerReason: "required_human_input",
          detail: "Resume attachment needs your help.",
        }),
      ),
    ).toBe(true);
  });

  it("keeps non-CV awaiting_review results out of the CV retry CTA", () => {
    expect(
      applyResultNeedsResumeAttachment(
        createResult({
          state: "awaiting_review",
          blockerReason: "required_human_input",
          detail: "Answer the required work-authorization question.",
        }),
      ),
    ).toBe(false);
    expect(
      applyResultNeedsResumeAttachment(
        createResult({
          state: "awaiting_review",
          blockerReason: null,
          detail:
            "Review the prepared application before any later execution step.",
        }),
      ),
    ).toBe(false);
  });

  it("keeps a final-checkpoint missing-resume stop out of the CV attachment CTA", () => {
    const missingResume = createResult({
      state: "failed",
      blockerReason: "resume_missing",
      detail:
        "A final application control is visible, but the runtime did not locate and attach the current approved resume on this preparation path. It stopped for manual verification.",
    });
    missingResume.summary =
      "Final checkpoint reached without a verified resume upload";

    expect(applyResultNeedsResumeAttachment(missingResume)).toBe(false);
  });
});

describe("getQueueStateExplanation", () => {
  const baseInput = {
    selectedJobCount: 3,
    blockedJobCount: 0,
    skippedJobCount: 0,
    failedJobCount: 0,
    completedJobCount: 0,
    unfinishedJobCount: 3,
  };

  it("keeps an active queue framed as running even after an earlier job failed", () => {
    expect(
      getQueueStateExplanation({
        ...baseInput,
        runState: "running",
        failedJobCount: 1,
      }),
    ).toBe(
      "This run is still working through its jobs. Progress and outcomes update here as each application finishes.",
    );
  });

  it("says a stop-rule pause needs an explicit retry", () => {
    const explanation = getQueueStateExplanation({
      ...baseInput,
      runState: "paused_for_user_review",
    });

    expect(explanation).toContain("A safety limit paused this run.");
    expect(explanation).toContain("will not carry on by itself");
    expect(explanation).toContain("Open Safeguards to see the limit");
    expect(explanation).toContain(
      "press Try again on an unstarted job when the limit allows it",
    );
    // Unlike the consent pause, there is nothing to resolve to resume.
    expect(explanation).not.toContain("Needs you");
  });

  it("does not name Prepare remaining jobs when the stopped run has no unfinished work", () => {
    const explanation = getQueueStateExplanation({
      ...baseInput,
      runState: "paused_for_user_review",
      unfinishedJobCount: 0,
      completedJobCount: 3,
    });

    expect(explanation).not.toContain("Prepare remaining jobs");
  });

  it("keeps the live consent pause framed as resumable", () => {
    const explanation = getQueueStateExplanation({
      ...baseInput,
      runState: "paused_for_consent",
    });

    expect(explanation).toContain("Handle it in Needs you");
    // The common cause is a sign-in wall, so the sentence names it rather
    // than sending the reader hunting for a permission prompt.
    expect(explanation).toContain("signing in on the job site");
    expect(explanation).not.toContain("will not carry on by itself");
  });

  it("returns no explanation when no run is selected", () => {
    expect(getQueueStateExplanation(null)).toBeNull();
  });
});

describe("buildQueueEntries recovery population", () => {
  it("keeps blocked jobs in Prepare remaining jobs", () => {
    const entries = buildQueueEntries({
      applicationRecords: [],
      applyJobResults: [
        {
          id: "result_blocked",
          runId: "run_blocked",
          jobId: "job_blocked",
          applicationRecordId: null,
          state: "blocked",
        },
      ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      discoveryJobs: [],
      selectedRun: {
        id: "run_blocked",
        jobIds: ["job_blocked"],
      } as JobFinderRendererWorkspaceSnapshot["applyRuns"][number],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.includeInRecovery).toBe(true);
  });
});

describe("service-worker site block helpers", () => {
  it("detects service-worker blockers and marks recovery as primary", () => {
    const result = {
      id: "result_sw",
      runId: "run_sw",
      jobId: "job_li",
      applicationRecordId: "application_li",
      queuePosition: 0,
      state: "blocked" as const,
      summary: "A LinkedIn service worker blocked automated preparation.",
      detail: "Reset the browser profile, then finish manually.",
      startedAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:01:00.000Z",
      completedAt: "2026-08-27T10:01:00.000Z",
      blockerReason: "site_protection" as const,
      blockerSummary: "Service worker interference",
      listingSignalEvidence: null,

      latestQuestionCount: 0,
      latestAnswerCount: 0,
      pendingConsentRequestCount: 0,
      artifactCount: 0,
      latestCheckpointId: null,
      privacyReceipt: null,
      reviewCard: null,
    };

    expect(applyResultIsServiceWorkerBlocked(result)).toBe(true);
    expect(applyResultNeedsManualFieldFinish(result)).toBe(false);
    expect(
      applicationNeedsPrimaryRecovery({
        lastAttemptState: "paused",
        visibleApplyResult: result,
      }),
    ).toBe(true);
    expect(SITE_BLOCKED_AUTOMATIC_PREP_GUIDANCE).toMatch(
      /Reset the Job Finder browser in Safeguards/i,
    );
    expect(SITE_BLOCKED_AUTOMATIC_PREP_GUIDANCE).not.toMatch(/service worker/i);
  });

  it("detects site-blocked pauses from persisted application record fields", () => {
    expect(
      applicationRecordLooksSiteBlocked({
        nextActionLabel: "Inspect the application page manually",
        lastActionLabel: "Inspect the application page manually.",
        latestBlocker: null,
      }),
    ).toBe(true);
    expect(
      applicationRecordLooksSiteBlocked({
        nextActionLabel: "Apply",
        lastActionLabel: "Resume approved",
        latestBlocker: null,
      }),
    ).toBe(false);
    expect(SITE_BLOCKED_AUTOMATIC_PREP_LIST_NEXT_STEP).toMatch(
      /Open Safeguards to reset the Job Finder browser/i,
    );
  });
});

describe("manual field-finish helpers", () => {
  function createResult(input: {
    summary: string;
    detail?: string;
    blockerSummary?: string | null;
    blockerReason?: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]["blockerReason"];
    state?: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]["state"];
  }): JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] {
    return {
      id: "result_field",
      runId: "run_field",
      jobId: "job_field",
      applicationRecordId: "application_field",
      queuePosition: 0,
      state: input.state ?? "blocked",
      summary: input.summary,
      detail: input.detail ?? input.summary,
      startedAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:01:00.000Z",
      completedAt: "2026-08-27T10:01:00.000Z",
      blockerReason: input.blockerReason ?? "required_human_input",
      blockerSummary: input.blockerSummary ?? input.summary,
      listingSignalEvidence: null,

      latestQuestionCount: 0,
      latestAnswerCount: 0,
      pendingConsentRequestCount: 0,
      artifactCount: 0,
      latestCheckpointId: null,
      privacyReceipt: null,
      reviewCard: null,
    };
  }

  it("routes a manual-navigation pause to the finish-yourself path", () => {
    // The page offered no control Job Finder could press without risking a
    // send. It used to end here with nothing to click.
    const result = createResult({
      summary: "Finish this application step yourself",
      detail:
        "Job Finder could not tell which control moves this application forward without sending it, so it stopped rather than guess. Open the application and finish this step yourself.",
      blockerSummary:
        "Job Finder stopped here because it could not tell which control is safe to press. Finish this application step yourself in the open application.",
    });

    expect(applyResultNeedsManualFieldFinish(result)).toBe(true);
    expect(
      applicationNeedsPrimaryRecovery({
        lastAttemptState: "paused",
        visibleApplyResult: result,
      }),
    ).toBe(true);
  });

  it("detects conflicting prefilled fields and marks recovery as primary", () => {
    const result = createResult({
      summary: "Prefilled application values need manual review",
      detail:
        "One or more known application fields already contain values that do not match the exact saved candidate profile.",
      blockerSummary: "Prefilled application values need manual review",
    });

    expect(applyResultNeedsManualFieldFinish(result)).toBe(true);
    expect(applyResultIsServiceWorkerBlocked(result)).toBe(false);
    expect(
      applicationNeedsPrimaryRecovery({
        lastAttemptState: "paused",
        visibleApplyResult: result,
      }),
    ).toBe(true);
    expect(MANUAL_FIELD_FINISH_NEXT_STEP).toMatch(
      /Review and fix the conflicting or unfinished fields/i,
    );
    expect(MANUAL_FIELD_FINISH_GUIDANCE).toMatch(
      /Run preparation again" only if you want a fresh run/i,
    );
    // Actual conflicts keep the conflicting-fields copy.
    expect(applyResultIsFieldSavePause(result)).toBe(false);
    expect(getManualFieldFinishNextStep(result)).toBe(
      MANUAL_FIELD_FINISH_NEXT_STEP,
    );
    expect(getManualFieldFinishGuidance(result)).toBe(
      MANUAL_FIELD_FINISH_GUIDANCE,
    );
    expect(getManualFieldFinishReason(result)).toBe(
      MANUAL_FIELD_CONFLICT_REASON,
    );
  });

  it("offers browser handoff for a blocked background request without inventing a field save", () => {
    const result = createResult({
      summary: "The application page needs manual review",
      detail:
        "Job Finder blocked a background page request before it could continue preparing this application.",
      state: "awaiting_review",
    });
    expect(applyResultNeedsManualFieldFinish(result)).toBe(true);
    expect(applyResultIsFieldSavePause(result)).toBe(false);
    expect(getManualFieldFinishNextStep(result)).toContain(
      "Open a fresh application page in the Job Finder browser.",
    );
    expect(getManualFieldFinishReason(result)).not.toMatch(
      /conflict|save a field/i,
    );
  });

  it("explains a prepare-only autosave pause without claiming a field conflict", () => {
    const result = createResult({
      summary: "The application page could not safely save a prepared field",
      detail:
        "The application site tried to save 'Phone' while it was being prepared, but this run did not have permission for that external save. Job Finder stopped and left the application open instead of risking a final submission.",
      blockerSummary:
        "The application page could not safely save a prepared field",
      state: "awaiting_review",
    });

    expect(applyResultNeedsManualFieldFinish(result)).toBe(true);
    expect(applyResultIsFieldSavePause(result)).toBe(true);
    expect(getManualFieldFinishNextStep(result)).toBe(
      FIELD_SAVE_PAUSE_NEXT_STEP,
    );
    expect(getManualFieldFinishGuidance(result)).toBe(
      FIELD_SAVE_PAUSE_GUIDANCE,
    );
    expect(getManualFieldFinishReason(result)).toMatch(
      /tried to save a field automatically/i,
    );
    // One name for the window, and the instruction says the window is
    // separate and names the exact action the user comes back to.
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).toMatch(
      /tried to save a field automatically/i,
    );
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).toMatch(
      /Finish this application in the Job Finder browser\./,
    );
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).toMatch(/right here in the app/i);
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).toMatch(
      /Check whether this step is done/,
    );
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).not.toMatch(/the open browser/i);
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).not.toMatch(/the managed browser/i);
    expect(FIELD_SAVE_PAUSE_NEXT_STEP).not.toMatch(/conflict/i);
    expect(getManualFieldFinishReason(null)).toBeNull();
  });

  it("derives a query-free destination URL from the privacy receipt", () => {
    const receipt = createReceipt([]);
    expect(
      getApplyResultDestinationUrl({
        ...receipt,
        destination: {
          origin: "https://jobs.example.com",
          safePath: "/apply/123",
        },
      }),
    ).toBe("https://jobs.example.com/apply/123");
    expect(getApplyResultDestinationUrl(null)).toBeNull();
  });

  it("formats run states and modes for people", () => {
    expect(formatApplyRunStateLabel("paused_for_user_review")).toBe(
      "Paused for your review",
    );
    expect(formatApplyRunStateLabel("paused_for_consent")).toBe(
      "Paused — needs something from you",
    );
    expect(formatApplyRunStateLabel("completed")).toBe("Completed");
    expect(formatApplyRunModeLabel("copilot")).toBe("Preparation");
    expect(formatApplyRunModeLabel("single_job_auto")).toBe(
      "Automatic preparation",
    );
  });

  it("detects prepare-only field saves that require finishing in the open application", () => {
    const result = createResult({
      summary: "The application page could not safely save a prepared field",
      detail:
        "The application site tried to save 'application field' while it was being prepared, but this run did not have permission for that external save.",
      blockerSummary:
        "The application page could not safely save a prepared field",
    });

    expect(applyResultNeedsManualFieldFinish(result)).toBe(true);
  });

  it("keeps resume-attachment retries out of the manual-finish path", () => {
    const result = createResult({
      summary: "Resume attachment needs your help",
      detail: "The approved resume was not attached.",
      blockerSummary: "Resume attachment needs your help",
      state: "blocked",
    });

    expect(applyResultNeedsResumeAttachment(result)).toBe(true);
    expect(applyResultNeedsManualFieldFinish(result)).toBe(false);
  });
});

describe("blocked-attempt diagnostics", () => {
  const stopText =
    "Job Finder blocked a background page request before it could continue preparing this application. Review the application in the browser; no submission was made. Blocked: xhr POST https://example.test/cdn-cgi/rum?req=1.";

  it("leads with the plain sentence and keeps the request line for a disclosure", () => {
    expect(getCustomerFacingApplyText(stopText)).toBe(
      "Job Finder blocked a background page request before it could continue preparing this application. Review the application in the browser; no submission was made.",
    );
    expect(getApplyBlockedAttemptDetail(stopText)).toBe(
      "Blocked: xhr POST https://example.test/cdn-cgi/rum?req=1.",
    );
  });

  it("leaves text without a recorded attempt untouched", () => {
    expect(getCustomerFacingApplyText("This page needs a human.")).toBe(
      "This page needs a human.",
    );
    expect(getApplyBlockedAttemptDetail("This page needs a human.")).toBeNull();
  });
});

it("lets the person retry a cancelled item without including it in the remaining batch", () => {
  const result = {
    state: "cancelled",
    applicationRecordId: "application_1",
  } as JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
  expect(
    applicationNeedsPrimaryRecovery({
      lastAttemptState: "cancelled",
      visibleApplyResult: result,
    }),
  ).toBe(true);
  expect(applyRunJobNeedsPreparation(result)).toBe(false);
  expect(
    applyRunJobNeedsPreparation({ ...result, applicationRecordId: null }),
  ).toBe(false);
  expect(getQueueRecoveryTone("cancelled")).toBe(
    getQueueRecoveryTone("failed"),
  );
});

it("counts question waits as pending work without inventing a safety limit", () => {
  expect(
    getQueueStateExplanation({
      runState: "paused_for_user_review",
      selectedJobCount: 2,
      blockedJobCount: 0,
      skippedJobCount: 0,
      failedJobCount: 0,
      completedJobCount: 0,
      waitingJobCount: 2,
      unfinishedJobCount: 0,
    }),
  ).toBe(
    "0 sent. 2 applications need your answers or review. Open each waiting application to continue.",
  );
});

it("describes a failed preparation without internal workflow jargon", () => {
  expect(
    getQueueStateExplanation({
      runState: "completed",
      selectedJobCount: 1,
      blockedJobCount: 0,
      skippedJobCount: 0,
      failedJobCount: 1,
      completedJobCount: 0,
      unfinishedJobCount: 1,
    }),
  ).toBe(
    "Some applications could not be prepared. Check each job below before trying again.",
  );
});
