import {
  ApplicationPrivacyReceiptSchema,
  APPLICATION_SKIPPED_BY_PERSON_LABEL,
  PREPARED_PAGE_CLOSED_SUMMARY,
  ApplicationCrmDataSchema,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  applyActionLabel,
  applyAllActionLabel,
  OPEN_THE_BROWSER_ACTION,
  resolveApplyStatePresentation,
} from "./apply-state";

type ApplyResult = JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];

function buildResult(overrides: Partial<ApplyResult>): ApplyResult {
  return {
    id: "result_1",
    runId: "run_1",
    jobId: "job_1",
    applicationRecordId: "application_1",
    queuePosition: 0,
    state: "awaiting_review",
    summary: null,
    detail: null,
    startedAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:01:00.000Z",
    completedAt: "2026-09-14T10:01:00.000Z",
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

describe("the five apply states (ADR 0022)", () => {
  it("never recommends retry for an observed closed listing", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: buildResult({
          state: "failed",
          blockerReason: "application_closed",
          summary: "This job is no longer accepting applications.",
        }),
      }),
    ).toMatchObject({
      kind: "could_not_apply",
      title: "Listing closed",
      action: "none",
      actionLabel: null,
    });
  });

  it.each(["site_protection", "required_human_input"] as const)(
    "keeps a CAPTCHA without a question in Needs you (%s)",
    (blockerReason) => {
      expect(
        resolveApplyStatePresentation({
          mode: "fill_only",
          pendingQuestionCount: 0,
          result: buildResult({
            blockerReason,
            summary: "The site asks you to complete a CAPTCHA.",
          }),
        }),
      ).toMatchObject({
        kind: "needs_you",
        title: "Needs you",
        action: "open_browser",
      });
    },
  );

  it("gives each state one title and at most one button", () => {
    const cases: Array<{
      expected: { kind: string; title: string; actionLabel: string | null };
      result: ApplyResult;
    }> = [
      {
        expected: {
          kind: "filling_in",
          title: "Preparing (3 min)",
          actionLabel: null,
        },
        result: buildResult({
          state: "filling",
          startedAt: "2026-09-14T10:00:00.000Z",
        }),
      },
      {
        expected: {
          kind: "ready_to_send",
          title: "Ready to send",
          actionLabel: OPEN_THE_BROWSER_ACTION,
        },
        result: buildResult({ state: "awaiting_review" }),
      },
      {
        expected: { kind: "applied", title: "Applied", actionLabel: null },
        result: buildResult({ state: "submitted" }),
      },
      {
        expected: {
          kind: "needs_you",
          title: "Needs you",
          actionLabel: OPEN_THE_BROWSER_ACTION,
        },
        result: buildResult({
          state: "blocked",
          blockerReason: "auth_required",
          blockerSummary: "The site wants you signed in first.",
        }),
      },
      {
        expected: {
          kind: "could_not_apply",
          title: "Could not apply",
          actionLabel: "Try again",
        },
        result: buildResult({
          state: "failed",
          summary: "The employer site timed out before the form loaded.",
        }),
      },
      {
        // A stop a fresh run cannot change never offers a retry.
        expected: {
          kind: "could_not_apply",
          title: "Could not apply",
          actionLabel: OPEN_THE_BROWSER_ACTION,
        },
        result: buildResult({
          state: "failed",
          summary: "This listing has no apply link Job Finder can use.",
        }),
      },
    ];

    for (const testCase of cases) {
      const presentation = resolveApplyStatePresentation({
        mode: "fill_only",
        now: Date.parse("2026-09-14T10:03:00.000Z"),
        result: testCase.result,
      });

      expect(presentation.kind, testCase.expected.kind).toBe(
        testCase.expected.kind,
      );
      expect(presentation.title).toBe(testCase.expected.title);
      expect(presentation.actionLabel).toBe(testCase.expected.actionLabel);
      if (testCase.expected.actionLabel === null) {
        expect(presentation.action).toBe("none");
      }
    }
  });

  it("a ready form whose send was refused says Not sent and why", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "apply_for_me",
      result: buildResult({
        summary: "Not sent: your permission to send changed",
        detail: "Nothing was sent.",
      }),
    });
    expect(presentation).toMatchObject({
      kind: "ready_to_send",
      sentence: "Not sent: your permission to send changed. Nothing was sent.",
    });
  });

  it("an application waiting for a browser tab says so instead of filling in", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "fill_only",
      result: buildResult({
        state: "planned",
        applicationPreparationStartedAt: "2026-09-14T10:00:30.000Z",
        completedAt: null,
        summary: "Waiting for a free browser tab",
        detail: "Close a tab you no longer need and this one starts.",
      }),
      run: { state: "running" } as never,
    });
    expect(presentation).toMatchObject({
      kind: "filling_in",
      sentence: "Close a tab you no longer need and this one starts.",
    });
    expect(presentation.title).toBe("Waiting for a browser tab");
  });

  it("never calls an unverified outcome Applied", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "apply_for_me",
      result: buildResult({
        state: "blocked",
        blockerReason: "submission_outcome_uncertain",
        privacyReceipt: {
          submissionOutcome: { outcome: "outcome_uncertain" },
        } as unknown as ApplyResult["privacyReceipt"],
      }),
    });

    expect(presentation).toMatchObject({
      kind: "needs_you",
      title: "Needs you",
      action: "open_browser",
      actionLabel: OPEN_THE_BROWSER_ACTION,
    });
    expect(presentation.sentence).toContain("could not confirm");
    expect(presentation.sentence).not.toContain("click Apply");
  });

  it("does not treat a failed run's not-submitted receipt as a filled form", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "apply_for_me",
        result: buildResult({
          state: "failed",
          detail: "The assistant is unavailable. Try again shortly.",
          privacyReceipt: {
            submissionOutcome: { outcome: "not_submitted" },
          } as unknown as ApplyResult["privacyReceipt"],
        }),
      }),
    ).toMatchObject({
      kind: "could_not_apply",
      action: "try_again",
    });
  });

  it("keeps uncertain submission ahead of retryable local record failures", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "apply_for_me",
        recordFailure: {
          lastActionLabel: "The application page closed.",
          lastUpdatedAt: "2026-09-14T10:04:00.000Z",
        },
        result: buildResult({
          state: "blocked",
          blockerReason: "submission_outcome_uncertain",
        }),
      }),
    ).toMatchObject({ kind: "needs_you", action: "open_browser" });
  });

  it("lets a newer durable failed record correct an older ready result", () => {
    const result = buildResult({
      state: "awaiting_review",
      updatedAt: "2026-09-14T10:01:00.000Z",
    });
    const corrected = resolveApplyStatePresentation({
      mode: "fill_only",
      recordFailure: {
        lastActionLabel: "The prepared application page is no longer open.",
        lastUpdatedAt: "2026-09-14T10:02:00.000Z",
      },
      result,
    });
    expect(corrected).toMatchObject({
      kind: "could_not_apply",
      title: "Could not apply",
      action: "try_again",
      questionsLeftLabel: null,
    });

    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        recordFailure: {
          lastActionLabel: "An older failure.",
          lastUpdatedAt: "2026-09-14T09:59:00.000Z",
        },
        result,
      }).kind,
    ).toBe("ready_to_send");
    expect(
      resolveApplyStatePresentation({
        mode: "apply_for_me",
        recordFailure: {
          lastActionLabel: "A stale local failure.",
          lastUpdatedAt: "2026-09-14T10:03:00.000Z",
        },
        result: buildResult({ state: "submitted" }),
      }).kind,
    ).toBe("applied");
  });

  it("says how many questions are left for the person", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        pendingQuestionCount: 1,
        result: buildResult({ state: "awaiting_review" }),
      }).questionsLeftLabel,
    ).toBe("1 question left for you");
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        pendingQuestionCount: 3,
        result: buildResult({ state: "awaiting_review" }),
      }).questionsLeftLabel,
    ).toBe("3 questions left for you");
  });

  it("names the one control after the mode", () => {
    expect(applyActionLabel("fill_only")).toBe("Apply");
    expect(applyActionLabel("apply_for_me")).toBe("Apply");
    expect(applyAllActionLabel("fill_only")).toBe("Fill in all shortlisted");
    expect(applyAllActionLabel("apply_for_me")).toBe(
      "Apply to all shortlisted",
    );
  });

  it("keeps the banned jargon out of every state sentence", () => {
    const sentences = [
      buildResult({ state: "awaiting_review" }),
      buildResult({ state: "failed", summary: "The site timed out." }),
      buildResult({ state: "blocked", blockerReason: "auth_required" }),
    ].map(
      (result) =>
        resolveApplyStatePresentation({ mode: "apply_for_me", result })
          .sentence ?? "",
    );

    for (const sentence of sentences) {
      expect(sentence).not.toMatch(
        /form state|safe advance|authority envelope|configured model|prepare-only|verified writes|submit click/i,
      );
    }
  });
});

describe("a job the person asked to skip", () => {
  it("reads Skipped, not Could not apply", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "apply_for_me",
      recordLastActionLabel: APPLICATION_SKIPPED_BY_PERSON_LABEL,
      result: buildResult({ state: "skipped", summary: "Not started." }),
    });
    expect(presentation).toMatchObject({
      title: "Skipped",
      actionLabel: "Apply again",
    });
    expect(presentation.sentence).toContain("Nothing was sent");
  });
});

describe("a job its batch stopped around", () => {
  it("reads Could not apply with Try again, never Ready to send", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "apply_for_me",
      result: buildResult({
        state: "skipped",
        summary: "Not started.",
        detail:
          "You took over the browser, so Job Finder stopped this batch here. Nothing more was sent. Try again when you are ready.",
      }),
    });
    expect(presentation).toMatchObject({
      kind: "could_not_apply",
      action: "try_again",
    });
    expect(presentation.sentence).toMatch(/took over the browser/);
  });
});

describe("an answer given after the prepared page closed", () => {
  it("reads Could not apply with Try again, not a dead end", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "apply_for_me",
      result: buildResult({
        state: "failed",
        summary: "Application retry stopped safely",
        detail: "The exact prepared application page is no longer open.",
      }),
    });
    expect(presentation).toMatchObject({
      kind: "could_not_apply",
      action: "try_again",
    });
  });
});

describe("a planned job is never Filling in", () => {
  const planned = buildResult({
    state: "planned",
    startedAt: "2026-09-14T10:00:00.000Z",
    completedAt: null,
  });

  it("waits its turn while its batch runs", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        now: Date.parse("2026-09-14T10:30:00.000Z"),
        result: planned,
        run: { state: "running", activityPaused: false, started: true },
      }),
    ).toMatchObject({
      kind: "filling_in",
      title: "Waiting its turn",
      action: "none",
      plannedStanding: "waiting_turn",
    });
  });

  it("reads Paused when the person paused new work before it", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: planned,
        run: { state: "running", activityPaused: true, started: true },
      }),
    ).toMatchObject({
      kind: "filling_in",
      title: "Paused",
      action: "none",
      plannedStanding: "paused",
    });
  });

  it.each([
    "paused_for_user_review",
    "failed",
    "cancelled",
    "completed",
  ] as const)(
    "is retryable in one press when its batch stopped (%s)",
    (state) => {
      const presentation = resolveApplyStatePresentation({
        mode: "fill_only",
        result: planned,
        run: { state, activityPaused: false, started: true },
      });
      expect(presentation).toMatchObject({
        kind: "could_not_apply",
        title: "Not started",
        action: "try_again",
        plannedStanding: "not_started",
      });
      expect(presentation.sentence).toContain("Nothing was filled in or sent.");
    },
  );

  it("does not call an untouched safety-paused batch active", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: planned,
        run: {
          state: "paused_for_user_review",
          activityPaused: false,
          started: false,
        },
      }).title,
    ).toBe("Not started");
  });
  it("names the safety limit when one stopped the batch", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: planned,
        run: {
          state: "paused_for_user_review",
          activityPaused: false,
          started: true,
        },
      }).sentence,
    ).toMatch(/^A safety limit stopped the batch/);
  });

  it("keeps a started job Filling in whatever its run says", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        now: Date.parse("2026-09-14T10:03:00.000Z"),
        result: buildResult({
          state: "filling",
          startedAt: "2026-09-14T10:00:00.000Z",
        }),
        run: { state: "running", activityPaused: true, started: true },
      }),
    ).toMatchObject({ kind: "filling_in", title: "Preparing (3 min)" });
  });
});

it("shows cancellation by the person instead of the former security check", () => {
  expect(
    resolveApplyStatePresentation({
      mode: "fill_only",
      result: buildResult({
        state: "cancelled",
        summary: "Cancelled by you",
        detail: "Nothing was sent.",
        blockerReason: "site_protection",
        blockerSummary: "Complete the security check.",
      }),
    }),
  ).toMatchObject({
    title: "Cancelled by you",
    action: "try_again",
    questionsLeftLabel: null,
    // A neutral state: the badge must not read as an error.
    cancelledByPerson: true,
  });
});

describe("an application the person recorded as sent in the tracker", () => {
  const trackedCrm = (stage: "applied" | "interview" | "preparing") =>
    ApplicationCrmDataSchema.parse({
      stage,
      stageSource: "user",
      stageChangedAt: "2026-09-14T11:00:00.000Z",
    });

  it("reads as their record, with nothing to finish or retry", () => {
    const presentation = resolveApplyStatePresentation({
      mode: "fill_only",
      result: buildResult({
        state: "failed",
        summary: "The prepared application page is no longer open.",
      }),
      recordCrm: trackedCrm("interview"),
    });
    expect(presentation).toMatchObject({
      kind: "applied",
      title: "Marked applied",
      action: "none",
    });
  });

  it("leaves a stage before sending to the run's own state", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: buildResult({ state: "failed" }),
        recordCrm: trackedCrm("preparing"),
      }).kind,
    ).toBe("could_not_apply");
  });

  it("keeps a verified send as Applied", () => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: buildResult({ state: "submitted" }),
        recordCrm: trackedCrm("applied"),
      }).title,
    ).toBe("Applied");
  });
});

it("labels an automatic send as waiting, with no manual action", () => {
  expect(
    resolveApplyStatePresentation({
      mode: "apply_for_me",
      result: buildResult({
        state: "awaiting_review",
        summary: "The copy can change without changing the state.",
        automaticSendPending: true,
        detail: "Job Finder will send this application next.",
      }),
    }),
  ).toMatchObject({
    title: "Waiting to send",
    action: "none",
    actionLabel: null,
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
  expect(
    resolveApplyStatePresentation({ mode: "fill_only", result }),
  ).toMatchObject({ title: "Send not confirmed", action: "none" });
});

it("offers Prepare again for a lost prepared form", () => {
  const result = buildResult({
    state: "failed",
    summary: PREPARED_PAGE_CLOSED_SUMMARY,
    blockerReason: "unexpected_navigation",
    latestQuestionCount: 2,
  });
  // Nothing failed: the form closed before a send was seen.
  expect(
    resolveApplyStatePresentation({ mode: "fill_only", result }),
  ).toMatchObject({
    title: "Form closed",
    actionLabel: "Prepare again",
    formClosed: true,
  });
});

it("a queued job remains queued after a preparation timestamp was written", () => {
  const result = buildResult({
    state: "planned",
    applicationPreparationStartedAt: "2026-09-14T10:00:00.000Z",
  });
  expect(
    resolveApplyStatePresentation({
      mode: "fill_only",
      result,
      run: { state: "running", activityPaused: false, started: true },
    }),
  ).toMatchObject({ title: "Waiting its turn" });
});

it("a validation rejection uses the site message instead of ready-to-send copy", () => {
  const result = buildResult({
    state: "awaiting_review",
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
  expect(
    resolveApplyStatePresentation({ mode: "fill_only", result }),
  ).toMatchObject({
    title: "Not sent",
    sentence: "Select at least one skill.",
    actionLabel: "Correct the fields in the browser",
  });
});

it.each([false, true])(
  "keeps awaiting review with a blocker in Needs you (record=%s)",
  (onRecord) => {
    expect(
      resolveApplyStatePresentation({
        mode: "fill_only",
        result: buildResult({
          state: "awaiting_review",
          blockerReason: onRecord ? null : "required_human_input",
        }),
        recordLatestBlocker: onRecord
          ? {
              code: "requires_manual_review",
              summary: "Finish this step",
            }
          : null,
        pendingQuestionCount: 0,
      }),
    ).toMatchObject({ kind: "needs_you", title: "Needs you" });
  },
);
