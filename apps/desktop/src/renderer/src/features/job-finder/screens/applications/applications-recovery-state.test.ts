import { describe, expect, it } from "vitest";
import {
  ApplicationPrivacyReceiptSchema,
  APPLICATION_SKIPPED_BY_PERSON_LABEL,
  PREPARED_PAGE_CLOSED_SUMMARY,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nordri/contracts";
import {
  applyResultStoppedStructurally,
  buildApplyRunContextReader,
  formatQuestionPrompt,
  getApplicationStopReasonSentence,
  resolveApplicationRecoveryPresentation,
} from "./applications-recovery-state";

type ApplyResult = JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];

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

function resolve(result: ApplyResult | null, isApplyPending = false) {
  return resolveApplicationRecoveryPresentation({
    canOpenSafeguards: true,
    isApplyPending,
    visibleApplyResult: result,
  });
}

describe("resolveApplicationRecoveryPresentation", () => {
  it.each(["site_protection", "required_human_input"] as const)(
    "opens the browser for a CAPTCHA instead of repeating preparation (%s)",
    (blockerReason) => {
      const result = buildResult({
        state: "awaiting_review",
        blockerReason,
        summary: "The site asks you to complete a CAPTCHA.",
      });
      expect(resolve(result)).toMatchObject({
        statusLine: "This application needs a security check",
        primaryAction: "open_browser",
      });
      if (blockerReason === "required_human_input") {
        expect(resolve({ ...result, state: "skipped" }).primaryAction).toBe(
          "try_again",
        );
      }
    },
  );

  it.each(["failed", "skipped"] as const)(
    "offers retry after a question step ends as %s despite retained questions",
    (state) => {
      const result = buildResult({
        state,
        blockerReason: "required_human_input",
        latestQuestionCount: 4,
        detail: "The person closed this step. Choose Try again to continue.",
      });
      expect(
        resolveApplicationRecoveryPresentation({
          canOpenSafeguards: false,
          isApplyPending: false,
          pausedQuestionCount: 4,
          visibleApplyResult: result,
        }),
      ).toMatchObject({
        state: "retry",
        statusLine: "This application did not finish",
        primaryAction: "try_again",
        primaryActionLabel: "Try again",
        reasonSentence: result.detail,
      });
    },
  );

  it("does not retry a failed question result with an uncertain submission", () => {
    expect(
      resolve(
        buildResult({
          state: "failed",
          blockerReason: "required_human_input",
          latestQuestionCount: 4,
          privacyReceipt: {
            submissionOutcome: { outcome: "outcome_uncertain" },
          } as ApplyResult["privacyReceipt"],
        }),
      ),
    ).toMatchObject({ state: "verify_outcome", primaryAction: "none" });
  });

  it("shows a confirmed submission as terminal and never offers Try again", () => {
    const presentation = resolve(
      buildResult({
        state: "submitted",
        summary: "Application submitted",
        detail: "The employer site confirmed that it received the application.",
        privacyReceipt: {
          finalSubmitOccurred: true,
          submissionOutcome: { outcome: "submitted" },
        } as ApplyResult["privacyReceipt"],
      }),
    );

    expect(presentation.state).toBe("submitted");
    expect(presentation.statusLine).toBe("Application submitted");
    expect(presentation.primaryAction).toBe("none");
    expect(presentation.primaryActionLabel).toBeNull();
  });

  it("keeps an old person-send claim unconfirmed without a receipt", () => {
    const presentation = resolve(
      buildResult({
        state: "submitted",
        summary: "You sent this application yourself on the site.",
        detail:
          "The site showed its confirmation after you sent the form Job Finder filled in. Job Finder did not press send.",
        privacyReceipt: null,
      }),
    );

    expect(presentation).toMatchObject({
      state: "verify_outcome",
      statusLine: "Not confirmed",
      primaryAction: "none",
      primaryActionLabel: null,
    });
  });

  it("keeps an uncertain submission terminal until a person verifies it", () => {
    const presentation = resolve(
      buildResult({ blockerReason: "submission_outcome_uncertain" }),
    );

    expect(presentation.state).toBe("verify_outcome");
    expect(presentation.primaryAction).toBe("none");
    expect(presentation.primaryActionLabel).toBeNull();
  });

  it("gives a running preparation a sentence and no action", () => {
    const presentation = resolve(buildResult({ state: "filling" }), true);

    expect(presentation.state).toBe("preparing");
    expect(presentation.primaryAction).toBe("none");
    expect(presentation.primaryActionLabel).toBeNull();
  });

  it("does not repeat an obsolete blocker summary after exact-page verification reaches review", () => {
    const result = buildResult({
      state: "awaiting_review",
      summary: "The CAPTCHA still needs to be completed.",
      detail: "The CAPTCHA still needs to be completed.",
      blockerReason: null,
      blockerSummary: null,
    });

    expect(getApplicationStopReasonSentence(result)).toBeNull();
    expect(resolve(result)).toMatchObject({
      state: "finish_in_browser",
      statusLine: "Ready for you to read over and send",
      reasonSentence:
        "Job Finder filled the form in and stopped before the send button.",
    });
  });

  it("lets a pause the person must finish outrank the in-flight flag", () => {
    const presentation = resolve(
      buildResult({
        blockerSummary: "Conflicting application fields need manual review.",
      }),
      true,
    );

    expect(presentation.state).toBe("finish_in_browser");
    expect(presentation.primaryActionLabel).toBe("Open the Job Finder browser");
  });

  it("sends sign-in, account, and security-check stops to the browser", () => {
    for (const blockerReason of [
      "auth_required",
      "site_protection",
      "signup_consent_required",
    ] as const) {
      const presentation = resolve(buildResult({ blockerReason }));
      expect(presentation.state).toBe("needs_sign_in");
      expect(presentation.primaryActionLabel).toBe(
        "Open the Job Finder browser",
      );
    }
  });

  it("offers Try again only where a retry could change the reason", () => {
    const retryable = resolve(
      buildResult({
        state: "failed",
        summary: "The employer site timed out before the form loaded.",
      }),
    );
    expect(retryable.state).toBe("retry");
    expect(retryable.primaryActionLabel).toBe("Try again");

    const structural = resolve(
      buildResult({
        state: "failed",
        summary: "This listing has no apply link Job Finder can use.",
      }),
    );
    expect(structural.state).toBe("structural_stop");
    expect(structural.primaryAction).toBe("open_listing");
    expect(structural.primaryActionLabel).toBe(
      "Open the listing in the Job Finder browser",
    );
  });

  it("treats a timed-out closed-looking page as retryable rather than structural", () => {
    expect(
      applyResultStoppedStructurally(
        buildResult({
          state: "failed",
          summary:
            "The listing is closed to us right now — the site timed out.",
        }),
      ),
    ).toBe(false);
  });

  it("offers Prepare again when the exact prepared browser page was lost", () => {
    const presentation = resolve(
      buildResult({
        state: "failed",
        blockerReason: "unexpected_navigation",
        summary: "The prepared application page is no longer open.",
      }),
    );

    expect(presentation.state).toBe("retry");
    expect(presentation.primaryActionLabel).toBe("Prepare again");
  });

  it("always carries a reason sentence for a stopped run", () => {
    const presentation = resolve(
      buildResult({
        state: "failed",
        summary: "Job Finder could not finish this application",
        blockerSummary: "The run never left the job listing page.",
      }),
    );

    expect(presentation.reasonSentence).toBe(
      "The run never left the job listing page.",
    );
    expect(presentation.reasonSentence).not.toMatch(/nothing blocking/i);
  });

  it("prefers the blocker sentence over the general summary", () => {
    expect(
      getApplicationStopReasonSentence(
        buildResult({
          summary: "Attempt finished.",
          blockerSummary: "The apply button never appeared.",
        }),
      ),
    ).toBe("The apply button never appeared.");
  });

  it("makes an unverified outcome terminal with no action at all", () => {
    const presentation = resolve(
      buildResult({ blockerReason: "submission_outcome_uncertain" }),
    );

    expect(presentation.state).toBe("verify_outcome");
    expect(presentation.primaryAction).toBe("none");
  });

  it("takes the Built In sign-in stop from the run's own detail, not the generic summary", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      destinationUrl: "https://www.builtinchicago.org/auth/login",
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "failed",
        summary: "Job Finder could not finish this application",
        detail:
          "Job Finder got stuck: Blocked by a Built In sign-in wall requiring login before applying, which I cannot bypass.",
      }),
    });

    expect(presentation.state).toBe("needs_sign_in");
    expect(presentation.primaryActionLabel).toBe("Open the Job Finder browser");
    expect(presentation.reasonSentence).toBe(
      "This site asks you to sign in before applying. Sign in in the Job Finder browser and Job Finder can pick the application back up.",
    );
  });

  it("strips the stuck prefix and never falls back to a could-not-finish summary", () => {
    expect(
      getApplicationStopReasonSentence(
        buildResult({
          state: "failed",
          summary: "Job Finder could not finish this application",
          detail:
            "Job Finder stopped on builtinchicago.org because it got stuck: The apply button opened an empty modal.",
        }),
      ),
    ).toBe("The apply button opened an empty modal.");

    expect(
      getApplicationStopReasonSentence(
        buildResult({
          state: "failed",
          summary: "Job Finder could not finish this application",
        }),
      ),
    ).toBeNull();
  });

  it("reads a login page from the final URL even with no blocker code", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      destinationUrl: "https://jobs.example.com/sso/signin?next=/apply",
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "failed",
        detail: "The run ended on a page with no application form.",
      }),
    });

    expect(presentation.state).toBe("needs_sign_in");
    expect(presentation.primaryAction).toBe("open_browser");
  });

  it("treats an account wall like a sign-in wall with its own sentence", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      destinationUrl: "https://jobs.example.com/apply",
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "signup_consent_required",
        detail:
          "Job Finder got stuck: the site wants an account before you can apply.",
      }),
    });

    expect(presentation.state).toBe("needs_sign_in");
    expect(presentation.statusLine).toBe(
      "This application needs an account first",
    );
    expect(presentation.reasonSentence).toMatch(
      /never creates accounts for you/,
    );
    expect(presentation.primaryActionLabel).toBe("Open the Job Finder browser");
    expect(presentation.primaryAction).not.toBe("try_again");
  });

  it("keeps every stop reason free of the banned operations copy", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "blocked",
        summary:
          "Prepare-only guard blocked a POST xhr attempt while the resume upload was running.",
      }),
    });

    expect(presentation.reasonSentence).toBe(
      "The resume file could not be attached.",
    );
    expect(presentation.reasonSentence).not.toMatch(
      /verified writes|site behavior to report|submit click|safe review checkpoint/i,
    );
  });

  it("shows the form's question and sends the person to Needs you", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "question_grounding_failed",
        blockerSummary:
          'Job Finder stopped on "Are you subject to any employment agreements?". Nothing in your profile answers this.',
      }),
    });

    expect(presentation.state).toBe("needs_answer");
    expect(presentation.reasonSentence).toBe(
      "The form asks: Are you subject to any employment agreements?",
    );
    expect(presentation.primaryActionLabel).toBe("Answer the questions");
    expect(presentation.primaryAction).not.toBe("try_again");
  });

  it("offers a plain retry when an older run stopped because the site saves as you type", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      destinationUrl: "https://www.boards.example.com/apply/123",
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerSummary:
          'The site tried to save your answer to "First Name" straight away. Job Finder blocked it and stopped, so nothing was sent.',
      }),
    });

    expect(presentation.state).toBe("site_saves_as_you_go");
    expect(presentation.reasonSentence).toBe(
      "This site saves your answers as you type. Job Finder now lets sites do that, so run it again.",
    );
    expect(presentation.primaryActionLabel).toBe("Try again");
    expect(presentation.primaryAction).toBe("try_again");
  });

  it("prints a field description only when it differs from the label", () => {
    expect(formatQuestionPrompt("Phone — Phone")).toBe("Phone");
    expect(formatQuestionPrompt("Phone — Mobile number")).toBe(
      "Phone — Mobile number",
    );

    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "question_grounding_failed",
        blockerSummary: 'Job Finder stopped on "Phone — Phone".',
      }),
    });

    expect(presentation.reasonSentence).toBe("The form asks: Phone");
  });

  it("counts the questions when the form is waiting on more than one", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      pausedQuestionCount: 3,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "question_grounding_failed",
        blockerSummary: 'Job Finder stopped on "Phone".',
      }),
    });

    expect(presentation.reasonSentence).toBe("The form asks 3 questions.");
    expect(presentation.primaryActionLabel).toBe("Answer the questions");
  });

  it("offers a same-record retry after the current resume-review blocker clears", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      recordLatestBlockerCode: null,
      visibleApplyResult: buildResult({
        state: "blocked",
        blockerReason: "required_human_input",
        blockerSummary:
          "The resume for 'Senior Product Designer' leaves out a role that Job Finder wants you to confirm first.",
      }),
    });

    expect(presentation.state).toBe("retry");
    expect(presentation.primaryActionLabel).toBe("Try again");
  });

  it("keeps the saved outcome until this application's retry actually starts", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: true,
      now: Date.parse("2026-09-01T11:37:00.000Z"),
      visibleApplyResult: buildResult({ state: "blocked" }),
    });

    expect(presentation.state).toBe("retry");
    expect(presentation.statusLine).not.toContain("37 min");
  });

  it("keeps saying it is working for as long as the run record is running", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      // The local pending flag has long since expired.
      isApplyPending: false,
      now: Date.parse("2026-09-01T10:07:00.000Z"),
      visibleApplyResult: buildResult({
        state: "filling",
        startedAt: "2026-09-01T10:00:00.000Z",
      }),
    });

    expect(presentation.state).toBe("preparing");
    expect(presentation.statusLine).toBe(
      "Job Finder is filling in the form (7 min)",
    );
    expect(presentation.primaryAction).toBe("none");
    expect(presentation.primaryActionLabel).toBeNull();
  });
});

describe("a planned job's standing in its batch", () => {
  const planned = buildResult({
    runId: "run_1",
    state: "planned",
    completedAt: null,
  });

  it("reads what the run is doing from the workspace", () => {
    const read = buildApplyRunContextReader({
      applyRuns: [
        { id: "run_1", state: "running" },
      ] as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"],
      applyJobResults: [
        buildResult({
          id: "result_0",
          runId: "run_1",
          state: "awaiting_review",
        }),
        planned,
      ],
      activityControl: { paused: true, pauseBehavior: "finish_current" },
    });
    expect(read(planned)).toEqual({
      state: "running",
      activityPaused: true,
      started: true,
    });
    expect(read(buildResult({ runId: "run_gone" }))).toBeNull();
  });

  it("offers Try again for a job a safety limit left behind", () => {
    expect(
      resolveApplicationRecoveryPresentation({
        canOpenSafeguards: true,
        isApplyPending: false,
        run: {
          state: "paused_for_user_review",
          activityPaused: false,
          started: true,
        },
        visibleApplyResult: planned,
      }),
    ).toMatchObject({
      state: "retry",
      statusLine: "Job Finder did not get to this application",
      primaryAction: "try_again",
    });
  });

  it("says Paused, with no action, while the person's pause holds it", () => {
    expect(
      resolveApplicationRecoveryPresentation({
        canOpenSafeguards: true,
        isApplyPending: false,
        run: { state: "running", activityPaused: true, started: true },
        visibleApplyResult: planned,
      }),
    ).toMatchObject({
      statusLine: "Paused before this application",
      primaryAction: "none",
    });
  });

  it("waits its turn in a batch that is still going", () => {
    expect(
      resolveApplicationRecoveryPresentation({
        canOpenSafeguards: true,
        isApplyPending: false,
        run: { state: "running", activityPaused: false, started: true },
        visibleApplyResult: planned,
      }),
    ).toMatchObject({
      statusLine: "Waiting its turn",
      primaryAction: "none",
    });
  });
});

describe("a job the person asked to skip", () => {
  it("reads as skipped with Apply again, not as an unfinished application", () => {
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: false,
      isApplyPending: false,
      recordLastActionLabel: APPLICATION_SKIPPED_BY_PERSON_LABEL,
      visibleApplyResult: buildResult({ state: "failed" }),
    });
    expect(presentation).toMatchObject({
      statusLine: "Skipped at your request",
      primaryActionLabel: "Apply again",
    });
  });
});

it("names cancellation before interpreting any retained security-check evidence", () => {
  expect(
    resolve(
      buildResult({
        state: "cancelled",
        summary: "Cancelled by you",
        detail: "Nothing was sent.",
        blockerReason: "site_protection",
        blockerSummary: "Complete the security check.",
      }),
    ),
  ).toMatchObject({
    statusLine: "Cancelled by you",
    reasonSentence: "Nothing was sent.",
    primaryAction: "try_again",
  });
});

it.each(["planned", "awaiting_review", "failed"] as const)(
  "another job's pending work does not replace selected %s state",
  (state) => {
    const result = buildResult({
      state,
      completedAt: state === "planned" ? null : "2026-09-01T10:01:00.000Z",
    });
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: false,
      isApplyPending: true,
      visibleApplyResult: result,
      run: { state: "running", activityPaused: false, started: true },
    });
    expect(presentation.statusLine).not.toContain("Filling");
    if (state === "planned")
      expect(presentation.statusLine).toBe("Waiting its turn");
    if (state === "awaiting_review")
      expect(presentation.state).toBe("finish_in_browser");
    if (state === "failed") expect(presentation.state).toBe("retry");
  },
);

it("waiting automatic send offers no competing manual send", () => {
  expect(
    resolve(
      buildResult({
        state: "awaiting_review",
        summary: "The copy can change without changing the state.",
        automaticSendPending: true,
        detail: "Job Finder will send this application next.",
      }),
    ),
  ).toMatchObject({
    statusLine: "Waiting for automatic send",
    primaryAction: "none",
  });
});

it("does not call a contradictory submitted state a send", () => {
  const result = buildResult({
    state: "submitted",
    privacyReceipt: ApplicationPrivacyReceiptSchema.parse({
      generatedAt: "2026-09-14T10:00:00.000Z",
      lineage: {
        runId: "run_1",
        jobId: "job_1",
        resultId: "result_1",
        applicationRecordId: "application_1",
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
  expect(resolve(result)).toMatchObject({
    statusLine: "Not confirmed",
    primaryAction: "none",
  });
});

it("offers Prepare again for a lost prepared form", () => {
  const result = buildResult({
    state: "failed",
    summary: PREPARED_PAGE_CLOSED_SUMMARY,
    blockerReason: "unexpected_navigation",
    latestQuestionCount: 2,
  });
  expect(resolve(result)).toMatchObject({
    statusLine: "Prepare again",
    primaryActionLabel: "Prepare again",
  });
});

it.each(["Waiting for a free browser tab", "Waiting its turn"])(
  "a planned result with a preparation timestamp stays queued: %s",
  (summary) => {
    const result = buildResult({
      state: "planned",
      summary,
      applicationPreparationStartedAt: "2026-09-01T10:00:00.000Z",
    });
    const presentation = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: false,
      isApplyPending: true,
      visibleApplyResult: result,
      run: { state: "running", activityPaused: false, started: true },
    });
    expect(presentation.statusLine).toBe(
      summary.startsWith("Waiting for")
        ? "Waiting for a browser tab"
        : "Waiting its turn",
    );
  },
);

it("shows the exact validation rejection ahead of stale ready wording", () => {
  const result = buildResult({
    state: "awaiting_review",
    detail: "Ready for you to read over and send",
    privacyReceipt: {
      submissionOutcome: {
        outcome: "not_submitted",
        browserAction: {
          reason: "form_validation_failed",
          detail: "Select at least one skill.",
        },
      },
    } as unknown as ApplyResult["privacyReceipt"],
  });
  expect(resolve(result)).toMatchObject({
    statusLine: "Not sent",
    reasonSentence: "Select at least one skill.",
    primaryAction: "open_browser",
    primaryActionLabel: "Correct the fields in the browser",
  });
});

it("shows a repeated stop sentence only once in Next step", () => {
  const result = buildResult({
    state: "failed",
    summary: "Could not finish",
    detail:
      "The listing has no application form. The listing has no application form.",
    startedAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
  });
  expect(getApplicationStopReasonSentence(result)).toBe(
    "The listing has no application form.",
  );
});

it("shows a saved person-send receipt and its reference without claiming automation sent it", () => {
  const presentation = resolveApplicationRecoveryPresentation({
    visibleApplyResult: null,
    canOpenSafeguards: false,
    isApplyPending: false,
    personSendReceiptSummary: "The site confirmed receipt. Reference: SYN-25.",
  });
  expect(presentation).toMatchObject({
    state: "submitted",
    reasonSentence: "The site confirmed receipt. Reference: SYN-25.",
    primaryAction: "none",
  });
});

it("offers Prepare again after Tracker Undo instead of the withdrawn summary", () => {
  expect(
    resolve(
      buildResult({
        state: "skipped",
        summary: "Withdrawal undone. Prepare again.",
        detail: "Your previous tracker stage is restored.",
      }),
    ),
  ).toMatchObject({
    statusLine: "Prepare again",
    primaryActionLabel: "Prepare again",
    reasonSentence: "Your previous tracker stage is restored.",
  });
});
