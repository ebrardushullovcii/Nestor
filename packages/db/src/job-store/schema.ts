/**
 * The Job Finder store: one SQLite file, one row per job.
 *
 * Everything a screen lists, filters, sorts or counts is a real column with an
 * index behind it; long text and detail-only facts sit in `job_details`. Add
 * your own tables beside these (`job_id INTEGER NOT NULL REFERENCES jobs(id)
 * ON DELETE CASCADE`) as another entry in `JOB_STORE_SCHEMA`: new tables need no
 * version change. Changing an existing table bumps `JOB_STORE_VERSION`, which
 * starts the file over. There are no migrations before release.
 */
import { JOB_SITES_SCHEMA } from "./job-sites";
import { TRACKER_SCHEMA } from "./tracker-schema";
import { APPLICATION_SCHEMA } from "./application-schema";
import { SEEN_CARDS_SCHEMA } from "./seen-cards";

export const JOB_STORE_VERSION = 4;

const JOBS = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('found', 'hidden', 'shortlisted', 'resume', 'applied')),
  stage_at INTEGER NOT NULL,
  -- why it is in its stage when the app put it there (a search hid it)
  stage_note TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  -- remote 1, hybrid 2, onsite 4, flexible 8
  work_modes INTEGER NOT NULL DEFAULT 0,
  salary_text TEXT,
  -- -1 until scored, so the fit order needs no NULL handling
  fit_score INTEGER NOT NULL DEFAULT -1,
  fit_summary TEXT,
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
`;

export const JOB_STORE_SCHEMA: readonly string[] = [
  JOBS,
  SEARCHES,
  RESUMES,
  APPLICATION_SCHEMA,
  SEEN_CARDS_SCHEMA,
  TRACKER_SCHEMA,
  JOB_SITES_SCHEMA,
];
