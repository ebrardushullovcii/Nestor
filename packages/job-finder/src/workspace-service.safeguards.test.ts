import {
  ApplicationConsentRequestSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  JobFinderIntelligenceStateSchema,
  type CompanyEntity,
} from "@nestor/contracts";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepositorySeed,
} from "@nestor/db";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
} from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSavedJob } from "./workspace-service.test-fixtures";
import { createSeed } from "./workspace-service.test-fixtures";

const now = "2026-08-15T10:00:00.000Z";
const day0 = "2026-08-01T00:00:00.000Z";

function companyEntity(
  id: string,
  canonicalName: string,
  jobIds: readonly string[],
): CompanyEntity {
  return {
    id,
    canonicalName,
    aliases: [],
    domains: [],
    preference: "neutral",
    preferenceReason: null,
    mergeReviewCandidates: [],
    contacts: [],
    notes: [],
    salaryOfferEvidence: [],
    sourceHistory: [],
    jobIds: [...jobIds],
    applicationRecordIds: [],
    createdAt: day0,
    updatedAt: now,
  };
}

function seedWithCompanies(): JobFinderRepositorySeed {
  const seed = createSeed();
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready");
  if (!job) throw new Error("Test seed is missing job_ready.");
  seed.intelligence = JobFinderIntelligenceStateSchema.parse({
    companies: [
      companyEntity("company_signal", "Signal Systems", ["job_ready"]),
      companyEntity("company_northwind", "Northwind Labs", ["job_generating"]),
    ],
  });
  return seed;
}

function capEvidenceForCompany(count: number, companyId = "company_signal") {
  return Array.from({ length: count }, (_, index) => ({
    applicationRecordId: `application_signal_${index}`,
    companyId,
    appliedAt: `2026-08-0${(index % 9) + 1}T10:00:00.000Z`,
  }));
}

describe("workspace service high-volume safeguards", () => {
  test("company caps: applying cap-limit evidence blocks application preparation for that company only", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService, repository } = harness;

    const snapshot = await workspaceService.mutateSafeguards({
      type: "apply_company_application_evidence",
      evidence: capEvidenceForCompany(3),
      config: {
        companyId: "company_signal",
        maxApplicationsPerWindow: 3,
        windowDays: 7,
        windowStartedAt: day0,
        explanation: "Per-company weekly application cap reached.",
        recoveryGuidance:
          "Wait for the window to roll over or apply to another company.",
      },
    });

    expect(
      snapshot.intelligence.safeguards.companyApplicationCaps[0]?.limitReached,
    ).toBe(true);
    expect(
      snapshot.intelligence.safeguards.companyApplicationCaps[0]
        ?.currentWindowCount,
    ).toBe(3);

    const blockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]);
    expect(blockers.map((blocker) => blocker.kind)).toEqual([
      "company_cap_limit",
    ]);
    expect(blockers[0]?.explanation).toContain("cap");

    // A different company's job is unaffected.
    const otherCompanyBlockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_generating",
      ]);
    expect(otherCompanyBlockers).toEqual([]);

    await expect(
      workspaceService.startAutoApplyRun("job_ready"),
    ).rejects.toThrow(/Open Safeguards to resolve, dismiss, or retry/);

    const overview = await workspaceService.getSafeguardsOverview();
    expect(overview.counts.activeCaps).toBe(1);
    expect(overview.counts.caps).toBe(1);
    expect(overview.highestPriorityBlocker?.kind).toBe("company_cap_limit");

    // The persisted cap stays in the repository for a reopened service.
    const persisted = await repository.getIntelligenceState();
    expect(persisted.safeguards.companyApplicationCaps[0]?.limitReached).toBe(
      true,
    );
  });

  test("company caps: below the limit does not block preparation", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;

    await workspaceService.mutateSafeguards({
      type: "apply_company_application_evidence",
      evidence: capEvidenceForCompany(2),
      config: {
        companyId: "company_signal",
        maxApplicationsPerWindow: 3,
        windowDays: 7,
        windowStartedAt: day0,
        explanation: "Per-company weekly application cap.",
        recoveryGuidance: "Wait for rollover or choose another company.",
      },
    });

    const blockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]);
    expect(blockers).toEqual([]);
    expect(
      (await workspaceService.getSafeguardsOverview()).counts.activeCaps,
    ).toBe(0);
  });

  test("simultaneous conflicts: a detected conflict blocks the involved jobs only", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService, repository } = harness;

    await repository.upsertApplicationRecord({
      id: "application_a",
      jobId: "job_ready",
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "submitted",
      lastActionLabel: "Applied",
      nextActionLabel: null,
      lastUpdatedAt: now,
      lastAttemptState: null,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
        sourceInstructionArtifactId: null,
      },
      events: [],
      crm: null,
    });
    await repository.upsertApplicationRecord({
      id: "application_b",
      jobId: "job_generating",
      title: "Principal UX Engineer",
      company: "Northwind Labs",
      status: "submitted",
      lastActionLabel: "Applied",
      nextActionLabel: null,
      lastUpdatedAt: now,
      lastAttemptState: null,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
        sourceInstructionArtifactId: null,
      },
      events: [],
      crm: null,
    });

    await workspaceService.mutateSafeguards({
      type: "record_simultaneous_application_conflict",
      conflictId: "conflict_1",
      applicationRecordId: "application_a",
      conflictingApplicationRecordId: "application_b",
      explanation: "Two applications overlapped in time.",
      recoveryGuidance: "Review both applications and keep one.",
    });

    const jobReadyBlockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]);
    expect(jobReadyBlockers.map((blocker) => blocker.kind)).toEqual([
      "simultaneous_application_conflict",
    ]);

    await workspaceService.mutateSafeguards({
      type: "resolve_simultaneous_application_conflict",
      conflictId: "conflict_1",
    });
    expect(
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]),
    ).toEqual([]);
  });

  test("listing signals: stale, closed, and suspicious signals block their own job", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;

    for (const [index, signal] of ["stale", "closed", "suspicious"].entries()) {
      await workspaceService.mutateSafeguards({
        type: "record_listing_signal",
        signalId: `signal_${index}`,
        jobId: "job_ready",
        signal: signal as "stale" | "closed" | "suspicious",
        detail: null,
        detectedAt: `2026-08-0${index + 1}T10:00:00.000Z`,
        confidence: 0.9,
        provenance: "provider",
        explanation: `Provider reported the listing as ${signal}.`,
        recoveryGuidance: "Re-verify the listing before applying.",
      });
    }

    const blockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]);
    expect(blockers.map((blocker) => blocker.kind)).toEqual(["listing_signal"]);
    // Only the latest signal per job is considered.
    expect(blockers[0]?.id).toBe("signal_2");

    const otherBlockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_generating",
      ]);
    expect(otherBlockers).toEqual([]);

    const overview = await workspaceService.getSafeguardsOverview();
    expect(overview.counts.signals).toBe(3);
    expect(overview.counts.activeSignals).toBe(1);
  });

  test("abnormal failure pauses: below the threshold does not block, at the threshold blocks preparation but not discovery", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;

    const recordEvidence = (failed: readonly boolean[]) =>
      workspaceService.mutateSafeguards({
        type: "record_abnormal_failure_evidence",
        pauseId: "pause_1",
        windowStartedAt: day0,
        evidence: failed.map((isFailed, index) => ({
          attemptId: `attempt_${index}`,
          failed: isFailed,
          occurredAt: `2026-08-0${index + 1}T10:00:00.000Z`,
        })),
        config: {
          windowDays: 7,
          failureRateThresholdPercent: 40,
          minimumSample: 5,
          explanation: "Elevated application failure rate.",
          recoveryGuidance:
            "Inspect the latest failure evidence before resuming.",
        },
      });

    // 2 failures out of 5 (40%) meets the threshold and pauses.
    await recordEvidence([true, true, false, false, false]);
    const overview = await workspaceService.getSafeguardsOverview();
    expect(overview.counts.activePauses).toBe(1);
    expect(overview.highestPriorityBlocker?.kind).toBe(
      "abnormal_failure_pause",
    );

    await expect(
      workspaceService.startAutoApplyRun("job_ready"),
    ).rejects.toThrow(/Open Safeguards to resolve, dismiss, or retry/);
    expect(await workspaceService.evaluateDiscoverySafeguardBlockers()).toEqual(
      [],
    );

    // Re-applying evidence that drops the rate clears the pause (recovery).
    await recordEvidence([true, false, false, false, false]);
    expect(
      (await workspaceService.getSafeguardsOverview()).counts.activePauses,
    ).toBe(0);
    expect(await workspaceService.evaluateDiscoverySafeguardBlockers()).toEqual(
      [],
    );
  });

  test("a failure-rate pause lets the person's Try again of the failed jobs through", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;
    await workspaceService.mutateSafeguards({
      type: "record_abnormal_failure_evidence",
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: [true, true, false, false, false].map((failed, index) => ({
        attemptId: `attempt_${index}`,
        failed,
        occurredAt: `2026-08-0${index + 1}T10:00:00.000Z`,
      })),
      config: {
        windowDays: 7,
        failureRateThresholdPercent: 40,
        minimumSample: 5,
        explanation: "Elevated application failure rate.",
        recoveryGuidance: "Review the failed attempts, then retry.",
      },
    });
    await harness.repository.upsertApplyJobResult({
      id: "result_failed_before",
      runId: "run_before",
      jobId: "job_ready",
      state: "failed",
      summary: "Not sent: the site could not be reached",
      detail: "Nothing was sent.",
      startedAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:01:00.000Z",
      completedAt: "2026-08-05T10:01:00.000Z",
      blockerReason: "application_page_unreachable",
    } as never);

    const outcome = await workspaceService
      .startAutoApplyRun("job_ready")
      .then(() => "started")
      .catch((error: unknown) => String(error));
    expect(outcome).not.toMatch(/Open Safeguards to resolve/u);
  });

  test("pending automatic sample reviews are retired and do not block preparation", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    await workspaceService.mutateSafeguards({
      type: "prepare_batch_sample_review",
      reviewId: "automatic_batch_sample_review:batch_prepared",
      batchId: "batch_prepared",
      prepared: Array.from({ length: 10 }, (_, index) => ({
        id: `item_${index}`,
      })),
      requiredSampleRatio: 0.2,
      explanation: "Review a prepared sample.",
      recoveryGuidance: "Review the sample.",
    });
    expect(
      (await workspaceService.getSafeguardsOverview()).counts.pendingReviews,
    ).toBe(0);
    expect(
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]),
    ).toEqual([]);
    expect(await workspaceService.evaluateDiscoverySafeguardBlockers()).toEqual(
      [],
    );
    expect(
      (await repository.getIntelligenceState()).safeguards
        .preparedBatchSampleReviews,
    ).toEqual([]);
  });

  test("a safeguard added after staging leaves approval and the run pending", async () => {
    const seed = seedWithCompanies();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const harness = createWorkspaceServiceHarness({ seed });
    await harness.workspaceService.getWorkspaceSnapshot();
    const staged =
      await harness.workspaceService.startAutoApplyRun("job_ready");
    const run = staged.applyRuns.find(
      (candidate) => candidate.mode === "single_job_auto",
    );
    if (!run?.submitApprovalId) throw new Error("Expected a staged apply run.");

    await harness.workspaceService.mutateSafeguards({
      type: "record_listing_signal",
      signalId: "signal_after_staging",
      jobId: "job_ready",
      signal: "closed",
      detail: null,
      detectedAt: now,
      confidence: 1,
      provenance: "provider",
      explanation: "The listing closed after the queue was staged.",
      recoveryGuidance: "Re-verify the listing before continuing.",
    });

    await expect(
      harness.workspaceService.approveApplyRun(run.id),
    ).rejects.toThrow(/Open Safeguards to resolve, dismiss, or retry/);
    const [runs, approvals] = await Promise.all([
      harness.repository.listApplyRuns(),
      harness.repository.listApplySubmitApprovals(),
    ]);
    expect(runs.find((candidate) => candidate.id === run.id)?.state).toBe(
      "awaiting_submit_approval",
    );
    expect(
      approvals.find((candidate) => candidate.id === run.submitApprovalId)
        ?.status,
    ).toBe("pending");
  });

  test.each(["approve", "decline"] as const)(
    "a safeguard appearing before consent %s continuation leaves request and run coherent",
    async (action) => {
      const seed = seedWithCompanies();
      seed.applyRuns = [
        ApplyRunSchema.parse({
          id: "run_consent_guard",
          campaignId: null,
          mode: "queue_auto",
          state: "paused_for_consent",
          jobIds: ["job_ready", "job_generating"],
          currentJobId: "job_ready",
          submitApprovalId: "approval_consent_guard",
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          summary: "Consent needed.",
          detail: "The run is waiting for one consent decision.",
          totalJobs: 2,
          pendingJobs: 2,
          blockedJobs: 1,
        }),
      ];
      seed.applyJobResults = [
        ApplyJobResultSchema.parse({
          id: "result_consent_guard",
          runId: "run_consent_guard",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
          state: "blocked",
          summary: "Consent needed.",
          detail: "The job is waiting for consent.",
          startedAt: now,
          updatedAt: now,
          pendingConsentRequestCount: 1,
        }),
        ApplyJobResultSchema.parse({
          id: "result_consent_guard_remaining",
          runId: "run_consent_guard",
          jobId: "job_generating",
          applicationRecordId: "application_job_generating",
          state: "planned",
          summary: "Planned.",
          detail: "This job has not started.",
          startedAt: now,
          updatedAt: now,
        }),
      ];
      seed.applySubmitApprovals = [
        ApplySubmitApprovalSchema.parse({
          id: "approval_consent_guard",
          runId: "run_consent_guard",
          mode: "queue_auto",
          jobIds: ["job_ready", "job_generating"],
          status: "approved",
          createdAt: now,
          approvedAt: now,
          revokedAt: null,
          expiresAt: null,
          detail: "Preparation approval remains safe and non-submitting.",
        }),
      ];
      seed.applicationConsentRequests = [
        ApplicationConsentRequestSchema.parse({
          id: "consent_guard",
          runId: "run_consent_guard",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
          resultId: "result_consent_guard",
          kind: "manual_verification",
          linkedConsentKind: null,
          label: "Review this consent",
          detail: "Explicit approval is required.",
          status: "pending",
          requestedAt: now,
          decidedAt: null,
          expiresAt: null,
        }),
      ];
      const harness = createWorkspaceServiceHarness({ seed });
      await harness.workspaceService.mutateSafeguards({
        type: "record_listing_signal",
        signalId: "signal_before_consent",
        jobId: "job_generating",
        signal: "closed",
        detail: null,
        detectedAt: now,
        confidence: 1,
        provenance: "provider",
        explanation: "The remaining listing closed before the queue continued.",
        recoveryGuidance: "Re-verify the listing before continuing.",
      });

      await expect(
        harness.workspaceService.resolveApplyConsentRequest(
          "consent_guard",
          action,
        ),
      ).rejects.toThrow(/Open Safeguards to resolve, dismiss, or retry/);
      const [requests, runs, results] = await Promise.all([
        harness.repository.listApplicationConsentRequests(),
        harness.repository.listApplyRuns(),
        harness.repository.listApplyJobResults(),
      ]);
      expect(requests[0]?.status).toBe("pending");
      expect(requests[0]?.decidedAt).toBeNull();
      expect(runs[0]?.state).toBe("paused_for_consent");
      expect(results[0]?.state).toBe("blocked");
      expect(results[0]?.pendingConsentRequestCount).toBe(1);
    },
  );

  test("a blocker appearing while jobs run stops new launches and lets the running job finish", async () => {
    // With two preparations at once (ADR 0036; the default is wider now, the
    // stop rule is the same at any width), job two is already running when
    // job one's blocker for job three appears: job two may finish, job three
    // must never be launched.
    vi.stubEnv("NESTOR_APPLICATION_PREPARATION_CONCURRENCY", "2");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const seed = seedWithCompanies();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const secondJob = seed.savedJobs.find(
      (entry) => entry.id === "job_generating",
    );
    if (!secondJob) throw new Error("Test seed is missing job_generating.");
    seed.savedJobs = [
      ...seed.savedJobs,
      createSavedJob({
        ...secondJob,
        id: "job_third",
        sourceJobId: "linkedin_northwind_third",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_northwind_third",
      }),
    ];
    const baseRuntime = createBrowserRuntime();
    let addThirdJobBlocker: () => Promise<unknown> = () =>
      Promise.reject(new Error("Safeguard test harness not initialized."));
    let markBlockerRecorded: () => void = () => undefined;
    const blockerRecorded = new Promise<void>((resolve) => {
      markBlockerRecorded = resolve;
    });
    const launchedJobIds: string[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      async executeApplicationFlow(source, input, options) {
        launchedJobIds.push(input.job.id);
        if (input.job.id === "job_generating") {
          // The job running alongside finishes only after the blocker exists.
          await blockerRecorded;
        }
        const result = await baseRuntime.executeApplicationFlow(
          source,
          input,
          options,
        );
        if (input.job.id === "job_ready") {
          await addThirdJobBlocker();
          markBlockerRecorded();
        }
        return result;
      },
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    const workspaceService = harness.workspaceService;
    addThirdJobBlocker = () =>
      workspaceService.mutateSafeguards({
        type: "record_listing_signal",
        signalId: "signal_job_three_mid_run",
        jobId: "job_third",
        signal: "closed",
        detail: null,
        detectedAt: now,
        confidence: 1,
        provenance: "provider",
        explanation: "The third listing closed while jobs one and two ran.",
        recoveryGuidance: "Re-verify the listing before continuing.",
      });
    await workspaceService.getWorkspaceSnapshot();
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_generating",
      "job_third",
    ]);
    const run = staged.applyRuns.find(
      (candidate) => candidate.mode === "queue_auto",
    );
    if (!run) throw new Error("Expected a staged queue run.");

    const snapshot = await workspaceService.approveApplyRun(run.id);
    expect([...launchedJobIds].sort()).toEqual(["job_generating", "job_ready"]);
    expect(
      snapshot.applyRuns.find((candidate) => candidate.id === run.id),
    ).toMatchObject({
      state: "paused_for_user_review",
      currentJobId: "job_third",
    });
    const resultState = (jobId: string) =>
      snapshot.applyJobResults.find(
        (result) => result.runId === run.id && result.jobId === jobId,
      )?.state;
    expect(resultState("job_third")).toBe("planned");
    expect(resultState("job_ready")).toBe(resultState("job_generating"));
    expect(["planned", "filling"]).not.toContain(resultState("job_generating"));
  });

  test("contradictory answers are advisory and never block preparation", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;

    await workspaceService.mutateSafeguards({
      type: "record_contradictory_answer_detection",
      detectionId: "detection_1",
      questionA: "How many years of Figma?",
      questionB: "Years of design tooling?",
      answerA: "5",
      answerB: "2",
      contradictionScore: 0.9,
      detectedAt: day0,
      explanation: "Reused answers conflict with each other.",
      recoveryGuidance: "Ask the user to resolve the answers.",
    });

    const blockers =
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.kind).toBe("contradictory_answer");
    expect(blockers[0]?.severity).toBe("advisory");

    // Advisory only: application preparation still proceeds.
    const overview = await workspaceService.getSafeguardsOverview();
    expect(overview.counts.activeContradictions).toBe(1);
    expect(overview.highestPriorityBlocker?.kind).toBe("contradictory_answer");
    expect(overview.highestPriorityBlocker?.severity).toBe("advisory");

    await workspaceService.mutateSafeguards({
      type: "dismiss_contradictory_answer_detection",
      detectionId: "detection_1",
    });
    expect(
      (await workspaceService.getSafeguardsOverview()).counts
        .activeContradictions,
    ).toBe(0);
  });

  test("dismissals suppress a blocker and restore re-arms it (recovery control)", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;

    await workspaceService.mutateSafeguards({
      type: "record_listing_signal",
      signalId: "signal_dismiss",
      jobId: "job_ready",
      signal: "closed",
      detail: null,
      detectedAt: day0,
      confidence: 0.95,
      provenance: "provider",
      explanation: "Provider reported the listing as closed.",
      recoveryGuidance: "Re-verify the listing before applying.",
    });

    expect(
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]),
    ).toHaveLength(1);

    const dismissed = await workspaceService.mutateSafeguards({
      type: "dismiss_safeguard_entry",
      kind: "listing_signal",
      referenceId: "signal_dismiss",
      reason: "rechecked",
      note: "Re-verified the listing is open.",
    });
    const dismissalId =
      dismissed.intelligence.safeguards.safeguardDismissals[0]?.id;
    expect(dismissalId).toBeDefined();
    expect(
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]),
    ).toEqual([]);

    await workspaceService.mutateSafeguards({
      type: "restore_safeguard_entry",
      dismissalId: dismissalId!,
    });
    expect(
      await workspaceService.evaluateApplicationSafeguardBlockers([
        "job_ready",
      ]),
    ).toHaveLength(1);
  });

  test("restart persistence: safeguards survive a reopened service on the same repository", async () => {
    const repository = createInMemoryJobFinderRepository(seedWithCompanies());
    const createService = () =>
      createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

    const firstService = createService();
    await firstService.mutateSafeguards({
      type: "record_listing_signal",
      signalId: "signal_persist",
      jobId: "job_ready",
      signal: "suspicious",
      detail: null,
      detectedAt: day0,
      confidence: 1,
      provenance: "browser",
      explanation: "Listing shows unusual signs.",
      recoveryGuidance: "Inspect the listing before applying.",
    });
    await firstService.mutateSafeguards({
      type: "prepare_batch_sample_review",
      reviewId: "automatic_batch_sample_review:batch_persist",
      batchId: "batch_persist",
      prepared: [{ id: "item_a" }, { id: "item_b" }],
      requiredSampleRatio: 0.5,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the sample.",
    });

    // Simulate a restart: a brand new service reads the same persisted state.
    const reopenedService = createService();
    const reopenedOverview = await reopenedService.getSafeguardsOverview();
    expect(reopenedOverview.counts.signals).toBe(1);
    expect(reopenedOverview.counts.activeSignals).toBe(1);
    expect(reopenedOverview.counts.pendingReviews).toBe(0);
    expect(
      await reopenedService.evaluateApplicationSafeguardBlockers(["job_ready"]),
    ).toHaveLength(1);
  });

  test("safeguard mutations never grant final-submit or credential authority", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedWithCompanies(),
    });
    const { workspaceService } = harness;

    const snapshot = await workspaceService.mutateSafeguards({
      type: "record_simultaneous_application_conflict",
      conflictId: "conflict_safe",
      applicationRecordId: "application_safe_a",
      conflictingApplicationRecordId: "application_safe_b",
      explanation: "Overlapping applications.",
      recoveryGuidance: "Review and keep one.",
    });

    const serialized = JSON.stringify(snapshot.intelligence.safeguards);
    for (const key of [
      "submitAuthorized",
      "accountCreationAuthorized",
      "credentials",
      "captchaToken",
      "mfaCode",
      "legalConsent",
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }

    // An attempt to smuggle a submit flag through a mutation is rejected by
    // the strict input schema inside the service.
    await expect(
      workspaceService.mutateSafeguards({
        type: "record_listing_signal",
        signalId: "signal_bad",
        jobId: "job_ready",
        signal: "stale",
        detail: null,
        detectedAt: day0,
        confidence: 0.5,
        provenance: "provider",
        explanation: "Provider reported the listing.",
        recoveryGuidance: "Re-verify the listing.",
        // @ts-expect-error submit authority is structurally impossible
        submitAuthorized: true,
      }),
    ).rejects.toThrow();

    // The persisted apply-submit approval path stays untouched: no approval is
    // created or flipped by safeguard mutations.
    expect(await harness.repository.listApplySubmitApprovals()).toEqual([]);
  });

  test("createSavedJob fixture and SavedJob import remain intact", () => {
    const job = createSavedJob({
      id: "job_custom",
      source: "target_site",
      sourceJobId: "custom_source",
      discoveryMethod: "catalog_seed",
      canonicalUrl: "https://example.com/jobs/1",
      applicationUrl: null,
      title: "Custom",
      company: "Acme",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "easy_apply",
      easyApplyEligible: true,
      postedAt: now,
      postedAtText: null,
      discoveredAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      lastVerifiedActiveAt: now,
      salaryText: null,
      normalizedCompensation: {
        currency: "USD",
        interval: "year",
        minAmount: 100000,
        maxAmount: 120000,
        minAnnualUsd: 100000,
        maxAnnualUsd: 120000,
      },
      summary: null,
      description: "Custom description",
      keySkills: [],
      responsibilities: [],
      minimumQualifications: [],
      preferredQualifications: [],
      seniority: null,
      employmentType: null,
      department: null,
      team: null,
      employerWebsiteUrl: null,
      employerDomain: null,
      atsProvider: null,
      screeningHints: {
        sponsorshipText: null,
        requiresSecurityClearance: null,
        relocationText: null,
        travelText: null,
        remoteGeographies: [],
        requiresConsentInterrupt: null,
        requiresConsentInterruptKind: null,
      },
      keywordSignals: [],
      benefits: [],
      status: "ready_for_review",
      matchAssessment: {
        score: 90,
        reasons: ["Strong overlap"],
        gaps: [],
      },
      provenance: [],
    });
    expect(job.company).toBe("Acme");
  });
});
