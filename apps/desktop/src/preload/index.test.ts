import type {
  JobFinderWorkspaceEntityMutationInput,
  JobFinderWorkspaceSyncResult,
  ResumeBatchGenerationInput,
  ResumeBatchGenerationProgress,
  ResumeBatchGenerationResult,
} from "@nestor/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  applyJobs: Window["nestor"]["jobFinder"]["applyJobs"];
  listApplications: Window["nestor"]["jobFinder"]["listApplications"];
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
  importResume: (onProgress?: (event: unknown) => void) => Promise<unknown>;
  cancelImportResume: () => void;
  startApplyCopilotRun: (input: unknown) => Promise<unknown>;
  resolveApplyConsentRequest: (input: unknown) => Promise<unknown>;
  setResumeClaimConfirmation: (input: unknown) => Promise<unknown>;
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
    mockInvoke.mockResolvedValue(snapshot);
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

it("exposes the store Apply selection and paged applications without a workspace response", async () => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === "job-finder:apply-jobs") return Promise.resolve({ queued: 2, unchanged: 0, notApproved: 0 });
    if (channel === "job-finder:list-applications") return Promise.resolve({ rows: [], nextCursor: null });
    return Promise.resolve({ ready: true });
  });
  expect(await exposedJobFinder.applyJobs({ selection: { ids: [1, 2] } })).toEqual({ queued: 2, unchanged: 0, notApproved: 0 });
  expect(mockInvoke).toHaveBeenCalledWith("job-finder:apply-jobs", { selection: { ids: [1, 2] } });
  expect(() => exposedJobFinder.applyJobs({ selection: { ids: [-1] } })).toThrow();
  expect(await exposedJobFinder.listApplications({ state: "queued", limit: 20 })).toEqual({ rows: [], nextCursor: null });
  expect(mockInvoke).toHaveBeenCalledWith("job-finder:list-applications", { state: "queued", cursor: null, limit: 20 });
});
