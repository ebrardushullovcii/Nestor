import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  workModeValues,
  QueryJobListInputSchema,
  QueryCompaniesInputSchema,
  type WorkspaceStartupContext,
  type WorkspaceJobListRow,
  type WorkspaceEntitySummary,
  type SavedJob,
  type CompanyEntity,
  type QueryJobListInput,
  type QueryJobListResult,
  type QueryCompaniesInput,
  type QueryCompaniesResult,
  type WorkspaceListCounts,
  type WorkspaceHomeSummary,
  type WorkspaceChanges,
  type WorkspaceJobList,
  type JobFinderJobDetail,
} from "@nestor/contracts";
import { ensureWorkspaceReadIndex } from "./internal/workspace-read-index";
import {
  savedJobValueSql,
  ensureSavedJobRelations,
} from "./internal/saved-job-storage";
import { ensureResumeApprovalState } from "./internal/resume-approval-state";
import { ensurePreferenceStorageTables } from "./internal/preference-storage";
import { validateWorkspaceSettingsFile } from "./internal/state";
import { createWorkspaceListActivityReader } from "./internal/workspace-list-activity";
import {
  createWorkspaceListOrdering,
  createWorkspacePageOrder,
} from "./internal/workspace-list-ordering";
import { createWorkspaceListFilters } from "./internal/workspace-list-filters";
import { createWorkspaceListFacets } from "./internal/workspace-list-facets";
import type { ListingActivity } from "@nestor/contracts";
import {
  describeMatchTieBreakReason,
  type TieBreakAssessment,
} from "@nestor/job-list-policy/tie-break-reason";

export interface WorkspaceQueryRepository {
  getStartupContext(): WorkspaceStartupContext;
  queryJobList(input: QueryJobListInput): QueryJobListResult;
  getJobDetail(
    jobId: string,
    planId?: string | null,
  ): JobFinderJobDetail | null;
  getCompanyDetail(companyId: string): CompanyEntity | null;
  getListCounts(input?: {
    planId?: string | null | undefined;
  }): WorkspaceListCounts;
  getHomeSummary(input?: {
    planId?: string | null | undefined;
  }): WorkspaceHomeSummary;
  queryCompanies(input?: QueryCompaniesInput): QueryCompaniesResult;
  getChanges(after: number, limit?: number): WorkspaceChanges;
  close(): void;
}

function prepareQuerySchema(database: DatabaseSync): void {
  validateWorkspaceSettingsFile(database);
  ensureResumeApprovalState(database);
  ensureSavedJobRelations(database);
  ensurePreferenceStorageTables(database);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_changes (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, item_id TEXT,
    operation TEXT CHECK(operation IN ('upsert', 'delete')));
    CREATE TABLE IF NOT EXISTS workspace_read_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE INDEX IF NOT EXISTS plan_job_membership_job_idx ON plan_job_memberships(item_id,plan_id)`);
  if (
    !database.prepare("SELECT 1 FROM schema_migrations WHERE version=27").get()
  )
    database.exec(`INSERT OR IGNORE INTO plan_job_memberships(plan_id,item_id,position)
      WITH campaigns AS MATERIALIZED (
        SELECT json_extract(c.value, '$.id') AS id, jsonb_extract(jsonb(c.value), '$.jobIds') AS jobs
        FROM singleton_state s, json_each(s.value, '$.campaigns') c WHERE s.key = 'campaign_state')
      SELECT c.id, j.value, j.key FROM campaigns c, json_each(c.jobs) j`);
}

/** Prepare screen facts only. Evidence conversion is not a prerequisite. */
export function prepareWorkspaceQueryDatabase(
  filePath: string,
  onContextReady?: () => void,
): void {
  const database = new DatabaseSync(filePath);
  try {
    database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 0",
    );
    if (!onContextReady) database.exec("PRAGMA synchronous = NORMAL");
    database.exec("BEGIN IMMEDIATE");
    prepareQuerySchema(database);
    if (onContextReady) {
      // Keep this connection alive: closing between the two gates checkpoints
      // the entire legacy WAL before the index can even start. The canonical
      // checkpoint worker owns checkpoint scheduling once the writer opens.
      database.exec("COMMIT");
      onContextReady();
      database.exec("PRAGMA synchronous = NORMAL; BEGIN IMMEDIATE");
    }
    ensureWorkspaceReadIndex(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

const activeApplication = `(e.returned_to_shortlist_at IS NULL OR julianday(e.returned_to_shortlist_at) < julianday(e.updated_at))`;
const applicationMember = `EXISTS (SELECT 1 FROM workspace_entity_index e
  WHERE e.origin = 'application_records' AND e.job_id = i.id AND ${activeApplication})`;
// The canonical review queue includes prepared applications and excludes the
// plain shortlisted status used when a job is moved back to Find jobs.
const shortlistMember = `i.status IN ('drafting','ready_for_review','approved')`;
const discoveryMember = `i.visible = 1 AND i.feedback = 0 AND i.status IN ('discovered','shortlisted')
  AND (i.origin='saved_jobs' OR EXISTS (SELECT 1 FROM discovery_pending_jobs pending WHERE pending.id=i.id
    AND workspace_pending_visible(pending.id,json_extract(pending.value,'$.title'),json_extract(pending.value,'$.company'),
      json_extract(pending.value,'$.canonicalUrl'),json_extract(pending.value,'$.status'))=1))`;
function membership(list: WorkspaceJobList): string {
  switch (list) {
    case "discovery":
      return discoveryMember;
    case "dismissed":
      return "i.hidden = 1";
    case "shortlisted":
      return `(${shortlistMember})`;
    case "applications":
      return applicationMember;
    case "company":
      return "EXISTS (SELECT 1 FROM workspace_company_jobs c WHERE c.job_id = i.id)";
    case "all":
      return "1";
  }
}
const deduplicated = `(i.origin = 'saved_jobs' OR NOT EXISTS (
  SELECT 1 FROM workspace_job_index saved WHERE saved.origin = 'saved_jobs' AND saved.id = i.id AND saved.plan_id = ''))`;
const allLists: WorkspaceJobList[] = [
  "discovery",
  "dismissed",
  "shortlisted",
  "applications",
  "company",
  "all",
];
function affectedLists(table: string, id: string): WorkspaceJobList[] {
  if (
    table === "discovery_ledger" ||
    table === "discovery_ledger_observations" ||
    table === "application_attempts" ||
    table === "job_sources" ||
    table === "search_preference_sources" ||
    (table === "singleton_state" &&
      ["intelligence_state", "search_preferences"].includes(id))
  )
    return allLists;
  if (
    table === "saved_jobs" ||
    table === "discovery_pending_jobs" ||
    table === "plan_job_memberships" ||
    (table === "singleton_state" && id === "campaign_state")
  )
    return allLists;
  if (table.startsWith("resume_") || table === "tailored_assets")
    return ["shortlisted", "applications"];
  if (
    table === "application_records" ||
    table === "apply_job_results" ||
    table === "prepared_application_forms"
  )
    return ["applications", "shortlisted", "company", "all"];
  return [];
}

export function createWorkspaceQueryRepository(
  filePath: string,
): WorkspaceQueryRepository {
  const database = new DatabaseSync(filePath, { readOnly: true });
  database.exec(
    "PRAGMA busy_timeout = 100; PRAGMA cache_size = -8192; PRAGMA temp_store=MEMORY",
  );
  // The main file is opened readOnly. Only connection-local scalar TEMP tables
  // can be written by these helpers; no canonical row can be changed.
  const activity = createWorkspaceListActivityReader(database);
  const prepareOrder = createWorkspaceListOrdering(database);
  const pageOrder = createWorkspacePageOrder(database);
  const prepareFilters = createWorkspaceListFilters(database);
  const facets = createWorkspaceListFacets(database);
  const revision = () =>
    Number(
      database
        .prepare(
          "SELECT COALESCE(MAX(revision), 0) AS revision FROM workspace_changes",
        )
        .get()!.revision,
    );
  // Every reply observes one committed SQLite snapshot: rows, totals, badges and
  // its revision cannot come from different concurrent writer transactions.
  const read = <T>(fn: () => T): T => {
    database.exec("BEGIN");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      activity.invalidate();
      pageOrder.invalidate();
      throw error;
    }
  };
  function activePlan(): string | null {
    const row = database
      .prepare(
        "SELECT json_extract(value, '$.activeCampaignId') AS id FROM singleton_state WHERE key = 'campaign_state'",
      )
      .get();
    return typeof row?.id === "string" ? row.id : null;
  }
  const plan = (input?: { planId?: string | null | undefined }) =>
    input?.planId === undefined ? (activePlan() ?? "") : (input.planId ?? "");
  function counts(planId: string): WorkspaceListCounts {
    prepareFilters(
      `${revision()}:${String(database.prepare("PRAGMA data_version").get()!.data_version)}`,
    );
    const totals = database
      .prepare(
        `SELECT
      sum(CASE WHEN ${discoveryMember} AND i.result_group IN ('matches','unchecked') THEN 1 ELSE 0 END) AS discovery,
      sum(CASE WHEN i.hidden=1 THEN 1 ELSE 0 END) AS dismissed,
      sum(CASE WHEN ${shortlistMember} THEN 1 ELSE 0 END) AS shortlisted,count(*) AS total
      FROM workspace_job_index i WHERE i.plan_id=? AND ${deduplicated}`,
      )
      .get(planId)!;
    const applications = Number(
      database
        .prepare(
          `SELECT count(DISTINCT e.job_id) AS n FROM workspace_entity_index e
      WHERE e.origin = 'application_records' AND ${activeApplication}
      AND EXISTS (SELECT 1 FROM workspace_job_index i WHERE i.id = e.job_id AND i.plan_id = ?)`,
        )
        .get(planId)!.n,
    );
    return {
      discovery: Number(totals.discovery),
      dismissed: Number(totals.dismissed),
      shortlisted: Number(totals.shortlisted),
      applications,
      companies: Number(
        database
          .prepare("SELECT count(*) AS total FROM workspace_company_index")
          .get()!.total,
      ),
      all: Number(totals.total),
    };
  }
  const raw = (value: unknown): unknown => JSON.parse(String(value)) as unknown;
  function associated(table: string, ids: string[]): WorkspaceEntitySummary[] {
    if (!ids.length) return [];
    return database
      .prepare(
        `SELECT e.id, e.job_id AS jobId,
      CASE WHEN a.draft_id IS NOT NULL THEN 'stale' ELSE e.status END AS status,
      COALESCE(a.updated_at, e.updated_at) AS updatedAt,
      CASE WHEN a.draft_id IS NOT NULL THEN NULL ELSE e.approved_at END AS approvedAt,
      CASE WHEN a.draft_id IS NOT NULL THEN NULL ELSE e.approved_export_id END AS approvedExportId,
      COALESCE(a.stale_reason, e.stale_reason) AS staleReason,
      e.stage, e.returned_to_shortlist_at AS returnedToShortlistAt, e.run_id AS runId,
      e.last_action_label AS lastActionLabel, e.next_action_label AS nextActionLabel
      FROM workspace_entity_index e LEFT JOIN resume_draft_approval_state a
        ON e.origin = 'resume_drafts' AND a.draft_id = e.id
      WHERE e.origin = ? AND e.job_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(table, ...ids) as unknown as WorkspaceEntitySummary[];
  }
  return {
    getStartupContext() {
      return read(() => {
        const values = new Map(
          database
            .prepare(
              "SELECT key, value FROM singleton_state WHERE key IN ('profile_setup_state', 'settings', 'activity_control')",
            )
            .all()
            .map((row) => [String(row.key), raw(row.value)]),
        );
        const normalized = !!database
          .prepare("SELECT 1 FROM schema_migrations WHERE version = 27")
          .get();
        const preferenceRow = normalized
          ? database
              .prepare(
                "SELECT p.id, p.value FROM singleton_state s JOIN search_preference_sets p ON p.id = json_extract(s.value, '$.preferenceId') WHERE s.key = 'search_preferences'",
              )
              .get()
          : database
              .prepare(
                "SELECT json_remove(value, '$.discovery.targets') AS value FROM singleton_state WHERE key = 'search_preferences'",
              )
              .get();
        const sourceCount = normalized
          ? Number(
              database
                .prepare(
                  "SELECT count(*) AS n FROM search_preference_sources WHERE preference_id = ?",
                )
                .get(String(preferenceRow?.id))!.n,
            )
          : Number(
              database
                .prepare(
                  "SELECT COALESCE(json_array_length(value, '$.discovery.targets'),0) AS n FROM singleton_state WHERE key = 'search_preferences'",
                )
                .get()?.n ?? 0,
            );
        const planValue = (
          value: string,
        ) => `json_object('id', json_extract(${value}, '$.id'), 'name', json_extract(${value}, '$.name'),
          'description', json_extract(${value}, '$.description'), 'mode', json_extract(${value}, '$.mode'), 'status', json_extract(${value}, '$.status'),
          'minimumFitScore', json_extract(${value}, '$.minimumFitScore'), 'progress', json_extract(${value}, '$.progress'))`;
        const planRows = normalized
          ? database
              .prepare(
                `SELECT ${planValue("p.value")} AS value, (SELECT count(*) FROM plan_job_memberships j WHERE j.plan_id = p.id) AS job_count,
            (SELECT count(*) FROM plan_sources s WHERE s.plan_id = p.id) AS source_count FROM job_search_plans p ORDER BY position, id`,
              )
              .all()
          : database
              .prepare(
                `SELECT ${planValue("c.value")} AS value,
            json_array_length(c.value, '$.jobIds') AS job_count, json_array_length(c.value, '$.sourceTargetIds') AS source_count
            FROM singleton_state s, json_each(s.value, '$.campaigns') c WHERE s.key = 'campaign_state'`,
              )
              .all();
        const profile = database
          .prepare(
            `SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.fullName') AS fullName,
          json_extract(value, '$.firstName') AS firstName, json_extract(value, '$.lastName') AS lastName,
          json_extract(value, '$.headline') AS headline, json_extract(value, '$.currentLocation') AS currentLocation,
          json_extract(value, '$.baseResume.id') IS NOT NULL AS hasResume FROM singleton_state WHERE key = 'profile'`,
          )
          .get();
        return {
          profile: { ...profile, hasResume: profile?.hasResume === 1 },
          searchPreferences: preferenceRow ? raw(preferenceRow.value) : null,
          profileSetupState: values.get("profile_setup_state"),
          settings: values.get("settings"),
          campaigns: planRows.map((row) => ({
            ...(raw(row.value) as object),
            jobCount: Number(row.job_count),
            sourceCount: Number(row.source_count),
          })),
          activeCampaignId: activePlan(),
          sourceCount,
          activityControl: values.get("activity_control"),
        } as WorkspaceStartupContext;
      });
    },
    queryJobList(input) {
      const query = QueryJobListInputSchema.parse(input);
      return read(() => {
        const planId = plan(query.filters);
        const version = `${revision()}:${String(database.prepare("PRAGMA data_version").get()!.data_version)}`;
        const activityVersion = String(
          database
            .prepare(
              "SELECT value FROM workspace_read_meta WHERE key='activity_revision'",
            )
            .get()?.value ?? "0",
        );
        activity.ensure(planId, activityVersion);
        prepareOrder(activityVersion);
        prepareFilters(version);
        const from = `FROM workspace_job_index i JOIN workspace_listing_activity a
          ON a.plan_id=i.plan_id AND a.origin=i.origin AND a.id=i.id`;
        const sortRevision = String(
          database
            .prepare(
              "SELECT value FROM workspace_read_meta WHERE key='sort_revision'",
            )
            .get()?.value ?? "0",
        );
        pageOrder.ensure(
          planId,
          query.sort,
          `${activityVersion}:${sortRevision}`,
          from,
        );
        const args: SQLInputValue[] = [planId];
        const where = ["i.plan_id = ?", deduplicated, membership(query.list)];
        if (query.list === "discovery") {
          const bands = query.filters.discoveryBands ?? [
            "matches",
            "unchecked",
          ];
          where.push(`i.result_group IN (${bands.map(() => "?").join(",")})`);
          args.push(...bands);
        }
        const pool = where.join(" AND "),
          poolArgs = [...args];
        for (const [values, column] of [
          [query.filters.statuses, "status"],
          [query.filters.sources, "source"],
        ] as const) {
          if (values?.length) {
            where.push(`i.${column} IN (${values.map(() => "?").join(",")})`);
            args.push(...values);
          }
        }
        if (query.filters.workModes?.length) {
          const mask = query.filters.workModes.reduce(
            (value, mode) => value | (1 << workModeValues.indexOf(mode)),
            0,
          );
          where.push(
            query.filters.workModeUnspecified
              ? "((i.work_mode & ?) != 0 OR i.work_mode=0)"
              : "(i.work_mode & ?) != 0",
          );
          args.push(mask);
        } else if (query.filters.workModeUnspecified)
          where.push("i.work_mode=0");
        for (const [values, column] of [
          [query.filters.recommendations, "i.recommendation"],
          [query.filters.activities, "a.status"],
        ] as const) {
          if (values?.length) {
            where.push(`${column} IN (${values.map(() => "?").join(",")})`);
            args.push(...values);
          }
        }
        if (query.filters.sourceLabels?.length) {
          where.push(
            `EXISTS (SELECT 1 FROM json_each(workspace_sources(i.source_provenance)) s WHERE s.value IN (${query.filters.sourceLabels.map(() => "?").join(",")}))`,
          );
          args.push(...query.filters.sourceLabels);
        }
        if (query.filters.newOnly && query.filters.newSince) {
          where.push(
            "workspace_listing_time(COALESCE(i.first_seen_at,i.discovered_at))>?",
          );
          args.push(Date.parse(query.filters.newSince));
        }
        if (query.filters.minimumScore !== undefined) {
          where.push("i.score >= ?");
          args.push(query.filters.minimumScore);
        }
        if (query.filters.maximumScore !== undefined) {
          where.push("i.score <= ?");
          args.push(query.filters.maximumScore);
        }
        if (query.filters.companyId) {
          where.push(
            "EXISTS (SELECT 1 FROM workspace_company_jobs c WHERE c.company_id = ? AND c.job_id = i.id)",
          );
          args.push(query.filters.companyId);
        }
        if (query.search.trim()) {
          where.push(
            "workspace_search(i.title,i.company,i.location,i.salary_text,i.status,i.apply_path,i.work_mode,i.recommendation,a.status,?)=1",
          );
          args.push(query.search.trim());
        }
        const condition = where.join(" AND ");
        const countFrom =
          query.filters.activities?.length || query.search.trim()
            ? from
            : "FROM workspace_job_index i";
        const total = Number(
          database
            .prepare(`SELECT count(*) AS total ${countFrom} WHERE ${condition}`)
            .get(...args)!.total,
        );
        const listFacets = facets(
          version,
          from,
          pool,
          poolArgs,
          condition,
          args,
          query.filters.newSince,
        );
        const columns = database
          .prepare(
            `WITH page AS MATERIALIZED (
          SELECT i.origin,i.id,i.plan_id,r.position FROM workspace_page_order r
          CROSS JOIN workspace_job_index i ON i.plan_id=r.plan_id AND i.origin=r.origin AND i.id=r.id
          CROSS JOIN workspace_listing_activity a ON a.plan_id=i.plan_id AND a.origin=i.origin AND a.id=i.id
          WHERE r.plan_id=? AND r.sort='${query.sort}' AND ${condition} ORDER BY r.position LIMIT ? OFFSET ?)
          SELECT i.id, i.status, i.title, i.company, i.location, i.source,
          i.source_job_id AS sourceJobId, i.canonical_url AS canonicalUrl, i.application_url AS applicationUrl,
          i.work_mode AS workModeMask, i.posted_at AS postedAt, i.posted_text AS postedAtText,
          i.discovered_at AS discoveredAt, i.first_seen_at AS firstSeenAt, i.last_seen_at AS lastSeenAt,
          i.salary_text AS salaryText, i.detail_quality AS detailQuality,
          i.resume_mode AS resumeApplicationMode, i.tailoring_mode AS resumeTailoringMode,
          nullif(i.plan_id, '') AS planId, COALESCE(plan_verdict.score, i.score) AS score, i.recommendation, i.unjudged, i.provisional,
          i.score_upper AS scoreUpper, i.title_family_match AS titleFamilyMatch,
          i.location_reach AS locationReach, a.value AS activityJson, a.status AS activityStatus, i.result_group AS resultGroup,
          i.provider_updated_at AS providerUpdatedAt,i.discovery_method AS discoveryMethod,i.apply_path AS applyPath,
          workspace_sources(i.source_provenance) AS sourcesJson,i.recommendation_rationale AS recommendationRationale,
          i.first_gap AS firstGap,i.role_state AS roleSuitabilityState,i.seniority,i.rescored,
          i.tie_requirements AS tieRequirements,i.first_reason AS firstReason,
          workspace_lookalike(i.title,i.company,i.location,workspace_sources(i.source_provenance)) AS lookalike,
          workspace_score_tied(i.score,i.unjudged,i.provisional) AS scoreTied
          FROM page p JOIN workspace_job_index i ON i.origin=p.origin AND i.id=p.id AND i.plan_id=p.plan_id
          JOIN workspace_listing_activity a ON a.origin=i.origin AND a.id=i.id AND a.plan_id=i.plan_id
          LEFT JOIN job_plan_assessments plan_verdict ON i.origin = 'saved_jobs'
            AND plan_verdict.job_id = i.id AND plan_verdict.plan_id = i.plan_id
          ORDER BY p.position`,
          )
          .all(planId, ...args, query.page.limit, query.page.offset);
        const rows = columns.map(
          ({
            workModeMask,
            unjudged,
            provisional,
            scoreUpper,
            activityJson,
            activityStatus,
            sourcesJson,
            rescored,
            tieRequirements,
            firstReason,
            lookalike,
            scoreTied,
            ...row
          }) => ({
            ...row,
            workMode: workModeValues.filter(
              (_, index) => (Number(workModeMask) & (1 << index)) !== 0,
            ),
            judged: unjudged === 0,
            scoreWithheld: unjudged !== 0 || provisional !== 0,
            scoreIsUpperBound: scoreUpper === 1,
            listingActivity: JSON.parse(
              String(activityJson),
            ) as ListingActivity,
            listingClosed:
              activityStatus === "inactive" || activityStatus === "closed",
            sourceLabels: JSON.parse(String(sourcesJson)) as string[],
            rescoredAfterListingRead: rescored === 1,
            indistinguishable: lookalike === 1,
            scoreTied: scoreTied === 1,
            tieBreakReason: describeMatchTieBreakReason({
              titleFamilyMatch:
                row.titleFamilyMatch as WorkspaceJobListRow["titleFamilyMatch"],
              locationReach:
                row.locationReach as WorkspaceJobListRow["locationReach"],
              reasons: typeof firstReason === "string" ? [firstReason] : [],
              gaps: typeof row.firstGap === "string" ? [row.firstGap] : [],
              requirements: JSON.parse(
                String(tieRequirements ?? "[]"),
              ) as TieBreakAssessment["requirements"],
            }),
          }),
        ) as unknown as WorkspaceJobListRow[];
        const ids = rows.map((row) => row.id);
        return {
          rows,
          total,
          counts: counts(planId),
          revision: revision(),
          resumeDrafts: associated("resume_drafts", ids),
          applications: associated("application_records", ids),
          applyResults: associated("apply_job_results", ids),
          facets: listFacets,
        };
      });
    },
    getJobDetail(jobId, planId = null) {
      return read(() => {
        const row = database
          .prepare(
            `SELECT ${savedJobValueSql()} AS value FROM saved_jobs WHERE id = ? UNION ALL SELECT value FROM discovery_pending_jobs WHERE id = ? LIMIT 1`,
          )
          .get(jobId, jobId);
        if (!row) return null;
        const job = raw(row.value) as SavedJob;
        if (planId && job.planAssessments?.[planId])
          job.matchAssessment = job.planAssessments[planId];
        return { job, planId };
      });
    },
    getCompanyDetail(companyId) {
      return read(() => {
        const row = database
          .prepare("SELECT value FROM workspace_company_index WHERE id = ?")
          .get(companyId);
        return row ? (raw(row.value) as CompanyEntity) : null;
      });
    },
    getListCounts(input) {
      return read(() => counts(plan(input)));
    },
    getHomeSummary(input) {
      return read(() => {
        const planId = plan(input);
        const statuses = database
          .prepare(
            `SELECT e.status, count(*) AS total FROM workspace_entity_index e
          WHERE e.origin = 'application_records' AND ${activeApplication} AND EXISTS (SELECT 1 FROM workspace_job_index i
            WHERE i.id = e.job_id AND i.plan_id = ?) GROUP BY e.status`,
          )
          .all(planId);
        const drafts = database
          .prepare(
            `SELECT CASE WHEN a.draft_id IS NOT NULL THEN 'stale' ELSE e.status END AS status, count(*) AS total
          FROM workspace_entity_index e LEFT JOIN resume_draft_approval_state a ON a.draft_id = e.id
          WHERE e.origin = 'resume_drafts' AND EXISTS (SELECT 1 FROM workspace_job_index i WHERE i.id = e.job_id AND i.plan_id = ?)
          GROUP BY CASE WHEN a.draft_id IS NOT NULL THEN 'stale' ELSE e.status END`,
          )
          .all(planId);
        return {
          counts: counts(planId),
          revision: revision(),
          activePlanId: planId || null,
          searchRunning:
            database
              .prepare(
                "SELECT json_extract(value, '$.runState') AS state FROM singleton_state WHERE key = 'discovery_state'",
              )
              .get()?.state === "running",
          resumesToReview: drafts
            .filter(
              (row) => row.status === "needs_review" || row.status === "draft",
            )
            .reduce((n, row) => n + Number(row.total), 0),
          resumesApproved: drafts
            .filter((row) => row.status === "approved")
            .reduce((n, row) => n + Number(row.total), 0),
          applicationsByStatus: Object.fromEntries(
            statuses.map((row) => [String(row.status), Number(row.total)]),
          ),
        };
      });
    },
    queryCompanies(input = {}) {
      const query = QueryCompaniesInputSchema.parse(input);
      return read(() => {
        const total = Number(
          database
            .prepare(
              "SELECT count(*) AS total FROM workspace_company_index WHERE instr(name, lower(?)) > 0",
            )
            .get(query.search.trim())!.total,
        );
        const rows = database
          .prepare(
            "SELECT id, canonical_name AS canonicalName, preference, job_count AS jobCount, application_count AS applicationCount, updated_at AS updatedAt FROM workspace_company_index WHERE instr(name, lower(?)) > 0 ORDER BY name, id LIMIT ? OFFSET ?",
          )
          .all(
            query.search.trim(),
            query.page.limit,
            query.page.offset,
          ) as unknown as QueryCompaniesResult["rows"];
        return { rows, total, revision: revision() };
      });
    },
    getChanges(after, limit = 500) {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 2000
      )
        throw new Error("Invalid change cursor.");
      return read(() => {
        const rows = database
          .prepare(
            "SELECT revision, table_name, item_id, operation FROM workspace_changes WHERE revision > ? ORDER BY revision LIMIT ?",
          )
          .all(after, limit + 1);
        const hasMore = rows.length > limit;
        const changes = rows.slice(0, limit).map((row) => ({
          revision: Number(row.revision),
          table: String(row.table_name),
          id: String(row.item_id),
          operation:
            row.operation === "delete"
              ? ("delete" as const)
              : ("upsert" as const),
        }));
        return {
          changes,
          revision: changes.at(-1)?.revision ?? Math.min(after, revision()),
          hasMore,
          lists: [
            ...new Set(
              changes.flatMap((change) =>
                affectedLists(change.table, change.id),
              ),
            ),
          ],
        };
      });
    },
    close() {
      database.close();
    },
  };
}
