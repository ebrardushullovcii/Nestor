import { describe, expect, test } from "vitest";

import {
  CampaignNotificationSchema,
  CampaignRunFactsSchema,
  DISCOVERY_NO_JOB_SITES_MESSAGE,
  DiscoveryRunRecordSchema,
  MatchAssessmentSchema,
  type CampaignNotification,
  type CampaignRunFacts,
  type DiscoveryRunRecord,
} from "@nestor/contracts";

import {
  MAX_CAMPAIGN_NOTIFICATIONS,
  STRONG_MATCH_MIN_SCORE,
  buildCampaignDigest,
  deriveCampaignNotifications,
  describeJobSourceWorkTitle,
  listFailedSources,
  markAllCampaignNotificationsRead,
  markCampaignNotificationRead,
  mergeCampaignNotifications,
} from "./campaign-digest-notifications";

function createRun(
  overrides: Record<string, unknown> = {},
): DiscoveryRunRecord {
  return DiscoveryRunRecordSchema.parse({
    id: "run-1",
    state: "completed",
    startedAt: "2026-07-31T10:00:00.000Z",
    completedAt: "2026-07-31T10:30:00.000Z",
    ...overrides,
  });
}

function notification(
  id: string,
  createdAt: string,
  campaignId = "campaign-1",
): CampaignNotification {
  return CampaignNotificationSchema.parse({
    id,
    campaignId,
    kind: "digest_ready",
    title: `Notification ${id}`,
    body: null,
    createdAt,
    readAt: null,
    unread: true,
    jobId: null,
    sourceTargetId: null,
  });
}

function createRunFacts(
  overrides: Partial<CampaignRunFacts> = {},
): CampaignRunFacts {
  return CampaignRunFactsSchema.parse({
    nextRunAt: null,
    lastRunAt: null,
    lastRunOutcome: null,
    lastRunSummary: null,
    consecutiveFailures: 0,
    ...overrides,
  });
}

function boundAssessment(score: number) {
  return {
    discoveryMethod: "browser_agent" as const,
    matchAssessment: MatchAssessmentSchema.parse({
      score,
      contextFingerprint: "match_context_v4_test",
      postingFingerprint: `match_posting_v4_test_${score}`,
    }),
  };
}

describe("buildCampaignDigest", () => {
  test("builds a truthful digest for a completed run with zero evidence", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun(),
    });

    expect(digest).not.toBeNull();
    expect(digest).toMatchObject({
      id: "digest_run-1",
      campaignId: "campaign-1",
      discoveryRunId: "run-1",
      generatedAt: "2026-07-31T10:30:00.000Z",
      counts: {
        new: 0,
        changed: 0,
        reactivated: 0,
        inactive: 0,
        known: 0,
        skipped: 0,
      },
      failedSources: [],
      jobIds: [],
    });
  });

  test("carries the run's frozen report so a plan card needs no run record", () => {
    const report = {
      version: 1 as const,
      measuredAt: "2026-07-31T10:30:00.000Z",
      found: 50,
      new: 50,
      saved: 50,
      retained: 15,
      worthOpening: 0,
      duplicates: 0,
    };
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({
        summary: { changeDigest: { new: 100, known: 0, skipped: 0 } },
      }),
      report,
    });

    // The digest's change tally and the run's own accounting are different
    // populations; the card must print the run's, not a second number.
    expect(digest?.counts.new).toBe(100);
    expect(digest?.report).toEqual(report);
  });

  test("falls back to the report the run already froze", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({
        summary: {
          report: {
            version: 1,
            measuredAt: "2026-07-31T10:30:00.000Z",
            found: 12,
            new: 9,
            saved: 9,
            retained: 4,
            worthOpening: 1,
            duplicates: 3,
          },
        },
      }),
    });

    expect(digest?.report?.retained).toBe(4);
  });

  test("copies the aggregate change digest counts without fabricating", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({
        summary: {
          changeDigest: {
            new: 3,
            unchanged: 2,
            changed: 1,
            reactivated: 1,
            inactive: 2,
            known: 7,
            skipped: 3,
          },
        },
      }),
    });

    expect(digest?.counts).toEqual({
      new: 3,
      changed: 1,
      reactivated: 1,
      inactive: 2,
      known: 7,
      skipped: 3,
    });
  });

  test("lists only failed sources for a partial run and skips healthy or warning sources", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({
        targetExecutions: [
          {
            targetId: "source-good",
            adapterKind: "auto",
            state: "completed",
            completedAt: "2026-07-31T10:20:00.000Z",
          },
          {
            targetId: "source-failed",
            adapterKind: "auto",
            state: "failed",
            completedAt: "2026-07-31T10:15:00.000Z",
          },
        ],
        summary: {
          sourceHealth: [
            {
              targetId: "source-good",
              health: "healthy",
              durationMs: 600_000,
              warnings: [],
            },
            {
              targetId: "source-warning",
              health: "warning",
              durationMs: 300_000,
              warnings: ["Slow response."],
            },
            {
              targetId: "source-failed",
              health: "failed",
              durationMs: 900_000,
              warnings: ["The source stopped responding."],
            },
          ],
        },
      }),
    });

    expect(digest?.failedSources).toEqual([
      {
        sourceTargetId: "source-failed",
        reason: "The source stopped responding.",
        failedAt: "2026-07-31T10:15:00.000Z",
        retryable: false,
      },
    ]);
    expect(digest?.sourceOutcome).toEqual({ completed: 1, planned: 2 });
  });

  test("falls back to the run completion time for failed sources without target timestamps", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({
        summary: {
          sourceHealth: [
            {
              targetId: "source-failed",
              health: "failed",
              durationMs: 0,
              warnings: [],
            },
          ],
        },
      }),
    });

    expect(digest?.failedSources).toEqual([
      {
        sourceTargetId: "source-failed",
        reason: "The discovery source failed before this run completed.",
        failedAt: "2026-07-31T10:30:00.000Z",
        retryable: false,
      },
    ]);
  });

  test("builds a digest for a failed run state", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({
        state: "failed",
        summary: {
          changeDigest: { new: 1 },
          sourceHealth: [
            {
              targetId: "source-failed",
              health: "failed",
              durationMs: 0,
              warnings: ["Timed out."],
            },
          ],
        },
      }),
    });

    expect(digest?.counts.new).toBe(1);
    expect(digest?.failedSources).toHaveLength(1);
    expect(digest?.failedSources[0]?.sourceTargetId).toBe("source-failed");
    expect(digest?.failedSources[0]?.reason).toBe("Timed out.");
  });

  test("dedupes and caps job ids at the schema maximum", () => {
    const jobIds = [
      "job-1",
      " job-1 ",
      "job-2",
      "",
      "job-2",
      ...Array.from({ length: 10_001 }, (_, index) => `job-${index}`),
    ];
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun(),
      jobIds,
    });

    expect(digest?.jobIds).toHaveLength(10_000);
    expect(new Set(digest?.jobIds).size).toBe(10_000);
  });

  test("honors an explicit generatedAt", () => {
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun(),
      generatedAt: "2026-08-01T09:00:00.000Z",
    });

    expect(digest?.generatedAt).toBe("2026-08-01T09:00:00.000Z");
  });

  test("returns null for runs still in progress", () => {
    expect(
      buildCampaignDigest({
        campaignId: "campaign-1",
        run: createRun({ state: "running" }),
      }),
    ).toBeNull();
    expect(
      buildCampaignDigest({
        campaignId: "campaign-1",
        run: createRun({ state: "idle" }),
      }),
    ).toBeNull();
  });

  test("returns null when the completion time is missing", () => {
    expect(
      buildCampaignDigest({
        campaignId: "campaign-1",
        run: createRun({ completedAt: null }),
      }),
    ).toBeNull();
  });

  test("returns null for invalid run evidence", () => {
    expect(
      buildCampaignDigest({ campaignId: "campaign-1", run: null }),
    ).toBeNull();
    expect(
      buildCampaignDigest({ campaignId: "campaign-1", run: { id: "x" } }),
    ).toBeNull();
    expect(
      buildCampaignDigest({
        campaignId: "campaign-1",
        run: {
          ...createRun(),
          summary: { changeDigest: { new: -1 } },
        },
      }),
    ).toBeNull();
  });

  test("returns null for an empty campaign id", () => {
    expect(
      buildCampaignDigest({ campaignId: "   ", run: createRun() }),
    ).toBeNull();
  });

  test("returns null for an invalid explicit generatedAt", () => {
    expect(
      buildCampaignDigest({
        campaignId: "campaign-1",
        run: createRun(),
        generatedAt: "not-a-timestamp",
      }),
    ).toBeNull();
  });

  test("caps failed sources at the schema maximum", () => {
    const sourceHealth = Array.from({ length: 101 }, (_, index) => ({
      targetId: `source-${index}`,
      health: "failed" as const,
      durationMs: 0,
      warnings: [],
    }));
    const digest = buildCampaignDigest({
      campaignId: "campaign-1",
      run: createRun({ summary: { sourceHealth } }),
    });

    expect(digest?.failedSources).toHaveLength(100);
    expect(digest?.failedSources[0]?.sourceTargetId).toBe("source-0");
    expect(digest?.failedSources[99]?.sourceTargetId).toBe("source-99");
  });
});

describe("listFailedSources", () => {
  test("returns an empty list for invalid run evidence", () => {
    expect(listFailedSources(null)).toEqual([]);
    expect(listFailedSources({ id: "x" })).toEqual([]);
  });

  test("returns an empty list when the run has no completion timestamp", () => {
    expect(listFailedSources(createRun({ completedAt: null }))).toEqual([]);
  });

  test("says a source stopped at a sign-in plainly, not in the agent's words", () => {
    const [source] = listFailedSources(
      createRun({
        targetExecutions: [
          {
            targetId: "source-sign-in",
            adapterKind: "auto",
            state: "failed",
            completedAt: "2026-07-31T10:12:00.000Z",
            accessBlockerReason: "auth_required",
          },
        ],
        summary: {
          sourceHealth: [
            {
              targetId: "source-sign-in",
              health: "failed",
              durationMs: 0,
              warnings: [
                "I did not enter credentials because signing in is not allowed in this run.",
              ],
            },
          ],
        },
      }),
    );
    expect(source?.reason).toBe(
      "This site asks you to sign in before Job Finder can read its jobs. Sign in from Needs you; the search carries on by itself.",
    );
  });

  test("lists only failed health entries with a truthful failure time", () => {
    const sources = listFailedSources(
      createRun({
        targetExecutions: [
          {
            targetId: "source-failed",
            adapterKind: "auto",
            state: "failed",
            completedAt: "2026-07-31T10:12:00.000Z",
          },
        ],
        summary: {
          sourceHealth: [
            {
              targetId: "source-healthy",
              health: "healthy",
              durationMs: 0,
              warnings: [],
            },
            {
              targetId: "source-cancelled",
              health: "cancelled",
              durationMs: 0,
              warnings: [],
            },
            {
              targetId: "source-skipped",
              health: "skipped",
              durationMs: 0,
              warnings: [],
            },
            {
              targetId: "source-pending",
              health: "pending",
              durationMs: 0,
              warnings: [],
            },
            {
              targetId: "source-failed",
              health: "failed",
              durationMs: 0,
              warnings: ["Auth required."],
            },
          ],
        },
      }),
    );

    expect(sources).toEqual([
      {
        sourceTargetId: "source-failed",
        reason: "Auth required.",
        failedAt: "2026-07-31T10:12:00.000Z",
        retryable: false,
      },
    ]);
  });
});

describe("deriveCampaignNotifications", () => {
  test("derives strong match notifications only at or above the strong threshold", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T10:31:00.000Z",
      strongMatches: [
        { jobId: "job-84", title: "Low", fitScore: 84 },
        {
          jobId: "job-86",
          title: "Threshold",
          fitScore: STRONG_MATCH_MIN_SCORE,
          assessment: boundAssessment(STRONG_MATCH_MIN_SCORE),
        },
        {
          jobId: "job-90",
          title: "Senior Engineer",
          company: "Acme",
          fitScore: 90,
          assessment: boundAssessment(90),
        },
        {
          jobId: "job-100",
          title: "Principal",
          fitScore: 100,
          assessment: boundAssessment(100),
        },
      ],
    });

    expect(notifications).toHaveLength(3);
    expect(notifications.map((item) => item.jobId)).toEqual([
      "job-86",
      "job-90",
      "job-100",
    ]);
    expect(notifications[0]).toMatchObject({
      kind: "strong_match",
      id: "n_campaign-1_strong_job-86",
      title: "Strong match: Threshold",
      body: "New match scores 86 of 100.",
      campaignId: "campaign-1",
      unread: true,
      readAt: null,
      sourceTargetId: null,
    });
    expect(notifications[1]?.body).toBe("New match at Acme scores 90 of 100.");
  });

  test("keeps an authoritative bound fit score numeric in the notification body", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T10:31:00.000Z",
      strongMatches: [
        {
          jobId: "job-bound",
          title: "Bound assessment",
          company: "Acme",
          fitScore: 94,
          assessment: boundAssessment(94),
        },
      ],
    });

    expect(notifications[0]?.body).toBe("New match at Acme scores 94 of 100.");
  });

  test("does not expose an unbound fit score in the notification body", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T10:31:00.000Z",
      strongMatches: [
        {
          jobId: "job-unbound",
          title: "Unbound assessment",
          company: "Acme",
          fitScore: 99,
        },
      ],
    });

    expect(notifications[0]?.body).toBe(
      "New match at Acme has fit not assessed.",
    );
    expect(notifications[0]?.body).not.toContain("99");
  });

  test("raises the strong threshold to the campaign minimum fit score", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T10:31:00.000Z",
      minimumFitScore: 90,
      strongMatches: [
        { jobId: "job-86", title: "Below min", fitScore: 86 },
        { jobId: "job-90", title: "At min", fitScore: 90 },
        { jobId: "job-95", title: "Above min", fitScore: 95 },
      ],
    });

    expect(notifications.map((item) => item.jobId)).toEqual([
      "job-90",
      "job-95",
    ]);
  });

  test("skips matches with missing titles, missing job ids, or non-finite scores", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T10:31:00.000Z",
      strongMatches: [
        { jobId: "job-a", title: "   ", fitScore: 95 },
        { jobId: "   ", title: "No id", fitScore: 95 },
        { jobId: "job-b", title: "NaN score", fitScore: Number.NaN },
        { jobId: "job-c", title: "Kept", fitScore: 95 },
      ],
    });

    expect(notifications.map((item) => item.jobId)).toEqual(["job-c"]);
  });

  test("dedupes duplicate strong match evidence by deterministic id", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T10:31:00.000Z",
      strongMatches: [
        { jobId: "job-a", title: "First", fitScore: 95 },
        { jobId: "job-a", title: "Duplicate", fitScore: 95 },
      ],
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Strong match: First");
  });

  test("derives blocked and failed work notifications with truthful details", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:00:00.000Z",
      blockedWork: [
        {
          workId: "apply-run-1",
          jobId: "job-1",
          title: "Senior Engineer",
          reason: "Login required before applying.",
        },
        { jobId: "job-2" },
      ],
      failedWork: [
        {
          workId: "apply-run-2",
          jobId: "job-3",
          title: "Staff Engineer",
          reason: "The application form changed.",
        },
      ],
    });

    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toMatchObject({
      kind: "blocked_work",
      id: "n_campaign-1_blocked_apply-run-1",
      jobId: "job-1",
      title: "Blocked: Senior Engineer",
      body: "Login required before applying.",
      unread: true,
      readAt: null,
    });
    expect(notifications[1]).toMatchObject({
      id: "n_campaign-1_blocked_job-2",
      jobId: "job-2",
      title: "Blocked: Campaign work",
      body: null,
    });
    expect(notifications[2]).toMatchObject({
      id: "n_campaign-1_failed_apply-run-2",
      jobId: "job-3",
      title: "Failed: Staff Engineer",
      body: "The application form changed.",
    });
  });

  test("skips work evidence without a work id or job id", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:00:00.000Z",
      blockedWork: [{ title: "No ids" }, { title: "   ", workId: "" }],
      failedWork: [{}],
    });

    expect(notifications).toEqual([]);
  });

  test("uses source target identity and keeps blocked/failed identities distinct", () => {
    const blocked = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:00:00.000Z",
      blockedWork: [
        {
          sourceTargetId: "source-board",
          title: "Source check",
          reason: "Login required.",
        },
      ],
    });
    const failed = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:01:00.000Z",
      failedWork: [
        {
          sourceTargetId: "source-board",
          title: "Source check",
          reason: "Runtime failed.",
        },
      ],
    });

    expect(blocked[0]).toMatchObject({
      id: "n_campaign-1_blocked_source-board",
      sourceTargetId: "source-board",
    });
    expect(failed[0]).toMatchObject({
      id: "n_campaign-1_failed_source-board",
      sourceTargetId: "source-board",
    });
    expect(blocked[0]?.id).not.toBe(failed[0]?.id);
  });

  test("derives a blocked work notification from failed run facts", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T12:00:00.000Z",
      runFacts: createRunFacts({
        lastRunAt: "2026-07-31T11:00:00.000Z",
        lastRunOutcome: "failed",
        lastRunSummary: "The scheduled run failed after two attempts.",
        consecutiveFailures: 2,
      }),
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "blocked_work",
      id: "n_campaign-1_failed_run_2026-07-31T11:00:00.000Z",
      title: "Failed: search plan run",
      body: "The scheduled run failed after two attempts.",
      jobId: null,
    });
  });

  test("names the failure reason in the body of a failed run notification", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T12:00:00.000Z",
      runFacts: createRunFacts({
        lastRunAt: "2026-07-31T11:00:00.000Z",
        lastRunOutcome: "failed",
        lastRunSummary: `Run failed: ${DISCOVERY_NO_JOB_SITES_MESSAGE}`,
        consecutiveFailures: 1,
      }),
    });

    expect(notifications[0]).toMatchObject({
      title: "Failed: search plan run",
      body: `Run failed: ${DISCOVERY_NO_JOB_SITES_MESSAGE}`,
    });
  });

  test("does not derive run facts notifications for successful or partial outcomes", () => {
    expect(
      deriveCampaignNotifications({
        campaignId: "campaign-1",
        now: "2026-07-31T12:00:00.000Z",
        runFacts: createRunFacts({
          lastRunAt: "2026-07-31T11:00:00.000Z",
          lastRunOutcome: "success",
          lastRunSummary: "Everything worked.",
        }),
      }),
    ).toEqual([]);
    expect(
      deriveCampaignNotifications({
        campaignId: "campaign-1",
        now: "2026-07-31T12:00:00.000Z",
        runFacts: createRunFacts({
          lastRunAt: "2026-07-31T11:00:00.000Z",
          lastRunOutcome: "partial",
          lastRunSummary: "Some sources failed.",
        }),
      }),
    ).toEqual([]);
    expect(
      deriveCampaignNotifications({
        campaignId: "campaign-1",
        now: "2026-07-31T12:00:00.000Z",
        runFacts: createRunFacts({ lastRunOutcome: "failed" }),
      }),
    ).toEqual([]);
  });

  test("returns an empty list for invalid evidence", () => {
    expect(
      deriveCampaignNotifications({
        campaignId: "   ",
        now: "2026-07-31T12:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      deriveCampaignNotifications({
        campaignId: "campaign-1",
        now: "not-a-timestamp",
        strongMatches: [{ jobId: "job-a", title: "T", fitScore: 95 }],
      }),
    ).toEqual([]);
  });
});

describe("mergeCampaignNotifications", () => {
  test("merges lists and dedupes by id keeping the existing notification", () => {
    const existing = [
      notification("n-1", "2026-07-01T00:00:00.000Z"),
      notification("n-2", "2026-07-02T00:00:00.000Z"),
    ];
    const incoming = [
      notification("n-2", "2026-07-03T00:00:00.000Z"),
      notification("n-3", "2026-07-04T00:00:00.000Z"),
    ];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged.map((item) => item.id)).toEqual(["n-1", "n-2", "n-3"]);
    // Existing wins: the duplicate's original createdAt is preserved.
    expect(merged[1]?.createdAt).toBe("2026-07-02T00:00:00.000Z");
  });

  test("preserves read state of existing notifications across re-derivation", () => {
    const existing = [
      {
        ...notification("n-strong-1", "2026-07-01T00:00:00.000Z"),
        readAt: "2026-07-01T12:00:00.000Z",
        unread: false,
      },
    ];
    const incoming = [notification("n-strong-1", "2026-07-01T00:00:00.000Z")];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.unread).toBe(false);
    expect(merged[0]?.readAt).toBe("2026-07-01T12:00:00.000Z");
  });

  test("drops invalid notifications", () => {
    const merged = mergeCampaignNotifications({
      existing: [notification("n-1", "2026-07-01T00:00:00.000Z")],
      incoming: [
        { id: "n-broken" } as unknown as CampaignNotification,
        {
          ...notification("n-read-unread", "2026-07-02T00:00:00.000Z"),
          readAt: "2026-07-02T12:00:00.000Z",
          unread: true,
        },
      ],
    });

    expect(merged.map((item) => item.id)).toEqual(["n-1"]);
  });

  test("caps at 5000 keeping the newest notifications", () => {
    const existing = Array.from(
      { length: MAX_CAMPAIGN_NOTIFICATIONS },
      (_, index) =>
        notification(
          `existing-${index}`,
          new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
        ),
    );
    const incoming = [
      notification("incoming-newest", "2026-07-02T00:00:00.000Z"),
    ];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged).toHaveLength(MAX_CAMPAIGN_NOTIFICATIONS);
    expect(merged.some((item) => item.id === "incoming-newest")).toBe(true);
    // The oldest existing notification is dropped.
    expect(merged.some((item) => item.id === "existing-0")).toBe(false);
  });

  test("kept notifications retain their original relative order", () => {
    const existing = [
      notification("oldest", "2026-07-01T00:00:00.000Z"),
      notification("second", "2026-07-01T00:00:01.000Z"),
      notification("third", "2026-07-01T00:00:02.000Z"),
    ];
    const incoming = [notification("newest", "2026-07-02T00:00:00.000Z")];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged.map((item) => item.id)).toEqual([
      "oldest",
      "second",
      "third",
      "newest",
    ]);
  });

  test("returns an empty list for empty inputs", () => {
    expect(mergeCampaignNotifications({ existing: [], incoming: [] })).toEqual(
      [],
    );
  });
});

describe("markCampaignNotificationRead", () => {
  test("marks exactly one notification read and leaves the rest untouched", () => {
    const notifications = [
      notification("n-1", "2026-07-01T00:00:00.000Z"),
      notification("n-2", "2026-07-02T00:00:00.000Z"),
      notification("n-3", "2026-07-03T00:00:00.000Z"),
    ];

    const marked = markCampaignNotificationRead({
      notifications,
      notificationId: "n-2",
      readAt: "2026-07-04T09:00:00.000Z",
    });

    expect(marked).toHaveLength(3);
    expect(marked[1]).toMatchObject({
      id: "n-2",
      unread: false,
      readAt: "2026-07-04T09:00:00.000Z",
    });
    expect(marked[0]?.unread).toBe(true);
    expect(marked[2]?.unread).toBe(true);
    expect(marked[0]).toBe(notifications[0]);
    expect(marked[2]).toBe(notifications[2]);
    expect(notifications[1]?.unread).toBe(true);
  });

  test("is a no-op for an unknown notification id", () => {
    const notifications = [notification("n-1", "2026-07-01T00:00:00.000Z")];

    const marked = markCampaignNotificationRead({
      notifications,
      notificationId: "n-missing",
      readAt: "2026-07-04T09:00:00.000Z",
    });

    expect(marked).toEqual(notifications);
    expect(marked[0]?.unread).toBe(true);
  });

  test("is a no-op for an invalid readAt", () => {
    const notifications = [notification("n-1", "2026-07-01T00:00:00.000Z")];

    const marked = markCampaignNotificationRead({
      notifications,
      notificationId: "n-1",
      readAt: "yesterday",
    });

    expect(marked).toEqual(notifications);
    expect(marked[0]?.unread).toBe(true);
  });
});

describe("markAllCampaignNotificationsRead", () => {
  test("marks every unread notification read with the same timestamp", () => {
    const notifications = [
      notification("n-1", "2026-07-01T00:00:00.000Z"),
      {
        ...notification("n-2", "2026-07-02T00:00:00.000Z"),
        unread: false,
        readAt: "2026-07-02T12:00:00.000Z",
      },
      notification("n-3", "2026-07-03T00:00:00.000Z"),
    ];

    const marked = markAllCampaignNotificationsRead({
      notifications,
      readAt: "2026-07-04T09:00:00.000Z",
    });

    expect(marked).toHaveLength(3);
    expect(marked[0]).toMatchObject({
      id: "n-1",
      unread: false,
      readAt: "2026-07-04T09:00:00.000Z",
    });
    expect(marked[1]).toMatchObject({
      id: "n-2",
      unread: false,
      readAt: "2026-07-02T12:00:00.000Z",
    });
    expect(marked[2]).toMatchObject({
      id: "n-3",
      unread: false,
      readAt: "2026-07-04T09:00:00.000Z",
    });
    // The original array is not mutated.
    expect(notifications[0]?.unread).toBe(true);
  });

  test("returns a copy even when everything is already read", () => {
    const notifications = [
      {
        ...notification("n-1", "2026-07-01T00:00:00.000Z"),
        unread: false,
        readAt: "2026-07-01T12:00:00.000Z",
      },
    ];

    const marked = markAllCampaignNotificationsRead({
      notifications,
      readAt: "2026-07-04T09:00:00.000Z",
    });

    expect(marked).toEqual(notifications);
    expect(marked[0]?.readAt).toBe("2026-07-01T12:00:00.000Z");
  });

  test("is a no-op for an invalid readAt", () => {
    const notifications = [notification("n-1", "2026-07-01T00:00:00.000Z")];

    const marked = markAllCampaignNotificationsRead({
      notifications,
      readAt: "not-a-timestamp",
    });

    expect(marked).toEqual(notifications);
    expect(marked[0]?.unread).toBe(true);
  });
});

describe("describeJobSourceWorkTitle", () => {
  const targets = [
    { id: "target_tzhl5nit", label: "RemoteOK" },
    { id: "target_blank", label: "   " },
  ];

  test("names a source by the label the user saved", () => {
    expect(describeJobSourceWorkTitle("target_tzhl5nit", targets)).toBe(
      "Job source RemoteOK",
    );
  });

  test("never shows the internal id when the label is gone", () => {
    expect(describeJobSourceWorkTitle("target_removed", targets)).toBe(
      "A job source",
    );
    expect(describeJobSourceWorkTitle("target_blank", targets)).toBe(
      "A job source",
    );
  });
});
