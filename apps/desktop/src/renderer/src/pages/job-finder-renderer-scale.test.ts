import { performance } from "node:perf_hooks";

import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  DiscoveryJobViewSchema,
  ReviewQueueItemSchema,
  UserActionRequestSchema,
  type ApplicationAttempt,
  type ApplicationRecord,
  type DiscoveryJobView,
  type ReviewQueueItem,
  type SavedJob,
  type UserActionRequest,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { listUnresolvedUserActions } from "../features/job-finder/screens/actions/actions-screen";
import {
  APPLICATION_FILTERS,
  type ApplicationsViewFilter,
} from "../features/job-finder/screens/applications/applications-filters";
import {
  getLatestApplicationAttemptForRecord,
  matchesApplicationsFilter,
} from "../features/job-finder/screens/applications/applications-screen-helpers";
import { getJobFinderWorkspaceSelection } from "./use-job-finder-page-controller-helpers";

const DISCOVERY_JOB_COUNT = 1_000;
const REVIEW_QUEUE_COUNT = 100;
const APPLICATION_COUNT = 200;
const APPLICATION_ATTEMPT_COUNT = APPLICATION_COUNT * 2;
const USER_ACTION_COUNT = 100;
const VIEW_MODEL_PASSES = 50;
const SCALE_BUDGET_MS = 1_500;
const FIXED_NOW = "2026-07-30T08:00:00.000Z";

type RendererScaleFixture = {
  applicationAttempts: readonly ApplicationAttempt[];
  applicationRecords: readonly ApplicationRecord[];
  discoveryJobs: readonly DiscoveryJobView[];
  reviewQueue: readonly ReviewQueueItem[];
  userActionRequests: readonly UserActionRequest[];
};

function createDiscoveryJobs(): DiscoveryJobView[] {
  return Array.from({ length: DISCOVERY_JOB_COUNT }, (_, index) => {
    const ordinal = index.toString().padStart(4, "0");

    return DiscoveryJobViewSchema.parse({
      id: `renderer_job_${ordinal}`,
      source: "target_site",
      sourceJobId: `renderer_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.com/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.com/roles/${ordinal}/apply`,
      title: `Senior Product Designer ${ordinal}`,
      company: `Renderer Company ${index % 50}`,
      location: index % 2 === 0 ? "Remote" : "Budapest, Hungary",
      workMode: index % 2 === 0 ? ["remote"] : ["hybrid"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: FIXED_NOW,
      salaryText: null,
      description: `Own product design systems and research for role ${ordinal}.`,
      status: index % 10 === 0 ? "shortlisted" : "discovered",
      matchAssessment: {
        score: 70 + (index % 30),
        reasons: ["Relevant product design experience"],
        gaps: [],
      },
      listingActivity: {
        status: "active",
        observedAt: FIXED_NOW,
        evidence: "last_seen_at",
      },
    });
  });
}

function createReviewQueue(
  discoveryJobs: readonly SavedJob[],
): ReviewQueueItem[] {
  return Array.from({ length: REVIEW_QUEUE_COUNT }, (_, index) => {
    const job = discoveryJobs[index * 10]!;

    return ReviewQueueItemSchema.parse({
      jobId: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      matchScore: job.matchAssessment.score,
      applicationStatus: "shortlisted",
      assetStatus: "not_started",
      progressPercent: 0,
      resumeAssetId: null,
      updatedAt: FIXED_NOW,
    });
  });
}

function createApplications(discoveryJobs: readonly SavedJob[]): {
  attempts: ApplicationAttempt[];
  records: ApplicationRecord[];
} {
  const records: ApplicationRecord[] = [];
  const attempts: ApplicationAttempt[] = [];

  for (let index = 0; index < APPLICATION_COUNT; index += 1) {
    const job = discoveryJobs[index]!;
    const category = index % 5;
    const status = category === 2 ? "submitted" : "drafting";
    const lastAttemptState =
      category === 0
        ? "paused"
        : category === 1
          ? "in_progress"
          : category === 2
            ? "submitted"
            : category === 3
              ? "unsupported"
              : "ready";

    records.push(
      ApplicationRecordSchema.parse({
        id: `renderer_application_${index}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status,
        lastActionLabel: "Application preparation updated",
        nextActionLabel:
          category === 0 || category === 3 ? "Needs user review" : null,
        lastUpdatedAt: FIXED_NOW,
        lastAttemptState,
      }),
    );

    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      const minute = attemptIndex.toString().padStart(2, "0");
      attempts.push(
        ApplicationAttemptSchema.parse({
          id: `renderer_attempt_${index}_${attemptIndex}`,
          jobId: job.id,
          applicationRecordId: `renderer_application_${index}`,
          state: lastAttemptState,
          summary: "Application preparation checkpoint",
          detail: "Final submission remains disabled.",
          startedAt: `2026-07-30T07:${minute}:00.000Z`,
          updatedAt: `2026-07-30T08:${minute}:00.000Z`,
          completedAt: null,
          outcome: status,
          nextActionLabel: null,
        }),
      );
    }
  }

  return { attempts, records };
}

function createUserActions(
  discoveryJobs: readonly SavedJob[],
): UserActionRequest[] {
  return Array.from({ length: USER_ACTION_COUNT }, (_, index) => {
    const job = discoveryJobs[index]!;
    const resolved = index % 4 === 0;

    return UserActionRequestSchema.parse({
      id: `renderer_action_${index}`,
      dedupeKey: `renderer:application:${index}:login`,
      revision: 1,
      kind: "login",
      state: resolved ? "resolved" : "pending",
      scope: {
        type: "application",
        runId: `renderer_run_${index}`,
        jobId: job.id,
        resultId: `renderer_result_${index}`,
        replayCheckpointId: null,
        source: "target_site",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: `renderer_login_${index}`,
        expectedPageFingerprint: null,
      },
      title: "Sign in to continue",
      summary: "Complete sign-in in the Job Finder browser.",
      actionUrl: job.applicationUrl,
      displayOrigin: "https://jobs.example.com/",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      resolvedAt: resolved ? "2026-07-30T08:01:00.000Z" : null,
    });
  });
}

function createFixture(): RendererScaleFixture {
  const discoveryJobs = createDiscoveryJobs();
  const reviewQueue = createReviewQueue(discoveryJobs);
  const applications = createApplications(discoveryJobs);

  return {
    applicationAttempts: applications.attempts,
    applicationRecords: applications.records,
    discoveryJobs,
    reviewQueue,
    userActionRequests: createUserActions(discoveryJobs),
  };
}

function buildRendererViewModelPass(fixture: RendererScaleFixture) {
  const selection = getJobFinderWorkspaceSelection(
    fixture,
    "renderer_job_0999",
    "renderer_job_0990",
  );
  const filterCounts = Object.fromEntries(
    APPLICATION_FILTERS.map((filter) => [
      filter,
      fixture.applicationRecords.filter((record) =>
        matchesApplicationsFilter(record, filter),
      ).length,
    ]),
  ) as Record<ApplicationsViewFilter, number>;
  const activeRecords = fixture.applicationRecords.filter((record) =>
    matchesApplicationsFilter(record, "all"),
  );
  const selectedRecord =
    activeRecords.find((record) => record.id === "renderer_application_199") ??
    activeRecords[0] ??
    null;
  const selectedAttempt = selectedRecord
    ? getLatestApplicationAttemptForRecord(
        selectedRecord,
        fixture.applicationAttempts,
      )
    : null;
  const unresolvedActions = listUnresolvedUserActions(
    fixture.userActionRequests,
  );
  const jobsById = new Map(fixture.discoveryJobs.map((job) => [job.id, job]));
  const actionJobLabels = unresolvedActions.map((request) => {
    const jobId =
      request.scope.type === "application" ? request.scope.jobId : null;
    const job = jobId ? jobsById.get(jobId) : null;
    return job ? `${job.title} at ${job.company}` : null;
  });

  return {
    actionJobLabels,
    filterCounts,
    selectedAttempt,
    selectedRecord,
    selection,
    unresolvedActions,
  };
}

describe("Job Finder renderer workspace scale", () => {
  test("builds deterministic screen view models for 1,000 jobs within budget", () => {
    const fixture = createFixture();

    const startedAt = performance.now();
    let viewModel = buildRendererViewModelPass(fixture);
    for (let pass = 1; pass < VIEW_MODEL_PASSES; pass += 1) {
      viewModel = buildRendererViewModelPass(fixture);
    }
    const durationMs = performance.now() - startedAt;

    const metrics = {
      applicationAttempts: fixture.applicationAttempts.length,
      applicationRecords: fixture.applicationRecords.length,
      discoveryJobs: fixture.discoveryJobs.length,
      durationMs: Math.round(durationMs),
      passes: VIEW_MODEL_PASSES,
      reviewQueueItems: fixture.reviewQueue.length,
      userActionRequests: fixture.userActionRequests.length,
    };

    console.info("job-finder-renderer-scale-benchmark", metrics);

    expect(metrics).toMatchObject({
      applicationAttempts: APPLICATION_ATTEMPT_COUNT,
      applicationRecords: APPLICATION_COUNT,
      discoveryJobs: DISCOVERY_JOB_COUNT,
      passes: VIEW_MODEL_PASSES,
      reviewQueueItems: REVIEW_QUEUE_COUNT,
      userActionRequests: USER_ACTION_COUNT,
    });
    expect(viewModel.selection.selectedDiscoveryJob?.id).toBe(
      "renderer_job_0999",
    );
    expect(viewModel.selection.selectedReviewItem?.jobId).toBe(
      "renderer_job_0990",
    );
    expect(viewModel.selection.selectedReviewJob?.id).toBe("renderer_job_0990");
    expect(viewModel.filterCounts).toEqual({
      all: 200,
      in_progress: 40,
      manual_only: 40,
      needs_action: 120,
      submitted: 40,
    });
    expect(viewModel.selectedRecord?.id).toBe("renderer_application_199");
    expect(viewModel.selectedAttempt?.id).toBe("renderer_attempt_199_1");
    expect(viewModel.unresolvedActions).toHaveLength(75);
    expect(viewModel.actionJobLabels).toHaveLength(75);
    expect(viewModel.actionJobLabels[0]).toContain(
      "Senior Product Designer 0001",
    );
    expect(durationMs).toBeLessThan(SCALE_BUDGET_MS);
  });
});
