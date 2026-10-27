/**
 * The Applications tracker, beside Apply's `applications` table: where each
 * application stands after it is sent, its replies, interviews, reminders,
 * notes and tags. Apply's table keeps the work state; triggers here only add
 * a tracker row when Apply queues a job and mark it applied when it is sent.
 */
export const TRACKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS tracker (
  job_id INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'applying', 'applied', 'replied', 'assessment', 'interview', 'offer',
    'rejected', 'withdrawn', 'no_reply'
  )),
  status_at INTEGER NOT NULL,
  status_change_id TEXT,
  applied_at INTEGER,
  -- The soonest open interview or reminder, kept by the event triggers.
  next_at INTEGER,
  next_title TEXT
);
CREATE INDEX IF NOT EXISTS tracker_by_status ON tracker (status, status_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS tracker_by_recent ON tracker (status_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS tracker_by_applied ON tracker (applied_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS tracker_by_next ON tracker (next_at, job_id) WHERE next_at IS NOT NULL;
-- The Applied and Next sorts order by these exact expressions (tracker.ts),
-- so a page reads them in index order instead of sorting every row.
CREATE INDEX IF NOT EXISTS tracker_by_applied_order ON tracker (COALESCE(applied_at, 0) DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS tracker_by_next_order ON tracker (COALESCE(next_at, 9007199254740991), job_id);
CREATE INDEX IF NOT EXISTS tracker_by_status_applied ON tracker (status, COALESCE(applied_at, 0) DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS tracker_by_status_next ON tracker (status, COALESCE(next_at, 9007199254740991), job_id);

CREATE TABLE IF NOT EXISTS tracker_counts (
  status TEXT PRIMARY KEY,
  n INTEGER NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO tracker_counts (status, n) VALUES
  ('applying', 0), ('applied', 0), ('replied', 0), ('assessment', 0),
  ('interview', 0), ('offer', 0), ('rejected', 0), ('withdrawn', 0), ('no_reply', 0);
CREATE TRIGGER IF NOT EXISTS tracker_count_insert AFTER INSERT ON tracker BEGIN
  UPDATE tracker_counts SET n = n + 1 WHERE status = NEW.status;
END;
CREATE TRIGGER IF NOT EXISTS tracker_count_delete AFTER DELETE ON tracker BEGIN
  UPDATE tracker_counts SET n = n - 1 WHERE status = OLD.status;
END;
CREATE TRIGGER IF NOT EXISTS tracker_count_status AFTER UPDATE OF status ON tracker
WHEN OLD.status <> NEW.status BEGIN
  UPDATE tracker_counts SET n = n - 1 WHERE status = OLD.status;
  UPDATE tracker_counts SET n = n + 1 WHERE status = NEW.status;
END;

-- Replies, interviews, reminders, notes, and each status change.
CREATE TABLE IF NOT EXISTS tracker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('status', 'reply', 'interview', 'reminder', 'note')),
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  due_at INTEGER,
  done_at INTEGER,
  place TEXT
);
CREATE INDEX IF NOT EXISTS tracker_events_by_job ON tracker_events (job_id, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tracker_agenda ON tracker_events (due_at, id) WHERE due_at IS NOT NULL AND done_at IS NULL;
CREATE INDEX IF NOT EXISTS tracker_events_open ON tracker_events (job_id, due_at)
  WHERE due_at IS NOT NULL AND done_at IS NULL;
-- Interviews and replies by day, for Home's charts.
CREATE INDEX IF NOT EXISTS tracker_events_by_kind ON tracker_events (kind, at);
-- Open interviews and reminders by when they are due, for Home's Coming up.
CREATE INDEX IF NOT EXISTS tracker_events_due ON tracker_events (kind, due_at)
  WHERE due_at IS NOT NULL AND done_at IS NULL;

CREATE TABLE IF NOT EXISTS tracker_tags (
  tag TEXT NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  PRIMARY KEY (tag, job_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tracker_tags_by_job ON tracker_tags (job_id, tag);

-- Individual tracker changes Undo can put back without overwriting later edits.
CREATE TABLE IF NOT EXISTS tracker_undo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  items_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracker_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  filter_json TEXT NOT NULL,
  sort TEXT NOT NULL
);

-- Apply queued the job: it is being applied to.
CREATE TRIGGER IF NOT EXISTS tracker_on_queue AFTER INSERT ON applications BEGIN
  INSERT OR IGNORE INTO tracker (job_id, status, status_at)
  VALUES (NEW.job_id, 'applying', NEW.queued_at);
END;
-- Apply sent it: the application is out and the job leaves Shortlisted.
CREATE TRIGGER IF NOT EXISTS tracker_on_submit AFTER UPDATE OF state ON applications
WHEN NEW.state = 'submitted' AND OLD.state <> 'submitted' BEGIN
  INSERT OR IGNORE INTO tracker (job_id, status, status_at)
  VALUES (NEW.job_id, 'applying', NEW.updated_at);
  UPDATE tracker SET status = 'applied', status_at = COALESCE(NEW.submitted_at, NEW.updated_at),
    applied_at = COALESCE(NEW.submitted_at, NEW.updated_at)
  WHERE job_id = NEW.job_id AND status = 'applying';
  UPDATE jobs SET stage = 'applied', stage_at = COALESCE(NEW.submitted_at, NEW.updated_at)
  WHERE id = NEW.job_id AND stage <> 'applied';
END;

-- The soonest open interview or reminder, so lists sort and Home counts by it.
CREATE TRIGGER IF NOT EXISTS tracker_next_insert AFTER INSERT ON tracker_events
WHEN NEW.due_at IS NOT NULL BEGIN
  UPDATE tracker SET (next_at, next_title) = (
    SELECT due_at, title FROM tracker_events
    WHERE job_id = NEW.job_id AND due_at IS NOT NULL AND done_at IS NULL
    ORDER BY due_at, id LIMIT 1
  ) WHERE job_id = NEW.job_id;
END;
CREATE TRIGGER IF NOT EXISTS tracker_next_update AFTER UPDATE OF due_at, done_at, title ON tracker_events BEGIN
  UPDATE tracker SET (next_at, next_title) = (
    SELECT due_at, title FROM tracker_events
    WHERE job_id = NEW.job_id AND due_at IS NOT NULL AND done_at IS NULL
    ORDER BY due_at, id LIMIT 1
  ) WHERE job_id = NEW.job_id;
END;
CREATE TRIGGER IF NOT EXISTS tracker_next_delete AFTER DELETE ON tracker_events
WHEN OLD.due_at IS NOT NULL BEGIN
  UPDATE tracker SET (next_at, next_title) = (
    SELECT due_at, title FROM tracker_events
    WHERE job_id = OLD.job_id AND due_at IS NOT NULL AND done_at IS NULL
    ORDER BY due_at, id LIMIT 1
  ) WHERE job_id = OLD.job_id;
END;
`;
