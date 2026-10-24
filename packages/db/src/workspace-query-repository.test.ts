import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import {
  ApplicationRecordSchema,
  FitJudgmentSchema,
  QueryJobListInputSchema,
  DiscoveryLedgerEntrySchema,
  JobDiscoveryTargetSchema,
  SavedJobDiscoveryProvenanceSchema,
  ResumeDraftSchema,
  type SavedJob,
  type QueryJobListInput,
  type QueryJobListResult,
  type WorkspaceListCounts,
} from "@nestor/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  createTempRepository,
  createSavedJob,
} from "./file-repository.test-support";
import {
  createWorkspaceQueryRepository,
  prepareWorkspaceQueryDatabase,
} from "./workspace-query-repository";
import { subscribeWorkspaceCommits } from "./workspace-commits";
import { ensureWorkspaceReadIndex } from "./internal/workspace-read-index";
import { compareDiscoveryJobs } from "@nestor/job-list-policy/ordering";

const cleanups: Array<() => Promise<void> | void> = [];
function assessedJob(overrides: Partial<SavedJob> = {}) {
  const base = createSavedJob({
    status: "discovered",
    discoveryMethod: "browser_agent",
    postedAt: null,
    firstSeenAt: "2026-10-20T00:00:00.000Z",
    lastSeenAt: "2026-10-20T00:00:00.000Z",
    lastVerifiedActiveAt: null,
  });
  return createSavedJob({
    ...base,
    matchAssessment: {
      ...base.matchAssessment,
      score: 60,
      contextFingerprint: "profile",
      postingFingerprint: "posting",
      judgment: FitJudgmentSchema.parse({
        source: "batch",
        judgedAt: "2026-10-24T00:00:00.000Z",
        score: 60,
        recommendation: "review_before_applying",
      }),
    },
    ...overrides,
  });
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const temp = await createTempRepository("nestor-query-");
  cleanups.push(temp.cleanup);
  const writer = await temp.createRepository();
  cleanups.push(() => writer.close());
  const reader = createWorkspaceQueryRepository(temp.filePath);
  cleanups.push(() => reader.close());
  return { ...temp, writer, reader };
}
describe("independent workspace queries", () => {
  test("a legacy rebuild preserves the typed first fifty rows, order and counts for every sort", async () => {
    const temp = await createTempRepository("nestor-index-startup-");
    cleanups.push(temp.cleanup);
    const writer = await temp.createRepository();
    let writerClosed = false;
    cleanups.push(() => (writerClosed ? undefined : writer.close()));
    const jobs = Array.from({ length: 75 }, (_, index) =>
      assessedJob({
        id: `startup-${index}`,
        title: index % 2 ? `Engineer (${index})` : `Engineer - ${index}`,
        company: index % 2 ? "10Company" : "2Company",
        status:
          index === 10
            ? "ready_for_review"
            : index === 11
              ? "approved"
              : "discovered",
        postedAt: index % 3 ? null : "2026-10-21T00:00:00.000Z",
        postedAtText: index % 3 ? "Posted 3 months ago" : null,
        matchAssessment: {
          ...assessedJob().matchAssessment,
          score: 50 + (index % 45),
        },
      }),
    );
    jobs.push(
      assessedJob({
        id: "utility",
        title: "Search jobs",
        company: "Unknown company",
        canonicalUrl: "https://example.test/jobs",
      }),
    );
    await writer.commitSavedJobDelta({ upserts: jobs });
    const beforeReader = createWorkspaceQueryRepository(temp.filePath);
    const before = new Map<
      string,
      { query: QueryJobListInput; page: QueryJobListResult }
    >();
    let counts: WorkspaceListCounts | undefined;
    try {
      for (const list of [
        "discovery",
        "shortlisted",
        "applications",
        "all",
      ] as const)
        for (const sort of [
          "best_match",
          "newest",
          "company",
          "title",
          "recently_seen",
        ] as const) {
          const query = {
            list,
            sort,
            filters: { planId: null },
            page: { offset: 0, limit: 50 },
          };
          before.set(`${list}:${sort}`, {
            query,
            page: beforeReader.queryJobList(query),
          });
        }
      counts = beforeReader.getListCounts({ planId: null });
    } finally {
      beforeReader.close();
    }
    expect(counts).toMatchObject({ all: jobs.length, shortlisted: 2 });
    const preferences = await writer.getSearchPreferences();
    const campaigns = await writer.getCampaignState();
    await writer.close();
    writerClosed = true;
    const raw = new DatabaseSync(temp.filePath);
    cleanups.push(() => raw.close());
    const put =
      raw.prepare(`UPDATE saved_jobs SET value=?,assessment_id=NULL,description_id=NULL,
      list_visible=NULL,display_company=NULL,display_location=NULL,first_seen_at=NULL,last_seen_at=NULL,last_verified_active_at=NULL WHERE id=?`);
    for (const job of jobs) put.run(JSON.stringify(job), job.id);
    raw
      .prepare(
        "UPDATE singleton_state SET value=? WHERE key='search_preferences'",
      )
      .run(JSON.stringify(preferences));
    raw
      .prepare("UPDATE singleton_state SET value=? WHERE key='campaign_state'")
      .run(JSON.stringify(campaigns));
    for (const { name } of raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'workspace_%'",
      )
      .all())
      raw.exec(`DROP TRIGGER ${String(name)}`);
    raw.exec(`DROP TABLE workspace_job_index; DROP TABLE workspace_entity_index;
      DROP TABLE workspace_company_index; DROP TABLE workspace_company_jobs;
      DELETE FROM schema_migrations WHERE version IN (26,27,28,29); DELETE FROM workspace_read_meta`);
    let headerReady = false;
    prepareWorkspaceQueryDatabase(temp.filePath, () => {
      headerReady = true;
      expect(
        raw
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='workspace_job_index'",
          )
          .get(),
      ).toBeUndefined();
      const headerReader = createWorkspaceQueryRepository(temp.filePath);
      try {
        expect(headerReader.getStartupContext().activeCampaignId).toBe(
          campaigns?.activeCampaignId ?? null,
        );
      } finally {
        headerReader.close();
      }
    });
    expect(headerReady).toBe(true);
    const reader = createWorkspaceQueryRepository(temp.filePath);
    cleanups.push(() => reader.close());
    for (const { query, page } of before.values()) {
      const { revision: ignoredBeforeRevision, ...expected } = page;
      const { revision: ignoredAfterRevision, ...actual } =
        reader.queryJobList(query);
      expect(actual).toEqual(expected);
      expect(ignoredAfterRevision).toBeGreaterThanOrEqual(
        ignoredBeforeRevision,
      );
    }
    expect(reader.getListCounts({ planId: null })).toEqual(counts);
    raw
      .prepare(
        "UPDATE saved_jobs SET value=json_set(value,'$.title','Changed after switch') WHERE id=?",
      )
      .run(jobs[0]!.id);
    expect(
      reader.queryJobList({
        list: "all",
        filters: { planId: null },
        search: "Changed after switch",
      }).rows[0]?.id,
    ).toBe(jobs[0]!.id);
  });
  test("plan ordering preserves indexed job facts; actual membership changes update them", async () => {
    const { writer, reader, filePath } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: ["a", "b", "c"].map((id) => createSavedJob({ id })),
    });
    const db = new DatabaseSync(filePath);
    cleanups.push(() => db.close());
    db.exec(`INSERT INTO plan_job_memberships VALUES ('p', 'a', 0), ('p', 'b', 1), ('q', 'a', 0);
      CREATE TEMP TABLE query_index_writes(operation TEXT);
      CREATE TEMP TRIGGER count_query_insert AFTER INSERT ON main.workspace_job_index BEGIN INSERT INTO query_index_writes VALUES ('insert'); END;
      CREATE TEMP TRIGGER count_query_update AFTER UPDATE ON main.workspace_job_index BEGIN INSERT INTO query_index_writes VALUES ('update'); END;
      CREATE TEMP TRIGGER count_query_delete AFTER DELETE ON main.workspace_job_index BEGIN INSERT INTO query_index_writes VALUES ('delete'); END;
      DROP TRIGGER workspace_membership_identity_update;
      CREATE TRIGGER workspace_membership_update AFTER UPDATE ON plan_job_memberships BEGIN SELECT RAISE(FAIL, 'Legacy broad trigger ran'); END;`);
    // An existing database gets only the corrected trigger, without a rebuild.
    ensureWorkspaceReadIndex(db);
    expect(db.prepare("SELECT * FROM query_index_writes").all()).toEqual([]);
    const ids = (planId: string) =>
      reader
        .queryJobList({
          list: "all",
          filters: { planId },
        })
        .rows.map((job) => job.id)
        .sort();
    expect(ids("p")).toEqual(["a", "b"]);
    const canonical = await writer.listSavedJobs();
    db.exec(
      "UPDATE plan_job_memberships SET position = 1 - position WHERE plan_id = 'p'",
    );
    expect(db.prepare("SELECT * FROM query_index_writes").all()).toEqual([]);
    expect(ids("p")).toEqual(["a", "b"]);
    expect(await writer.listSavedJobs()).toEqual(canonical);
    expect(
      db
        .prepare(
          "SELECT item_id FROM plan_job_memberships WHERE plan_id = 'p' ORDER BY position",
        )
        .all()
        .map((row) => row.item_id),
    ).toEqual(["b", "a"]);
    db.exec(
      "UPDATE plan_job_memberships SET item_id = 'c' WHERE plan_id = 'p' AND item_id = 'a'",
    );
    expect(ids("p")).toEqual(["b", "c"]);
    expect(ids("q")).toEqual(["a"]);
    db.exec(
      "BEGIN; DELETE FROM plan_job_memberships WHERE plan_id = 'p'; ROLLBACK",
    );
    expect(ids("p")).toEqual(["b", "c"]);
    db.exec(
      "DELETE FROM plan_job_memberships WHERE plan_id = 'p' AND item_id = 'b'",
    );
    expect(ids("p")).toEqual(["c"]);
  });

  test("triage reuses activity and an uncommitted sighting cannot escape its transaction", async () => {
    const { writer, reader, filePath } = await fixture();
    const job = assessedJob({ id: "triage-activity" });
    await writer.commitSavedJobDelta({ upserts: [job] });
    const before = reader.queryJobList({
      list: "all",
      filters: { planId: null },
    }).rows[0]?.listingActivity;
    const raw = new DatabaseSync(filePath);
    try {
      const epoch = () =>
        raw
          .prepare(
            "SELECT value FROM workspace_read_meta WHERE key='activity_revision'",
          )
          .get()!.value;
      const revision = epoch();
      await writer.commitSavedJobDelta({
        updateJobIds: [job.id],
        update: (current) => ({ ...current, status: "ready_for_review" }),
      });
      expect(epoch()).toBe(revision);
      expect(reader.getListCounts({ planId: null })).toMatchObject({
        discovery: 0,
        shortlisted: 1,
      });
      raw.exec("BEGIN IMMEDIATE");
      raw
        .prepare("UPDATE saved_jobs SET last_seen_at=? WHERE id=?")
        .run("2026-10-25T00:00:00.000Z", job.id);
      expect(epoch()).not.toBe(revision);
      expect(
        reader.queryJobList({ list: "all", filters: { planId: null } }).rows[0]
          ?.listingActivity,
      ).toEqual(before);
      raw.exec("ROLLBACK");
      expect(epoch()).toBe(revision);
      expect(
        reader.queryJobList({ list: "all", filters: { planId: null } }).rows[0]
          ?.listingActivity,
      ).toEqual(before);
    } finally {
      if (raw.isTransaction) raw.exec("ROLLBACK");
      raw.close();
    }
  });
  test("Home counts current approvals separately from stale approval overlays", async () => {
    const { writer, reader, filePath } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [
        assessedJob({ id: "approved-a" }),
        assessedJob({ id: "approved-b" }),
      ],
    });
    for (const id of ["approved-a", "approved-b"])
      await writer.upsertResumeDraft(
        ResumeDraftSchema.parse({
          id,
          jobId: id,
          status: "approved",
          templateId: "classic_ats",
          createdAt: "2026-10-20T00:00:00.000Z",
          updatedAt: "2026-10-20T00:00:00.000Z",
          approvedAt: "2026-10-20T00:00:00.000Z",
          sections: [],
        }),
      );
    const raw = new DatabaseSync(filePath);
    try {
      raw
        .prepare("INSERT INTO resume_draft_approval_state VALUES (?,?,?)")
        .run("approved-a", "Profile changed.", "2026-10-24T00:00:00.000Z");
    } finally {
      raw.close();
    }
    expect(reader.getHomeSummary({ planId: null }).resumesApproved).toBe(1);
  });
  test("orders complete ties with the existing locale comparison and keeps unknown posting dates last", async () => {
    const { writer, reader } = await fixture();
    const first = assessedJob({
      id: "hyphen",
      title: "Senior Backend Engineer - Content Protection",
    });
    const second = assessedJob({
      id: "paren",
      title: "Senior Backend Engineer (Data serving)",
    });
    await writer.commitSavedJobDelta({ upserts: [first, second] });
    expect(
      reader
        .queryJobList({ list: "discovery", filters: { planId: null } })
        .rows.map((row) => row.id),
    ).toEqual([first, second].sort(compareDiscoveryJobs).map((row) => row.id));
    const jobs = [
      assessedJob({
        id: "posted",
        company: "1Password",
        postedAt: "2026-10-13T00:00:00.000Z",
      }),
      assessedJob({
        id: "absolute",
        company: "10Beauty",
        postedAtText: "November 1, 2026",
      }),
      assessedJob({
        id: "provider",
        company: "Alpaca",
        providerUpdatedAt: "2026-10-12T00:00:00.000Z",
      }),
      assessedJob({
        id: "relative",
        company: "Alpaca",
        postedAtText: "Posted 3 months ago",
        providerUpdatedAt: "2026-12-01T00:00:00.000Z",
        firstSeenAt: "2026-12-01T00:00:00.000Z",
      }),
    ];
    await writer.commitSavedJobDelta({ upserts: jobs });
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null },
          sort: "newest",
        })
        .rows.slice(0, 3)
        .map((row) => row.id),
    ).toEqual(["absolute", "posted", "provider"]);
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null },
          sort: "company",
        })
        .rows.slice(0, 2)
        .map((row) => row.company),
    ).toEqual(["1Password", "10Beauty"]);
  });
  test("exposes actual row facts, search labels, source filters and pool facet counts", async () => {
    const { writer, reader } = await fixture();
    const preferences = await writer.getSearchPreferences();
    const target = JobDiscoveryTargetSchema.parse({
      id: "query-source",
      label: "Configured board",
      startingUrl: "https://example.test/jobs",
    });
    await writer.saveSearchPreferences({
      ...preferences,
      discovery: { ...preferences.discovery, targets: [target] },
    });
    const job = assessedJob({
      id: "labeled",
      firstSeenAt: "2026-10-24T00:00:00.000Z",
      providerUpdatedAt: "2026-10-23T00:00:00.000Z",
      provenance: [
        SavedJobDiscoveryProvenanceSchema.parse({
          targetId: target.id,
          adapterKind: "auto",
          startingUrl: target.startingUrl,
          discoveredAt: "2026-10-20T00:00:00.000Z",
          sourceLabel: "Historical label",
        }),
      ],
    });
    job.matchAssessment = {
      ...job.matchAssessment,
      recommendation: "apply_with_original",
      titleFamilyMatch: "same_family",
    };
    await writer.commitSavedJobDelta({
      upserts: [job, assessedJob({ id: "unspecified", workMode: [] })],
    });
    const result = reader.queryJobList({
      list: "discovery",
      filters: {
        planId: null,
        sourceLabels: ["Configured board"],
        recommendations: ["apply_with_original"],
        activities: ["active"],
        newSince: "2026-10-23T00:00:00.000Z",
        newOnly: true,
      },
      search: "Original resume is credible",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: "labeled",
      providerUpdatedAt: job.providerUpdatedAt,
      sourceLabels: ["Configured board"],
      applyPath: "easy_apply",
      listingActivity: { status: "active", observedAt: job.lastSeenAt },
      tieBreakReason: "Job title matches one of your target roles.",
    });
    expect(result.facets.sources).toEqual([
      { value: "Configured board", count: 1 },
      { value: "Source unavailable", count: 1 },
    ]);
    expect(result.facets.workModes).toEqual([
      { value: "remote", count: 1 },
      { value: "Not specified", count: 1 },
    ]);
    expect(result.facets.newSince).toBe(1);
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null, workModeUnspecified: true },
        })
        .rows.map((row) => row.id),
    ).toEqual(["unspecified"]);
    await writer.saveSearchPreferences({
      ...preferences,
      discovery: {
        ...preferences.discovery,
        targets: [{ ...target, label: "Renamed board" }],
      },
    });
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null, sourceLabels: ["Renamed board"] },
        })
        .rows.map((row) => row.id),
    ).toEqual(["labeled"]);
  });
  test("uses the existing identity ambiguity and newer activity rules for ledger and signal facts", async () => {
    const { writer, reader } = await fixture();
    const job = assessedJob({
      id: "activity",
      canonicalUrl: "https://example.test/jobs/activity",
      applicationUrl: null,
    });
    await writer.commitSavedJobDelta({ upserts: [job] });
    await writer.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: [
        DiscoveryLedgerEntrySchema.parse({
          id: "inactive",
          canonicalUrl: job.canonicalUrl,
          source: job.source,
          sourceJobId: job.sourceJobId,
          title: job.title,
          company: job.company,
          location: job.location,
          targetId: "synthetic",
          firstSeenAt: job.firstSeenAt,
          lastSeenAt: job.lastSeenAt,
          inactiveAt: "2026-10-22T00:00:00.000Z",
          latestStatus: "inactive",
        }),
      ],
    }));
    const read = () =>
      reader.queryJobList({ list: "discovery", filters: { planId: null } });
    expect(read().rows[0]).toMatchObject({
      id: "activity",
      listingClosed: true,
      listingActivity: { status: "inactive", ledgerEntryId: "inactive" },
    });
    await writer.commitSavedJobDelta({
      upserts: [{ ...job, id: "ambiguous" }],
    });
    expect(
      read().rows.every((row) => row.listingActivity.status === "active"),
    ).toBe(true);
    expect(read().rows.every((row) => row.indistinguishable)).toBe(true);
    const intelligence = await writer.getIntelligenceState();
    await writer.saveIntelligenceState({
      ...intelligence,
      safeguards: {
        ...intelligence.safeguards,
        listingSignals: [
          {
            id: "closed-signal",
            jobId: job.id,
            signal: "closed",
            detail: null,
            detectedAt: "2026-10-23T00:00:00.000Z",
            confidence: 1,
            provenance: "provider",
            explanation: "The source reported this listing closed.",
            recoveryGuidance: "Choose another listing.",
          },
        ],
      },
    });
    const closed = reader.queryJobList({
      list: "discovery",
      filters: { planId: null, activities: ["closed"] },
    });
    expect(closed.rows.map((row) => row.id)).toEqual(["activity"]);
    expect(closed.rows[0]?.listingActivity).toMatchObject({
      status: "closed",
      signalId: "closed-signal",
    });
    expect(closed.facets.activities).toEqual([
      { value: "active", count: 1 },
      { value: "closed", count: 1 },
    ]);
    await writer.commitSavedJobDelta({
      upserts: [
        assessedJob({
          id: "unknown",
          sourceJobId: "unknown",
          canonicalUrl: "https://example.test/jobs/unknown",
          lastSeenAt: null,
          lastVerifiedActiveAt: null,
        }),
      ],
    });
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null, activities: ["unknown"] },
        })
        .rows.map((row) => row.id),
    ).toEqual(["unknown"]);
  });
  test("pending intake reads real missing-employer body facts and retains curated rows", async () => {
    const { writer, reader } = await fixture();
    const empty = assessedJob({
      id: "empty-pending",
      title: "Opportunities",
      company: "Unknown",
      description: "Opportunities",
      canonicalUrl: "https://example.test/catalog",
    });
    const real = assessedJob({
      ...empty,
      id: "real-pending",
      description:
        "An actual role with responsibilities and a complete application path.",
    });
    const curated = assessedJob({
      ...empty,
      id: "curated-pending",
      status: "shortlisted",
    });
    await writer.commitDiscoveryStateUpdate((current) => ({
      ...current,
      pendingDiscoveryJobs: [empty, real, curated],
    }));
    expect(
      reader
        .queryJobList({ list: "discovery", filters: { planId: null } })
        .rows.map((row) => row.id)
        .sort(),
    ).toEqual(["curated-pending", "real-pending"]);
    expect(reader.getListCounts({ planId: null }).discovery).toBe(2);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).total,
    ).toBe(3);
  });
  test("Find jobs bands keep unjudged work visible and exclude decided and weaker jobs by default", async () => {
    const { writer, reader } = await fixture();
    const base = createSavedJob({
      status: "discovered",
      discoveryMethod: "browser_agent",
    });
    const judged = {
      ...base.matchAssessment,
      contextFingerprint: "profile",
      postingFingerprint: "listing",
      judgment: FitJudgmentSchema.parse({
        source: "batch",
        judgedAt: "2026-10-24T00:00:00.000Z",
        score: 60,
        recommendation: "review_before_applying",
      }),
    };
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          ...base,
          id: "strong",
          matchAssessment: { ...judged, score: 60 },
        }),
        createSavedJob({
          ...base,
          id: "unchecked",
          matchAssessment: { ...judged, score: 10, judgment: null },
        }),
        createSavedJob({
          ...base,
          id: "weaker",
          matchAssessment: { ...judged, score: 45 },
        }),
        createSavedJob({
          ...base,
          id: "mismatch",
          matchAssessment: { ...judged, score: 20 },
        }),
        createSavedJob({
          ...base,
          id: "decided",
          status: "ready_for_review",
          matchAssessment: judged,
        }),
        createSavedJob({
          ...base,
          id: "returned",
          status: "shortlisted",
          matchAssessment: judged,
        }),
      ],
    });
    const result = reader.queryJobList({
      list: "discovery",
      filters: { planId: null },
    });
    expect(result.rows.map((row) => row.id).sort()).toEqual([
      "returned",
      "strong",
      "unchecked",
    ]);
    expect(result.counts.discovery).toBe(3);
    expect(
      result.rows.find((row) => row.id === "unchecked")?.scoreWithheld,
    ).toBe(true);
    expect(result.rows.find((row) => row.id === "strong")?.scoreWithheld).toBe(
      false,
    );
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null, discoveryBands: ["weaker", "mismatches"] },
        })
        .rows.map((row) => row.id)
        .sort(),
    ).toEqual(["mismatch", "weaker"]);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).total,
    ).toBe(6);
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          ...base,
          id: "unbound-skip",
          matchAssessment: {
            ...judged,
            contextFingerprint: null,
            recommendation: "skip",
            judgment: { ...judged.judgment, recommendation: "skip" },
          },
        }),
      ],
    });
    expect(
      reader
        .queryJobList({
          list: "all",
          filters: { planId: null },
          search: "Lead Designer",
        })
        .rows.find((row) => row.id === "unbound-skip"),
    ).toMatchObject({
      judged: true,
      scoreWithheld: true,
      resultGroup: "mismatches",
    });
  });
  test("startup reads preserve legacy bodies and do not wait for evidence conversion", async () => {
    const temp = await createTempRepository("nestor-early-query-");
    cleanups.push(temp.cleanup);
    const writer = await temp.createRepository();
    const preferences = await writer.getSearchPreferences();
    const campaigns = await writer.getCampaignState();
    const job = createSavedJob({
      id: "early",
      status: "discovered",
      description: "Synthetic listing evidence.",
      firstSeenAt: "2026-10-20T10:00:00.000Z",
    });
    await writer.commitSavedJobDelta({ upserts: [job] });
    await writer.close();
    const raw = new DatabaseSync(temp.filePath);
    cleanups.push(() => raw.close());
    raw
      .prepare(
        "UPDATE saved_jobs SET value = ?, assessment_id = NULL, description_id = NULL, list_visible = NULL, first_seen_at = NULL, last_seen_at = NULL WHERE id = ?",
      )
      .run(JSON.stringify(job), job.id);
    raw
      .prepare(
        "UPDATE singleton_state SET value = ? WHERE key = 'search_preferences'",
      )
      .run(JSON.stringify(preferences));
    raw
      .prepare(
        "UPDATE singleton_state SET value = ? WHERE key = 'campaign_state'",
      )
      .run(JSON.stringify(campaigns));
    raw.exec(
      "DELETE FROM schema_migrations WHERE version IN (26,27,28,29); DELETE FROM workspace_read_meta",
    );
    const before = raw
      .prepare("SELECT value FROM saved_jobs WHERE id = ?")
      .get(job.id)!.value;
    prepareWorkspaceQueryDatabase(temp.filePath);
    const reader = createWorkspaceQueryRepository(temp.filePath);
    cleanups.push(() => reader.close());
    expect(reader.getStartupContext().sourceCount).toBe(
      preferences.discovery.targets.length,
    );
    const page = reader.queryJobList({
      list: "all",
      filters: { planId: null },
    });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      id: job.id,
      firstSeenAt: job.firstSeenAt,
    });
    expect(reader.getHomeSummary({ planId: null }).counts.all).toBe(1);
    expect(
      raw.prepare("SELECT value FROM saved_jobs WHERE id = ?").get(job.id)!
        .value,
    ).toBe(before);
    expect(
      raw
        .prepare(
          "SELECT version FROM schema_migrations WHERE version IN (26,27,28,29)",
        )
        .all(),
    ).toEqual([]);
  });
  test("a bulk index rebuild bumps order/activity once and retains subsequent row updates", async () => {
    const { writer, reader, filePath } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: Array.from({ length: 12 }, (_, index) =>
        assessedJob({ id: `bulk-${index}` }),
      ),
    });
    const raw = new DatabaseSync(filePath);
    cleanups.push(() => raw.close());
    const epochs = () =>
      raw
        .prepare(
          "SELECT key, CAST(value AS INTEGER) AS value FROM workspace_read_meta WHERE key IN ('activity_revision','sort_revision') ORDER BY key",
        )
        .all();
    const beforeRows = reader.queryJobList({
      list: "all",
      filters: { planId: null },
    }).rows;
    const before = epochs();
    raw.exec("DELETE FROM workspace_read_meta WHERE key = 'version'");
    ensureWorkspaceReadIndex(raw);
    expect(epochs()).toEqual(
      before.map((row) => ({ ...row, value: Number(row.value) + 1 })),
    );
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).rows,
    ).toEqual(beforeRows);
    await writer.commitSavedJobDelta({
      updateJobIds: ["bulk-0"],
      update: (current) => ({ ...current, title: "Updated after rebuild" }),
    });
    expect(reader.getJobDetail("bulk-0")?.job.title).toBe(
      "Updated after rebuild",
    );
    expect(epochs()).not.toEqual(before);
  });
  test("closing the query connection before the writer permits a clean-close marker", async () => {
    const temp = await createTempRepository("nestor-query-close-");
    const writer = await temp.createRepository();
    const reader = createWorkspaceQueryRepository(temp.filePath);
    try {
      reader.getStartupContext();
      reader.close();
      await writer.close();
      expect(existsSync(`${temp.filePath}.clean-close`)).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });
  test("pending rows retain their location before promotion", async () => {
    const { writer, reader } = await fixture();
    await writer.commitDiscoveryStateUpdate((current) => ({
      ...current,
      pendingDiscoveryJobs: [
        createSavedJob({
          id: "pending-location",
          status: "discovered",
          location: "Remote, Europe",
        }),
      ],
    }));
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).rows[0]
        ?.location,
    ).toBe("Remote, Europe");
  });
  test("commit callbacks see committed rows without a polling timer and never see rollbacks", async () => {
    const { filePath, writer, reader } = await fixture();
    const seen: string[] = [];
    const stop = subscribeWorkspaceCommits(filePath, () => {
      seen.push(reader.getJobDetail("pushed")?.job.title ?? "missing");
    });
    cleanups.push(stop);
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "pushed", title: "Committed" })],
    });
    expect(seen).toEqual(["Committed"]);
    await expect(
      writer.commitSavedJobDelta({
        updateJobIds: ["pushed"],
        update() {
          throw new Error("abort");
        },
      }),
    ).rejects.toThrow("abort");
    expect(seen).toEqual(["Committed"]);
    stop();
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "pushed", title: "Later" })],
    });
    expect(seen).toEqual(["Committed"]);
  });
  test("intake-only utility filtering keeps curated work and hidden jobs recoverable", async () => {
    const { writer, reader } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          id: "chrome",
          title: "Privacy policy",
          status: "discovered",
        }),
        createSavedJob({
          id: "curated",
          title: "Privacy policy",
          status: "shortlisted",
        }),
        createSavedJob({ id: "role", status: "discovered" }),
        createSavedJob({
          id: "hidden",
          status: "archived",
          discoveryFeedback: {
            version: 1,
            revision: 1,
            reasons: [],
            priorStatus: "discovered",
            recordedAt: "2026-10-24T00:00:00.000Z",
          },
        }),
      ],
    });
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null },
          sort: "title",
        })
        .rows.map((row) => row.id)
        .sort(),
    ).toEqual(["curated", "role"]);
    expect(
      reader
        .queryJobList({ list: "dismissed", filters: { planId: null } })
        .rows.map((row) => row.id),
    ).toEqual(["hidden"]);
    await writer.commitSavedJobDelta({
      updateJobIds: ["hidden"],
      update: (job) => ({
        ...job,
        status: "discovered",
        discoveryFeedback: null,
      }),
    });
    expect(reader.getListCounts({ planId: null }).dismissed).toBe(0);
    expect(reader.getListCounts({ planId: null }).discovery).toBe(3);
  });
  test("returned unsent applications leave Applications while their review-queue job and history stay available", async () => {
    const { writer, reader } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "returned", status: "ready_for_review" })],
    });
    const record = ApplicationRecordSchema.parse({
      id: "application",
      jobId: "returned",
      title: "Synthetic role",
      company: "Synthetic company",
      lastActionLabel: "Prepared",
      nextActionLabel: null,
      status: "ready_for_review",
      lastUpdatedAt: "2026-10-24T00:00:00.000Z",
    });
    await writer.upsertApplicationRecord(record);
    expect(reader.getListCounts({ planId: null })).toMatchObject({
      applications: 1,
      shortlisted: 1,
    });
    await writer.upsertApplicationRecord({
      ...record,
      returnedToShortlistAt: "2026-10-24T00:00:00Z",
    });
    expect(reader.getListCounts({ planId: null })).toMatchObject({
      applications: 0,
      shortlisted: 1,
    });
    await writer.upsertApplicationRecord({
      ...record,
      returnedToShortlistAt: record.lastUpdatedAt,
      lastUpdatedAt: "2026-10-24T00:01:00.000Z",
    });
    expect(reader.getListCounts({ planId: null })).toMatchObject({
      applications: 1,
      shortlisted: 1,
    });
  });
  test("query input rejects unbounded pages and unknown filters", () => {
    expect(
      QueryJobListInputSchema.safeParse({ list: "all", page: { limit: 201 } })
        .success,
    ).toBe(false);
    expect(
      QueryJobListInputSchema.safeParse({
        list: "all",
        filters: { sql: "DROP TABLE" },
      }).success,
    ).toBe(false);
  });
  test("pages and filters saved and pending jobs without carrying bodies", async () => {
    const { writer, reader } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({ id: "a", title: "Alpha", status: "discovered" }),
        createSavedJob({ id: "b", title: "Beta", status: "discovered" }),
        createSavedJob({ id: "c", title: "Gamma", status: "shortlisted" }),
      ],
    });
    const result = reader.queryJobList({
      list: "discovery",
      filters: { planId: null, workModes: ["remote"] },
      sort: "title",
      page: { offset: 1, limit: 1 },
    });
    expect(result.rows.map((row) => row.id)).toEqual(["b"]);
    expect(result.total).toBe(3);
    expect(result.counts.shortlisted).toBe(0);
    expect(result.rows[0]).not.toHaveProperty("description");
    expect(reader.getJobDetail("b")?.job.description).toContain(
      "Lead product design",
    );
    expect(
      reader
        .queryJobList({
          list: "all",
          filters: { planId: null },
          search: "Gamma",
        })
        .rows.map((row) => row.id),
    ).toEqual(["c"]);
    expect(reader.getJobDetail("missing")).toBeNull();
  });
  test("feed and metadata commit together, retain deletes, and exclude rollbacks", async () => {
    const { filePath, writer, reader } = await fixture();
    const before = reader.getChanges(Number.MAX_SAFE_INTEGER).revision;
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "changed" })],
    });
    const changes = reader.getChanges(before);
    expect(changes.changes).toContainEqual(
      expect.objectContaining({
        table: "saved_jobs",
        id: "changed",
        operation: "upsert",
      }),
    );
    const other = new DatabaseSync(filePath);
    cleanups.push(() => other.close());
    other.exec(
      "BEGIN IMMEDIATE; DELETE FROM saved_jobs WHERE id = 'changed'; ROLLBACK",
    );
    expect(reader.getChanges(changes.revision).changes).toEqual([]);
    expect(reader.getJobDetail("changed")).not.toBeNull();
    other.exec("DELETE FROM saved_jobs WHERE id = 'changed'");
    expect(reader.getChanges(changes.revision).changes).toContainEqual(
      expect.objectContaining({ id: "changed", operation: "delete" }),
    );
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).total,
    ).toBe(0);
  });
  test("per-plan scores, stable paging, and older-connection writes remain current", async () => {
    const { filePath, writer, reader } = await fixture();
    const base = createSavedJob();
    const assessment = {
      ...base.matchAssessment,
      score: 90,
      contextFingerprint: "profile",
      postingFingerprint: "posting",
    };
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          id: "plan-a",
          campaignIds: ["p"],
          planAssessments: { p: assessment },
        }),
        createSavedJob({ id: "unscoped" }),
      ],
    });
    const membership = new DatabaseSync(filePath);
    membership
      .prepare(
        "INSERT INTO plan_job_memberships(plan_id, item_id, position) VALUES ('p', 'plan-a', 0)",
      )
      .run();
    membership.close();
    const result = reader.queryJobList({
      list: "all",
      filters: { planId: "p" },
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.score).toBe(90);
    const other = new DatabaseSync(filePath);
    cleanups.push(() => other.close());
    other
      .prepare(
        "UPDATE saved_jobs SET value = json_set(value, '$.title', ?) WHERE id = ?",
      )
      .run("Changed title", "plan-a");
    expect(
      reader.queryJobList({ list: "all", filters: { planId: "p" } }).rows[0]
        ?.title,
    ).toBe("Changed title");
    prepareWorkspaceQueryDatabase(filePath);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: "p" } }).total,
    ).toBe(1);
  });
  test("read connection cannot mutate canonical data", async () => {
    const { filePath } = await fixture();
    const readOnly = new DatabaseSync(filePath, { readOnly: true });
    cleanups.push(() => readOnly.close());
    expect(() => readOnly.exec("DELETE FROM saved_jobs")).toThrow();
  });
});
