import { describe, expect, it, test } from "vitest";

import {
  ACTIVITY_PAUSED_MESSAGE,
  appendDiscoveryLiveActivityEvent,
  applyCompensationPreferenceChange,
  assessJobPostingDetailQuality,
  buildDiscoveryCardOnlyEvidenceWarning,
  DISCOVERY_LIVE_ACTIVITY_EVENT_LIMIT,
  DISCOVERY_RUN_JOB_BUDGET_MAX,
  DiscoveryActivityEventSchema,
  DiscoveryJobViewSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  DiscoveryRunResultSchema,
  DiscoveryRunSummarySchema,
  DiscoveryTargetExecutionSchema,
  DiscoveryTimingSummarySchema,
  isCardOnlyDiscoveryEvidence,
  JobDiscoveryPreferencesSchema,
  SavedJobDiscoveryProvenanceSchema,
  JobPostingSchema,
  MatchAssessmentSchema,
  SavedJobSchema,
  TailoredAssetSchema,
  type DiscoveryActivityEvent,
} from "./discovery";

const postingInput = {
  source: "target_site" as const,
  sourceJobId: "job_1",
  canonicalUrl: "https://example.com/jobs/job-1",
  title: "Software Engineer",
  company: "Acme",
  location: "Remote",
  workMode: ["remote"] as const,
  applyPath: "unknown" as const,
  easyApplyEligible: false,
  discoveredAt: "2026-07-12T10:00:00.000Z",
  salaryText: null,
  description: "Software Engineer role at Acme",
};

const tailoredAssetInput = {
  id: "resume_job_1",
  jobId: "job_1",
  kind: "resume" as const,
  status: "ready" as const,
  label: "Tailored Resume",
  version: "v2",
  templateName: "Chronology Classic",
  compatibilityScore: 92,
  progressPercent: 100,
  updatedAt: "2026-08-23T10:00:00.000Z",
};

describe("discovery contracts", () => {
  test("keeps listing activity snapshot-only with legacy unknown compatibility", () => {
    const savedJobInput = {
      ...postingInput,
      id: "job_1",
      status: "discovered" as const,
      matchAssessment: {
        score: 80,
        reasons: [],
        gaps: [],
      },
    };

    expect(DiscoveryJobViewSchema.parse(savedJobInput).listingActivity).toEqual(
      {
        status: "unknown",
      },
    );
    expect(
      DiscoveryJobViewSchema.parse({
        ...savedJobInput,
        listingActivity: {
          status: "closed",
          observedAt: "2026-08-23T10:00:00.000Z",
          signalId: "signal-1",
          provenance: "provider",
          explanation: "The provider explicitly reported the listing closed.",
          detail: null,
          confidence: 1,
        },
      }).listingActivity,
    ).toMatchObject({
      status: "closed",
      provenance: "provider",
    });
    expect(
      Object.hasOwn(SavedJobSchema.parse(savedJobInput), "listingActivity"),
    ).toBe(false);
    expect(SavedJobSchema.parse(savedJobInput).campaignIds).toEqual([]);
    expect(
      SavedJobSchema.parse({
        ...savedJobInput,
        campaignIds: ["campaign_primary", "campaign_shared"],
      }).campaignIds,
    ).toEqual(["campaign_primary", "campaign_shared"]);
  });

  test("defaults legacy target executions to empty fairness evidence", () => {
    const execution = DiscoveryTargetExecutionSchema.parse({
      targetId: "target_1",
      adapterKind: "auto",
      state: "completed",
    });

    expect(execution).toMatchObject({
      requestedJobBudget: null,
      jobsReviewed: 0,
      jobsSkippedByLedger: 0,
      jobsSkippedByTitleTriage: 0,
      duplicatesMerged: 0,
      invalidSkipped: 0,
      agentCheckpoint: null,
      changeDigest: {
        new: 0,
        unchanged: 0,
        changed: 0,
        reactivated: 0,
        inactive: 0,
        known: 0,
        skipped: 0,
      },
    });
  });

  test("persists a resumable browser-agent checkpoint without weakening job validation", () => {
    const execution = DiscoveryTargetExecutionSchema.parse({
      targetId: "target_checkpoint",
      adapterKind: "auto",
      state: "running",
      agentCheckpoint: {
        revision: 2,
        savedAt: "2026-08-12T10:00:00.000Z",
        currentUrl: "https://example.com/jobs",
        lastStableUrl: "https://example.com/jobs",
        stepCount: 4,
        collectedJobs: [postingInput],
        visitedUrls: ["https://example.com/jobs"],
        phaseEvidence: {},
      },
    });

    expect(execution.agentCheckpoint).toMatchObject({
      revision: 2,
      stepCount: 4,
      collectedJobs: [{ sourceJobId: "job_1" }],
    });
  });

  test("defaults legacy run summaries and validates persisted change and source health", () => {
    const legacy = DiscoveryRunSummarySchema.parse({});

    expect(legacy.changeDigest).toEqual({
      new: 0,
      unchanged: 0,
      changed: 0,
      reactivated: 0,
      inactive: 0,
      known: 0,
      skipped: 0,
    });
    expect(legacy.sourceHealth).toEqual([]);
    expect(legacy.warnings).toEqual([]);

    const summary = DiscoveryRunSummarySchema.parse({
      changeDigest: {
        new: 3,
        unchanged: 4,
        changed: 2,
        reactivated: 1,
        inactive: 5,
        known: 7,
        skipped: 2,
      },
      sourceHealth: [
        {
          targetId: "source_1",
          health: "warning",
          durationMs: 1_200,
          warnings: ["One listing could not be opened."],
        },
      ],
      warnings: ["One listing could not be opened."],
    });

    expect(summary.sourceHealth[0]).toMatchObject({
      targetId: "source_1",
      health: "warning",
      durationMs: 1_200,
    });
  });

  test("defaults legacy discovery timing milestones to unknown", () => {
    const timing = DiscoveryTimingSummarySchema.parse({
      totalDurationMs: 4_200,
      firstActivityMs: 0,
      longestGapMs: 2_000,
      eventCount: 3,
    });

    expect(timing.firstActivityMs).toBe(0);
    expect(timing.firstCandidateMs).toBeNull();
    expect(timing.firstDistinctUsefulJobMs).toBeNull();
  });

  test("defaults legacy postings to card-only detail quality", () => {
    expect(JobPostingSchema.parse(postingInput).detailQuality).toBe(
      "card_only",
    );
  });

  test("defaults legacy tailored assets to null failure detail", () => {
    const asset = TailoredAssetSchema.parse(tailoredAssetInput);

    expect(asset.failureMessage).toBeNull();
    expect(asset.failedAt).toBeNull();
  });

  test("parses a durable failed tailored asset with bounded failure detail", () => {
    const failedAt = "2026-08-23T10:05:00.000Z";
    const asset = TailoredAssetSchema.parse({
      ...tailoredAssetInput,
      status: "failed",
      progressPercent: null,
      storagePath: null,
      contentText: null,
      failureMessage: "Resume generation failed at the provider.",
      failedAt,
    });

    expect(asset.status).toBe("failed");
    expect(asset.failureMessage).toBe(
      "Resume generation failed at the provider.",
    );
    expect(asset.failedAt).toBe(failedAt);
  });

  test("rejects malformed failure timestamps on tailored assets", () => {
    expect(
      TailoredAssetSchema.safeParse({
        ...tailoredAssetInput,
        failedAt: "yesterday",
      }).success,
    ).toBe(false);
  });

  test("defaults legacy postings and ledger entries to unknown provider freshness", () => {
    expect(JobPostingSchema.parse(postingInput).providerUpdatedAt).toBeNull();
    expect(
      DiscoveryLedgerEntrySchema.parse({
        id: "ledger_legacy_freshness",
        canonicalUrl: postingInput.canonicalUrl,
        source: postingInput.source,
        sourceJobId: postingInput.sourceJobId,
        title: postingInput.title,
        company: postingInput.company,
        targetId: "target_1",
        firstSeenAt: postingInput.discoveredAt,
        lastSeenAt: postingInput.discoveredAt,
      }).providerUpdatedAt,
    ).toBeNull();
  });

  test("validates an explicit provider freshness timestamp", () => {
    const timestamp = "2026-07-12T11:00:00.000Z";
    expect(
      JobPostingSchema.parse({ ...postingInput, providerUpdatedAt: timestamp })
        .providerUpdatedAt,
    ).toBe(timestamp);
    expect(() =>
      JobPostingSchema.parse({
        ...postingInput,
        providerUpdatedAt: "yesterday",
      }),
    ).toThrow();
  });

  test("defaults legacy ledger entries to a safe missing fingerprint", () => {
    const ledgerEntry = DiscoveryLedgerEntrySchema.parse({
      id: "ledger_legacy",
      canonicalUrl: postingInput.canonicalUrl,
      source: postingInput.source,
      sourceJobId: postingInput.sourceJobId,
      title: postingInput.title,
      company: postingInput.company,
      targetId: "target_1",
      firstSeenAt: postingInput.discoveredAt,
      lastSeenAt: postingInput.discoveredAt,
    });

    expect(ledgerEntry.fingerprints).toBeNull();
  });

  test("preserves explicit detail-enriched quality on postings and ledger entries", () => {
    const posting = JobPostingSchema.parse({
      ...postingInput,
      detailQuality: "detail_enriched",
    });
    const ledgerEntry = DiscoveryLedgerEntrySchema.parse({
      id: "ledger_1",
      canonicalUrl: posting.canonicalUrl,
      source: posting.source,
      sourceJobId: posting.sourceJobId,
      title: posting.title,
      company: posting.company,
      targetId: "target_1",
      collectionMethod: "careers_page",
      detailQuality: posting.detailQuality,
      fingerprints: {
        version: 1,
        card: "v1_card",
        detail: "v1_detail",
        material: "v1_material",
      },
      firstSeenAt: posting.discoveredAt,
      lastSeenAt: posting.discoveredAt,
      latestStatus: "enriched",
      titleTriageOutcome: "pass",
    });

    expect(posting.detailQuality).toBe("detail_enriched");
    expect(ledgerEntry.detailQuality).toBe("detail_enriched");
    expect(ledgerEntry.fingerprints?.version).toBe(1);
  });

  test("defaults legacy match assessments to review-first evidence semantics", () => {
    const assessment = MatchAssessmentSchema.parse({
      score: 80,
      reasons: ["Relevant title"],
      gaps: [],
    });

    expect(assessment.recommendation).toBe("review_before_applying");
    expect(assessment.requirements).toEqual([]);
    expect(assessment.scorerVersion).toBe(1);
    expect(assessment.contextFingerprint).toBeNull();
    expect(assessment.postingFingerprint).toBeNull();
    expect(assessment.compensationFit).toMatchObject({
      state: "unknown",
      confidence: "unavailable",
      minimumSalaryUsd: null,
      listingMinimumAnnualUsd: null,
    });
    expect(assessment.dimensions).toMatchObject({
      roleSuitability: { state: "unknown", evidence: [] },
      preferenceAlignment: { state: "unknown", evidence: [] },
      applicationEffort: { level: "unknown", evidence: [] },
      evidenceConfidence: {
        level: "unavailable",
        evidence: [],
        supportedCount: 0,
        partialCount: 0,
        missingCount: 0,
        unknownCount: 0,
        conflictCount: 0,
      },
    });
  });

  test("validates versioned explicit compensation fit evidence", () => {
    const assessment = MatchAssessmentSchema.parse({
      scorerVersion: 2,
      score: 68,
      reasons: [],
      gaps: ["Compensation is below the saved salary minimum."],
      compensationFit: {
        state: "below_minimum",
        confidence: "high",
        minimumSalaryUsd: 120_000,
        listingMinimumAnnualUsd: 95_000,
        listingCurrency: "USD",
        explanation: "The listing minimum is below the saved USD minimum.",
      },
    });

    expect(assessment.scorerVersion).toBe(2);
    expect(assessment.compensationFit.state).toBe("below_minimum");
    expect(assessment.compensationFit.listingMinimumAnnualUsd).toBe(95_000);
  });

  test("validates bounded explainable match dimensions", () => {
    const dimensions = {
      roleSuitability: {
        state: "exact" as const,
        explanation: "The listing title directly matches a target role.",
        evidence: [
          {
            source: "listing" as const,
            label: "Listing title",
            detail: "Senior Product Designer",
          },
        ],
      },
      preferenceAlignment: {
        state: "mixed" as const,
        explanation: "Location aligns while work mode conflicts.",
        evidence: [],
      },
      applicationEffort: {
        level: "low" as const,
        explanation: "An in-platform application path is available.",
        evidence: [],
      },
      evidenceConfidence: {
        level: "high" as const,
        explanation: "Most extracted requirements have explicit evidence.",
        evidence: [],
        supportedCount: 3,
        partialCount: 0,
        missingCount: 1,
        unknownCount: 0,
        conflictCount: 0,
      },
    };
    const assessment = MatchAssessmentSchema.parse({
      scorerVersion: 3,
      score: 82,
      dimensions,
    });

    expect(assessment.dimensions).toEqual(dimensions);
    expect(
      MatchAssessmentSchema.safeParse({
        scorerVersion: 3,
        score: 82,
        dimensions: {
          ...dimensions,
          roleSuitability: {
            ...dimensions.roleSuitability,
            evidence: Array.from({ length: 5 }, (_, index) => ({
              source: "derived" as const,
              label: `Evidence ${index}`,
              detail: "Bounded diagnostic evidence.",
            })),
          },
        },
      }).success,
    ).toBe(false);
  });

  test("validates requirement evidence and its resume source", () => {
    const assessment = MatchAssessmentSchema.parse({
      score: 74,
      reasons: [],
      gaps: ["FastAPI is not present in the resume."],
      recommendation: "review_before_applying",
      recommendationRationale: "FastAPI needs explicit evidence.",
      requirements: [
        {
          id: "requirement_skill_fastapi",
          category: "skill",
          label: "FastAPI",
          importance: "required",
          status: "missing",
          jobEvidence: "You must have production experience with FastAPI.",
          resumeEvidence: [],
          explanation: "No explicit FastAPI evidence was found.",
        },
      ],
    });

    expect(assessment.requirements[0]).toMatchObject({
      label: "FastAPI",
      importance: "required",
      status: "missing",
    });
  });

  test("keeps live activity bounded while retaining each source's latest and terminal truth", () => {
    const event = (input: {
      id: string;
      targetId: string | null;
      message: string;
      kind?: "info" | "progress" | "success" | "warning" | "error";
      terminalState?: "completed" | "failed" | "cancelled" | "skipped" | null;
    }) =>
      DiscoveryActivityEventSchema.parse({
        id: input.id,
        runId: "run_live_cap",
        timestamp: "2026-08-19T10:00:00.000Z",
        kind: input.kind ?? "progress",
        stage: input.targetId ? "target" : "run",
        targetId: input.targetId,
        message: input.message,
        terminalState: input.terminalState ?? null,
      });

    let liveEvents = appendDiscoveryLiveActivityEvent(
      [],
      event({
        id: "source_1_progress",
        targetId: "source_1",
        message: "Source 1 is still being reviewed.",
      }),
    );
    liveEvents = appendDiscoveryLiveActivityEvent(
      liveEvents,
      event({
        id: "source_1_terminal",
        targetId: "source_1",
        kind: "error",
        terminalState: "failed",
        message: "Source 1 failed.",
      }),
    );
    liveEvents = appendDiscoveryLiveActivityEvent(
      liveEvents,
      event({
        id: "source_1_late_progress",
        targetId: "source_1",
        message: "A late source 1 progress tick.",
      }),
    );

    for (
      let index = 0;
      index < DISCOVERY_LIVE_ACTIVITY_EVENT_LIMIT * 3;
      index += 1
    ) {
      liveEvents = appendDiscoveryLiveActivityEvent(
        liveEvents,
        event({
          id: `run_progress_${index}`,
          targetId: null,
          message: `Run progress ${index}`,
        }),
      );
    }

    expect(
      liveEvents.filter((candidate) => candidate.targetId === null),
    ).toHaveLength(DISCOVERY_LIVE_ACTIVITY_EVENT_LIMIT);
    expect(liveEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source_1_terminal",
          terminalState: "failed",
        }),
        expect.objectContaining({ id: "source_1_late_progress" }),
      ]),
    );
    expect(liveEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run_progress_0" }),
      ]),
    );

    let sourceEvents: DiscoveryActivityEvent[] = [];
    for (let index = 0; index < 511; index += 1) {
      sourceEvents = appendDiscoveryLiveActivityEvent(
        sourceEvents,
        event({
          id: `source_${index}_progress`,
          targetId: `source_${index}`,
          message: `Source ${index} progress`,
        }),
      );
      sourceEvents = appendDiscoveryLiveActivityEvent(
        sourceEvents,
        event({
          id: `source_${index}_terminal`,
          targetId: `source_${index}`,
          kind: "success",
          terminalState: "completed",
          message: `Source ${index} completed`,
        }),
      );
    }

    expect(sourceEvents).toHaveLength(511);
    expect(
      new Set(sourceEvents.map((candidate) => candidate.targetId)).size,
    ).toBe(511);
    expect(
      sourceEvents.every(
        (candidate) => candidate.terminalState === "completed",
      ),
    ).toBe(true);
  });

  test("keeps complete persisted activity history separate from the live projection", () => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "run_full_history",
      state: "running",
      startedAt: "2026-08-19T10:00:00.000Z",
      activity: [],
    });
    const events = Array.from({ length: 511 }, (_, index) =>
      DiscoveryActivityEventSchema.parse({
        id: `history_${index}`,
        runId: run.id,
        timestamp: "2026-08-19T10:00:00.000Z",
        kind: "progress",
        stage: "target",
        targetId: `source_${index}`,
        message: `Source ${index} progress`,
        terminalState: null,
      }),
    );

    const persistedActivity = events.reduce((current, nextEvent) => {
      current.activity.push(nextEvent);
      return current;
    }, run);

    expect(persistedActivity.activity).toHaveLength(511);
    expect(persistedActivity.activity[0]?.id).toBe("history_0");
    expect(persistedActivity.activity.at(-1)?.id).toBe("history_510");
  });

  test("persists the exact request used to start a discovery run", () => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "run_retry_request",
      state: "running",
      startedAt: "2026-09-21T10:00:00.000Z",
      targetIds: ["source_one"],
      searchIntent: "Staff frontend roles in climate software",
      searchBreadth: "wide",
      searchFreshness: "recent",
    });

    expect(run).toMatchObject({
      targetIds: ["source_one"],
      searchIntent: "Staff frontend roles in climate software",
      searchBreadth: "wide",
      searchFreshness: "recent",
    });
  });

  test("keeps the discovery run budget optional and hard-capped", () => {
    const preferences = JobDiscoveryPreferencesSchema.parse({});

    expect(preferences.runJobBudget).toBeUndefined();
    expect(
      JobDiscoveryPreferencesSchema.parse({ runJobBudget: null }).runJobBudget,
    ).toBeNull();
    expect(
      JobDiscoveryPreferencesSchema.parse({
        runJobBudget: DISCOVERY_RUN_JOB_BUDGET_MAX,
      }).runJobBudget,
    ).toBe(DISCOVERY_RUN_JOB_BUDGET_MAX);

    expect(() =>
      JobDiscoveryPreferencesSchema.parse({
        runJobBudget: DISCOVERY_RUN_JOB_BUDGET_MAX + 1,
      }),
    ).toThrow();
    expect(() =>
      JobDiscoveryPreferencesSchema.parse({ runJobBudget: 0 }),
    ).toThrow();
  });

  test("classifies retained card-only evidence and leaves mixed or empty runs alone", () => {
    const cardOnlyPosting = JobPostingSchema.parse({
      ...postingInput,
      description: postingInput.title,
    });
    const enrichedPosting = JobPostingSchema.parse({
      ...postingInput,
      sourceJobId: "job_2",
      canonicalUrl: "https://example.com/jobs/job-2",
      description:
        "We are hiring a software engineer to own the ingestion pipeline, review changes from the platform team, and improve the deployment path for every service the group runs today. You will pair with the data team on schema changes, carry the on-call pager one week in four, and write the runbooks the rest of the group follows. We care more about clear reasoning and steady delivery than about any particular framework, so tell us about a system you kept running while it changed underneath you.",
      keySkills: ["TypeScript", "Postgres"],
      responsibilities: ["Own the ingestion pipeline."],
    });

    expect(cardOnlyPosting.detailQuality).toBe("card_only");
    expect(assessJobPostingDetailQuality(enrichedPosting)).toBe(
      "detail_enriched",
    );

    expect(isCardOnlyDiscoveryEvidence([cardOnlyPosting])).toBe(true);
    expect(
      isCardOnlyDiscoveryEvidence([cardOnlyPosting, cardOnlyPosting]),
    ).toBe(true);
    expect(
      isCardOnlyDiscoveryEvidence([cardOnlyPosting, enrichedPosting]),
    ).toBe(false);
    expect(isCardOnlyDiscoveryEvidence([])).toBe(false);
  });

  test("carries the card-only evidence warning through run result, execution, and summary", () => {
    const warning = buildDiscoveryCardOnlyEvidenceWarning("Primary target");

    expect(warning).toBe(
      "Only listing titles and card details were read from Primary target; no job description was captured, so match details for these results are unchecked.",
    );
    expect(buildDiscoveryCardOnlyEvidenceWarning("   ")).toBe(
      "Only listing titles and card details were read from this source; no job description was captured, so match details for these results are unchecked.",
    );
    // The warning never claims the product can open a listing for the user.
    expect(warning).not.toMatch(/open|browser|link/iu);

    expect(
      DiscoveryRunResultSchema.parse({
        source: "target_site",
        startedAt: "2026-09-03T18:09:27.794Z",
        completedAt: "2026-09-03T18:09:37.794Z",
        querySummary: "Software Engineer",
        warning,
        jobs: [],
      }).warning,
    ).toBe(warning);

    expect(
      DiscoveryTargetExecutionSchema.parse({
        targetId: "source_1",
        adapterKind: "target_site",
        state: "completed",
        warning,
      }).warning,
    ).toBe(warning);

    const summary = DiscoveryRunSummarySchema.parse({
      sourceHealth: [
        {
          targetId: "source_1",
          health: "warning",
          durationMs: 5_149,
          warnings: [warning],
        },
      ],
      warnings: [warning],
    });

    expect(summary.warnings).toEqual([warning]);
    expect(summary.sourceHealth[0]?.warnings).toEqual([warning]);
    expect(summary.sourceHealth[0]?.health).toBe("warning");
  });
});

describe("applyCompensationPreferenceChange", () => {
  const awaitingClarification = {
    minimum: null,
    maximum: null,
    interval: "year" as const,
    currency: null,
    currencyStatus: "needs_clarification" as const,
  };

  test("a change that names a currency sets it", () => {
    expect(
      applyCompensationPreferenceChange(awaitingClarification, {
        minimum: 55_000,
        currency: "USD",
      }),
    ).toMatchObject({
      minimum: 55_000,
      currency: "USD",
      currencyStatus: "explicit",
    });
  });

  test("clearing the currency puts it back to awaiting clarification", () => {
    expect(
      applyCompensationPreferenceChange(
        { ...awaitingClarification, currency: "EUR", currencyStatus: "explicit" },
        { currency: null },
      ).currencyStatus,
    ).toBe("needs_clarification");
  });

  test("a change that leaves the currency alone keeps the status", () => {
    expect(
      applyCompensationPreferenceChange(awaitingClarification, {
        minimum: 55_000,
      }),
    ).toMatchObject({ currency: null, currencyStatus: "needs_clarification" });
  });

  test("an inherited currency survives a change that keeps it", () => {
    expect(
      applyCompensationPreferenceChange(
        { ...awaitingClarification, currency: "USD", currencyStatus: "inherited" },
        { maximum: 90_000 },
      ).currencyStatus,
    ).toBe("inherited");
  });
});

describe("paused background work names a control that exists", () => {
  it("points at the Continue button on Home", () => {
    // The app has no "command center". A person who read that sentence had
    // nowhere to go.
    expect(ACTIVITY_PAUSED_MESSAGE).toContain("Press Continue");
    expect(ACTIVITY_PAUSED_MESSAGE).toContain("Home");
    expect(ACTIVITY_PAUSED_MESSAGE).not.toContain("command center");
  });
});

describe("SavedJobDiscoveryProvenanceSchema sightings", () => {
  const base = {
    targetId: "target_a",
    adapterKind: "auto",
    startingUrl: "https://jobs.example.com/",
    discoveredAt: "2026-09-23T10:00:00.000Z",
  };

  test("provenance written before sightings kept their own links still parses", () => {
    const parsed = SavedJobDiscoveryProvenanceSchema.parse(base);
    expect(parsed.listingUrl).toBeUndefined();
    expect(parsed.pageApplyUrl).toBeUndefined();
  });

  test("a sighting keeps its own listing, application and page apply links", () => {
    const parsed = SavedJobDiscoveryProvenanceSchema.parse({
      ...base,
      listingUrl: "https://jobs.example.com/jobs/9",
      applicationUrl: "https://jobs.example.com/jobs/9",
      pageApplyUrl: "https://jobs.example.com/apply/9",
      routeReadAt: "2026-09-23T10:05:00.000Z",
      sourceJobId: "9",
      applyPath: "unknown",
    });
    expect(parsed.pageApplyUrl).toBe("https://jobs.example.com/apply/9");
    expect(parsed.applyPath).toBe("unknown");
  });
});

test("discovery progress carries phase and bounded live counts", () => {
  const event = DiscoveryActivityEventSchema.parse({
    id: "live",
    runId: "run",
    timestamp: "2026-10-05T10:00:00.000Z",
    kind: "progress",
    stage: "extraction",
    message: "Reading listings",
    progress: { phase: "reading_listings", completed: 12, total: 60 },
  });
  expect(event.progress).toEqual({
    phase: "reading_listings",
    completed: 12,
    total: 60,
  });
  expect(
    DiscoveryActivityEventSchema.safeParse({
      ...event,
      progress: { ...event.progress, completed: -1 },
    }).success,
  ).toBe(false);
});
