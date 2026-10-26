import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import * as contracts from "@nestor/contracts";
import {
  ResumeDraftSchema,
  ResumeDraftRevisionSchema,
  type ResumeDraft,
  getDefaultCampaignConfiguration,
  JobSearchCampaignSchema,
  writeDiscoveryPreparation,
  type DiscoverySavedJobFingerprints,
} from "@nestor/contracts";
import {
  createTempRepository,
  createSavedJob,
  savedJobData,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";
import {
  readResumeRevision,
  serializeResumeRevision,
  rebaseRetainedResumeRevisions,
} from "./internal/resume-revision-storage";
import {
  migrateResumeStorage,
  migrateResumeStorageSteps,
} from "./internal/resume-storage-migration";
import { migratePreferenceStorage } from "./internal/preference-storage";
import {
  migrateSavedJobStorage,
  migrateSavedJobStorageSteps,
} from "./internal/saved-job-storage-migration";
import { savedJobValueSql } from "./internal/saved-job-storage";
import {
  createWorkspaceQueryRepository,
  prepareWorkspaceQueryDatabase,
} from "./workspace-query-repository";
import { completeWorkspaceDatabaseMigrations } from "./workspace-database-startup";
import { createFileJobFinderRepository } from "./file-repository";
import { readSavedJobFingerprintBatch } from "./internal/saved-job-fingerprints";
import {
  restoreResumeDraftStorage,
  compactResumeDraftStorage,
} from "./internal/resume-draft-storage";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
const source = "Original source evidence and listing text. "
  .repeat(300)
  .trimEnd();
function draft(): ResumeDraft {
  return ResumeDraftSchema.parse({
    id: "resume_1",
    jobId: "job_1",
    templateId: "classic_ats",
    status: "needs_review",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    sections: [
      {
        id: "skills",
        kind: "skills",
        label: "Skills",
        included: true,
        origin: "imported",
        sortOrder: 0,
        updatedAt: "2026-10-24T00:00:00.000Z",
        sourceRefs: [],
        entries: [],
        text: null,
        bullets: Array.from({ length: 30 }, (_, i) => ({
          id: `bullet_${i}`,
          text: `Skill ${i}`,
          included: true,
          origin: "imported",
          updatedAt: "2026-10-24T00:00:00.000Z",
          sourceRefs: [
            {
              id: `ref_${i}`,
              sourceKind: "job",
              sourceId: "job_1",
              snippet: source,
            },
          ],
        })),
      },
    ],
  });
}
test("source records preserve exact evidence once without changing the canonical draft", () => {
  const db = new DatabaseSync(":memory:");
  cleanups.push(() => db.close());
  const before = draft();
  const stored = compactResumeDraftStorage(db, before);
  const after = restoreResumeDraftStorage(db, structuredClone(stored));
  expect(after).toEqual(before);
  expect(
    Number(
      db.prepare("SELECT count(*) AS n FROM resume_source_texts").get()!.n,
    ),
  ).toBe(1);
  expect(JSON.stringify(stored).length).toBeLessThan(20000);
});

test("interrupted job conversion keeps queries exact and resumes without overwriting a newer write", async () => {
  const temp = await createTempRepository("nestor-sliced-job-migration-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  await repo.replaceSavedJobs([]);
  await repo.close();
  let db = new DatabaseSync(temp.filePath);
  cleanups.push(() => db.close());
  const jobs = Array.from({ length: 600 }, (_, index) =>
    createSavedJob({
      id: `job-${String(index).padStart(3, "0")}`,
      description: `Synthetic listing evidence ${index}`,
      campaignIds: ["plan"],
    }),
  );
  const insert = db.prepare("INSERT INTO saved_jobs(id,value) VALUES (?,?)");
  for (const job of jobs) insert.run(job.id, JSON.stringify(job));
  db.exec(
    "DELETE FROM schema_migrations WHERE version = 28; DELETE FROM workspace_read_meta WHERE key = 'version'",
  );
  prepareWorkspaceQueryDatabase(temp.filePath);
  const reader = createWorkspaceQueryRepository(temp.filePath);
  cleanups.push(() => reader.close());
  const index = () =>
    db
      .prepare("SELECT * FROM workspace_job_index ORDER BY origin,id,plan_id")
      .all();
  const before = index();
  const steps = migrateSavedJobStorageSteps(db);
  expect(steps.next().done).toBe(false);
  expect(db.isTransaction).toBe(false);
  const converted = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM saved_jobs WHERE assessment_id IS NOT NULL",
      )
      .get()?.n,
  );
  expect(converted).toBeGreaterThan(0);
  expect(converted).toBeLessThan(jobs.length);
  expect(index()).toEqual(before);
  expect(reader.getJobDetail(jobs[0]!.id)?.job).toEqual(jobs[0]);
  expect(reader.getJobDetail(jobs.at(-1)!.id)?.job).toEqual(jobs.at(-1));
  steps.return(undefined);
  db.close();
  db = new DatabaseSync(temp.filePath);
  const edited = {
    ...jobs.at(-1)!,
    title: "A newer title",
    description: "Salary: USD 91,000 per year.",
  };
  const liveWriter = await createFileJobFinderRepository({
    filePath: temp.filePath,
    seed: createSeed(),
    deferEvidenceConversion: true,
  });
  try {
    expect(
      db.prepare("SELECT 1 FROM schema_migrations WHERE version=28").get(),
    ).toBeUndefined();
    expect(
      savedJobData(
        (await liveWriter.listSavedJobsByIds([jobs.at(-1)!.id]))[0]!,
      ),
    ).toEqual(jobs.at(-1));
    await liveWriter.commitSavedJobDelta({
      updateJobIds: [edited.id],
      update: () => edited,
    });
    expect(
      db.prepare("SELECT 1 FROM schema_migrations WHERE version=28").get(),
    ).toBeUndefined();
  } finally {
    await liveWriter.close();
  }
  migrateSavedJobStorage(db);
  expect(
    JSON.parse(
      String(
        db
          .prepare(
            `SELECT ${savedJobValueSql()} AS value FROM saved_jobs WHERE id = ?`,
          )
          .get(edited.id)?.value,
      ),
    ),
  ).toEqual(edited);
  expect(
    reader
      .queryJobList({
        list: "all",
        filters: { planId: null },
        search: "A newer title",
      })
      .rows.map((row) => row.id),
  ).toEqual([edited.id]);
  expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
    "ok",
  );
});

test("background conversion retires obsolete validation triggers before writing jobs", async () => {
  const temp = await createTempRepository("nestor-migration-order-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  const job = createSavedJob({ id: "migration-order" });
  await repo.commitSavedJobDelta({ upserts: [job] });
  await repo.close();
  const db = new DatabaseSync(temp.filePath);
  cleanups.push(() => db.close());
  db.prepare(
    "UPDATE saved_jobs SET value=?,assessment_id=NULL,description_id=NULL WHERE id=?",
  ).run(JSON.stringify(job), job.id);
  db.exec(`DELETE FROM schema_migrations WHERE version IN (26,28);
    CREATE TRIGGER row_validations_guard AFTER UPDATE ON saved_jobs BEGIN
      SELECT RAISE(ABORT,'Retired validation trigger ran'); END;`);
  let writerReady = false;
  await completeWorkspaceDatabaseMigrations(temp.filePath, () => {
    writerReady = true;
    expect(
      db.prepare("SELECT 1 FROM schema_migrations WHERE version=28").get(),
    ).toBeUndefined();
    // An action can write the original row before its evidence is converted.
    db.prepare("UPDATE saved_jobs SET value=value WHERE id=?").run(job.id);
  });
  expect(writerReady).toBe(true);
  expect(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='row_validations_guard'")
      .get(),
  ).toBeUndefined();
  expect(
    JSON.parse(
      String(
        db
          .prepare(
            `SELECT ${savedJobValueSql()} AS value FROM saved_jobs WHERE id=?`,
          )
          .get(job.id)?.value,
      ),
    ),
  ).toEqual(job);
});

test("sliced resume conversion preserves pending approval state and exact citations across restart", async () => {
  const temp = await createTempRepository("nestor-sliced-resume-migration-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  await repo.close();
  let db = new DatabaseSync(temp.filePath);
  cleanups.push(() => db.close());
  const drafts = Array.from({ length: 5 }, (_, index) => ({
    ...draft(),
    id: `draft-${index}`,
  }));
  const put = db.prepare(
    "INSERT INTO resume_drafts(id,job_id,created_at,updated_at,value) VALUES (?,?,?,?,?)",
  );
  for (const row of drafts)
    put.run(
      row.id,
      row.jobId,
      row.createdAt,
      row.updatedAt,
      JSON.stringify(row),
    );
  db.prepare("INSERT INTO resume_draft_approval_state VALUES (?,?,?)").run(
    drafts[0]!.id,
    "Profile changed",
    drafts[0]!.updatedAt,
  );
  db.exec("DELETE FROM schema_migrations WHERE version = 26");
  const steps = migrateResumeStorageSteps(db);
  expect(steps.next().done).toBe(false);
  expect(db.isTransaction).toBe(false);
  steps.return(undefined);
  db.close();
  db = new DatabaseSync(temp.filePath);
  migrateResumeStorage(db);
  expect(
    db
      .prepare(
        "SELECT stale_reason FROM resume_draft_approval_state WHERE draft_id = ?",
      )
      .get(drafts[0]!.id)?.stale_reason,
  ).toBe("Profile changed");
  for (const row of drafts)
    expect(
      restoreResumeDraftStorage(
        db,
        JSON.parse(
          String(
            db
              .prepare("SELECT value FROM resume_drafts WHERE id = ?")
              .get(row.id)?.value,
          ),
        ),
      ),
    ).toEqual(row);
});
test("revision deltas reconstruct exact snapshots after retention and base replacement", () => {
  const db = new DatabaseSync(":memory:");
  cleanups.push(() => db.close());
  db.exec(
    "CREATE TABLE resume_draft_revisions(id TEXT PRIMARY KEY, draft_id TEXT, created_at TEXT, value TEXT)",
  );
  const expected = [];
  for (let i = 0; i < 4; i++) {
    const snapshotDraft = draft();
    snapshotDraft.sections[0]!.bullets[0]!.text = `Edited ${i}`;
    const revision = ResumeDraftRevisionSchema.parse({
      id: `r${i}`,
      draftId: snapshotDraft.id,
      snapshotDraft,
      snapshotSections: snapshotDraft.sections,
      snapshotIdentity: snapshotDraft.identity,
      createdAt: `2026-10-24T00:00:0${i}.000Z`,
    });
    const value = serializeResumeRevision(db, revision);
    db.prepare("INSERT INTO resume_draft_revisions VALUES (?, ?, ?, ?)").run(
      revision.id,
      revision.draftId,
      revision.createdAt,
      value,
    );
    expected.push(revision);
    expect(readResumeRevision(db, revision.id)).toEqual(revision);
    if (i > 0) expect(value.length).toBeLessThan(1000);
  }
  rebaseRetainedResumeRevisions(db, "resume_1", 2);
  db.exec("DELETE FROM resume_draft_revisions WHERE id IN ('r0','r1')");
  expect(readResumeRevision(db, "r2")).toEqual(expected[2]);
  expect(readResumeRevision(db, "r3")).toEqual(expected[3]);
  const changed = { ...expected[2]!, reason: "Updated metadata" };
  const value = serializeResumeRevision(db, changed);
  db.prepare("UPDATE resume_draft_revisions SET value = ? WHERE id = 'r2'").run(
    value,
  );
  expect(readResumeRevision(db, "r3")).toEqual(expected[3]);
});
test("forward migrations retain resume text, source evidence, independent plans and source settings", async () => {
  const temp = await createTempRepository("nestor-normalize-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  let repoClosed = false;
  cleanups.push(() => (repoClosed ? Promise.resolve() : repo.close()));
  const seed = createSeed();
  const prefs = contracts.JobSearchPreferencesSchema.parse(
    seed.searchPreferences,
  );
  await repo.saveSearchPreferences(prefs);
  const campaign = JobSearchCampaignSchema.parse({
    id: "plan_1",
    name: "First plan",
    mode: "precision",
    status: "active",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    searchPreferences: prefs,
    jobIds: [],
    ...getDefaultCampaignConfiguration("precision"),
    progress: { lastUpdatedAt: "2026-10-24T00:00:00.000Z" },
  });
  const campaigns = {
    campaigns: [campaign],
    activeCampaignId: campaign.id,
    notifications: [],
  };
  const one = {
    ...campaigns.campaigns[0]!,
    searchPreferences: prefs,
    jobIds: ["j2", "j1"],
    sourceTargetIds: ["site_b", "site_a"],
  };
  const two = {
    ...one,
    id: "plan_2",
    name: "Independent plan",
    searchPreferences: { ...prefs, targetRoles: ["A different role"] },
    jobIds: ["j3"],
  };
  const state = contracts.JobSearchCampaignCollectionSchema.parse({
    ...campaigns,
    campaigns: [two, one],
    activeCampaignId: one.id,
  });
  await repo.saveCampaignState(state);
  await repo.close();
  repoClosed = true;
  const db = new DatabaseSync(temp.filePath);
  cleanups.push(() => db.close());
  // Recreate the exact old storage shapes, then migrate the owner's shape.
  const before = draft();
  db.prepare(
    "INSERT INTO resume_drafts(id, job_id, created_at, updated_at, value) VALUES (?, ?, ?, ?, ?)",
  ).run(
    before.id,
    before.jobId,
    before.createdAt,
    before.updatedAt,
    JSON.stringify(before),
  );
  db.prepare(
    "UPDATE singleton_state SET value = ? WHERE key = 'campaign_state'",
  ).run(JSON.stringify(state));
  db.exec("DELETE FROM schema_migrations WHERE version IN (26,27)");
  migrateResumeStorage(db);
  migratePreferenceStorage(db);
  const stored = restoreResumeDraftStorage(
    db,
    JSON.parse(
      String(
        db
          .prepare("SELECT value FROM resume_drafts WHERE id = ?")
          .get(before.id)!.value,
      ),
    ) as unknown,
  );
  expect(stored.sections.map((s) => s.bullets.map((b) => b.text))).toEqual(
    before.sections.map((s) => s.bullets.map((b) => b.text)),
  );
  for (const bullet of stored.sections[0]!.bullets)
    expect(bullet.sourceRefs[0]?.snippet).toBe(source);
  expect(
    Number(db.prepare("SELECT count(*) AS n FROM resume_drafts").get()!.n),
  ).toBe(1);
  const restored = await temp.createRepository();
  cleanups.push(() => restored.close());
  expect(await restored.getCampaignState()).toEqual(state);
  // Same key order too: plan reconciliation compares these as JSON.
  expect(JSON.stringify(await restored.getCampaignState())).toBe(
    JSON.stringify(state),
  );
});
test("saved-job tables preserve distinct source and per-plan history after a write", async () => {
  const temp = await createTempRepository("nestor-job-relations-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  cleanups.push(() => repo.close());
  const base = createSavedJob({ description: source });
  const job = createSavedJob({
    ...base,
    campaignIds: ["a", "b"],
    planAssessments: {
      a: base.matchAssessment,
      b: { ...base.matchAssessment, score: 87 },
    },
    provenance: [
      {
        targetId: "source_a",
        adapterKind: "auto",
        startingUrl: "https://example.com/jobs",
        discoveredAt: base.discoveredAt,
        collectionMethod: "api",
        providerKey: null,
        providerBoardToken: null,
        titleTriageOutcome: "pass",
        resolvedAdapterKind: "target_site",
        listingFacts: {
          title: base.title,
          company: base.company,
          location: base.location,
          salaryText: base.salaryText,
          seniority: base.seniority,
          description: base.description,
          summary: base.summary,
        },
      },
    ],
  });
  await repo.commitSavedJobDelta({ upserts: [job] });
  const restored = (await repo.listSavedJobsByIds([job.id]))[0]!;
  expect(savedJobData(restored)).toEqual(job);
  restored.description = "A different current listing";
  restored.matchAssessment = { ...restored.matchAssessment, score: 23 };
  await repo.commitSavedJobDelta({ upserts: [restored] });
  const next = (await repo.listSavedJobsByIds([job.id]))[0]!;
  expect(next.provenance[0]?.listingFacts?.description).toBe(job.description);
  expect(next.planAssessments?.a?.score).toBe(job.matchAssessment.score);
  expect(next.planAssessments?.b?.score).toBe(87);
});

test("saved-job conversion retains exact prepared identity across the codec", async () => {
  const temp = await createTempRepository("nestor-job-preparation-migration-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  const job = createSavedJob();
  const matchAssessmentPostingFingerprint =
    contracts.computeMatchAssessmentPostingFingerprint(job);
  const value: DiscoverySavedJobFingerprints = {
    version: 1,
    card: "card",
    detail: "detail",
    material: "material",
    matchAssessmentPostingFingerprint,
    identity: {
      version: 1,
      local: { keys: ["opaque"], priorities: [40] },
      acrossSources: { keys: ["opaque"], priorities: [40] },
      content: { digest: "digest", packed: new Uint8Array([1, 2, 255]) },
    },
  };
  const { identity, ...fingerprints } = value;
  writeDiscoveryPreparation(job, {
    fingerprints: { owner: job, value: fingerprints },
    savedIdentity: { owner: job, value: identity! },
    matchAssessmentPostingFingerprint,
  });
  Object.freeze(job);
  await repo.commitSavedJobDelta({ upserts: [job] });
  await repo.close();
  const db = new DatabaseSync(temp.filePath);
  cleanups.push(() => db.close());
  const stored = db
    .prepare(
      "SELECT value FROM saved_job_discovery_fingerprints WHERE job_id = ?",
    )
    .get(job.id)!.value;
  // Recreate the original full row plus its independently persisted preparation.
  db.prepare(
    "UPDATE saved_jobs SET value = ?, assessment_id = NULL, description_id = NULL WHERE id = ?",
  ).run(JSON.stringify(job), job.id);
  db.prepare("INSERT INTO saved_job_discovery_fingerprints VALUES (?, ?)").run(
    job.id,
    String(stored),
  );
  db.exec("DELETE FROM schema_migrations WHERE version = 28");
  migrateSavedJobStorage(db);
  expect(readSavedJobFingerprintBatch(db, [job.id])).toEqual(
    new Map([[job.id, value]]),
  );
});

test("salary evidence reuses carried results and parses each old listing text once", async () => {
  const temp = await createTempRepository("nestor-body-salary-");
  cleanups.push(temp.cleanup);
  const repo = await temp.createRepository();
  cleanups.push(() => repo.close());
  const description = "Salary: USD 90,000 - 110,000 per year.";
  const job = createSavedJob({ id: "a", description });
  const preparation = {
    ...contracts.readDiscoveryPreparation(job),
    fingerprints: {
      owner: job,
      value: {
        version: 1 as const,
        card: "salary-card",
        detail: "salary-detail",
        material: "salary-material",
      },
    },
    bodySalaryRange: "USD 90,000 - 110,000 per year",
  };
  writeDiscoveryPreparation(job, preparation);
  Object.freeze(job);
  const parser = vi.spyOn(contracts, "extractSalaryRangeFromListingBody");
  try {
    await repo.commitSavedJobDelta({ upserts: [job] });
    await repo.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "b", description })],
    });
    expect(parser).not.toHaveBeenCalled();
    await repo.commitSavedJobDelta({
      upserts: [
        createSavedJob({ id: "c", description: "Pay: USD 40,000 per year." }),
        createSavedJob({ id: "d", description: "No pay evidence is stated." }),
      ],
    });
    expect(parser).toHaveBeenCalledTimes(2);
    const rows = await repo.listSavedJobsByIds(["a", "b", "c", "d"]);
    expect(
      rows.map(
        (row) =>
          Reflect.get(
            contracts.readDiscoveryPreparation(row)!,
            "bodySalaryRange",
          ) as unknown,
      ),
    ).toEqual([
      preparation.bodySalaryRange,
      preparation.bodySalaryRange,
      "USD 40,000 per year",
      null,
    ]);
    const borrowed = await repo.readSavedJobsProjection();
    expect(
      borrowed.map(
        (row) =>
          Reflect.get(
            contracts.readDiscoveryPreparation(row)!,
            "bodySalaryRange",
          ) as unknown,
      ),
    ).toEqual([
      preparation.bodySalaryRange,
      preparation.bodySalaryRange,
      "USD 40,000 per year",
      null,
    ]);
    await repo.commitSavedJobDelta({
      updateJobIds: ["d"],
      update: (row) => ({ ...row, status: "approved" }),
    });
    expect(parser).toHaveBeenCalledTimes(2);
    const changed = rows[0]!;
    changed.description = "Salary: USD 130,000 per year.";
    delete contracts.readDiscoveryPreparation(changed)!.bodySalaryRange;
    await repo.commitSavedJobDelta({ upserts: [changed] });
    expect(parser).toHaveBeenCalledTimes(3);
    expect(
      Reflect.get(
        contracts.readDiscoveryPreparation(
          (await repo.listSavedJobsByIds(["a"]))[0]!,
        )!,
        "bodySalaryRange",
      ),
    ).toBe("USD 130,000 per year");
  } finally {
    parser.mockRestore();
  }
});
