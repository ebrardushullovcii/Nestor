import { describe, expect, test } from "vitest";

import {
  JobFinderRepositoryStateSchema,
  SavedJobDiscoveryProvenanceSchema,
} from "@nestor/contracts";

import {
  createAggressiveTailoringDriveState,
  createAgentOwnedBrowserDriveState,
  createApplyQueueDemoState,
  createResumeWorkspaceDemoState,
} from "./job-finder-demo-state";

describe("job finder demo state", () => {
  test("keeps apply-queue seeds campaign-free so adoption derives coherent retention", () => {
    const state = createApplyQueueDemoState();

    // Campaign-free seeds let ensureCampaignState adopt one default campaign
    // whose retention and source targets derive from the seed itself; a
    // hand-built campaign here would be a second source of truth.
    expect(state.campaigns).toEqual([]);
    expect(state.activeCampaignId).toBeNull();

    const readyForReviewJobs = state.savedJobs.filter(
      (job) => job.status === "ready_for_review",
    );
    expect(readyForReviewJobs.length).toBeGreaterThan(0);
    const savedJobIds = new Set(state.savedJobs.map((job) => job.id));
    expect(
      [...state.tailoredAssets, ...state.resumeDrafts].every((entry) =>
        savedJobIds.has(entry.jobId),
      ),
    ).toBe(true);
    expect(state.searchPreferences.discovery.targets).toEqual(
      expect.arrayContaining([expect.objectContaining({ enabled: true })]),
    );
    expect(
      state.savedJobs.find((job) => job.id === "job_consent_queue"),
    ).toEqual(
      expect.objectContaining({
        company: "Consent Labs",
        employerDomain: "consentlabs.example.com",
        employerWebsiteUrl: "https://consentlabs.example.com",
      }),
    );
  });

  test("resume workspace seeds stay campaign-free with an enabled source", () => {
    const state = createResumeWorkspaceDemoState();

    expect(state.campaigns).toEqual([]);
    expect(state.activeCampaignId).toBeNull();
    expect(
      state.searchPreferences.discovery.targets.some(
        (target) => target.enabled,
      ),
    ).toBe(true);
  });

  test("agent-owned browser drive can reach Apply with an approved resume", () => {
    const applicationUrl = "http://127.0.0.1:43210/apply";
    const secondaryApplicationUrl = "http://127.0.0.1:43210/apply-second";
    const state = createAgentOwnedBrowserDriveState({
      sourceUrl: "http://127.0.0.1:43210",
      applicationUrl,
      secondaryApplicationUrl,
    });

    const job = state.savedJobs.find((entry) => entry.id === "job_ready");
    const draft = state.resumeDrafts.find(
      (entry) => entry.jobId === "job_ready",
    );
    const approvedExport = state.resumeExportArtifacts.find(
      (entry) => entry.id === draft?.approvedExportId,
    );

    expect(job?.applicationUrl).toBe(applicationUrl);
    expect(
      state.savedJobs.find((entry) => entry.id === "job_consent_queue"),
    ).toMatchObject({
      applicationUrl: secondaryApplicationUrl,
      company: "Contoso Labs",
      screeningHints: {
        requiresConsentInterrupt: false,
        requiresConsentInterruptKind: null,
      },
    });
    expect(draft).toMatchObject({ status: "approved" });
    expect(approvedExport).toMatchObject({
      jobId: "job_ready",
      isApproved: true,
    });
    expect(state.applyRuns).toEqual([]);
    expect(state.applicationRecords).toEqual([]);
    expect(state.applicationAttempts).toEqual([]);
    expect(state.userActionRequests).toEqual([]);
    expect(JobFinderRepositoryStateSchema.safeParse(state).success).toBe(true);
  });

  test("apply-queue seed jobs pin historical provenance to the configured target", () => {
    const applyState = createApplyQueueDemoState();
    const configuredTarget =
      applyState.searchPreferences.discovery.targets.find(
        (target) => target.id === "target_linkedin_default",
      );

    expect(configuredTarget).toBeDefined();
    expect(configuredTarget?.enabled).toBe(true);
    expect(configuredTarget?.startingUrl).toBe(
      "https://www.linkedin.com/jobs/search/",
    );

    // job_generating seeds the queue's not-ready entry, so both seed jobs are
    // asserted through the apply queue's derivation chain.
    const generatingSeed = createResumeWorkspaceDemoState().savedJobs.find(
      (job) => job.id === "job_generating",
    );
    const seededJobs = [
      applyState.savedJobs.find((job) => job.id === "job_ready"),
      generatingSeed,
    ];

    for (const job of seededJobs) {
      expect(job?.provenance.length).toBeGreaterThan(0);
      for (const entry of job?.provenance ?? []) {
        expect(SavedJobDiscoveryProvenanceSchema.safeParse(entry).success).toBe(
          true,
        );
        expect(entry.targetId).toBe(configuredTarget?.id);
        expect(entry.adapterKind).toBe(configuredTarget?.adapterKind);
        expect(entry.startingUrl).toBe(configuredTarget?.startingUrl);
        expect(entry.resolvedAdapterKind).toBe(job?.source);
        expect(entry.discoveredAt).toBe(job?.discoveredAt);
      }
    }

    const notReadyQueueJob = applyState.savedJobs.find(
      (job) => job.id === "job_not_ready_queue",
    );
    expect(notReadyQueueJob?.provenance).toEqual(generatingSeed?.provenance);
    expect(applyState.savedJobs.every((job) => job.provenance.length > 0)).toBe(
      true,
    );
  });

  test("apply-queue seed carries prepare-only apply lineage for both paused outcomes", () => {
    const state = createApplyQueueDemoState();

    // Before this seed existed the loader reset the workspace with zero rows
    // in every apply table, so the Applications hand-off could never render.
    expect(state.applyRuns).toHaveLength(1);
    expect(state.applyJobResults).toHaveLength(2);
    expect(state.applicationRecords).toHaveLength(2);
    expect(state.applicationAttempts).toHaveLength(2);
    expect(state.userActionRequests).toHaveLength(1);

    const run = state.applyRuns[0];
    expect(run?.state).toBe("paused_for_user_review");
    expect(run?.submittedJobs).toBe(0);

    const savedJobIds = new Set(state.savedJobs.map((job) => job.id));
    const recordIds = new Set(state.applicationRecords.map((r) => r.id));

    // The snapshot scopes apply rows to the active campaign, and the campaign
    // the seed adopts owns exactly the saved jobs. A run naming a job that is
    // not saved would resolve to no campaign and vanish from Applications even
    // though its rows exist in SQLite.
    expect(run?.jobIds.every((jobId) => savedJobIds.has(jobId))).toBe(true);

    for (const result of state.applyJobResults) {
      expect(result.runId).toBe(run?.id);
      expect(savedJobIds.has(result.jobId)).toBe(true);
      expect(recordIds.has(result.applicationRecordId ?? "")).toBe(true);
      // The exact lineage the browser hand-off and its verification read.
      expect(result.privacyReceipt?.lineage).toEqual({
        runId: run?.id,
        jobId: result.jobId,
        resultId: result.id,
        applicationRecordId: result.applicationRecordId,
      });
    }

    for (const attempt of state.applicationAttempts) {
      expect(savedJobIds.has(attempt.jobId)).toBe(true);
      expect(recordIds.has(attempt.applicationRecordId ?? "")).toBe(true);
      expect(attempt.state).toBe("paused");
    }

    const request = state.userActionRequests[0];
    expect(request?.scope.type).toBe("application");
    if (request?.scope.type === "application") {
      expect(request.scope.applicationRecordId).toBe(
        state.applyJobResults[0]?.applicationRecordId,
      );
      expect(request.scope.jobId).toBe(state.applyJobResults[0]?.jobId);
    }
    expect(request?.submitAuthorized).toBe(false);
    expect(request?.accountCreationAuthorized).toBe(false);
  });

  test("apply-queue seed never claims a submitted outcome", () => {
    const state = createApplyQueueDemoState();

    expect(
      state.applyJobResults.some(
        (result) => result.state === "submitted" || result.completedAt !== null,
      ),
    ).toBe(false);
    expect(
      state.applicationRecords.some((record) => record.status === "submitted"),
    ).toBe(false);
    expect(
      state.applicationAttempts.some(
        (attempt) => attempt.state === "submitted" || attempt.outcome !== null,
      ),
    ).toBe(false);
    expect(state.savedJobs.some((job) => job.status === "submitted")).toBe(
      false,
    );
    expect(state.applySubmitApprovals).toEqual([]);
    expect(state.submissionExecutionGrants).toEqual([]);
    expect(state.submissionArmedMarkers).toEqual([]);
    expect(state.submissionOutcomeRecords).toEqual([]);

    for (const result of state.applyJobResults) {
      expect(result.privacyReceipt?.finalSubmitOccurred).toBe(false);
      expect(result.privacyReceipt?.finalSubmitAuthorized).toBe(false);
      expect(result.privacyReceipt?.accountCreationAuthorized).toBe(false);
      expect(result.privacyReceipt?.submissionOutcome ?? null).toBeNull();
      expect(result.privacyReceipt?.externalWrites).toEqual([]);
    }
  });

  test("both demo repository states satisfy the repository state schema", () => {
    for (const factory of [
      createApplyQueueDemoState,
      createResumeWorkspaceDemoState,
      createAggressiveTailoringDriveState,
    ]) {
      const parsed = JobFinderRepositoryStateSchema.safeParse(factory());
      expect(parsed.success).toBe(true);
    }
  });
});
