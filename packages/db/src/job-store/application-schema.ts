export const APPLICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'needs_you', 'ready', 'submitting',
    'submitted', 'stopped', 'failed', 'uncertain'
  )),
  attempt INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  error TEXT,
  submission_outcome_id TEXT UNIQUE,
  submission_outcome_json TEXT
);
CREATE INDEX IF NOT EXISTS applications_by_updated ON applications(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_by_state ON applications(state, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_queue ON applications(state, queued_at, id);

CREATE TABLE IF NOT EXISTS needs_you (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'sign_in', 'captcha', 'mfa')),
  answer_key TEXT NOT NULL,
  country TEXT NOT NULL,
  site_origin TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input TEXT NOT NULL CHECK (input IN ('text', 'boolean', 'choice', 'number', 'file')),
  options_json TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  answer TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS needs_you_open_key
  ON needs_you(kind, answer_key, country, site_origin) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS needs_you_open ON needs_you(id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS application_needs_you (
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES needs_you(id) ON DELETE CASCADE,
  PRIMARY KEY (application_id, field_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS application_needs_you_by_task
  ON application_needs_you(task_id, application_id);
CREATE TRIGGER IF NOT EXISTS application_needs_you_delete AFTER DELETE ON application_needs_you BEGIN
  UPDATE needs_you SET resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = OLD.task_id AND resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM application_needs_you WHERE task_id = OLD.task_id);
END;
CREATE TRIGGER IF NOT EXISTS application_needs_you_replace AFTER UPDATE OF task_id ON application_needs_you
WHEN OLD.task_id <> NEW.task_id BEGIN
  UPDATE needs_you SET resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = OLD.task_id AND resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM application_needs_you WHERE task_id = OLD.task_id);
END;

CREATE TRIGGER IF NOT EXISTS applications_stop_tasks AFTER UPDATE OF state ON applications
WHEN NEW.state IN ('stopped', 'failed', 'submitted', 'uncertain') BEGIN
  UPDATE needs_you SET resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE resolved_at IS NULL
    AND id IN (SELECT task_id FROM application_needs_you WHERE application_id = NEW.id)
    AND NOT EXISTS (
      SELECT 1 FROM application_needs_you n JOIN applications a ON a.id = n.application_id
      WHERE n.task_id = needs_you.id AND n.attempt = a.attempt
        AND a.state IN ('running', 'needs_you')
    );
END;

CREATE TRIGGER IF NOT EXISTS applications_approval_removed AFTER UPDATE OF stage ON jobs
WHEN OLD.stage = 'resume' AND NEW.stage NOT IN ('resume', 'applied') BEGIN
  UPDATE applications SET state = 'stopped', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE job_id = NEW.id AND state IN ('queued', 'running', 'needs_you', 'ready');
END;

-- Form answer memory belongs to Needs you, never Profile or a workspace blob.
CREATE TABLE IF NOT EXISTS form_answers (
  answer_key TEXT NOT NULL,
  country TEXT NOT NULL,
  site_origin TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  input TEXT NOT NULL,
  options_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (answer_key, country, site_origin)
) WITHOUT ROWID;
`;
