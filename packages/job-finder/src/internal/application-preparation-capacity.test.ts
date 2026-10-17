import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
} from "@nestor/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { deriveGlobalDailyApplicationPreparationCapacity } from "./application-preparation-capacity";

const originalTimeZone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
});

function run(input: {
  id: string;
  campaignId: string | null;
  createdAt: string;
  totalJobs?: number;
  pendingJobs?: number;
}) {
  return ApplyRunSchema.parse({
    id: input.id,
    campaignId: input.campaignId,
    mode: "queue_auto",
    state: "completed",
    jobIds: ["job-1", "job-2"].slice(0, input.totalJobs ?? 1),
    currentJobId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: input.createdAt,
    summary: "Capacity fixture.",
    detail: "Capacity fixture.",
    totalJobs: input.totalJobs ?? 1,
    pendingJobs: input.pendingJobs ?? 0,
  });
}

function result(input: {
  id: string;
  runId: string;
  jobId: string;
  state: "planned" | "filling" | "failed";
  startedAt?: string;
  updatedAt?: string;
  preparationStartedAt?: string | null;
  preparationStartedLocalDate?: string | null;
  blockerReason?: string | null;
}) {
  return ApplyJobResultSchema.parse({
    ...input,
    queuePosition: 0,
    summary: "Capacity fixture.",
    detail: "Capacity fixture.",
    startedAt: input.startedAt ?? "2026-03-08T07:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-08T07:00:00.000Z",
    ...(input.preparationStartedAt !== undefined
      ? {
          applicationPreparationStartedAt: input.preparationStartedAt,
          applicationPreparationStartedLocalDate:
            input.preparationStartedLocalDate,
        }
      : {}),
  });
}

describe("global daily application preparation capacity", () => {
  test("counts persisted start dates exactly and reports intersecting legacy uncertainty", () => {
    const currentCampaign = run({
      id: "run-current",
      campaignId: "campaign-current",
      createdAt: "2026-03-08T06:00:00.000Z",
      totalJobs: 2,
      pendingJobs: 2,
    });
    const legacy = run({
      id: "run-legacy",
      campaignId: null,
      createdAt: "2026-03-08T06:15:00.000Z",
    });
    const legacyWithoutResults = run({
      id: "run-legacy-counters",
      campaignId: null,
      createdAt: "2026-03-08T06:30:00.000Z",
      totalJobs: 2,
      pendingJobs: 1,
    });
    const yesterday = run({
      id: "run-yesterday",
      campaignId: "campaign-other",
      createdAt: "2026-03-07T06:30:00.000Z",
    });

    expect(
      deriveGlobalDailyApplicationPreparationCapacity({
        now: new Date("2026-03-08T06:30:00.000Z"),
        applyRuns: [currentCampaign, legacy, legacyWithoutResults, yesterday],
        applyJobResults: [
          result({
            id: "result-current-planned",
            runId: currentCampaign.id,
            jobId: "job-1",
            state: "planned",
          }),
          result({
            id: "result-current-begun",
            runId: currentCampaign.id,
            jobId: "job-2",
            state: "failed",
            preparationStartedAt: "2026-03-08T07:00:00.000Z",
            preparationStartedLocalDate: "2026-03-08",
          }),
          result({
            id: "result-current-duplicate",
            runId: currentCampaign.id,
            jobId: "job-2",
            state: "filling",
            preparationStartedAt: "2026-03-08T07:00:00.000Z",
            preparationStartedLocalDate: "2026-03-08",
          }),
          result({
            id: "result-legacy-begun",
            runId: legacy.id,
            jobId: "job-1",
            state: "filling",
          }),
          result({
            id: "result-yesterday",
            runId: yesterday.id,
            jobId: "job-1",
            state: "failed",
            preparationStartedAt: "2026-03-07T07:00:00.000Z",
            preparationStartedLocalDate: "2026-03-07",
          }),
        ],
      }),
    ).toEqual({
      limit: 20,
      used: 1,
      legacyUncertain: 1,
      remaining: 18,
      localDate: "2026-03-08",
      resetsAt: "2026-03-09T04:00:00.000Z",
    });
  });

  test("charges a staged-yesterday result on its persisted approval-day mark", () => {
    const staged = run({
      id: "run-staged-yesterday",
      campaignId: "campaign-current",
      createdAt: "2026-03-07T15:00:00.000Z",
    });
    expect(
      deriveGlobalDailyApplicationPreparationCapacity({
        now: new Date("2026-03-08T16:00:00.000Z"),
        applyRuns: [staged],
        applyJobResults: [
          result({
            id: "result-approved-today",
            runId: staged.id,
            jobId: "job-1",
            state: "planned",
            preparationStartedAt: "2026-03-08T16:00:00.000Z",
            preparationStartedLocalDate: "2026-03-08",
          }),
        ],
      }),
    ).toMatchObject({ used: 1, legacyUncertain: 0, remaining: 19 });
  });

  test("does not guess from explicit null start facts or run counters", () => {
    const legacyCounter = run({
      id: "run-counter",
      campaignId: null,
      createdAt: "2026-03-08T15:00:00.000Z",
      totalJobs: 2,
      pendingJobs: 0,
    });
    const capacity = deriveGlobalDailyApplicationPreparationCapacity({
      now: new Date("2026-03-08T16:00:00.000Z"),
      applyRuns: [legacyCounter],
      applyJobResults: [
        result({
          id: "known-unstarted",
          runId: legacyCounter.id,
          jobId: "job-1",
          state: "failed",
          preparationStartedAt: null,
          preparationStartedLocalDate: null,
        }),
      ],
    });
    expect(capacity).toMatchObject({
      used: 0,
      legacyUncertain: 0,
      remaining: 20,
    });
  });

  test("discounts an unopened employer page from begun daily capacity", () => {
    const current = run({
      id: "run-unreachable",
      campaignId: "campaign-current",
      createdAt: "2026-03-08T06:00:00.000Z",
    });
    // The preparation mark exists because the slot is stamped before the
    // browser launches, but the page never opened, so the begun slot is
    // refunded instead of silently consuming daily capacity.
    expect(
      deriveGlobalDailyApplicationPreparationCapacity({
        now: new Date("2026-03-08T16:00:00.000Z"),
        applyRuns: [current],
        applyJobResults: [
          result({
            id: "result-unreachable",
            runId: current.id,
            jobId: "job-1",
            state: "failed",
            blockerReason: "application_page_unreachable",
            preparationStartedAt: "2026-03-08T07:00:00.000Z",
            preparationStartedLocalDate: "2026-03-08",
          }),
          result({
            id: "result-begun",
            runId: current.id,
            jobId: "job-2",
            state: "failed",
            blockerReason: "required_human_input",
            preparationStartedAt: "2026-03-08T07:30:00.000Z",
            preparationStartedLocalDate: "2026-03-08",
          }),
        ],
      }),
    ).toMatchObject({ used: 1, legacyUncertain: 0, remaining: 19 });
  });

  test("computes the next local midnight across the DST fall-back day", () => {
    expect(
      deriveGlobalDailyApplicationPreparationCapacity({
        now: new Date("2026-11-01T05:30:00.000Z"),
        applyRuns: [],
        applyJobResults: [],
      }).resetsAt,
    ).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("application records in the daily counter", () => {
  function record(input: {
    jobId: string;
    at: string;
    preparationStartedAt?: string;
  }) {
    return ApplicationRecordSchema.parse({
      id: `application_${input.jobId}`,
      jobId: input.jobId,
      title: "Senior Engineer",
      company: "Acme",
      status: "approved",
      lastActionLabel: "Application record created for safe preparation.",
      nextActionLabel: null,
      lastUpdatedAt: input.at,
      events: input.preparationStartedAt
        ? [
            {
              id: `event_${input.jobId}_preparation_started`,
              at: input.preparationStartedAt,
              title: "Application preparation started",
              detail: "The employer application was opened for preparation.",
              emphasis: "neutral",
            },
          ]
        : [],
    });
  }

  test("counts today's prepared applications and never double-counts a job", () => {
    // The footer read "0 of 20 used" after twenty preparations because only
    // apply-run results were counted.
    const capacity = deriveGlobalDailyApplicationPreparationCapacity({
      now: new Date("2026-03-08T18:00:00.000Z"),
      applyRuns: [],
      applyJobResults: [],
      applicationRecords: [
        record({
          jobId: "job-1",
          at: "2026-03-08T17:05:00.000Z",
          preparationStartedAt: "2026-03-08T17:00:00.000Z",
        }),
        record({
          jobId: "job-2",
          at: "2026-03-08T17:35:00.000Z",
          preparationStartedAt: "2026-03-08T17:30:00.000Z",
        }),
        record({
          jobId: "job-old",
          at: "2026-03-08T17:40:00.000Z",
          preparationStartedAt: "2026-03-01T17:30:00.000Z",
        }),
      ],
    });

    expect(capacity.used).toBe(2);
    expect(capacity.remaining).toBe(capacity.limit - 2);
  });

  test("a job held by a live reservation is not charged again by its record", () => {
    // The record is written the moment preparation begins, a beat before the
    // run's apply-job result exists. Counting both halved the real daily limit.
    const capacity = deriveGlobalDailyApplicationPreparationCapacity({
      now: new Date("2026-03-08T18:00:00.000Z"),
      applyRuns: [],
      applyJobResults: [],
      applicationRecords: [
        record({
          jobId: "job-1",
          at: "2026-03-08T17:05:00.000Z",
          preparationStartedAt: "2026-03-08T17:00:00.000Z",
        }),
        record({
          jobId: "job-2",
          at: "2026-03-08T17:35:00.000Z",
          preparationStartedAt: "2026-03-08T17:30:00.000Z",
        }),
      ],
      reservedJobIds: ["job-1"],
    });

    expect(capacity.used).toBe(1);
  });

  test("a job already counted through its apply result consumes one slot", () => {
    const applyRun = run({
      id: "run-1",
      campaignId: null,
      createdAt: "2026-03-08T16:00:00.000Z",
    });
    const capacity = deriveGlobalDailyApplicationPreparationCapacity({
      now: new Date("2026-03-08T18:00:00.000Z"),
      applyRuns: [applyRun],
      applyJobResults: [
        result({
          id: "result-1",
          runId: applyRun.id,
          jobId: "job-1",
          state: "filling",
          preparationStartedAt: "2026-03-08T17:00:00.000Z",
          preparationStartedLocalDate: "2026-03-08",
        }),
      ],
      applicationRecords: [
        record({
          jobId: "job-1",
          at: "2026-03-08T17:05:00.000Z",
          preparationStartedAt: "2026-03-08T17:00:00.000Z",
        }),
      ],
    });

    expect(capacity.used).toBe(1);
  });

  test("a record created before a failed preflight does not consume capacity", () => {
    const capacity = deriveGlobalDailyApplicationPreparationCapacity({
      now: new Date("2026-03-08T18:00:00.000Z"),
      applyRuns: [],
      applyJobResults: [],
      applicationRecords: [
        record({
          jobId: "job-preflight-failed",
          at: "2026-03-08T17:00:00.000Z",
        }),
      ],
    });

    expect(capacity).toMatchObject({ used: 0, remaining: capacity.limit });
  });
});

test("uses the person's configured daily preparation limit", () => {
  const capacity = deriveGlobalDailyApplicationPreparationCapacity({
    now: new Date("2026-03-08T18:00:00.000Z"),
    applyRuns: [],
    applyJobResults: [],
    limit: 30,
  });

  expect(capacity).toMatchObject({ limit: 30, used: 0, remaining: 30 });
});

test("exhausts a configured limit lower than the default", () => {
  const current = run({
    id: "run-configured-limit",
    campaignId: "campaign-current",
    createdAt: "2026-03-08T07:00:00.000Z",
  });
  const capacity = deriveGlobalDailyApplicationPreparationCapacity({
    now: new Date("2026-03-08T18:00:00.000Z"),
    applyRuns: [current],
    applyJobResults: [
      result({
        id: "result-configured-limit",
        runId: current.id,
        jobId: "job-1",
        state: "filling",
        preparationStartedAt: "2026-03-08T07:00:00.000Z",
        preparationStartedLocalDate: "2026-03-08",
      }),
    ],
    limit: 1,
  });

  expect(capacity).toMatchObject({ limit: 1, used: 1, remaining: 0 });
});
