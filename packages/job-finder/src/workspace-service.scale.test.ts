import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  JobFinderWorkspaceSnapshotSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nordri/contracts";
import {
  createFileJobFinderRepository,
  type JobFinderRepository,
  type JobFinderRepositorySeed,
} from "@nordri/db";
import { afterEach, describe, expect, test } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
  createSeed,
} from "./workspace-service.test-support";

const SAVED_JOB_COUNT = 1_001;
const APPLICATION_COUNT = 200;
const USER_ACTION_COUNT = 100;
const SHORTLISTED_JOB_COUNT = Math.ceil(SAVED_JOB_COUNT / 10);
const SCALE_BUDGET_MS = 5_000;

const temporaryDirectories = new Set<string>();

function createScaleSeed(): JobFinderRepositorySeed {
  const seed = createSeed();
  const baseJob = seed.savedJobs[0];

  if (!baseJob) {
    throw new Error("The workspace scale fixture requires one saved job.");
  }

  const savedJobs = Array.from({ length: SAVED_JOB_COUNT }, (_, index) => {
    const ordinal = index.toString().padStart(4, "0");
    const status =
      index % 10 === 0
        ? ("shortlisted" as const)
        : ("ready_for_review" as const);

    return {
      ...baseJob,
      id: `scale_job_${ordinal}`,
      sourceJobId: `scale_source_job_${ordinal}`,
      canonicalUrl: `https://jobs.example.com/roles/scale-${ordinal}`,
      applicationUrl: `https://jobs.example.com/roles/scale-${ordinal}/apply`,
      title: `Senior Product Designer ${ordinal}`,
      company: `Scale Company ${index % 50}`,
      status,
      matchAssessment: {
        ...baseJob.matchAssessment,
        score: 70 + (index % 30),
      },
      keywordSignals: baseJob.keywordSignals.map((signal, signalIndex) => ({
        ...signal,
        id: `scale_signal_${ordinal}_${signalIndex}`,
      })),
    };
  });

  const applicationRecords = Array.from(
    { length: APPLICATION_COUNT },
    (_, index) => {
      const job = savedJobs[index]!;
      return ApplicationRecordSchema.parse({
        id: `scale_application_${index}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "drafting",
        lastActionLabel: "Application prepared without submission",
        nextActionLabel: "Review final application",
        lastUpdatedAt: "2026-07-30T08:00:00.000Z",
        lastAttemptState: "paused",
      });
    },
  );

  const applicationAttempts = Array.from(
    { length: APPLICATION_COUNT },
    (_, index) =>
      ApplicationAttemptSchema.parse({
        id: `scale_attempt_${index}`,
        jobId: savedJobs[index]!.id,
        state: "paused",
        summary: "Application prepared for final review.",
        detail: "Stopped at the safe pre-submit checkpoint.",
        startedAt: "2026-07-30T07:59:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
        completedAt: null,
        outcome: "drafting",
        nextActionLabel: "Review final application",
      }),
  );

  const applyRuns = Array.from({ length: APPLICATION_COUNT }, (_, index) =>
    ApplyRunSchema.parse({
      id: `scale_run_${index}`,
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: [savedJobs[index]!.id],
      currentJobId: savedJobs[index]!.id,
      createdAt: "2026-07-30T07:59:00.000Z",
      updatedAt: "2026-07-30T08:00:00.000Z",
      completedAt: null,
      summary: "Application prepared for review.",
      detail: "Final submission remains disabled.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    }),
  );

  const applyJobResults = Array.from(
    { length: APPLICATION_COUNT },
    (_, index) =>
      ApplyJobResultSchema.parse({
        id: `scale_result_${index}`,
        runId: `scale_run_${index}`,
        jobId: savedJobs[index]!.id,
        queuePosition: index,
        state: "awaiting_review",
        summary: "Application prepared for review.",
        detail: "Final submission remains disabled.",
        startedAt: "2026-07-30T07:59:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
        completedAt: null,
      }),
  );

  const userActionRequests = Array.from(
    { length: USER_ACTION_COUNT },
    (_, index) =>
      UserActionRequestSchema.parse({
        id: `scale_action_${index}`,
        dedupeKey: `scale:application:${index}:login`,
        revision: 1,
        kind: "login",
        state: "pending",
        scope: {
          type: "application",
          runId: `scale_run_${index}`,
          jobId: savedJobs[index]!.id,
          resultId: `scale_result_${index}`,
          replayCheckpointId: null,
          source: savedJobs[index]!.source,
        },
        verification: {
          type: "page_blocker_absent",
          blockerFingerprint: `scale_login_wall_${index}`,
          expectedPageFingerprint: null,
        },
        title: "Sign in to continue",
        summary: "Complete sign-in in the Job Finder browser.",
        instructions: ["Sign in without sharing credentials with Job Finder."],
        actionUrl: savedJobs[index]!.applicationUrl,
        displayOrigin: "https://jobs.example.com/",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
      }),
  );

  const userActionEvents = Array.from(
    { length: USER_ACTION_COUNT },
    (_, index) =>
      UserActionEventSchema.parse({
        id: `scale_action_event_${index}`,
        requestId: `scale_action_${index}`,
        operation: "created",
        previousRevision: 0,
        resultingRevision: 1,
        previousState: "pending",
        resultingState: "pending",
        occurredAt: "2026-07-30T08:00:00.000Z",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
  );

  return {
    ...seed,
    savedJobs,
    tailoredAssets: [],
    applicationRecords,
    applicationAttempts,
    applyRuns,
    applyJobResults,
    userActionRequests,
    userActionEvents,
  };
}

function createWorkspaceService(repository: JobFinderRepository) {
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: {
      exists: () => Promise.resolve(true),
    },
    researchAdapter: createResearchAdapter(),
  });
}

function serializeStableSnapshot(snapshot: JobFinderWorkspaceSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    generatedAt: "<generated-at>",
    dashboard: {
      ...snapshot.dashboard,
      generatedAt: "<generated-at>",
    },
  });
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("workspace snapshot scale", () => {
  test("serializes and restores a realistic 1,000-job workspace", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nordri-workspace-scale-"),
    );
    temporaryDirectories.add(directory);
    const filePath = path.join(directory, "job-finder-state.sqlite");
    const seed = createScaleSeed();

    const initializeStartedAt = performance.now();
    let repository = await createFileJobFinderRepository({ filePath, seed });
    const initializeMs = performance.now() - initializeStartedAt;
    let service = createWorkspaceService(repository);

    const initialReadStartedAt = performance.now();
    await service.getWorkspaceSnapshot();
    const initialReadMs = performance.now() - initialReadStartedAt;

    const settingsSnapshot = await service.saveSettings(seed.settings);
    expect(settingsSnapshot.discoveryJobs).toHaveLength(SAVED_JOB_COUNT);

    const initialSerializeStartedAt = performance.now();
    // Both sides go through the same schema, so defaults and key order match.
    const initialSerialized = serializeStableSnapshot(
      JobFinderWorkspaceSnapshotSchema.parse(settingsSnapshot),
    );
    const initialSerializeMs = performance.now() - initialSerializeStartedAt;
    const serializedBytes = Buffer.byteLength(initialSerialized, "utf8");

    await repository.close();

    const restartStartedAt = performance.now();
    repository = await createFileJobFinderRepository({ filePath, seed });
    const restartOpenMs = performance.now() - restartStartedAt;
    service = createWorkspaceService(repository);

    const restartReadStartedAt = performance.now();
    const restartedSnapshot = JobFinderWorkspaceSnapshotSchema.parse(
      await service.getWorkspaceSnapshot(),
    );
    const restartReadMs = performance.now() - restartReadStartedAt;

    const restartSerializeStartedAt = performance.now();
    const restartedSerialized = serializeStableSnapshot(restartedSnapshot);
    const restartSerializeMs = performance.now() - restartSerializeStartedAt;
    const sqliteBytes = (await stat(filePath)).size;

    await repository.close();

    const metrics = {
      savedJobs: restartedSnapshot.discoveryJobs.length,
      reviewQueueItems: restartedSnapshot.reviewQueue.length,
      applicationRecords: restartedSnapshot.applicationRecords.length,
      applicationAttempts: restartedSnapshot.applicationAttempts.length,
      applyRuns: restartedSnapshot.applyRuns.length,
      applyJobResults: restartedSnapshot.applyJobResults.length,
      userActionRequests: restartedSnapshot.userActionRequests.length,
      userActionEvents: restartedSnapshot.userActionEvents.length,
      serializedBytes,
      sqliteBytes,
      initializeMs: Math.round(initializeMs),
      initialReadMs: Math.round(initialReadMs),
      initialSerializeMs: Math.round(initialSerializeMs),
      restartOpenMs: Math.round(restartOpenMs),
      restartReadMs: Math.round(restartReadMs),
      restartSerializeMs: Math.round(restartSerializeMs),
    };

    console.info("workspace-scale-benchmark", metrics);

    expect(metrics).toMatchObject({
      savedJobs: SAVED_JOB_COUNT,
      reviewQueueItems: SAVED_JOB_COUNT - SHORTLISTED_JOB_COUNT,
      applicationRecords: APPLICATION_COUNT,
      applicationAttempts: APPLICATION_COUNT,
      applyRuns: APPLICATION_COUNT,
      applyJobResults: APPLICATION_COUNT,
      userActionRequests: USER_ACTION_COUNT,
      userActionEvents: USER_ACTION_COUNT,
    });
    expect(serializedBytes).toBeGreaterThan(1_000_000);
    expect(restartedSerialized).toBe(initialSerialized);
    expect(initialReadMs).toBeLessThan(SCALE_BUDGET_MS);
    expect(initialSerializeMs).toBeLessThan(SCALE_BUDGET_MS);
    expect(restartOpenMs).toBeLessThan(SCALE_BUDGET_MS);
    expect(restartReadMs).toBeLessThan(SCALE_BUDGET_MS);
    expect(restartSerializeMs).toBeLessThan(SCALE_BUDGET_MS);
  }, 30_000);

  test("discovery preserves every pre-existing saved job above 1,000", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nordri-workspace-discovery-scale-"),
    );
    temporaryDirectories.add(directory);
    const filePath = path.join(directory, "job-finder-state.sqlite");
    const seed = createScaleSeed();
    const existingIds = new Set(seed.savedJobs.map((job) => job.id));
    const repository = await createFileJobFinderRepository({ filePath, seed });

    try {
      const service = createWorkspaceService(repository);
      const snapshot = await service.runDiscovery();
      const preservedJobs = snapshot.discoveryJobs.filter((job) =>
        existingIds.has(job.id),
      );

      expect(preservedJobs).toHaveLength(SAVED_JOB_COUNT);
      expect(await repository.listSavedJobs()).toHaveLength(
        SAVED_JOB_COUNT + 2,
      );
    } finally {
      await repository.close();
    }
  }, 30_000);
});
