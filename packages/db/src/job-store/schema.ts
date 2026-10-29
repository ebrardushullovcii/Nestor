import { PROFILE_EDIT_DRAFT_SCHEMA } from "./profile-edit-draft";
import { PROFILE_IMPORT_SCHEMA } from "./profile-import-store";
import { SEARCH_SOURCES_SCHEMA } from "./search-sources";
import { SOURCE_ACCESS_SCHEMA } from "./source-access";
import { PROFILE_SCHEMA } from "./profile-store";
import { PREFERENCES_SCHEMA } from "./preferences-store";
import { PROFILE_WORKFLOW_SCHEMA } from "./profile-workspace";
import { SITE_INSTRUCTIONS_SCHEMA } from "./site-instructions";
import { ACTIVITY_CONTROL_SCHEMA } from "./activity-control";
import { SEND_GUARDS_SCHEMA } from "./send-guards";
import { PREPARED_FORMS_SCHEMA } from "./prepared-forms";
/**
 * The Job Finder store: one SQLite file, one row per job.
 *
 * Everything a screen lists, filters, sorts or counts is a real column with an
 * index behind it; long text and detail-only facts sit in `job_details`.
 *
 * The file holds a person's real job hunt, so a new build never starts it
 * over and there is no version to bump. Every change is an additive step that
 * runs on each open and does nothing once applied:
 * - A new table, index or trigger is another `IF NOT EXISTS` entry in
 *   `JOB_STORE_SCHEMA` (`job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE
 *   CASCADE` for a table about jobs).
 * - A new column goes in its `CREATE TABLE` for new files and in
 *   `JOB_STORE_ADDED_COLUMNS` for files that already exist. SQLite adds it
 *   with its default, so a `NOT NULL` column needs one.
 * - Nothing renames, drops or redefines an existing column or table. A change
 *   that can't be made by adding needs a new table, filled from the old one.
 * `schema.test.ts` holds every column released files have and fails when one
 * goes missing or a new one isn't listed below.
 */
import { JOB_SITES_SCHEMA } from "./job-sites";
import { TRACKER_SCHEMA } from "./tracker-schema";
import { APPLICATION_SCHEMA } from "./application-schema";
import { SEEN_CARDS_SCHEMA } from "./seen-cards";

/**
 * The layout the store keeps from. A file from before it (an earlier
 * development layout) is started over once; from this version on, nothing is.
 */
export const JOB_STORE_KEPT_FROM_VERSION = 6;

export interface AddedColumn {
  table: string;
  column: string;
  /** What follows the name in `ALTER TABLE … ADD COLUMN`. */
  definition: string;
}

/** Columns added to tables after their release, in the order they came. */
export const JOB_STORE_ADDED_COLUMNS: readonly AddedColumn[] = [
  {
    table: "jobs",
    column: "fit_stale",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "jobs",
    column: "hide_owner",
    definition:
      "TEXT CHECK (hide_owner IN ('person','age_retention','closed_listing'))",
  },
  {
    table: "searches",
    column: "already_saved",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "job_move_items", column: "from_hide_owner", definition: "TEXT" },
  { table: "resume_changes", column: "before_stage_at", definition: "INTEGER" },
  { table: "resume_changes", column: "after_stage_at", definition: "INTEGER" },
  { table: "resume_changes", column: "after_move_id", definition: "INTEGER" },
  // SQLite cannot widen a CHECK later, so the column names both outcomes
  // now: a saved rule's skip, and the blocked site that the next change records.
  {
    table: "applications",
    column: "disposition",
    definition: "TEXT CHECK (disposition IN ('skipped', 'blocked'))",
  },
  { table: "form_answers", column: "option_fallback_json", definition: "TEXT" },
  { table: "needs_you", column: "blocked_url", definition: "TEXT" },
  { table: "needs_you", column: "ask_reason_json", definition: "TEXT" },
  {
    table: "needs_you",
    column: "multiple",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "applications",
    column: "review_refill",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  // Empty means Standard (speedLevelOf), as in a file that never had it.
  { table: "profile_settings", column: "speed_level", definition: "TEXT" },
  // Empty means off, as in a file from before the browser permissions.
  {
    table: "profile_settings",
    column: "ai_behavior_browser_permissions_solve_captchas",
    definition: "INTEGER",
  },
  {
    table: "profile_settings",
    column: "ai_behavior_browser_permissions_sign_in",
    definition: "INTEGER",
  },
  {
    table: "profile_settings",
    column: "ai_behavior_browser_permissions_google_sign_in",
    definition: "INTEGER",
  },
  {
    table: "profile_settings",
    column: "ai_behavior_browser_permissions_create_accounts",
    definition: "INTEGER",
  },
];

const JOBS = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('found', 'hidden', 'shortlisted', 'resume', 'applied')),
  stage_at INTEGER NOT NULL,
  -- why it is in its stage when the app put it there (a search hid it)
  stage_note TEXT,
  hide_owner TEXT CHECK (hide_owner IN ('person','age_retention','closed_listing')),
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  -- remote 1, hybrid 2, onsite 4, flexible 8
  work_modes INTEGER NOT NULL DEFAULT 0,
  salary_text TEXT,
  -- -1 until scored, so the fit order needs no NULL handling
  fit_score INTEGER NOT NULL DEFAULT -1,
  fit_summary TEXT,
  fit_stale INTEGER NOT NULL DEFAULT 0,
  -- 0 when the listing shows no date
  posted_at INTEGER NOT NULL DEFAULT 0,
  found_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  found_by TEXT,
  source_label TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 1,
  url TEXT NOT NULL,
  apply_url TEXT
);
CREATE INDEX IF NOT EXISTS jobs_by_fit ON jobs (stage, fit_score DESC, found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_found ON jobs (stage, found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_posted ON jobs (stage, posted_at DESC, found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_stage_at ON jobs (stage, stage_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_search ON jobs (found_by, stage, fit_score DESC, found_at DESC, id DESC);
-- A work-mode filter reads one range per stored mask in each order
-- (job-list.ts toFilterRanges), never the whole stage.
CREATE INDEX IF NOT EXISTS jobs_by_mode_fit ON jobs (stage, work_modes, fit_score DESC, found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_mode_found ON jobs (stage, work_modes, found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_mode_posted ON jobs (stage, work_modes, posted_at DESC, found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_by_mode_stage_at ON jobs (stage, work_modes, stage_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_pending_fit ON jobs (stage, fit_stale, fit_score DESC, found_at DESC);
CREATE INDEX IF NOT EXISTS jobs_waiting_fit ON jobs (stage, fit_score DESC, found_at DESC) WHERE fit_score=-1 OR fit_stale=1;
CREATE TABLE IF NOT EXISTS fit_context (id INTEGER PRIMARY KEY CHECK (id=1), fingerprint TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS job_stage_counts (
  stage TEXT PRIMARY KEY,
  n INTEGER NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO job_stage_counts (stage, n) VALUES
  ('found', 0), ('hidden', 0), ('shortlisted', 0), ('resume', 0), ('applied', 0);
CREATE TRIGGER IF NOT EXISTS jobs_count_insert AFTER INSERT ON jobs BEGIN
  UPDATE job_stage_counts SET n = n + 1 WHERE stage = NEW.stage;
END;
CREATE TRIGGER IF NOT EXISTS jobs_count_delete AFTER DELETE ON jobs BEGIN
  UPDATE job_stage_counts SET n = n - 1 WHERE stage = OLD.stage;
END;
CREATE TRIGGER IF NOT EXISTS jobs_count_stage AFTER UPDATE OF stage ON jobs
WHEN OLD.stage <> NEW.stage BEGIN
  UPDATE job_stage_counts SET n = n - 1 WHERE stage = OLD.stage;
  UPDATE job_stage_counts SET n = n + 1 WHERE stage = NEW.stage;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_text USING fts5(
  title, company, location, content = 'jobs', content_rowid = 'rowid'
);
CREATE TRIGGER IF NOT EXISTS jobs_text_insert AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_text (rowid, title, company, location)
  VALUES (NEW.rowid, NEW.title, NEW.company, NEW.location);
END;
CREATE TRIGGER IF NOT EXISTS jobs_text_delete AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_text (jobs_text, rowid, title, company, location)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.company, OLD.location);
END;
CREATE TRIGGER IF NOT EXISTS jobs_text_update AFTER UPDATE OF title, company, location ON jobs BEGIN
  INSERT INTO jobs_text (jobs_text, rowid, title, company, location)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.company, OLD.location);
  INSERT INTO jobs_text (rowid, title, company, location)
  VALUES (NEW.rowid, NEW.title, NEW.company, NEW.location);
END;

CREATE TABLE IF NOT EXISTS job_details (
  job_id INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  summary TEXT,
  seniority TEXT,
  employment_type TEXT,
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  fit_json TEXT
);
CREATE TRIGGER IF NOT EXISTS listing_fit_stale AFTER UPDATE OF description, seniority, employment_type, salary_min, salary_max, salary_currency ON job_details
WHEN OLD.description IS NOT NEW.description OR OLD.seniority IS NOT NEW.seniority OR OLD.employment_type IS NOT NEW.employment_type OR OLD.salary_min IS NOT NEW.salary_min OR OLD.salary_max IS NOT NEW.salary_max OR OLD.salary_currency IS NOT NEW.salary_currency
BEGIN UPDATE jobs SET fit_stale=1 WHERE id=NEW.job_id; END;
CREATE TRIGGER IF NOT EXISTS listing_row_fit_stale AFTER UPDATE OF title, company, location, work_modes, salary_text ON jobs
WHEN OLD.title IS NOT NEW.title OR OLD.company IS NOT NEW.company OR OLD.location IS NOT NEW.location OR OLD.work_modes IS NOT NEW.work_modes OR OLD.salary_text IS NOT NEW.salary_text
BEGIN UPDATE jobs SET fit_stale=1 WHERE id=NEW.id; END;

-- Each site that lists the job. A job seen on two sites is one job.
CREATE TABLE IF NOT EXISTS job_sightings (
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  site TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  apply_url TEXT,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS job_sightings_by_site ON job_sightings (job_id, site);

-- Identity keys: a found job that shares a key with a saved one is that job.
CREATE TABLE IF NOT EXISTS job_keys (
  key TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS job_keys_by_job ON job_keys (job_id);

-- Recent moves, so Undo puts each job back where it was.
CREATE TABLE IF NOT EXISTS job_moves (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  to_stage TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_move_items (
  move_id INTEGER NOT NULL REFERENCES job_moves (id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  from_stage TEXT NOT NULL,
  from_stage_at INTEGER NOT NULL,
  from_stage_note TEXT,
  from_hide_owner TEXT,
  PRIMARY KEY (move_id, job_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS job_move_items_by_job ON job_move_items (job_id);
`;

const SEARCHES = `
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'stopped', 'failed')),
  settings_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  sources_total INTEGER NOT NULL DEFAULT 0,
  sources_done INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  already_saved INTEGER NOT NULL DEFAULT 0,
  scored INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS searches_by_start ON searches (started_at DESC);
`;

/**
 * A shortlisted job's resume. The draft is one JSON document because only the
 * editor reads it; what a list shows or filters on is a column.
 */
const RESUMES = `
CREATE TABLE IF NOT EXISTS resumes (
  job_id INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('original', 'light', 'tailored', 'aggressive')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'writing', 'ready', 'failed')),
  updated_at INTEGER NOT NULL,
  error TEXT,
  draft_json TEXT,
  -- What the last level change replaced, for its Undo: {level, draft, approvedAt, pdfPath}
  previous_json TEXT,
  approved_at INTEGER,
  pdf_path TEXT
);
CREATE INDEX IF NOT EXISTS resumes_by_state ON resumes (state, updated_at);
CREATE TABLE IF NOT EXISTS resume_changes (
  id TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  before_json TEXT NOT NULL,
  before_stage TEXT NOT NULL,
    before_stage_at INTEGER,
  after_stage TEXT NOT NULL,
    after_stage_at INTEGER,
    after_move_id INTEGER,
  expected_updated_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS resume_changes_by_job ON resume_changes(job_id);
CREATE TABLE IF NOT EXISTS resume_pdf_assets (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (job_id, path, approved_at)
) WITHOUT ROWID;
`;

export const JOB_STORE_SCHEMA: readonly string[] = [
  JOBS,
  SEARCHES,
  RESUMES,
  APPLICATION_SCHEMA,
  SEEN_CARDS_SCHEMA,
  TRACKER_SCHEMA,
  JOB_SITES_SCHEMA,
  SOURCE_ACCESS_SCHEMA,
  SEARCH_SOURCES_SCHEMA,
  PROFILE_SCHEMA,
  PREFERENCES_SCHEMA,
  PROFILE_WORKFLOW_SCHEMA,
  PROFILE_EDIT_DRAFT_SCHEMA,
  PROFILE_IMPORT_SCHEMA,
  SITE_INSTRUCTIONS_SCHEMA,
  ACTIVITY_CONTROL_SCHEMA,
  SEND_GUARDS_SCHEMA,
  PREPARED_FORMS_SCHEMA,
];
