import { createHash } from "node:crypto";

import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  SubmissionExecutionGrantSchema,
  SubmissionFinalControlIdentitySchema,
  SubmissionObservationIdentitySchema,
  type ApplicationAutomationMode,
} from "@nestor/contracts";
import {
  createSendGuards,
  openJobStore,
  type SendGuards,
} from "@nestor/db/job-store";
import type {
  ApplicationFinalActionResult,
  ApplicationFinalControl,
  ApplicationFormObservation,
  ApplicationSafePageUrl,
} from "@nestor/browser-runtime";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildSubmissionPreflightRecord } from "./application-submission-preflight";
import {
  runApplicationSubmissionRuntime,
  type ApplicationSubmissionBrowserRuntime,
  type ApplicationSubmissionRuntimeInput,
} from "./application-submission-runtime";

const NOW = "2026-08-27T10:00:00.000Z";
const EXPIRES_AT = "2026-08-27T11:00:00.000Z";
const GRANT_EXPIRES_AT = "2026-08-27T10:05:00.000Z";
const ORIGIN = "https://boards.example.com";
const RESUME_BYTES = new TextEncoder().encode("trusted resume bytes");
const RESUME_SHA256 = createHash("sha256").update(RESUME_BYTES).digest("hex");
const ANSWER_SHA256 = "b".repeat(64);
const FORM_SHA256 = "c".repeat(64);
const CONTROL_SHA256 = "d".repeat(64);

const POLICY_RULES = {
  version: 1 as const,
  answerPolicy: {
    approvedAnswerSnapshot: { revision: 1, digest: ANSWER_SHA256 },
    unknownRequiredQuestion: "pause_for_user" as const,
    unknownEligibility: "pause_for_user" as const,
    unknownLegalRequirement: "pause_for_user" as const,
  },
  stopConditions: {
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
  },
};
const POLICY_DIGEST = createHash("sha256")
  .update(
    serializeApplicationAuthorityDecisionPolicyForDigest(POLICY_RULES),
    "utf8",
  )
  .digest("hex");
const POLICY_IDENTITY = {
  version: POLICY_RULES.version,
  revision: 1,
  digest: POLICY_DIGEST,
};

const PAGE: ApplicationSafePageUrl = {
  origin: ORIGIN,
  safePath: "/apply",
};
const CONTROL: ApplicationFinalControl = {
  identity: SubmissionFinalControlIdentitySchema.parse({
    ref: "final-control-0",
    signature: CONTROL_SHA256,
  }),
  ordinal: 0,
  kind: "button",
  label: "Send application",
  formIndex: 0,
  action: { ...PAGE, safePath: "/submit" },
};
const OBSERVATION: ApplicationFormObservation = {
  identity: SubmissionObservationIdentitySchema.parse({
    id: "application-observation-fixture",
    revision: 1,
    digest: FORM_SHA256,
  }),
  page: PAGE,
  complete: true,
  controls: [CONTROL],
};

const SUBMIT_REQUEST = {
  method: "POST",
  host: new URL(ORIGIN).host,
  path: "/apply",
  status: 200,
  failure: null,
  finalSubmit: true,
};

function emptyFacts(): ApplicationFinalActionResult["facts"] {
  return {
    actionAttempted: false,
    actionIssued: false,
    actionCompleted: false,
    pageBefore: PAGE,
    pageAfter: PAGE,
    urlChanged: false,
    requestsObservedDuringAction: 0,
    requestsAfterClick: [],
  };
}

function buildBrowserRuntime(
  input: {
    onObserve?: () => void | Promise<void>;
    onBetweenVetoes?: () => void | Promise<void>;
    controls?: ApplicationFinalControl[];
    outcome?: "submitted" | "uncertain" | "not_submitted";
  } = {},
): {
  runtime: ApplicationSubmissionBrowserRuntime;
  calls: { observe: number; execute: number; action: number };
} {
  const calls = { observe: 0, execute: 0, action: 0 };
  const observation =
    input.controls === undefined
      ? OBSERVATION
      : { ...OBSERVATION, controls: input.controls };
  const runtime: ApplicationSubmissionBrowserRuntime = {
    observeApplicationForm: async () => {
      calls.observe += 1;
      await input.onObserve?.();
      return observation;
    },
    executeExactlyOneFinalAction: async (_source, actionInput) => {
      calls.execute += 1;
      const firstVeto = await actionInput.veto({
        observation,
        control: observation.controls[0] ?? CONTROL,
      });
      if (!firstVeto) {
        return {
          outcome: "not_submitted",
          reason: "vetoed",
          observation,
          control: observation.controls[0] ?? null,
          facts: emptyFacts(),
        };
      }
      await input.onBetweenVetoes?.();
      const secondVeto = await actionInput.veto({
        observation,
        control: observation.controls[0] ?? CONTROL,
      });
      if (!secondVeto) {
        return {
          outcome: "not_submitted",
          reason: "vetoed",
          observation,
          control: observation.controls[0] ?? null,
          facts: emptyFacts(),
        };
      }
      calls.action += 1;
      if (input.outcome === "submitted") {
        return {
          outcome: "submitted",
          reason: "employer_confirmation",
          observation,
          control: observation.controls[0] ?? CONTROL,
          confirmation: {
            observedAt: NOW,
            destination: { origin: ORIGIN, safePath: "/confirmation" },
            summary: "The employer site confirmed receipt.",
          },
          facts: {
            ...emptyFacts(),
            actionAttempted: true,
            actionIssued: true,
            actionCompleted: true,
          },
        };
      }
      if (input.outcome === "not_submitted") {
        return {
          outcome: "not_submitted",
          reason: "action_error",
          observation,
          control: observation.controls[0] ?? CONTROL,
          facts: {
            ...emptyFacts(),
            actionAttempted: true,
          },
        };
      }
      return {
        outcome: "outcome_uncertain",
        reason: "action_issued",
        observation,
        control: observation.controls[0] ?? CONTROL,
        facts: {
          ...emptyFacts(),
          actionAttempted: true,
          actionIssued: true,
          actionCompleted: true,
          requestsObservedDuringAction: 1,
          requestsAfterClick: [SUBMIT_REQUEST],
        },
      };
    },
  };
  return { runtime, calls };
}

async function createHarness(input: {
  mode: ApplicationAutomationMode;
  runtime?: ApplicationSubmissionBrowserRuntime;
  calls?: { observe: number; execute: number; action: number };
  allowedOrigins?: string[];
}): Promise<{
  repository: SendGuards;
  runtimeInput: ApplicationSubmissionRuntimeInput;
  authority: ReturnType<typeof ApplicationAuthorityEnvelopeSchema.parse>;
}> {
  const repository = createSendGuards(openJobStore(":memory:"));
  const authority = ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_1",
    mode: input.mode,
    status: "active",
    revision: 1,
    scope: { campaignId: "campaign_1", jobIds: ["job_1"] },
    maxApplicationsPerRun: 1,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: input.mode === "prepare_only" ? [] : [RESUME_SHA256],
    allowedOrigins: input.allowedOrigins ?? [ORIGIN],
    createdAt: NOW,
    expiresAt: input.mode === "prepare_only" ? null : EXPIRES_AT,
    revokedAt: null,
    decisionPolicy:
      input.mode === "prepare_only"
        ? null
        : {
            ...POLICY_RULES,
            ...POLICY_IDENTITY,
          },
  });
  await repository.commitApplicationAuthorityEnvelope({
    envelope: authority,
    expectedRevision: null,
  });
  const browser = input.runtime
    ? {
        runtime: input.runtime,
        calls: input.calls ?? { observe: 0, execute: 0, action: 0 },
      }
    : buildBrowserRuntime();
  return {
    repository,
    authority,
    runtimeInput: {
      repository,
      browserRuntime: browser.runtime,
      source: "target_site",
      savedMode: input.mode,
      authorityEnvelopeId: authority.id,
      authorityRevision: authority.revision,
      preflightId: "preflight_1",
      idempotencyKey: "idempotency_1",
      lineage: {
        runId: "run_1",
        jobId: "job_1",
        resultId: "result_1",
        applicationRecordId: "application_1",
        campaignId: "campaign_1",
      },
      resumeBytes: RESUME_BYTES,
      answers: { revision: 1, digest: ANSWER_SHA256 },
      capacity: { remainingRunCapacity: 1 },
      currentPolicyFacts: {
        policy: input.mode === "prepare_only" ? null : POLICY_IDENTITY,
        answers: { revision: 1, digest: ANSWER_SHA256 },
        mandatoryStops: [],
      },
      now: NOW,
    },
  };
}

async function commitConfirmGrant(
  repository: SendGuards,
  expiresAt = EXPIRES_AT,
): Promise<void> {
  const preflight = buildSubmissionPreflightRecord({
    id: "preflight_1",
    idempotencyKey: "idempotency_1",
    lineage: {
      runId: "run_1",
      jobId: "job_1",
      resultId: "result_1",
      applicationRecordId: "application_1",
      campaignId: "campaign_1",
    },
    authorityEnvelopeId: "authority_1",
    authorityRevision: 1,
    decisionPolicy: POLICY_IDENTITY,
    origin: ORIGIN,
    formObservation: OBSERVATION.identity,
    resumeBytes: RESUME_BYTES,
    answers: { revision: 1, digest: ANSWER_SHA256 },
    finalControl: CONTROL.identity,
    capacity: { remainingRunCapacity: 1 },
    createdAt: NOW,
  });
  await repository.commitSubmissionPreflight(preflight);
  await repository.commitSubmissionExecutionGrant(
    SubmissionExecutionGrantSchema.parse({
      id: "grant_1",
      preflightId: preflight.id,
      idempotencyKey: preflight.idempotencyKey,
      runId: preflight.runId,
      jobId: preflight.jobId,
      resultId: preflight.resultId,
      applicationRecordId: preflight.applicationRecordId,
      authorityEnvelopeId: preflight.authorityEnvelopeId,
      authorityRevision: preflight.authorityRevision,
      mode: "confirm_before_submit",
      status: "active",
      grantedBy: "user",
      grantedAt: NOW,
      expiresAt,
      revokedAt: null,
      consumedAt: null,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("composed application submission runtime", () => {
  test("consumes one confirm grant, executes one browser action, and records uncertainty", async () => {
    const browser = buildBrowserRuntime();
    const harness = await createHarness({
      mode: "confirm_before_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });
    await commitConfirmGrant(harness.repository);

    const result = await runApplicationSubmissionRuntime({
      ...harness.runtimeInput,
      executionGrantId: "grant_1",
    });

    expect(result.status).toBe("outcome_uncertain");
    expect(browser.calls).toEqual({ observe: 1, execute: 1, action: 1 });
    await expect(
      harness.repository.getSubmissionExecutionGrant("grant_1"),
    ).resolves.toMatchObject({ status: "consumed" });
    await expect(
      harness.repository.getSubmissionOutcomeRecord("outcome_preflight_1"),
    ).resolves.toMatchObject({
      outcome: "outcome_uncertain",
      evidence: [],
      browserAction: {
        reason: "action_issued",
        actionAttempted: true,
        actionIssued: true,
        actionCompleted: true,
        // An uncertain outcome comes with what left after the click.
        requestsObservedDuringAction: 1,
        requestsAfterClick: [SUBMIT_REQUEST],
      },
    });
  });

  test("persists final-action exceptions separately from confirmation evidence and blocks retry", async () => {
    const browser = buildBrowserRuntime();
    browser.runtime.executeExactlyOneFinalAction = () =>
      Promise.reject(new Error("Target page has been closed"));
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });
    const first = await runApplicationSubmissionRuntime(harness.runtimeInput);
    expect(first.status).toBe("outcome_uncertain");
    await expect(
      harness.repository.getSubmissionOutcomeRecord("outcome_preflight_1"),
    ).resolves.toMatchObject({
      evidence: [],
      verifiedAt: null,
      browserAction: {
        reason: "runtime_exception",
        detail: "The browser tab Job Finder was working in was closed.",
      },
      retry: { eligible: false, blockReason: "outcome_uncertain" },
    });
    expect(
      (await runApplicationSubmissionRuntime(harness.runtimeInput)).status,
    ).toBe("blocked");
  });

  test("runs autonomous mode without a grant and never constructs a submitted outcome", async () => {
    const browser = buildBrowserRuntime();
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });

    const result = await runApplicationSubmissionRuntime(harness.runtimeInput);

    expect(result.status).toBe("outcome_uncertain");
    expect(browser.calls.action).toBe(1);
    if (result.status === "outcome_uncertain") {
      expect(result.outcome.outcome).toBe("outcome_uncertain");
    }
    await expect(
      harness.repository.listSubmissionOutcomeRecords(),
    ).resolves.toHaveLength(1);
  });

  test("records employer-site confirmation as a submitted outcome", async () => {
    const browser = buildBrowserRuntime({ outcome: "submitted" });
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });

    const result = await runApplicationSubmissionRuntime(harness.runtimeInput);

    expect(result.status).toBe("submitted");
    if (result.status === "submitted") {
      expect(result.outcome).toMatchObject({
        outcome: "submitted",
        verifiedAt: NOW,
        retry: { eligible: false, blockReason: "submission_confirmed" },
        evidence: [{ kind: "employer_site_state" }],
      });
    }
  });

  test("stops prepare-only before observation or browser action", async () => {
    const browser = buildBrowserRuntime();
    const harness = await createHarness({
      mode: "prepare_only",
      runtime: browser.runtime,
      calls: browser.calls,
    });

    const result = await runApplicationSubmissionRuntime(harness.runtimeInput);

    expect(result).toMatchObject({ status: "blocked", reason: "prepare_only" });
    expect(browser.calls).toEqual({ observe: 0, execute: 0, action: 0 });
    await expect(
      harness.repository.listSubmissionPreflightRecords(),
    ).resolves.toEqual([]);
  });

  test("re-reads the authority in the final veto and prevents action after revocation", async () => {
    const repositoryHolder: {
      current: SendGuards | null;
    } = { current: null };
    const browser = buildBrowserRuntime({
      onBetweenVetoes: async () => {
        if (!repositoryHolder.current) {
          throw new Error("repository fixture was not initialized");
        }
        await repositoryHolder.current.revokeApplicationAuthorityEnvelope({
          id: "authority_1",
          expectedRevision: 1,
          revokedAt: NOW,
        });
      },
    });
    const harness = await createHarness({
      mode: "confirm_before_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });
    repositoryHolder.current = harness.repository;
    await commitConfirmGrant(harness.repository);

    const result = await runApplicationSubmissionRuntime({
      ...harness.runtimeInput,
      executionGrantId: "grant_1",
    });

    expect(result.status).toBe("recorded_not_submitted");
    expect(browser.calls).toEqual({ observe: 1, execute: 1, action: 0 });
    if (result.status === "recorded_not_submitted") {
      expect(result.outcome.retry).toEqual({
        eligible: false,
        blockReason: "authority_no_longer_valid",
      });
    }
  });

  test("uses the current clock before observing instead of the attempt timestamp", async () => {
    const browser = buildBrowserRuntime();
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
    });
    vi.setSystemTime(EXPIRES_AT);

    const result = await runApplicationSubmissionRuntime(harness.runtimeInput);

    expect(result).toMatchObject({
      status: "blocked",
      reason: "preflight_authority_mismatch",
    });
    expect(browser.calls).toEqual({ observe: 0, execute: 0, action: 0 });
  });

  test.each(["observation", "final veto"] as const)(
    "vetoes authority expiring during %s at the exact expiry instant",
    async (phase) => {
      const expire = () => {
        vi.setSystemTime(EXPIRES_AT);
      };
      const browser = buildBrowserRuntime(
        phase === "observation"
          ? { onObserve: expire }
          : { onBetweenVetoes: expire },
      );
      const harness = await createHarness({
        mode: "autonomous_submit",
        runtime: browser.runtime,
      });

      const result = await runApplicationSubmissionRuntime(
        harness.runtimeInput,
      );

      expect(result).toMatchObject({
        status: "recorded_not_submitted",
        outcome: {
          evidence: [],
          browserAction: { reason: "vetoed", actionIssued: false },
          retry: { eligible: false, blockReason: "authority_no_longer_valid" },
        },
      });
      expect(browser.calls).toEqual({ observe: 1, execute: 1, action: 0 });
    },
  );

  test.each(["saved grant", "person confirmation"] as const)(
    "vetoes an expired %s even while the authority envelope is current",
    async (confirmation) => {
      const browser = buildBrowserRuntime({
        onBetweenVetoes: () => {
          vi.setSystemTime(GRANT_EXPIRES_AT);
        },
      });
      const harness = await createHarness({
        mode: "confirm_before_submit",
        runtime: browser.runtime,
      });
      if (confirmation === "saved grant") {
        await commitConfirmGrant(harness.repository, GRANT_EXPIRES_AT);
      }

      const result = await runApplicationSubmissionRuntime({
        ...harness.runtimeInput,
        ...(confirmation === "saved grant"
          ? { executionGrantId: "grant_1" }
          : {
              personConfirmation: {
                grantedAt: NOW,
                expiresAt: GRANT_EXPIRES_AT,
              },
            }),
      });

      expect(result).toMatchObject({
        status: "recorded_not_submitted",
        outcome: {
          evidence: [],
          browserAction: { reason: "vetoed", actionIssued: false },
          retry: { eligible: false, blockReason: "authority_no_longer_valid" },
        },
        executionGrant: { status: "consumed", expiresAt: GRANT_EXPIRES_AT },
      });
      expect(browser.calls).toEqual({ observe: 1, execute: 1, action: 0 });
      expect(Date.now()).toBe(Date.parse(GRANT_EXPIRES_AT));
    },
  );

  test("reads the clock after a slow final durable authority read", async () => {
    let atFinalVeto = false;
    const browser = buildBrowserRuntime({
      onBetweenVetoes: () => {
        atFinalVeto = true;
      },
    });
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
    });
    const readEnvelope =
      harness.repository.getApplicationAuthorityEnvelope.bind(
        harness.repository,
      );
    vi.spyOn(
      harness.repository,
      "getApplicationAuthorityEnvelope",
    ).mockImplementation(async (id) => {
      const envelope = await readEnvelope(id);
      if (atFinalVeto) {
        vi.setSystemTime(EXPIRES_AT);
      }
      return envelope;
    });

    const result = await runApplicationSubmissionRuntime(harness.runtimeInput);

    expect(result).toMatchObject({
      status: "recorded_not_submitted",
      outcome: {
        retry: { eligible: false, blockReason: "authority_no_longer_valid" },
      },
    });
    expect(browser.calls).toEqual({ observe: 1, execute: 1, action: 0 });
  });

  test.each(["resultId", "authorityRevision"] as const)(
    "vetoes consumed grant %s drift at the browser boundary",
    async (field) => {
      let drift = false;
      const browser = buildBrowserRuntime({
        onBetweenVetoes: () => {
          drift = true;
        },
      });
      const harness = await createHarness({
        mode: "confirm_before_submit",
        runtime: browser.runtime,
      });
      await commitConfirmGrant(harness.repository);
      const readGrant = harness.repository.getSubmissionExecutionGrant.bind(
        harness.repository,
      );
      vi.spyOn(
        harness.repository,
        "getSubmissionExecutionGrant",
      ).mockImplementation(async (id) => {
        const grant = await readGrant(id);
        return grant && drift
          ? {
              ...grant,
              ...(field === "resultId"
                ? { resultId: "another_result" }
                : { authorityRevision: 2 }),
            }
          : grant;
      });

      const result = await runApplicationSubmissionRuntime({
        ...harness.runtimeInput,
        executionGrantId: "grant_1",
      });

      expect(result).toMatchObject({
        status: "recorded_not_submitted",
        outcome: {
          retry: { eligible: false, blockReason: "authority_no_longer_valid" },
        },
      });
      expect(browser.calls.action).toBe(0);
    },
  );

  test("does not call the executor for zero or ambiguous controls and blocks a cancelled attempt", async () => {
    const browser = buildBrowserRuntime({ controls: [] });
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });
    const noControl = await runApplicationSubmissionRuntime(
      harness.runtimeInput,
    );
    expect(noControl).toMatchObject({
      status: "blocked",
      reason: "ambiguous_final_control",
    });
    expect(browser.calls.execute).toBe(0);

    const cancelledBrowser = buildBrowserRuntime();
    const cancelledHarness = await createHarness({
      mode: "autonomous_submit",
      runtime: cancelledBrowser.runtime,
      calls: cancelledBrowser.calls,
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runApplicationSubmissionRuntime({
      ...cancelledHarness.runtimeInput,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({
      status: "blocked",
      reason: "immediate_recheck_failed",
    });
    expect(cancelledBrowser.calls).toEqual({
      observe: 0,
      execute: 0,
      action: 0,
    });
  });

  test("persists uncertainty and permanently blocks a second browser attempt for the same key", async () => {
    const browser = buildBrowserRuntime();
    const harness = await createHarness({
      mode: "autonomous_submit",
      runtime: browser.runtime,
      calls: browser.calls,
    });

    const first = await runApplicationSubmissionRuntime(harness.runtimeInput);
    const second = await runApplicationSubmissionRuntime(harness.runtimeInput);

    expect(first.status).toBe("outcome_uncertain");
    expect(second).toMatchObject({
      status: "blocked",
      reason: "idempotency_outcome_uncertain",
    });
    expect(browser.calls.execute).toBe(1);
    await expect(
      harness.repository.getSubmissionIdempotencyRecord(
        harness.runtimeInput.idempotencyKey,
      ),
    ).resolves.toMatchObject({
      status: "outcome_uncertain",
      outcome: "outcome_uncertain",
    });
    await expect(
      harness.repository.listSubmissionOutcomeRecords({
        idempotencyKey: harness.runtimeInput.idempotencyKey,
      }),
    ).resolves.toMatchObject([
      {
        outcome: "outcome_uncertain",
        retry: { eligible: false, blockReason: "outcome_uncertain" },
      },
    ]);
  });
});

test("keeps exact validation feedback and allows correction after an attempted send", async () => {
  const base = buildBrowserRuntime();
  const runtime: ApplicationSubmissionBrowserRuntime = {
    ...base.runtime,
    executeExactlyOneFinalAction: () =>
      Promise.resolve({
        outcome: "not_submitted",
        reason: "form_validation_failed",
        observation: OBSERVATION,
        control: CONTROL,
        validationErrors: ["Select at least one skill."],
        facts: {
          ...emptyFacts(),
          actionAttempted: true,
          actionIssued: true,
          actionCompleted: true,
        },
      }),
  };
  const h = await createHarness({ mode: "autonomous_submit", runtime });
  const result = await runApplicationSubmissionRuntime(h.runtimeInput);
  expect(result).toMatchObject({
    status: "recorded_not_submitted",
    outcome: {
      outcome: "not_submitted",
      retry: { eligible: true, blockReason: null },
      browserAction: {
        actionAttempted: true,
        actionIssued: true,
        reason: "form_validation_failed",
        detail: "Select at least one skill.",
      },
    },
  });
});
