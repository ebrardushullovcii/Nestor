import type {
  ResumeBatchGenerationInput,
  ResumeBatchGenerationResult,
  ResumeBatchGenerationProgress,
} from "@nestor/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JobFinderWorkspaceEntityMutationInput,
  JobFinderWorkspaceSyncResult,
} from "@nestor/contracts";

const {
  mockExposeInMainWorld,
  mockInvoke,
  mockIpcRendererOff,
  mockIpcRendererOn,
  mockIpcRendererSend,
} = vi.hoisted(() => ({
  mockExposeInMainWorld: vi.fn(),
  mockInvoke: vi.fn(),
  mockIpcRendererOff: vi.fn(),
  mockIpcRendererOn: vi.fn(),
  mockIpcRendererSend: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    off: mockIpcRendererOff,
    on: mockIpcRendererOn,
    send: mockIpcRendererSend,
  },
}));

import "./index";

type ExposedJobFinderApi = {
  reopenApplicationPage: (
    input: { resultId: string },
    onProgress?: (progress: unknown) => void,
  ) => Promise<unknown>;
  generateResumeForBatch: (
    input: ResumeBatchGenerationInput,
  ) => Promise<ResumeBatchGenerationResult>;
  onResumeBatchProgress: (
    listener: (progress: ResumeBatchGenerationProgress) => void,
  ) => () => void;
  mutateWorkspaceEntities: (
    input: JobFinderWorkspaceEntityMutationInput,
  ) => Promise<JobFinderWorkspaceSyncResult>;
  getApplicationAuthorityReadiness: (input?: unknown) => Promise<unknown>;
  approveCurrentApplicationAnswers: (input: unknown) => Promise<unknown>;
  listApplicationAuthorityEnvelopes: (input?: unknown) => Promise<unknown>;
  createApplicationAuthorityEnvelope: (input: unknown) => Promise<unknown>;
  dismissDiscoveryJob: (
    jobId: string,
    reasons: readonly string[],
    action?: "hide_job" | "hide_and_exclude_employer",
    expectedNormalizedCompanyName?: string | null,
  ) => Promise<unknown>;
  importResume: (onProgress?: (event: unknown) => void) => Promise<unknown>;
  cancelImportResume: () => void;
  previewEmployerExclusion: (jobId: string) => Promise<unknown>;
  removeEmployerExclusion: (input: unknown) => Promise<unknown>;
  getApplyRunDetails: (input: unknown) => Promise<unknown>;
  exportApplicationPacket: (input: unknown) => Promise<unknown>;
  startApplyCopilotRun: (input: unknown) => Promise<unknown>;
  startAutoApplyRun: (input: unknown) => Promise<unknown>;
  cancelApplyRun: (input: unknown) => Promise<unknown>;
  resolveApplyConsentRequest: (input: unknown) => Promise<unknown>;
  focusPreparedApplicationPage: (input: unknown) => Promise<unknown>;
  markAllCampaignNotificationsRead: () => Promise<unknown>;
  mutateSafeguards: (input: unknown) => Promise<unknown>;
  mutateCompanyIntelligence: (input: unknown) => Promise<unknown>;
  projectGroupedManualAnswer: (command: unknown) => Promise<unknown>;
  applyGroupedManualAnswer: (input: unknown) => Promise<unknown>;
  snoozeGroupedDecision: (input: unknown) => Promise<unknown>;
  recordOutcome: (input: unknown) => Promise<unknown>;
  setResumeClaimConfirmation: (input: unknown) => Promise<unknown>;
  setOutcomeSuggestionEnabled: (input: unknown) => Promise<unknown>;
  recommendResumeStrategy: (input: unknown) => Promise<unknown>;
  setCampaignResumeStrategyDefault: (input: unknown) => Promise<unknown>;
  saveResumeStrategy: (input: unknown) => Promise<unknown>;
  selectResumeStrategy: (input: unknown) => Promise<unknown>;
  disableResumeStrategy: (strategyId: string) => Promise<unknown>;
  getStartupResetRecovery: () => Promise<unknown>;
  getStartupDatabaseRecovery: () => Promise<unknown>;
  dismissStartupDatabaseRecoveryNotice: () => Promise<unknown>;
};

const exposedJobFinder = (() => {
  const exposed = mockExposeInMainWorld.mock.calls.at(-1)?.[1] as
    | { jobFinder: ExposedJobFinderApi }
    | undefined;
  if (!exposed) {
    throw new Error("Preload did not expose the nestor API.");
  }
  return exposed.jobFinder;
})();

describe("preload jobFinder grouped manual-answer boundary", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("exposes projectGroupedManualAnswer over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:00:00.000Z" };
    mockInvoke
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce(snapshot);
    const command = {
      groupKey: "group_1",
      requestId: "request_a",
      expectedRequestRevision: 1,
      answer: { type: "text", value: "5 years" },
      saveScope: "reusable_profile",
    };

    const result = await exposedJobFinder.projectGroupedManualAnswer(command);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:project-grouped-manual-answer",
      command,
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes applyGroupedManualAnswer over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:01:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      decisionId: "group_1:abc123",
      requestIds: ["request_a", "request_b"],
      expectedRequestRevisions: { request_a: 1, request_b: 1 },
      answer: { type: "text", value: "5 years" },
    };

    const result = await exposedJobFinder.applyGroupedManualAnswer(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:apply-grouped-manual-answer",
      input,
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes snoozeGroupedDecision over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:02:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      decisionId: "group_1:abc123",
      expectedRevision: 1,
      until: "2026-08-17T10:00:00.000Z",
      reason: "Ask the recruiter",
    };

    const result = await exposedJobFinder.snoozeGroupedDecision(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:snooze-grouped-decision",
      input,
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes markAllCampaignNotificationsRead over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:03:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);

    const result = await exposedJobFinder.markAllCampaignNotificationsRead();

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:mark-all-campaign-notifications-read",
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes recordOutcome over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:04:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      jobId: "job-1",
      outcome: "interview",
      resumeStrategyId: "strategy-1",
      note: "Recruiter call went well",
    };

    const result = await exposedJobFinder.recordOutcome(input);

    expect(mockInvoke).toHaveBeenCalledWith("job-finder:record-outcome", input);
    expect(result).toEqual(snapshot);
  });

  it("exposes mutateSafeguards over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:06:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      type: "record_listing_signal",
      signalId: "signal_1",
      jobId: "job-1",
      signal: "closed",
      detail: null,
      detectedAt: "2026-08-15T10:00:00.000Z",
      confidence: 0.9,
      provenance: "provider",
      explanation: "Provider reported the listing as closed.",
      recoveryGuidance: "Re-verify the listing before applying.",
    };

    const result = await exposedJobFinder.mutateSafeguards(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:mutate-safeguards",
      input,
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes setOutcomeSuggestionEnabled over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:05:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const disable = { dimension: "source", key: "example", enabled: false };

    const result = await exposedJobFinder.setOutcomeSuggestionEnabled(disable);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:set-outcome-suggestion-enabled",
      disable,
    );
    expect(result).toEqual(snapshot);

    const reset = {
      dimension: "campaign",
      key: "campaign-1",
      enabled: true,
      reset: true,
    };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const resetResult =
      await exposedJobFinder.setOutcomeSuggestionEnabled(reset);

    expect(mockInvoke).toHaveBeenLastCalledWith(
      "job-finder:set-outcome-suggestion-enabled",
      reset,
    );
    expect(resetResult).toEqual(snapshot);
  });

  it("exposes recommendResumeStrategy over the typed channel", async () => {
    const recommendation = {
      jobId: "job-1",
      campaignId: "campaign-1",
      roleFamily: "Backend Engineering",
      strategyId: "strategy-1",
      strategyName: "Backend",
      source: "role_family",
      reason: "Exact role family match.",
    };
    mockInvoke.mockResolvedValueOnce(recommendation);

    const result = await exposedJobFinder.recommendResumeStrategy({
      jobId: "job-1",
      campaignId: "campaign-1",
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:recommend-resume-strategy",
      { jobId: "job-1", campaignId: "campaign-1" },
    );
    expect(result).toEqual(recommendation);
  });

  it("exposes setCampaignResumeStrategyDefault over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:06:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);

    const result = await exposedJobFinder.setCampaignResumeStrategyDefault({
      campaignId: "campaign-1",
      strategyId: "strategy-1",
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:set-campaign-resume-strategy-default",
      { campaignId: "campaign-1", strategyId: "strategy-1" },
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes saveResumeStrategy and disableResumeStrategy over typed channels", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:07:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      id: null,
      name: "Backend",
      roleFamily: "Backend Engineering",
      baseResumeDocumentId: "document-1",
      templateId: "classic_ats",
      headlinePolicy: "fixed",
      skillsPolicy: "base_only",
      coveragePolicy: "base_omissions",
      tailoringStrength: "conservative",
      evidenceBoundaries: {},
      enabled: true,
    };

    const saveResult = await exposedJobFinder.saveResumeStrategy(input);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:save-resume-strategy",
      input,
    );
    expect(saveResult).toEqual(snapshot);

    mockInvoke.mockResolvedValueOnce(snapshot);
    const disableResult =
      await exposedJobFinder.disableResumeStrategy("strategy-1");
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "job-finder:disable-resume-strategy",
      "strategy-1",
    );
    expect(disableResult).toEqual(snapshot);
  });

  it("exposes mutateCompanyIntelligence over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-15T10:09:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      companyId: "company_1",
      expectedUpdatedAt: "2026-08-15T10:00:00.000Z",
      mutation: {
        type: "add_note",
        note: {
          id: "note_1",
          body: "Recruiter call scheduled.",
          createdAt: "2026-08-15T10:09:00.000Z",
          updatedAt: "2026-08-15T10:09:00.000Z",
        },
      },
    };

    const result = await exposedJobFinder.mutateCompanyIntelligence(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:mutate-company-intelligence",
      input,
    );
    expect(result).toEqual(snapshot);
  });

  it("forwards exact application lineage through preparation IPC", async () => {
    const detailsTarget = {
      runId: "run-1",
      jobId: "job-1",
      applicationRecordId: "application-1",
    };
    const startTarget = {
      jobId: "job-1",
      applicationRecordId: "application-1",
      visualCheckpointsEnabled: true,
    };
    const consentTarget = {
      ...detailsTarget,
      requestId: "consent-1",
      action: "approve",
    };
    mockInvoke.mockResolvedValue({ ok: true });

    await exposedJobFinder.getApplyRunDetails(detailsTarget);
    await exposedJobFinder.exportApplicationPacket(detailsTarget);
    await exposedJobFinder.startApplyCopilotRun(startTarget);
    await exposedJobFinder.startAutoApplyRun({
      jobId: "job-1",
      applicationRecordId: "application-1",
    });
    await exposedJobFinder.cancelApplyRun(detailsTarget);
    await exposedJobFinder.resolveApplyConsentRequest(consentTarget);

    expect(mockInvoke.mock.calls).toEqual([
      ["job-finder:get-apply-run-details", detailsTarget],
      ["job-finder:export-application-packet", detailsTarget],
      ["job-finder:start-apply-copilot-run", startTarget],
      [
        "job-finder:start-auto-apply-run",
        { jobId: "job-1", applicationRecordId: "application-1" },
      ],
      ["job-finder:cancel-apply-run", detailsTarget],
      ["job-finder:resolve-apply-consent-request", consentTarget],
    ]);
  });

  it("exposes atomic employer exclusion preview, hide, and reversal channels", async () => {
    await exposedJobFinder.previewEmployerExclusion("job-1");
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "job-finder:preview-employer-exclusion",
      { jobId: "job-1" },
    );
    await exposedJobFinder.dismissDiscoveryJob(
      "job-1",
      ["company"],
      "hide_and_exclude_employer",
      "example co",
    );
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "job-finder:dismiss-discovery-job",
      {
        jobId: "job-1",
        reasons: ["company"],
        action: "hide_and_exclude_employer",
        expectedNormalizedCompanyName: "example co",
      },
    );
    await exposedJobFinder.removeEmployerExclusion({
      jobId: "job-1",
      normalizedCompanyName: "example co",
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "job-finder:remove-employer-exclusion",
      { jobId: "job-1", normalizedCompanyName: "example co" },
    );
  });
});

describe("preload prepared application page boundary", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("forwards the exact result lineage over its typed channel", async () => {
    const snapshot = { generatedAt: "2026-09-21T22:00:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const input = {
      runId: "run-1",
      jobId: "job-1",
      resultId: "result-1",
      applicationRecordId: "application-1",
    };

    await expect(
      exposedJobFinder.focusPreparedApplicationPage(input),
    ).resolves.toEqual(snapshot);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:focus-prepared-application-page",
      input,
    );
  });
});

describe("preload jobFinder resume import boundary", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockIpcRendererOn.mockReset();
    mockIpcRendererOff.mockReset();
    mockIpcRendererSend.mockReset();
  });

  it("cleans up the listener and single-flight lock when invoke throws synchronously", async () => {
    const onProgress = vi.fn();
    mockInvoke.mockImplementationOnce(() => {
      throw new Error("renderer is tearing down");
    });

    await expect(exposedJobFinder.importResume(onProgress)).rejects.toThrow(
      "renderer is tearing down",
    );

    const firstListenerCall = mockIpcRendererOn.mock.calls[0] as
      | [channel: string, listener: (...arguments_: unknown[]) => void]
      | undefined;
    const channel = firstListenerCall?.[0];
    const listener = firstListenerCall?.[1];
    expect(channel).toEqual(
      expect.stringMatching(/^job-finder:resume-import-progress:/),
    );
    expect(listener).toEqual(expect.any(Function));
    expect(mockIpcRendererOff).toHaveBeenCalledWith(channel, listener);

    // The failed request must not strand the module-level lock for the next
    // import attempt.
    const snapshot = { generatedAt: "2026-08-30T10:00:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    await expect(exposedJobFinder.importResume()).resolves.toEqual(snapshot);
  });

  it("cleans up after an asynchronous rejection so a retry is accepted", async () => {
    const onProgress = vi.fn();
    mockInvoke.mockRejectedValueOnce(new Error("picker failed"));

    await expect(exposedJobFinder.importResume(onProgress)).rejects.toThrow(
      "picker failed",
    );
    expect(mockIpcRendererOff).toHaveBeenCalledOnce();

    const snapshot = { generatedAt: "2026-08-30T10:01:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    await expect(exposedJobFinder.importResume()).resolves.toEqual(snapshot);
  });

  it("fences a cancelled picker with its request identity", async () => {
    const importResponse = new Promise<unknown>(() => undefined);
    mockInvoke.mockImplementation((channel: unknown) =>
      channel === "system:job-finder-routes-ready"
        ? Promise.resolve(undefined)
        : importResponse,
    );

    const parkedImport = exposedJobFinder.importResume();
    await vi.waitFor(() => {
      const importCall = mockInvoke.mock.calls.find(
        (call) => call[0] === "job-finder:import-resume",
      ) as [channel: string, payload: { requestId: string }] | undefined;

      expect(importCall?.[1].requestId).toMatch(/^resume_import_/);
    });
    await expect(exposedJobFinder.importResume()).rejects.toThrow(
      "A resume import is already running.",
    );
    exposedJobFinder.cancelImportResume();

    await vi.waitFor(() => expect(mockIpcRendererSend).toHaveBeenCalled());
    const cancelCall = mockIpcRendererSend.mock.calls.at(-1) as
      | [channel: string, payload: { requestId: string }]
      | undefined;
    expect(cancelCall?.[0]).toBe("job-finder:cancel-import-resume");
    expect(cancelCall?.[1].requestId).toMatch(/^resume_import_/);

    // The local lock is released for a retry, while the parked old promise's
    // eventual finally cannot clear the new request's identity.
    mockInvoke.mockResolvedValueOnce({
      generatedAt: "2026-08-30T10:02:00.000Z",
    });
    await expect(exposedJobFinder.importResume()).resolves.toEqual({
      generatedAt: "2026-08-30T10:02:00.000Z",
    });
    void parkedImport;
  });
});

describe("preload jobFinder resume claim confirmation boundary", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("exposes setResumeClaimConfirmation over the typed channel", async () => {
    const snapshot = { generatedAt: "2026-08-26T10:00:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const removeCommand = {
      intent: "remove",
      jobId: "job_1",
      draftId: "resume_draft_job_1",
      expectedDraftUpdatedAt: "2026-08-26T09:00:00.000Z",
      confirmationId: "claim_confirmation_section_experience_abc",
    };

    const result =
      await exposedJobFinder.setResumeClaimConfirmation(removeCommand);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:set-resume-claim-confirmation",
      removeCommand,
    );
    expect(result).toEqual(snapshot);
  });

  it("exposes the add intent without reshaping the command", async () => {
    const snapshot = { generatedAt: "2026-08-26T10:01:00.000Z" };
    mockInvoke.mockResolvedValueOnce(snapshot);
    const addCommand = {
      intent: "add",
      jobId: "job_1",
      draftId: "resume_draft_job_1",
      expectedDraftUpdatedAt: "2026-08-26T09:00:00.000Z",
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "experience_1",
      bulletId: "experience_1_bullet_1",
      confirmedClaimContentHash: "fnv1a32:5678efab",
      ownershipStatement: "I confirm this content is accurate and my own.",
    };

    const result =
      await exposedJobFinder.setResumeClaimConfirmation(addCommand);

    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:set-resume-claim-confirmation",
      addCommand,
    );
    expect(result).toEqual(snapshot);
  });
});

describe("preload startup recovery boundary", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("parses getStartupDatabaseRecovery responses through the contract schema", async () => {
    const fact = {
      status: "restored",
      incidentId: "incident-1",
      restoredFrom: "backup-prev",
      lossWindow: {
        detectedAtIso: "2026-08-20T10:00:00.000Z",
        quarantinedDatabaseModifiedAtIso: null,
        restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
      },
      quarantinedArtifactBasenames: ["workspace.sqlite.quarantine-1"],
      restoredAtIso: "2026-08-20T10:05:00.000Z",
      dismissedAtIso: null,
    };
    mockInvoke.mockResolvedValueOnce({ ...fact });

    await expect(
      exposedJobFinder.getStartupDatabaseRecovery(),
    ).resolves.toEqual(fact);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:get-startup-database-recovery",
    );
  });

  it("fails closed when getStartupDatabaseRecovery returns a malformed fact", async () => {
    mockInvoke.mockResolvedValueOnce({
      status: "restored",
      incidentId: "",
    });

    await expect(exposedJobFinder.getStartupDatabaseRecovery()).rejects.toThrow(
      /restored/,
    );
  });

  it("parses getStartupResetRecovery responses through the contract schema", async () => {
    const fact = {
      status: "degraded",
      reason: "marker_quarantined_malformed",
      quarantinedFileName: "job-finder-reset-intent.invalid-a.json",
    };
    mockInvoke.mockResolvedValueOnce({ ...fact });

    await expect(exposedJobFinder.getStartupResetRecovery()).resolves.toEqual(
      fact,
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:get-startup-reset-recovery",
    );
  });

  it("fails closed when getStartupResetRecovery returns a malformed fact", async () => {
    mockInvoke.mockResolvedValueOnce({ status: "completed" });

    await expect(exposedJobFinder.getStartupResetRecovery()).rejects.toThrow(
      /required/i,
    );
  });

  it("parses dismissStartupDatabaseRecoveryNotice responses through the contract schema", async () => {
    const fact = { status: "idle" };
    mockInvoke.mockResolvedValueOnce({ ...fact });

    await expect(
      exposedJobFinder.dismissStartupDatabaseRecoveryNotice(),
    ).resolves.toEqual(fact);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:dismiss-startup-database-recovery-notice",
    );
  });
});

describe("preload application authority boundary", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("validates authority management inputs and outputs", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await expect(
      exposedJobFinder.listApplicationAuthorityEnvelopes({ status: "active" }),
    ).resolves.toEqual([]);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:list-application-authority-envelopes",
      { status: "active" },
    );

    expect(() =>
      exposedJobFinder.createApplicationAuthorityEnvelope({
        mode: "prepare_only",
        scope: { campaignId: null, jobIds: [] },
        maxApplicationsPerRun: 1,
        maxApplicationsPerLocalDay: 1,
        intermediateMutationsAuthorized: false,
        allowedResumeSha256: [],
        allowedOrigins: ["https://jobs.example.com"],
        expiresAt: null,
        allowAutoSubmitOverride: true,
      }),
    ).toThrow();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    mockInvoke.mockResolvedValueOnce([{ id: "malformed" }]);
    await expect(
      exposedJobFinder.listApplicationAuthorityEnvelopes(),
    ).rejects.toThrow();
  });

  it("validates readiness and approval payloads at the preload boundary", async () => {
    const readiness = {
      generatedAt: "2026-08-28T10:00:00.000Z",
      executionCapability: "prepare_only",
      elevatedExecutionAvailable: false,
      answerApprovalStatus: "missing_answers",
      currentAnswers: {
        sourceProfileRevision: 1,
        digest: null,
        entryCount: 0,
        kinds: [],
        missingRequiredKinds: [],
      },
      approvedSnapshot: null,
      activeAuthority: null,
      blockers: [{ code: "no_reusable_answers", remediation: "profile" }],
    };
    mockInvoke.mockResolvedValueOnce(readiness);
    await expect(
      exposedJobFinder.getApplicationAuthorityReadiness(),
    ).resolves.toEqual(readiness);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:get-application-authority-readiness",
      {},
    );

    mockInvoke.mockResolvedValueOnce({
      status: "blocked",
      snapshot: null,
      readiness,
    });
    await expect(
      exposedJobFinder.approveCurrentApplicationAnswers({
        expectedProfileRevision: 1,
        confirmedCurrentAnswers: true,
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:approve-current-application-answers",
      { expectedProfileRevision: 1, confirmedCurrentAnswers: true },
    );
    expect(() =>
      exposedJobFinder.approveCurrentApplicationAnswers({
        expectedProfileRevision: 1,
        confirmedCurrentAnswers: false,
      }),
    ).toThrow();
  });
});

describe("preload desktop test API boundary", () => {
  it("omits the test surface entirely when the test API is disabled", () => {
    expect(process.env.NESTOR_ENABLE_TEST_API).not.toBe("1");
    expect(
      (exposedJobFinder as unknown as { test?: unknown }).test,
    ).toBeUndefined();
  });
});

describe("preload bulk shortlist boundary", () => {
  it("sends all 50 selected IDs in one typed bulk shortlist IPC request", async () => {
    const input: JobFinderWorkspaceEntityMutationInput = {
      baseRevision: 7,
      mutation: {
        type: "queue_jobs_for_review",
        jobIds: Array.from({ length: 50 }, (_, index) => `job-${index}`),
      },
    };
    const response = {
      kind: "delta",
      delta: { baseRevision: 7, currentRevision: 8 },
    };
    // The lazy route-readiness handshake may already be cached, or may run
    // first when this test is selected on its own. Count only the mutation.
    mockInvoke.mockReset().mockResolvedValue(response);
    try {
      expect(await exposedJobFinder.mutateWorkspaceEntities(input)).toBe(
        response,
      );
      expect(
        mockInvoke.mock.calls.filter(
          ([channel]) => channel === "job-finder:mutate-workspace-entities",
        ),
      ).toEqual([["job-finder:mutate-workspace-entities", input]]);
    } finally {
      mockInvoke.mockReset();
    }
  });
});

it("validates thin resume batch receipts and progress, then detaches its listener", async () => {
  mockInvoke.mockResolvedValueOnce({ jobId: "job", outcome: "written" });
  expect(
    await exposedJobFinder.generateResumeForBatch({
      batchId: "batch",
      jobId: "job",
    }),
  ).toEqual({ jobId: "job", outcome: "written" });
  const listener = vi.fn();
  const unsubscribe = exposedJobFinder.onResumeBatchProgress(listener);
  const handle = mockIpcRendererOn.mock.calls.findLast(
    ([channel]) => channel === "job-finder:resume-batch-progress",
  )![1] as (_event: unknown, payload: unknown) => void;
  handle({}, { batchId: "batch", jobId: "job", stage: "writing" });
  handle({}, { batchId: "batch", jobId: "job", stage: "bogus" });
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  expect(mockIpcRendererOff).toHaveBeenCalledWith(
    "job-finder:resume-batch-progress",
    handle,
  );
});

it("reopen validates progress for the requested result and removes its listener after failure", async () => {
  mockInvoke.mockReset();
  mockIpcRendererOn.mockClear();
  let reject!: (error: Error) => void;
  mockInvoke.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const progress = vi.fn();
  const pending = exposedJobFinder.reopenApplicationPage(
    { resultId: "result" },
    progress,
  );
  const [channel, handler] = mockIpcRendererOn.mock.calls[0]! as [
    string,
    (_event: unknown, payload: unknown) => void,
  ];
  handler({}, { resultId: "result", phase: "refilling" });
  handler({}, { resultId: "other", phase: "ready" });
  handler({}, { resultId: "result", phase: "submitted" });
  expect(progress).toHaveBeenCalledExactlyOnceWith({
    resultId: "result",
    phase: "refilling",
  });
  reject(new Error("offline"));
  await expect(pending).rejects.toThrow("offline");
  expect(mockIpcRendererOff).toHaveBeenCalledWith(channel, handler);
  expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(
    "job-finder:reopen-application-page",
    expect.objectContaining({ resultId: "result" }),
  );
});
