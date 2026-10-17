import { describe, expect, it, vi } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  ApplicationRecordSchema,
  JobFinderIntelligenceSafeguardsSchema,
} from "@nestor/contracts";
import {
  buildSafeguardsPresentationModel,
  describeSampleReviewExplanation,
  filterSafeguardRows,
  formatSafeguardTimestamp,
  type SafeguardRow,
} from "./safeguards-presentation";

const now = "2026-08-15T10:00:00.000Z";

it.each([3_000, 10_000])(
  "indexes %i retained jobs once for 50 labels and reuses the index on event-only updates",
  (count) => {
    let idReads = 0;
    let titleReads = 0;
    const jobs = Array.from({ length: count }, (_, index) => ({
      get id() {
        idReads++;
        return `scale_job_${index}`;
      },
      get title() {
        titleReads++;
        return `Role ${index}`;
      },
      company: "Synthetic employer",
      location: "Remote",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
    const firstBoundary = Math.floor(count / 3);
    const workspace = workspaceWith({
      discoveryJobs: jobs.slice(0, firstBoundary),
      companyJobs: jobs.slice(firstBoundary, 2 * firstBoundary),
      dismissedDiscoveryJobs: jobs.slice(2 * firstBoundary),
      campaigns: [],
      applicationRecords: [],
    });
    const arrays = [
      workspace.discoveryJobs,
      workspace.companyJobs,
      workspace.dismissedDiscoveryJobs,
    ];
    const finds = arrays.map((collection) => vi.spyOn(collection, "find"));
    const signals = Array.from({ length: 50 }, (_, index) => ({
      id: `signal_scale_${index}`,
      jobId: `scale_job_${Math.floor((index * count) / 50)}`,
      signal: "suspicious",
      confidence: 0.9,
      detectedAt: now,
      provenance: "browser",
      explanation: `Signal ${index}`,
      recoveryGuidance: "Inspect the listing.",
    }));
    const safeguards = buildSafeguards({ signals });
    const first = buildSafeguardsPresentationModel({ workspace, safeguards });
    expect(idReads).toBe(count);
    expect(titleReads).toBe(50);
    expect(first.rows).toHaveLength(50);
    expect(first.rows[49]!.lineage.jobs).toEqual([
      `Role ${Math.floor((49 * count) / 50)} · Remote · Synthetic employer`,
    ]);
    const again = buildSafeguardsPresentationModel({
      workspace: { ...workspace, generatedAt: "2026-10-13T10:00:00.000Z" },
      safeguards: buildSafeguards({
        signals: signals.map((signal) => ({
          ...signal,
          explanation: "Updated event",
        })),
      }),
    });
    expect(again.rows).toHaveLength(50);
    expect(idReads).toBe(count);
    expect(titleReads).toBe(50);
    // A different company collection does not invalidate unchanged job arrays.
    buildSafeguardsPresentationModel({
      workspace: {
        ...workspace,
        intelligence: { ...workspace.intelligence, companies: [] },
      },
      safeguards,
    });
    expect(idReads).toBe(count);
    const changed = workspace.dismissedDiscoveryJobs.map((job, index) =>
      index === 0 ? { ...job, title: "Updated role" } : job,
    );
    const beforeRebuild = idReads;
    buildSafeguardsPresentationModel({
      workspace: { ...workspace, dismissedDiscoveryJobs: changed },
      safeguards,
    });
    expect(idReads - beforeRebuild).toBe(count - 1);
    for (const find of finds) {
      expect(find).not.toHaveBeenCalled();
      find.mockRestore();
    }
  },
);

it("preserves first-match job precedence and application fallback when collections change", () => {
  const firstJob = {
    id: "same",
    title: "Discovery title",
    company: "Discovery employer",
    location: "Remote",
  };
  const workspace = workspaceWith({
    discoveryJobs: [
      firstJob,
    ] as JobFinderRendererWorkspaceSnapshot["discoveryJobs"],
    companyJobs: [
      { ...firstJob, title: "Company title" },
    ] as JobFinderRendererWorkspaceSnapshot["companyJobs"],
    dismissedDiscoveryJobs: [
      { ...firstJob, title: "Dismissed title" },
    ] as JobFinderRendererWorkspaceSnapshot["dismissedDiscoveryJobs"],
    applicationRecords: [
      {
        id: "record",
        jobId: "fallback",
        title: "Application title",
        company: "Application employer",
      },
    ] as JobFinderRendererWorkspaceSnapshot["applicationRecords"],
    campaigns: [],
  });
  const safeguards = buildSafeguards({
    signals: ["same", "fallback", "missing"].map((jobId) => ({
      id: `signal_${jobId}`,
      jobId,
      signal: "closed",
      confidence: 1,
      detectedAt: now,
      provenance: "browser",
      explanation: "Closed listing",
      recoveryGuidance: "Inspect the listing",
    })),
  });
  const build = (input: JobFinderRendererWorkspaceSnapshot) =>
    buildSafeguardsPresentationModel({ workspace: input, safeguards }).rows.map(
      (row) => row.lineage.jobs[0],
    );
  expect(build(workspace)).toEqual([
    "Discovery title · Remote · Discovery employer",
    "Application title · Application employer",
    "missing",
  ]);
  expect(build({ ...workspace, discoveryJobs: [], companyJobs: [] })[0]).toBe(
    "Dismissed title · Remote · Discovery employer",
  );
  expect(
    build({
      ...workspace,
      applicationRecords: [
        { ...workspace.applicationRecords[0]!, title: "Changed application" },
      ],
    })[1],
  ).toBe("Changed application · Application employer");
});

function emptySafeguards() {
  return JobFinderIntelligenceSafeguardsSchema.parse({});
}

function workspaceWith(
  overrides: Partial<JobFinderRendererWorkspaceSnapshot> = {},
): JobFinderRendererWorkspaceSnapshot {
  return {
    module: "job-finder",
    generatedAt: now,
    discoveryJobs: [
      {
        id: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        location: "Remote",
      },
      {
        id: "job_generating",
        title: "Principal UX Engineer",
        company: "Northwind Labs",
        location: "Hybrid, London",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["discoveryJobs"],
    applicationRecords: [
      {
        id: "application_a",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"],
    campaigns: [
      { id: "campaign_1", name: "Fall campaign", jobIds: ["job_ready"] },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["campaigns"],
    intelligence: {
      companies: [
        {
          id: "company_signal",
          canonicalName: "Signal Systems",
          jobIds: ["job_ready"],
        },
      ],
      safeguards: emptySafeguards(),
    } as unknown as JobFinderRendererWorkspaceSnapshot["intelligence"],
    ...overrides,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function buildSafeguards(overrides: {
  caps?: unknown[];
  conflicts?: unknown[];
  signals?: unknown[];
  pauses?: unknown[];
  reviews?: unknown[];
  contradictions?: unknown[];
  dismissals?: unknown[];
}) {
  return JobFinderIntelligenceSafeguardsSchema.parse({
    companyApplicationCaps: overrides.caps ?? [],
    simultaneousApplicationConflicts: overrides.conflicts ?? [],
    listingSignals: overrides.signals ?? [],
    abnormalFailurePauses: overrides.pauses ?? [],
    preparedBatchSampleReviews: overrides.reviews ?? [],
    contradictoryAnswerDetections: overrides.contradictions ?? [],
    safeguardDismissals: overrides.dismissals ?? [],
  });
}

describe("buildSafeguardsPresentationModel", () => {
  it("projects caps with company lineage and impact counts", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        caps: [
          {
            id: "cap_1",
            companyId: "company_signal",
            maxApplicationsPerWindow: 3,
            windowDays: 7,
            currentWindowCount: 3,
            limitReached: true,
            windowStartedAt: "2026-08-01T00:00:00.000Z",
            explanation: "Per-company weekly cap reached.",
            recoveryGuidance: "Wait for rollover or pick another company.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const capRows = model.rows.filter((row) => row.kind === "caps");
    expect(capRows).toHaveLength(1);
    expect(capRows[0]?.blocked).toBe(true);
    expect(capRows[0]?.title).toBe("3/3 applications");
    expect(capRows[0]?.lineage.companies).toContain("Signal Systems");
    expect(capRows[0]?.lineage.jobs).toContain(
      "Senior Product Designer · Remote · Signal Systems",
    );
    expect(model.counts.blockers).toBe(1);
    expect(model.counts.caps).toBe(1);
  });

  it("resolves simultaneous conflicts to their jobs and marks them detected", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        conflicts: [
          {
            id: "conflict_1",
            applicationRecordId: "application_a",
            conflictingApplicationRecordId: "application_missing",
            status: "detected",
            explanation: "Overlapping applications.",
            recoveryGuidance: "Review and keep one.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const conflictRows = model.rows.filter((row) => row.kind === "conflicts");
    expect(conflictRows).toHaveLength(1);
    expect(conflictRows[0]?.title).toContain(
      "Senior Product Designer · Remote · Signal Systems",
    );
    expect(conflictRows[0]?.title).not.toContain("application_a");
    expect(conflictRows[0]?.blocked).toBe(true);
    expect(conflictRows[0]?.controls.map((control) => control.kind)).toEqual([
      "resolve",
      "dismiss",
    ]);
  });

  it("treats only the latest signal per job as blocking", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        signals: [
          {
            id: "signal_stale",
            jobId: "job_ready",
            signal: "stale",
            detail: null,
            detectedAt: "2026-08-01T10:00:00.000Z",
            confidence: 0.9,
            provenance: "provider",
            explanation: "Stale listing.",
            recoveryGuidance: "Re-verify.",
          },
          {
            id: "signal_closed",
            jobId: "job_ready",
            signal: "closed",
            detail: null,
            detectedAt: "2026-08-02T10:00:00.000Z",
            confidence: 0.9,
            provenance: "provider",
            explanation: "Closed listing.",
            recoveryGuidance: "Re-verify.",
          },
          {
            id: "signal_other_job",
            jobId: "job_generating",
            signal: "suspicious",
            detail: null,
            detectedAt: "2026-08-02T10:00:00.000Z",
            confidence: 0.9,
            provenance: "provider",
            explanation: "Suspicious listing.",
            recoveryGuidance: "Re-verify.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const signalRows = model.rows.filter((row) => row.kind === "signals");
    expect(signalRows).toHaveLength(3);
    expect(signalRows.filter((row) => row.blocked)).toHaveLength(2);
    expect(model.counts.blockers).toBe(2);
  });

  it("exposes pending sample reviews with a review-increment control", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        reviews: [
          {
            id: "review_1",
            batchId: "batch_1",
            preparedCount: 10,
            sampleCount: 2,
            sampledItemIds: ["result_a", "result_b"],
            reviewedCount: 1,
            requiredSampleRatio: 0.2,
            reviewCompleted: false,
            explanation: "Sample review before proceeding.",
            recoveryGuidance: "Review the sample.",
          },
        ],
      }),
      workspace: workspaceWith({
        applyJobResults: [
          {
            id: "result_a",
            jobId: "job_ready",
            applicationRecordId: "application_a",
          },
          {
            id: "result_b",
            jobId: "job_generating",
            applicationRecordId: null,
          },
        ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
    });

    const reviewRows = model.rows.filter((row) => row.kind === "reviews");
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0]?.title).toBe("Quality sample review");
    expect(reviewRows[0]?.blocked).toBe(true);
    expect(reviewRows[0]?.sampleLinks?.[0]?.label).toBe(
      "Senior Product Designer · Remote · Signal Systems",
    );
    expect(reviewRows[0]?.sampleLinks?.[0]?.href).toContain(
      "applicationRecordId=application_a",
    );
    const increment = reviewRows[0]?.controls.find(
      (control) => control.kind === "review_increment",
    );
    expect(increment?.mutation.type).toBe("update_batch_sample_review");
    expect(
      (increment?.mutation as { reviewedCount?: number }).reviewedCount,
    ).toBe(2);
  });

  it("marks contradictions advisory and provides resolve/dismiss controls", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        contradictions: [
          {
            id: "detection_1",
            questionA: "How many years?",
            questionB: "Experience years?",
            answerA: "5",
            answerB: "2",
            contradictionScore: 0.9,
            status: "detected",
            detectedAt: now,
            resolvedAt: null,
            explanation: "Answers conflict.",
            recoveryGuidance: "Ask the user.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const contradictionRows = model.rows.filter(
      (row) => row.kind === "contradictions",
    );
    expect(contradictionRows).toHaveLength(1);
    // Advisory: never counted as a blocker.
    expect(contradictionRows[0]?.blocked).toBe(false);
    expect(model.counts.blockers).toBe(0);
    expect(
      contradictionRows[0]?.controls.map((control) => control.kind),
    ).toEqual(["resolve", "dismiss"]);
  });

  it("counts All as the rendered rows and as the sum of its categories", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        caps: [
          {
            id: "cap_1",
            companyId: "company_signal",
            maxApplicationsPerWindow: 3,
            windowDays: 7,
            currentWindowCount: 3,
            limitReached: true,
            windowStartedAt: "2026-08-01T00:00:00.000Z",
            explanation: "Per-company weekly cap reached.",
            recoveryGuidance: "Wait for rollover or pick another company.",
          },
        ],
        pauses: [
          {
            id: "pause_1",
            windowStartedAt: "2026-08-01T00:00:00.000Z",
            failuresInWindow: 4,
            sampleSize: 5,
            failureRatePercent: 80,
            failureRateThresholdPercent: 40,
            minimumSample: 5,
            paused: true,
            explanation: "Elevated discovery failure rate.",
            recoveryGuidance: "Inspect the failed source history.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const { counts } = model;
    const categorySum =
      counts.caps +
      counts.conflicts +
      counts.signals +
      counts.pauses +
      counts.reviews +
      counts.contradictions +
      counts.dismissals;

    expect(counts.total).toBe(model.rows.length);
    expect(counts.total).toBe(categorySum);
    expect(counts.total).toBe(2);
  });

  it("never builds a row for a threshold that has not been crossed", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        caps: [
          {
            id: "cap_quiet",
            companyId: "company_signal",
            maxApplicationsPerWindow: 3,
            windowDays: 7,
            currentWindowCount: 1,
            limitReached: false,
            windowStartedAt: "2026-08-01T00:00:00.000Z",
            explanation: "Per-company weekly cap.",
            recoveryGuidance: "Nothing to do.",
          },
        ],
        pauses: [
          {
            id: "pause_quiet",
            windowStartedAt: "2026-08-01T00:00:00.000Z",
            failuresInWindow: 0,
            sampleSize: 1,
            failureRatePercent: 0,
            failureRateThresholdPercent: 40,
            minimumSample: 5,
            paused: false,
            explanation: "Failures stayed under the threshold.",
            recoveryGuidance: "Nothing to do.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    expect(model.rows).toHaveLength(0);
    expect(model.counts.total).toBe(0);
    expect(model.counts.blockers).toBe(0);
  });

  it("carries a real destination for every recovery sentence that names one", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        pauses: [
          {
            id: "pause_1",
            windowStartedAt: "2026-08-01T00:00:00.000Z",
            failuresInWindow: 4,
            sampleSize: 5,
            failureRatePercent: 80,
            failureRateThresholdPercent: 40,
            minimumSample: 5,
            paused: true,
            explanation: "Elevated discovery failure rate.",
            recoveryGuidance:
              "Open Search history to see which source failed and why. Fix or disable that source, then retry.",
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const pauseRow = model.rows.find((row) => row.kind === "pauses");
    expect(pauseRow?.recoveryLink).toEqual({
      href: "/job-finder/discovery",
      label: "Open Find jobs",
    });
    // No raw ISO instant reaches the user.
    expect(pauseRow?.subtitle).not.toContain("2026-08-01T00:00:00.000Z");
    expect(pauseRow?.subtitle).toContain(
      formatSafeguardTimestamp("2026-08-01T00:00:00.000Z"),
    );
  });

  it("dismissals suppress a signal row until restored", () => {
    const signal = {
      id: "signal_1",
      jobId: "job_ready",
      signal: "closed",
      detail: null,
      detectedAt: now,
      confidence: 0.95,
      provenance: "provider",
      explanation: "Provider reported the listing as closed.",
      recoveryGuidance: "Re-verify the listing.",
    };
    const model = buildSafeguardsPresentationModel({
      safeguards: buildSafeguards({
        signals: [signal],
        dismissals: [
          {
            id: "dismissal_1",
            kind: "listing_signal",
            referenceId: "signal_1",
            reason: "rechecked",
            note: null,
            dismissedAt: now,
          },
        ],
      }),
      workspace: workspaceWith(),
    });

    const signalRows = model.rows.filter((row) => row.kind === "signals");
    expect(signalRows[0]?.blocked).toBe(false);
    expect(signalRows[0]?.dismissed).toBe(true);
    expect(signalRows[0]?.controls[0]?.kind).toBe("restore");
    expect(model.counts.blockers).toBe(0);
    expect(model.counts.dismissals).toBe(1);
  });
});

describe("filterSafeguardRows", () => {
  function sampleRow(overrides: Partial<SafeguardRow> = {}): SafeguardRow {
    return {
      key: "row_1",
      kind: "signals",
      title: "Listing closed",
      subtitle: "provider",
      explanation: "Provider reported the listing as closed.",
      recoveryGuidance: "Re-verify the listing.",
      statusLabel: "Blocking",
      statusTone: "critical",
      active: true,
      blocked: true,
      dismissed: false,
      lineage: {
        jobs: ["Senior Product Designer · Remote · Signal Systems"],
        companies: [],
        campaigns: [],
      },
      tags: ["signal:closed"],
      controls: [],
      recoveryLink: null,
      searchText: "listing closed signal systems",
      ...overrides,
    };
  }

  it("lists the application pause the Tasks card names, and counts it", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: emptySafeguards(),
      workspace: workspaceWith({
        applyRuns: [
          {
            id: "apply_run_paused",
            state: "paused_for_user_review",
            jobIds: ["job_ready"],
            totalJobs: 3,
            pendingJobs: 2,
            updatedAt: now,
            summary: "Paused by one of your safety limits.",
            detail:
              "Job Finder stopped after your search plan's safety rule was reached.",
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"],
      }),
    });

    const row = model.rows.find((entry) =>
      entry.key.startsWith("apply-run-pause-"),
    );
    expect(row?.title).toBe("Applications paused by a safety limit");
    expect(row?.explanation).toBe(
      "Job Finder stopped after your search plan's safety rule was reached.",
    );
    expect(row?.recoveryGuidance).toContain("Try again on an unstarted job");
    expect(row?.recoveryGuidance).toContain("Daily limits reset tomorrow");
    expect(row?.recoveryGuidance).not.toContain("Settle the limit above");
    expect(row?.recoveryLink).toEqual({
      href: "/job-finder/applications",
      label: "Open Applications",
    });
    // The counters must agree with the Tasks card instead of reading zero.
    expect(model.counts.blockers).toBe(1);
    expect(model.counts.pauses).toBe(1);
    expect(model.counts.total).toBe(1);
  });

  it("does not list a finished or filled-in run as a safety pause", () => {
    const model = buildSafeguardsPresentationModel({
      safeguards: emptySafeguards(),
      workspace: workspaceWith({
        applyRuns: [
          {
            id: "apply_run_sent",
            state: "paused_for_user_review",
            jobIds: ["job_sent"],
            totalJobs: 1,
            pendingJobs: 1,
            updatedAt: now,
            summary: "The site wants you signed in first.",
          },
          {
            id: "apply_run_ready",
            state: "paused_for_user_review",
            jobIds: ["job_ready"],
            totalJobs: 1,
            pendingJobs: 0,
            updatedAt: now,
            summary: "Filled in and ready to send.",
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"],
        applyJobResults: [
          {
            id: "result_sent",
            runId: "apply_run_sent",
            jobId: "job_sent",
            applicationRecordId: "record_sent",
            state: "submitted",
            updatedAt: now,
          },
          {
            id: "result_ready",
            runId: "apply_run_ready",
            jobId: "job_ready",
            applicationRecordId: "record_ready",
            state: "awaiting_review",
            blockerReason: null,
            latestQuestionCount: 0,
            pendingConsentRequestCount: 0,
            reviewCard: { waitingOnYou: [] },
            updatedAt: now,
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"],
      }),
    });

    expect(
      model.rows.filter((entry) => entry.key.startsWith("apply-run-pause-")),
    ).toEqual([]);
    expect(model.counts.blockers).toBe(0);
  });

  it("filters by tab and search text", () => {
    const rows = [
      sampleRow(),
      sampleRow({
        key: "row_2",
        kind: "pauses",
        title: "Paused after repeated failures",
        searchText: "failure rate elevated",
      }),
    ];

    expect(filterSafeguardRows(rows, "signals", "")).toHaveLength(1);
    expect(filterSafeguardRows(rows, "all", "failure")).toHaveLength(1);
    expect(filterSafeguardRows(rows, "all", "signal systems")).toHaveLength(1);
    expect(filterSafeguardRows(rows, "all", "no match")).toHaveLength(0);
  });
});

describe("describeSampleReviewExplanation", () => {
  it("reads a sample saved with the old wording in plain words", () => {
    expect(
      describeSampleReviewExplanation(
        "A deterministic sample of this prepared queue must be reviewed before more automatic preparation continues.",
      ),
    ).toBe(
      "Look over a few of these prepared applications before Job Finder prepares more on its own.",
    );
    expect(describeSampleReviewExplanation("A company cap was reached.")).toBe(
      "A company cap was reached.",
    );
  });
});

it("keeps an old same-company conflict limited to its two applications and uses plain text", () => {
  const workspace = workspaceWith();
  workspace.applicationRecords = Array.from({ length: 10 }, (_, index) => ({
    id: `application_${index}`,
    jobId: `job_${index}`,
    title: `Role ${index}`,
    company: "Synthetic Employer",
  })) as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
  workspace.discoveryJobs = workspace.applicationRecords.map((record) => ({
    id: record.jobId,
    title: record.title,
    company: record.company,
    location: "Remote",
  })) as JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    simultaneousApplicationConflicts: [
      {
        id: "legacy",
        applicationRecordId: "application_0",
        conflictingApplicationRecordId: "application_1",
        explanation:
          "application_0 conservatively normalized company application_1",
        recoveryGuidance: "Review internal IDs",
      },
    ],
  });
  const row = buildSafeguardsPresentationModel({
    safeguards,
    workspace,
  }).rows.find((row) => row.kind === "conflicts")!;
  expect(row.lineage.jobs).toHaveLength(2);
  expect(row.lineage.jobs.join(" ")).not.toContain("Role 9");
  expect(row.explanation).not.toContain("application_");
  expect(row.explanation).not.toContain("normalized");
});

it("shows one company group, labelled places, and revocable choices for specific pairs", () => {
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    simultaneousApplicationConflicts: [
      {
        id: "company_group",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_b",
        companyKey: "signal systems",
        companyName: "Signal Systems",
        jobIds: ["job_ready", "job_generating"],
        status: "detected",
        explanation: "Same employer",
        recoveryGuidance: "Choose a pair",
      },
    ],
  });
  const workspace = workspaceWith();
  workspace.companyJobs = [];
  workspace.dismissedDiscoveryJobs = [];
  workspace.discoveryJobs = workspace.discoveryJobs.map((job) => ({
    ...job,
    title: "Engineer",
    company: "Signal Systems",
  }));
  const row = buildSafeguardsPresentationModel({
    workspace,
    safeguards,
  }).rows.find((row) => row.kind === "conflicts")!;
  expect(row.title).toBe("Signal Systems");
  expect(row.lineage.jobs).toEqual([
    "Engineer · Remote · Signal Systems",
    "Engineer · Hybrid, London · Signal Systems",
  ]);
  expect(row.controls[0]?.label).toContain("London");
  expect(row.controls[0]?.mutation).toEqual({
    type: "decide_same_company_send_pair",
    conflictId: "company_group",
    jobIds: ["job_ready", "job_generating"],
    allow: true,
  });
  safeguards.simultaneousApplicationConflicts[0]!.allowedPairs = [
    {
      jobIds: ["job_generating", "job_ready"],
      decidedAt: now,
      revokedAt: null,
    },
  ];
  const allowed = buildSafeguardsPresentationModel({
    workspace,
    safeguards,
  }).rows.find((row) => row.kind === "conflicts")!;
  expect(allowed.blocked).toBe(false);
  expect(allowed.recoveryGuidance).not.toContain("Choose Send both anyway");
  expect(allowed.recoveryGuidance).toContain("Your choices are saved");
  expect(allowed.controls[0]?.mutation).toMatchObject({ allow: false });
  expect(allowed.controls[0]?.label).toContain("Revoke Send both anyway");
  safeguards.simultaneousApplicationConflicts[0]!.allowedPairs = [];
  workspace.applicationRecords = workspace.discoveryJobs
    .filter((job) => ["job_ready", "job_generating"].includes(job.id))
    .map((job) =>
      ApplicationRecordSchema.parse({
        id: `record_${job.id}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "submitted",
        lastAttemptState: "submitted",
        lastActionLabel: "Confirmed",
        nextActionLabel: "View application",
        lastUpdatedAt: now,
      }),
    );
  const historical = buildSafeguardsPresentationModel({
    workspace,
    safeguards,
  }).rows.find((row) => row.kind === "conflicts")!;
  expect(historical.statusLabel).toBe("Past overlap");
  expect(historical.blocked).toBe(false);
  expect(historical.controls).toHaveLength(0);
});
