import { describe, expect, it } from "vitest";

import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";

import {
  countWorkspaceNeedsYouItems,
  countApplicationLedgerEntries,
  countApplyRunItemsNeedingYou,
  countNeedsYouItems,
  listApplicationsAwaitingUser,
} from "./needs-you-count";

describe("application ledger count", () => {
  it("gives Home, Applications, and Tasks the same count from one fixture", () => {
    const records = Array.from({ length: 13 }, (_, index) => ({
      jobId: `job-${index}`,
    }));
    const applicationsCount = countApplicationLedgerEntries(records);
    const tasksCount = countApplicationLedgerEntries(records);
    const homeCount = countApplicationLedgerEntries(
      records,
      new Set(records.map((record) => record.jobId)),
    );

    expect({ applicationsCount, homeCount, tasksCount }).toEqual({
      applicationsCount: 13,
      homeCount: 13,
      tasksCount: 13,
    });
  });
});

describe("newest application result in Needs you", () => {
  const record = {
    id: "application_one",
    jobId: "shared_job",
    title: "Engineer",
    company: "Example",
    status: "approved",
    lastAttemptState: "paused",
    lastUpdatedAt: "2026-03-20T10:00:00.000Z",
    questionSummary: { total: 0, answered: 0 },
    consentSummary: { status: "approved" },
  } as JobFinderRendererWorkspaceSnapshot["applicationRecords"][number];
  const otherRecord = {
    ...record,
    id: "application_two",
  };
  const result = (
    applicationRecordId: string,
    state: "awaiting_review" | "blocked",
    updatedAt: string,
    uncertain = false,
  ) =>
    ({
      id: `${applicationRecordId}_${updatedAt}`,
      applicationRecordId,
      jobId: "shared_job",
      state,
      updatedAt,
      startedAt: updatedAt,
      blockerReason: uncertain ? "submission_outcome_uncertain" : null,
      privacyReceipt: uncertain
        ? { submissionOutcome: { outcome: "outcome_uncertain" } }
        : null,
    }) as JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];

  it("drops a stale paused record once its newest result is ready", () => {
    const applyJobResults = [
      result(record.id, "awaiting_review", "2026-03-20T11:00:00.000Z"),
      result(record.id, "blocked", "2026-03-20T10:30:00.000Z"),
    ];
    expect(
      listApplicationsAwaitingUser({
        applicationRecords: [record],
        applyJobResults,
        requests: [],
      }),
    ).toEqual([]);
    expect(
      countNeedsYouItems({
        applicationRecords: [record],
        applyJobResults,
        requests: [],
      }),
    ).toBe(0);
  });

  it("keeps an uncertain result for its exact record, even beside a ready record for the same job", () => {
    const applyJobResults = [
      result(record.id, "awaiting_review", "2026-03-20T11:00:00.000Z"),
      result(otherRecord.id, "blocked", "2026-03-20T11:01:00.000Z", true),
    ];
    expect(
      listApplicationsAwaitingUser({
        applicationRecords: [record, otherRecord],
        applyJobResults,
        requests: [],
      }).map((item) => item.id),
    ).toEqual([otherRecord.id]);
    expect(
      countNeedsYouItems({
        applicationRecords: [record, otherRecord],
        applyJobResults,
        requests: [],
      }),
    ).toBe(1);
  });
});

describe("one apply run's share of the Needs you population", () => {
  function blockedRecord(index: number) {
    return {
      id: `application_${index}`,
      jobId: `job_${index}`,
      title: "Manager",
      company: "Alliant Credit Union",
      status: "drafting",
      lastActionLabel: "Preparation paused",
      nextActionLabel: "Finish this step on the site",
      lastUpdatedAt: "2026-09-13T07:00:00.000Z",
      lastAttemptState: "paused",
      questionSummary: {},
      latestBlocker: null,
      consentSummary: { status: "granted" },
      replaySummary: {},
      events: [],
      crm: null,
    } as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"][number];
  }

  it("gives the run summary and the header badge the same number", () => {
    const applicationRecords = [1, 2, 3, 4, 5].map(blockedRecord);
    const runJobIds = new Set(applicationRecords.map((record) => record.jobId));

    const runSummaryCount = countApplyRunItemsNeedingYou({
      applicationRecords,
      requests: [],
      runId: "apply_run_1",
      runJobIds,
    });
    const badgeCount = countNeedsYouItems({
      applicationRecords,
      groupedDecisions: [],
      requests: [],
    });

    expect(runSummaryCount).toBe(5);
    expect(runSummaryCount).toBe(badgeCount);
  });

  it("counts a job once when a live request already represents it", () => {
    const applicationRecords = [1, 2, 3, 4, 5].map(blockedRecord);
    const runJobIds = new Set(applicationRecords.map((record) => record.jobId));
    const requests = [
      {
        id: "request_1",
        state: "awaiting_user",
        scope: {
          type: "application",
          runId: "apply_run_1",
          jobId: "job_1",
          applicationRecordId: "application_1",
        },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];

    expect(
      countApplyRunItemsNeedingYou({
        applicationRecords,
        requests,
        runId: "apply_run_1",
        runJobIds,
      }),
    ).toBe(
      countNeedsYouItems({
        applicationRecords,
        groupedDecisions: [],
        requests,
      }),
    );
  });

  it("leaves another run's waiting applications out of this run's number", () => {
    const applicationRecords = [1, 2, 3, 4, 5].map(blockedRecord);

    expect(
      countApplyRunItemsNeedingYou({
        applicationRecords,
        requests: [],
        runId: "apply_run_1",
        runJobIds: new Set(["job_1", "job_2"]),
      }),
    ).toBe(2);
  });
});

it("keeps resume drafts out of Needs you while the assistant can report them separately", () => {
  expect(
    countNeedsYouItems({
      reviewQueue: [
        {
          jobId: "review",
          resumeReview: { status: "needs_review" },
          resumeApplicationMode: "tailored_per_job",
        },
      ] as JobFinderRendererWorkspaceSnapshot["reviewQueue"],
      requests: [],
      applicationRecords: [],
    }),
  ).toBe(0);
});

it("counts a partially hydrated workspace without reading missing collections", () => {
  expect(
    countWorkspaceNeedsYouItems({
      applicationRecords: [],
      userActionRequests: [],
    } as unknown as JobFinderRendererWorkspaceSnapshot),
  ).toBe(0);
});
