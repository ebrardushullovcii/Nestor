import type { IpcMain } from "electron";
import {
  ApplicationPacketSchema,
  ApplicationQuestionRecordSchema,
  ApplyJobResultSchema,
  ApplyRunDetailsSchema,
  ApplyRunSchema,
} from "@nestor/contracts";
import { beforeEach, describe, expect, test, vi } from "vitest";

type Handler = (
  event: { sender: object },
  payload: unknown,
) => Promise<unknown>;

const {
  exposedValues,
  handlers,
  mockBuildApplicationPacket,
  mockClearApplicationAnswer,
  mockGetApplyRunDetails,
  mockSaveApplicationAnswer,
} = vi.hoisted(() => ({
  exposedValues: new Map<string, unknown>(),
  handlers: new Map<string, Handler>(),
  mockBuildApplicationPacket: vi.fn(),
  mockClearApplicationAnswer: vi.fn(),
  mockGetApplyRunDetails: vi.fn(),
  mockSaveApplicationAnswer: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => process.cwd()), getVersion: vi.fn(() => "test") },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposedValues.set(key, value);
    }),
  },
  dialog: { showSaveDialog: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn((channel: string, payload: unknown) => {
      if (channel === "system:job-finder-routes-ready") {
        return Promise.resolve(undefined);
      }
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler '${channel}'.`);
      return handler({ sender: {} }, payload);
    }),
    off: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("../services/job-finder", () => ({
  defaultBenchmarkCases: [],
  dismissJobFinderStartupDatabaseRecoveryNotice: vi.fn(),
  getDesktopTestDelayMs: vi.fn(() => 0),
  getJobFinderStartupDatabaseRecoveryFact: vi.fn(),
  getJobFinderStartupResetRecoveryFact: vi.fn(),
  getJobFinderWorkspaceService: vi.fn(() =>
    Promise.resolve({
      buildApplicationPacket: mockBuildApplicationPacket,
      clearApplicationAnswer: mockClearApplicationAnswer,
      getApplyRunDetails: mockGetApplyRunDetails,
      saveApplicationAnswer: mockSaveApplicationAnswer,
    }),
  ),
  importResumeFromSourcePath: vi.fn(),
  isDesktopTestApiEnabled: vi.fn(() => true),
  loadApplyQueueDemoState: vi.fn(),
  loadResumeWorkspaceDemoState: vi.fn(),
  parseResumeImportPathPayload: vi.fn(),
  resetJobFinderWorkspace: vi.fn(),
  runDesktopResumeImportBenchmark: vi.fn(),
  runDesktopResumeQualityBenchmark: vi.fn(),
  setJobFinderWorkspaceServiceTestEnv: vi.fn(),
}));

import "../../preload/index";
import { registerJobFinderRouteHandlers } from "./job-finder";

const now = "2026-08-23T10:00:00.000Z";
const jobId = "job_same";

function createDetails(suffix: "a" | "b") {
  const applicationRecordId = `application_${suffix}`;
  return ApplyRunDetailsSchema.parse({
    run: ApplyRunSchema.parse({
      id: `run_${suffix}`,
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: [jobId],
      currentJobId: jobId,
      createdAt: now,
      updatedAt: now,
      summary: `Run ${suffix.toUpperCase()}`,
      detail: "Final submit remains disabled.",
    }),
    result: ApplyJobResultSchema.parse({
      id: `result_${suffix}`,
      runId: `run_${suffix}`,
      jobId,
      applicationRecordId,
      state: "awaiting_review",
      summary: `Result ${suffix.toUpperCase()}`,
      detail: "Prepared without submission.",
      startedAt: now,
      updatedAt: now,
    }),
    results: [
      ApplyJobResultSchema.parse({
        id: `result_${suffix}`,
        runId: `run_${suffix}`,
        jobId,
        applicationRecordId,
        state: "awaiting_review",
        summary: `Result ${suffix.toUpperCase()}`,
        detail: "Prepared without submission.",
        startedAt: now,
        updatedAt: now,
      }),
    ],
    questionRecords: [
      ApplicationQuestionRecordSchema.parse({
        id: `question_${suffix}`,
        runId: `run_${suffix}`,
        jobId,
        applicationRecordId,
        resultId: `result_${suffix}`,
        prompt: `Question ${suffix.toUpperCase()}`,
        detectedAt: now,
      }),
    ],
  });
}

function createPacket(suffix: "a" | "b") {
  return ApplicationPacketSchema.parse({
    generatedAt: now,
    job: {
      id: jobId,
      source: "target_site",
      title: "Same job",
      company: "Example",
      location: "Remote",
      listingDestination: {
        origin: "https://jobs.example.com",
        safePath: "/same-job",
      },
      applicationDestination: null,
      summary: null,
    },
    run: {
      id: `run_${suffix}`,
      mode: "copilot",
      state: "paused_for_user_review",
    },
    result: {
      id: `result_${suffix}`,
      applicationRecordId: `application_${suffix}`,
      state: "awaiting_review",
      summary: `Result ${suffix.toUpperCase()}`,
      detail: "Prepared without submission.",
      blockerReason: null,
      blockerSummary: null,
      updatedAt: now,
    },
    resume: null,
    questions: [],
    consent: [],
    checkpoints: [],
    privacyReceipt: null,
    submissionOccurred: false,
  });
}

type JobFinderApi = {
  clearApplicationAnswer(command: unknown): Promise<unknown>;
  exportApplicationPacket(input: unknown): Promise<unknown>;
  getApplyRunDetails(input: unknown): Promise<unknown>;
  saveApplicationAnswer(command: unknown): Promise<unknown>;
};

describe("typed preload/main exact application-record transport", () => {
  let api: JobFinderApi;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerJobFinderRouteHandlers(
      {
        handle: vi.fn((channel: string, handler: Handler) => {
          handlers.set(channel, handler);
        }),
      } as unknown as IpcMain,
      { includeBootstrapRoutes: false },
    );
    const exposed = exposedValues.get("nestor") as
      | { jobFinder?: JobFinderApi }
      | undefined;
    if (!exposed?.jobFinder) throw new Error("Preload API was not exposed.");
    api = exposed.jobFinder;

    mockGetApplyRunDetails.mockImplementation(
      (runId: string, receivedJobId: string, applicationRecordId: string) => {
        const suffix = runId === "run_a" ? "a" : runId === "run_b" ? "b" : null;
        if (
          !suffix ||
          receivedJobId !== jobId ||
          applicationRecordId !== `application_${suffix}`
        ) {
          throw new Error("Exact application record lineage mismatch.");
        }
        return Promise.resolve(createDetails(suffix));
      },
    );
    mockSaveApplicationAnswer.mockImplementation((command: { runId: string }) =>
      Promise.resolve(createDetails(command.runId === "run_a" ? "a" : "b")),
    );
    mockClearApplicationAnswer.mockImplementation(
      (command: { runId: string }) =>
        Promise.resolve(createDetails(command.runId === "run_a" ? "a" : "b")),
    );
    mockBuildApplicationPacket.mockImplementation((runId: string) =>
      Promise.resolve(createPacket(runId === "run_a" ? "a" : "b")),
    );
  });

  test("preserves exact A/B query and command objects through preload and main validation", async () => {
    const targetA = {
      runId: "run_a",
      jobId,
      applicationRecordId: "application_a",
    };
    const targetB = {
      runId: "run_b",
      jobId,
      applicationRecordId: "application_b",
    };
    const saveA = {
      commandId: "save_a",
      runId: "run_a",
      jobId,
      resultId: "result_a",
      questionId: "question_a",
      expectedAnswerRevision: 0,
      value: { type: "text", value: "Only A" },
      saveScope: "application_once",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    };
    const clearB = {
      commandId: "clear_b",
      runId: "run_b",
      jobId,
      resultId: "result_b",
      questionId: "question_b",
      expectedAnswerRevision: 1,
      submitAuthorized: false,
      accountCreationAuthorized: false,
    };

    await expect(api.getApplyRunDetails(targetA)).resolves.toMatchObject({
      result: { applicationRecordId: "application_a" },
    });
    await expect(api.getApplyRunDetails(targetB)).resolves.toMatchObject({
      result: { applicationRecordId: "application_b" },
    });
    await api.saveApplicationAnswer(saveA);
    await api.clearApplicationAnswer(clearB);
    await api.exportApplicationPacket(targetA);
    await api.exportApplicationPacket(targetB);

    expect(mockGetApplyRunDetails).toHaveBeenNthCalledWith(
      1,
      "run_a",
      jobId,
      "application_a",
    );
    expect(mockGetApplyRunDetails).toHaveBeenNthCalledWith(
      2,
      "run_b",
      jobId,
      "application_b",
    );
    expect(mockSaveApplicationAnswer).toHaveBeenCalledWith(saveA);
    expect(mockClearApplicationAnswer).toHaveBeenCalledWith(clearB);
    expect(mockBuildApplicationPacket).toHaveBeenNthCalledWith(
      1,
      "run_a",
      jobId,
      "application_a",
    );
    expect(mockBuildApplicationPacket).toHaveBeenNthCalledWith(
      2,
      "run_b",
      jobId,
      "application_b",
    );
  });

  test("rejects sibling and legacy-null targets without first/latest fallback", async () => {
    await expect(
      api.getApplyRunDetails({
        runId: "run_a",
        jobId,
        applicationRecordId: "application_b",
      }),
    ).rejects.toThrow(/exact application record lineage mismatch/i);
    await expect(
      api.getApplyRunDetails({
        runId: "run_a",
        jobId,
        applicationRecordId: null,
      }),
    ).rejects.toThrow();
    await expect(
      api.getApplyRunDetails({ runId: "run_a", jobId }),
    ).rejects.toThrow();
    expect(mockGetApplyRunDetails).toHaveBeenCalledTimes(1);
  });
});
