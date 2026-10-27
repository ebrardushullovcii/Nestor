export const APPLICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  disposition TEXT CHECK (disposition IN ('skipped', 'blocked')),
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('confirm_before_submit', 'autonomous_submit')),
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
  submission_outcome_json TEXT,
  -- 1 while Open refills a lost page: that run never sends.
  review_refill INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS applications_by_updated ON applications(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_by_state ON applications(state, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_queue ON applications(state, queued_at, id);

-- Sidebar instructions are rechecked before work and sending, never model text.
CREATE TABLE IF NOT EXISTS application_instructions (
  application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('prepare_only', 'confirm_before_submit', 'autonomous_submit'))
);

-- Large preparation details are read only for the selected application.
CREATE TABLE IF NOT EXISTS application_details (
  application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  resume_artifact_json TEXT NOT NULL,
  execution_json TEXT,
  review_json TEXT,
  authority_envelope_id TEXT,
  profile_digest TEXT NOT NULL,
  access_recheck INTEGER NOT NULL DEFAULT 0
);
-- 1: session changed; 2: watcher confirmed this page is not held by the person.
CREATE INDEX IF NOT EXISTS application_access_ready ON application_details(application_id) WHERE access_recheck=2;
CREATE TABLE IF NOT EXISTS application_origins (
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  PRIMARY KEY (application_id, origin)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS application_origins_by_site ON application_origins(origin, application_id);

CREATE TABLE IF NOT EXISTS needs_you (
  blocked_url TEXT,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'sign_in', 'captcha', 'mfa')),
  answer_key TEXT NOT NULL,
  country TEXT NOT NULL,
  site_origin TEXT NOT NULL,
  prompt TEXT NOT NULL,
  prompt_key TEXT NOT NULL DEFAULT '',
  reuse_prompt INTEGER NOT NULL DEFAULT 0,
  input TEXT NOT NULL CHECK (input IN ('text', 'boolean', 'choice', 'number', 'file')),
  options_json TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  answer TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS needs_you_open_key
  ON needs_you(kind, answer_key, country, site_origin) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS needs_you_site_access ON needs_you(site_origin,id)
  WHERE resolved_at IS NULL AND kind <> 'question';
CREATE INDEX IF NOT EXISTS needs_you_open ON needs_you(id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS needs_you_by_kind ON needs_you(kind, id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS needs_you_by_prompt ON needs_you(prompt_key,country,site_origin) WHERE kind='question' AND resolved_at IS NULL AND reuse_prompt=1;
CREATE TABLE IF NOT EXISTS needs_you_counts (kind TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
INSERT OR IGNORE INTO needs_you_counts (kind, n) VALUES ('question',0),('sign_in',0),('captcha',0),('mfa',0),('saved',0);
CREATE TRIGGER IF NOT EXISTS needs_you_count_insert AFTER INSERT ON needs_you WHEN NEW.resolved_at IS NULL BEGIN
  UPDATE needs_you_counts SET n = n + 1 WHERE kind = NEW.kind;
END;
CREATE TRIGGER IF NOT EXISTS needs_you_count_resolve AFTER UPDATE OF resolved_at ON needs_you
WHEN OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL BEGIN
  UPDATE needs_you_counts SET n = n - 1 WHERE kind = OLD.kind;
END;
CREATE TRIGGER IF NOT EXISTS needs_you_count_reopen AFTER UPDATE OF resolved_at ON needs_you
WHEN OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL BEGIN
  UPDATE needs_you_counts SET n = n + 1 WHERE kind = NEW.kind;
END;
CREATE TRIGGER IF NOT EXISTS needs_you_count_kind AFTER UPDATE OF kind ON needs_you
WHEN OLD.kind <> NEW.kind AND NEW.resolved_at IS NULL AND OLD.resolved_at IS NULL BEGIN
  UPDATE needs_you_counts SET n = n - 1 WHERE kind = OLD.kind;
  UPDATE needs_you_counts SET n = n + 1 WHERE kind = NEW.kind;
END;
CREATE TRIGGER IF NOT EXISTS needs_you_count_delete AFTER DELETE ON needs_you WHEN OLD.resolved_at IS NULL BEGIN
  UPDATE needs_you_counts SET n = n - 1 WHERE kind = OLD.kind;
END;
CREATE TABLE IF NOT EXISTS needs_you_drafts (
  task_id INTEGER PRIMARY KEY REFERENCES needs_you(id) ON DELETE CASCADE,
  answer TEXT NOT NULL, remember INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS needs_you_text USING fts5(prompt, content='needs_you', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS needs_you_text_insert AFTER INSERT ON needs_you BEGIN
  INSERT INTO needs_you_text(rowid,prompt) VALUES(NEW.id,NEW.prompt);
END;
CREATE TRIGGER IF NOT EXISTS needs_you_text_delete AFTER DELETE ON needs_you BEGIN
  INSERT INTO needs_you_text(needs_you_text,rowid,prompt) VALUES('delete',OLD.id,OLD.prompt);
END;
CREATE TRIGGER IF NOT EXISTS needs_you_text_update AFTER UPDATE OF prompt ON needs_you BEGIN
  INSERT INTO needs_you_text(needs_you_text,rowid,prompt) VALUES('delete',OLD.id,OLD.prompt);
  INSERT INTO needs_you_text(rowid,prompt) VALUES(NEW.id,NEW.prompt);
END;

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

-- The refill ends with its run; a restart that requeues it keeps it.
CREATE TRIGGER IF NOT EXISTS applications_review_refill_done AFTER UPDATE OF state ON applications
WHEN NEW.review_refill = 1 AND NEW.state NOT IN ('queued', 'running') BEGIN
  UPDATE applications SET review_refill = 0 WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS applications_approval_removed AFTER UPDATE OF stage ON jobs
WHEN OLD.stage = 'resume' AND NEW.stage NOT IN ('resume', 'applied') BEGIN
  UPDATE applications SET state = 'stopped', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE job_id = NEW.id AND state IN ('queued', 'running', 'needs_you', 'ready');
END;

-- Form answer memory belongs to Needs you, never Profile or a workspace blob.
CREATE TABLE IF NOT EXISTS form_answer_undo (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, items_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS form_answers (
  option_fallback_json TEXT,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_key TEXT NOT NULL,
  country TEXT NOT NULL,
  site_origin TEXT NOT NULL,
  prompt TEXT NOT NULL,
  prompt_key TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  label TEXT NOT NULL DEFAULT '',
  role_families_json TEXT NOT NULL DEFAULT '[]',
  proof_entry_ids_json TEXT NOT NULL DEFAULT '[]',
  needs_confirmation INTEGER NOT NULL DEFAULT 0,
  input TEXT NOT NULL,
  options_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (answer_key, country, site_origin)
);
CREATE INDEX IF NOT EXISTS form_answers_by_kind ON form_answers(kind,country,site_origin,updated_at DESC);
CREATE INDEX IF NOT EXISTS form_answers_by_prompt ON form_answers(prompt_key,country,site_origin,updated_at DESC);
CREATE TRIGGER IF NOT EXISTS form_answers_count_insert AFTER INSERT ON form_answers BEGIN
  UPDATE needs_you_counts SET n = n + 1 WHERE kind = 'saved';
END;
CREATE TRIGGER IF NOT EXISTS form_answers_count_delete AFTER DELETE ON form_answers BEGIN
  UPDATE needs_you_counts SET n = n - 1 WHERE kind = 'saved';
END;
CREATE VIRTUAL TABLE IF NOT EXISTS form_answers_text USING fts5(prompt, answer, content='form_answers', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS form_answers_text_insert AFTER INSERT ON form_answers BEGIN
  INSERT INTO form_answers_text(rowid,prompt,answer) VALUES(NEW.id,NEW.prompt,NEW.answer);
END;
CREATE TRIGGER IF NOT EXISTS form_answers_text_delete AFTER DELETE ON form_answers BEGIN
  INSERT INTO form_answers_text(form_answers_text,rowid,prompt,answer) VALUES('delete',OLD.id,OLD.prompt,OLD.answer);
END;
CREATE TRIGGER IF NOT EXISTS form_answers_text_update AFTER UPDATE OF prompt,answer ON form_answers BEGIN
  INSERT INTO form_answers_text(form_answers_text,rowid,prompt,answer) VALUES('delete',OLD.id,OLD.prompt,OLD.answer);
  INSERT INTO form_answers_text(rowid,prompt,answer) VALUES(NEW.id,NEW.prompt,NEW.answer);
END;
`;
