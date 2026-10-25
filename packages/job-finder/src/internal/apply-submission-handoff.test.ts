import type { ApplyAgentResult } from "@nestor/browser-agent";

import type { ApplicationSubmissionRuntimeInput } from "./application-submission-runtime";
import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
} from "@nestor/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it, test, vi } from "vitest";

import {
  decideApplySubmissionHandoff,
  deriveApplySubmissionCapacity,
  submitPreparedApplication,
  describeSubmissionOutcome,
  enforceResolvedApplyAuthorityResult,
  selectSubmissionAttemptIds,
  sendPreparedApplication,
  SITE_UNREACHABLE_REASON,
} from "./apply-submission-handoff";

/**
 * What happens to a filled-in application, mode by mode.
 *
 * The one rule underneath all three: filling a form in and sending it are
 * separate acts. Preparation never sends; sending is one recorded, unrepeatable
 * attempt whose outcome only the employer's site can settle.
 */

const NOW = "2026-09-14T10:00:00.000Z";
const LATER = "2026-09-20T10:00:00.000Z";
const EARLIER = "2026-09-01T10:00:00.000Z";

const answerPolicy = {
  approvedAnswerSnapshot: { revision: 3, digest: "b".repeat(64) },
  unknownRequiredQuestion: "pause_for_user" as const,
  unknownEligibility: "pause_for_user" as const,
  unknownLegalRequirement: "pause_for_user" as const,
  preApprovedAttestationKinds: [],
  salaryDisclosure: "pause_for_user" as const,
};

const stopConditions = {
  unavailableCredentials: "pause_for_user" as const,
  loginRequired: "pause_for_user" as const,
  mfaRequired: "pause_for_user" as const,
  captcha: "pause_for_user" as const,
  antiBot: "pause_for_user" as const,
  accountCreation: "pause_for_user" as const,
  staleObservation: "pause_for_user" as const,
  ambiguousFinalControl: "pause_for_user" as const,
  originDrift: "pause_for_user" as const,
  outcomeUncertain: "stop_no_retry" as const,
};

function envelope(mode: "confirm_before_submit" | "autonomous_submit") {
  const content = { version: 1 as const, answerPolicy, stopConditions };
  return ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_test",
    mode,
    status: "active",
    revision: 4,
    scope: { campaignId: null, jobIds: ["job_test"] },
    maxApplicationsPerRun: 10,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: ["a".repeat(64)],
    allowedOrigins: ["https://apply.example.test"],
    createdAt: EARLIER,
    expiresAt: LATER,
    revokedAt: null,
    decisionPolicy: {
      ...content,
      revision: 2,
      digest: createHash("sha256")
        .update(serializeApplicationAuthorityDecisionPolicyForDigest(content))
        .digest("hex"),
    },
  });
}

function result(overrides: Partial<ApplyAgentResult> = {}): ApplyAgentResult {
  return {
    outcome: "ready_to_send",
    reason: "Filled in and ready.",
    steps: 9,
    finalUrl: "https://apply.example.test/form",
    filled: [],
    attachments: [],
    pauses: [],
    notes: [],
    timeline: [],
    modelTurns: 0,
    readyToSend: { actionRef: "a3", actionLabel: "Submit application" },
    ...overrides,
  };
}

describe("what happens to a filled-in application", () => {
  test("fill-in-only stops with the form complete and nothing sent", () => {
    const handoff = decideApplySubmissionHandoff({
      result: result(),
      mode: "prepare_only",
      envelope: null,
      siteLabel: "the careers site",
    });
    expect(handoff.status).toBe("not_ready");
    if (handoff.status === "not_ready") {
      expect(handoff.reason).toContain("nothing was sent");
    }
  });

  test("confirm-first hands it to the person with the send button already found", () => {
    const handoff = decideApplySubmissionHandoff({
      result: result(),
      mode: "confirm_before_submit",
      envelope: envelope("confirm_before_submit"),
      siteLabel: "the careers site",
    });
    expect(handoff.status).toBe("awaiting_your_review");
    if (handoff.status === "awaiting_your_review") {
      expect(handoff.finalAction.actionLabel).toBe("Submit application");
      expect(handoff.reason).toContain("Look it over");
    }
  });

  test("sending on its own hands it straight to the submission path", () => {
    const handoff = decideApplySubmissionHandoff({
      result: result(),
      mode: "autonomous_submit",
      envelope: envelope("autonomous_submit"),
      siteLabel: "the careers site",
    });
    expect(handoff.status).toBe("send_now");
  });

  test("anything still waiting on the person is never sent, in any mode", () => {
    for (const mode of [
      "prepare_only",
      "confirm_before_submit",
      "autonomous_submit",
    ] as const) {
      const handoff = decideApplySubmissionHandoff({
        result: result({
          pauses: [
            {
              code: "question_needs_you",
              summary: 'Job Finder stopped on "Expected salary".',
              question: null,
              blocker: null,
            },
          ],
        }),
        mode,
        envelope: mode === "prepare_only" ? null : envelope(mode),
        siteLabel: "the careers site",
      });
      expect(handoff.status).toBe("not_ready");
      if (handoff.status === "not_ready") {
        expect(handoff.reason).toContain("Expected salary");
      }
    }
  });

  test("a form that never became complete is not sent even with full permission", () => {
    const handoff = decideApplySubmissionHandoff({
      result: result({ readyToSend: null, outcome: "prepared" }),
      mode: "autonomous_submit",
      envelope: envelope("autonomous_submit"),
      siteLabel: "the careers site",
    });
    expect(handoff.status).toBe("not_ready");
  });
});

describe("handing one application to the submission path", () => {
  test("carries the exact permission, its policy, and the approved answers", async () => {
    const runSubmission = vi.fn((input: ApplicationSubmissionRuntimeInput) =>
      Promise.resolve({
        input,
        status: "outcome_uncertain" as const,
        decision: null,
        preflight: null,
        idempotency: null,
        executionGrant: null,
        outcome: null,
      } as never),
    );

    const active = envelope("autonomous_submit");
    await sendPreparedApplication(
      {
        repository: {} as never,
        browserRuntime: {} as never,
        source: "target_site",
        envelope: active,
        lineage: {
          runId: "run_1",
          jobId: "job_test",
          resultId: "result_1",
          applicationRecordId: "application_1",
          campaignId: null,
        },
        capacity: { remainingRunCapacity: 3 },
        resumeBytes: new Uint8Array([1, 2, 3]),
        idempotencyKey: "idempotency_1",
        preflightId: "preflight_1",
        now: NOW,
      },
      runSubmission,
    );

    expect(runSubmission).toHaveBeenCalledTimes(1);
    expect(runSubmission.mock.calls[0]?.[0]).toMatchObject({
      savedMode: "autonomous_submit",
      authorityEnvelopeId: active.id,
      authorityRevision: 4,
      idempotencyKey: "idempotency_1",
      answers: { revision: 3, digest: "b".repeat(64) },
      currentPolicyFacts: {
        policy: { version: 1, revision: 2 },
        mandatoryStops: [],
      },
    });
  });
});

describe("what the person is told after an attempt", () => {
  test("an uncertain outcome is never offered a retry", () => {
    const told = describeSubmissionOutcome({
      result: { status: "outcome_uncertain" } as never,
      siteLabel: "Northwind careers",
    });
    expect(told.summary).toBe("Check whether this application was sent");
    expect(told.detail).toContain("will not send it again");
    expect(told.nextActionLabel).toBe("Check the site and confirm");
    expect(told.detail).not.toMatch(/try again|retry/iu);
  });

  test("nothing sent says so plainly", () => {
    const told = describeSubmissionOutcome({
      result: { status: "recorded_not_submitted" } as never,
      siteLabel: "Northwind careers",
    });
    // Home reads the words after "Not sent: " as the reason.
    expect(told.summary).toBe("Not sent: the form was not ready to send");
    expect(told.detail).toContain("Nothing was sent");
  });
});

describe("the safety net on a preparation result", () => {
  test("a preparation that claims it sent something is refused, in every mode", () => {
    for (const mode of [
      "prepare_only",
      "confirm_before_submit",
      "autonomous_submit",
    ] as const) {
      expect(() =>
        enforceResolvedApplyAuthorityResult(
          { mode },
          {
            state: "submitted",
            summary: "Sent",
            detail: "Sent",
            submittedAt: NOW,
            outcome: "submitted",
            questions: [],
            blocker: null,
            consentDecisions: [],
            replay: {},
            visualEvidence: [],
            visualObservationSets: [],
            visualCheckpoints: [],
            nextActionLabel: null,
            checkpoints: [],
          } as never),
      ).toThrow(/Preparation never sends anything/iu);
    }
  });
});

describe("sending, gathered at the moment it is asked", () => {
  const lineage = {
    runId: "run_1",
    jobId: "job_test",
    resultId: "result_1",
    applicationRecordId: "application_1",
    campaignId: null,
  };

  function repositoryWith(
    outcomes: readonly { runId: string; attemptedAt: string }[],
  ) {
    return {
      listSubmissionOutcomeRecords: () => Promise.resolve(outcomes),
    } as unknown as Parameters<
      typeof submitPreparedApplication
    >[0]["repository"];
  }

  test("one application uses one key, so a second press cannot send a second", async () => {
    const runSubmission = vi.fn((input: ApplicationSubmissionRuntimeInput) =>
      Promise.resolve({ status: "outcome_uncertain", input } as never),
    );
    const send = () =>
      submitPreparedApplication({
        repository: repositoryWith([]),
        browserRuntime: {} as never,
        source: "target_site",
        envelope: envelope("autonomous_submit"),
        lineage,
        loadResumeBytes: () => Promise.resolve(new Uint8Array([1])),
        now: NOW,
        runSubmission,
      });

    await send();
    await send();

    const [first, second] = runSubmission.mock.calls.map((call) => call[0]);
    expect(first?.idempotencyKey).toBe("submission_run_1_job_test_result_1");
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(first?.preflightId).toBe("preflight_run_1_job_test_result_1");
  });

  test("the allowance counts attempts that happened, per run and per day", async () => {
    const runSubmission = vi.fn((input: ApplicationSubmissionRuntimeInput) =>
      Promise.resolve({ status: "outcome_uncertain", input } as never),
    );

    await submitPreparedApplication({
      repository: repositoryWith([
        { runId: "run_1", attemptedAt: NOW },
        { runId: "run_other", attemptedAt: NOW },
        // An earlier day still counts against this run's own allowance, which
        // is per run rather than per day.
        { runId: "run_1", attemptedAt: "2026-09-01T10:00:00.000Z" },
      ]),
      browserRuntime: {} as never,
      source: "target_site",
      envelope: envelope("autonomous_submit"),
      lineage,
      loadResumeBytes: () => Promise.resolve(new Uint8Array([1])),
      now: NOW,
      runSubmission,
    });

    expect(runSubmission.mock.calls[0]?.[0]?.capacity).toEqual({
      // 10 per run, two already attempted in this run whenever they happened.
      remainingRunCapacity: 8,
    });
  });

  test("a spent allowance is zero rather than a negative number", () => {
    const spent = deriveApplySubmissionCapacity({
      envelope: envelope("autonomous_submit"),
      outcomes: Array.from({ length: 25 }, () => ({
        runId: "run_1",
        attemptedAt: NOW,
      })),
      runId: "run_1",
      now: NOW,
    });
    expect(spent).toEqual({
      remainingRunCapacity: 0,
    });
  });
});

describe("what the person is told when the page showed a confirmation", () => {
  test("counts the employer's receipt confirmation as submitted", () => {
    const told = describeSubmissionOutcome({
      result: { status: "submitted" } as never,
      siteLabel: "Northwind careers",
    });
    expect(told.summary).toBe("Application submitted");
    expect(told.detail).toContain("confirmed that it received");
    expect(told.detail).toContain("will not send it again");
    expect(told.nextActionLabel).toBe("View application");
  });
});

// Gate 3 fixes: retry keys, not-sent copy, and the allowance.
const lineage = { runId: "run", jobId: "job", resultId: "result" };
const base = "submission_run_job_result";

describe("selectSubmissionAttemptIds", () => {
  it("keeps the one key per result for the run's own send", () => {
    expect(
      selectSubmissionAttemptIds({
        lineage,
        outcomes: [{ idempotencyKey: base, outcome: "not_submitted" }],
        personRetry: false,
      }).idempotencyKey,
    ).toBe(base);
  });

  it("gives the person's Send the next key after a not-sent attempt", () => {
    expect(
      selectSubmissionAttemptIds({
        lineage,
        outcomes: [{ idempotencyKey: base, outcome: "not_submitted" }],
        personRetry: true,
      }),
    ).toEqual({
      idempotencyKey: `${base}_retry1`,
      preflightId: "preflight_run_job_result_retry1",
    });
  });

  it("skips a key whose attempt stopped before it was armed", () => {
    expect(
      selectSubmissionAttemptIds({
        lineage,
        outcomes: [{ idempotencyKey: base, outcome: "not_submitted" }],
        attempts: [
          { idempotencyKey: base, status: "resolved" },
          { idempotencyKey: `${base}_retry1`, status: "available" },
        ],
        personRetry: true,
      }).idempotencyKey,
    ).toBe(`${base}_retry2`);
  });

  it("never moves past an armed, sent or uncertain attempt", () => {
    for (const attempts of [
      [{ idempotencyKey: `${base}_retry1`, status: "armed" }],
      [{ idempotencyKey: `${base}_retry1`, status: "outcome_uncertain" }],
    ])
      expect(
        selectSubmissionAttemptIds({
          lineage,
          outcomes: [{ idempotencyKey: base, outcome: "not_submitted" }],
          attempts,
          personRetry: true,
        }).idempotencyKey,
      ).toBe(`${base}_retry1`);
    expect(
      selectSubmissionAttemptIds({
        lineage,
        outcomes: [{ idempotencyKey: base, outcome: "submitted" }],
        personRetry: true,
      }).idempotencyKey,
    ).toBe(base);
  });
});

function notSubmitted(reason: string | null) {
  return {
    status: "recorded_not_submitted",
    outcome: reason ? { browserAction: { reason } } : {},
  } as unknown as Parameters<typeof describeSubmissionOutcome>[0]["result"];
}

describe("describeSubmissionOutcome for a send that did not go out", () => {
  it("names the site that could not be reached and offers Try again", () => {
    expect(
      describeSubmissionOutcome({
        result: notSubmitted(SITE_UNREACHABLE_REASON),
        siteLabel: "127.0.0.1:47967",
      }),
    ).toEqual({
      summary: "Not sent: 127.0.0.1:47967 could not be reached",
      detail:
        "The connection to 127.0.0.1:47967 was refused before the form went out, so nothing was sent. Try again prepares the application again once the site is back.",
      nextActionLabel: "Try again",
    });
  });

  it("gives Home a reason after 'Not sent: ' every time", () => {
    for (const reason of ["action_error", "stale_control", null])
      expect(
        describeSubmissionOutcome({
          result: notSubmitted(reason),
          siteLabel: "jobs.example.com",
        }).summary,
      ).toMatch(/^Not sent: \S/u);
    expect(
      describeSubmissionOutcome({
        result: notSubmitted("action_error"),
        siteLabel: "jobs.example.com",
      }).summary,
    ).toBe("Not sent: the send button could not be pressed");
  });
});

describe("deriveApplySubmissionCapacity", () => {
  it("does not spend the allowance on a send that reached nothing", () => {
    const envelope = {
      maxApplicationsPerRun: 2,
    } as Parameters<typeof deriveApplySubmissionCapacity>[0]["envelope"];
    const at = "2026-09-27T10:00:00.000Z";
    expect(
      deriveApplySubmissionCapacity({
        envelope,
        outcomes: [
          { runId: "run", attemptedAt: at, outcome: "not_submitted" },
          { runId: "run", attemptedAt: at, outcome: "not_submitted" },
          { runId: "run", attemptedAt: at, outcome: "submitted" },
        ],
        runId: "run",
        now: at,
      }),
    ).toEqual({ remainingRunCapacity: 1 });
  });
});

it.each([
  {
    status: "recorded_not_submitted",
    reason: "form_validation_failed",
    detail: "Select at least one skill.",
    summary: "Not sent: correct the marked fields",
    nextActionLabel: "Correct the fields in the browser",
  },
  {
    status: "outcome_uncertain",
    reason: "confirmation_timeout",
    detail:
      "127.0.0.1 did not confirm receipt in time. Check this application on the site before trying again.",
    summary: "Send attempted; confirmation timed out",
    nextActionLabel: "Check the site and confirm",
  },
])(
  "explains $reason without claiming a send",
  ({ status, reason, detail, summary, nextActionLabel }) => {
    const result = {
      status,
      outcome: { browserAction: { reason, detail } },
    } as unknown as Parameters<typeof describeSubmissionOutcome>[0]["result"];
    expect(
      describeSubmissionOutcome({ result, siteLabel: "127.0.0.1" }),
    ).toEqual({ summary, detail, nextActionLabel });
  },
);
