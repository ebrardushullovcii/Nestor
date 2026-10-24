# ADR 0069: Background database backups and generated export retention

Status: accepted (2026-10-24).

## Decision

Quit flushes pending writes and closes SQLite. It never starts a database
backup. A cancellable helper process uses SQLite's `VACUUM INTO` after migrations
and at most daily; an absent recovery point is created while the app is open.
The existing `.backup` and `.backup.prev` destinations and interrupted rotation
reconciliation remain the corruption recovery inputs. Quit and Reset stop the
process before closing or replacing the live database. A failed backup preserves
the completed recovery points and retries later.

Reset still takes a dedicated snapshot immediately before replacement. Successful
permanent deletion removes rotating, pre-reset, migration and quarantine copies.
An empty Reset also deletes unused normalized evidence and source versions.
These snapshots recover the database only, not deleted document directories.

Generated resume cleanup runs at workspace open and after successful exports.
It retains each resume's current export in each format, approved exports,
current tailored files and every export referenced by application history or a
prepared form, including references by export ID or checksum. History records
remain stored. Obsolete managed PDFs and HTML renders are removed; PDF printing
discards its temporary HTML. Explicit downloads outside the managed folder are
untouched. Pending renders, cover letters and filesystem links are preserved.
Page-count checks discard their unpersisted documents immediately.

Discovery Activity and source-debug evidence remain complete because screens
and decisions read them. Developer startup diagnostics are capped at 1 MiB.
Chromium's disk cache is capped at 64 MiB through its supported startup switch;
cookies and sign-in storage are separate.

## Consequences

A corruption restore can lose changes since the last daily recovery point,
instead of since the last clean quit. Normal hard-kill recovery still uses
SQLite's committed WAL. A short session can finish before its first backup;
closing it does not delay quit to create one. Existing recovery points remain
available throughout a refresh. Resume revision history can regenerate an old
resume; unused historical PDF files are no longer an archive.

The helper is a process because terminating a worker thread cannot interrupt
a native SQLite copy. `VACUUM INTO` excludes free pages left by migrations;
an online page backup would copy them too. The helper exists only during a
backup, with a hidden window and its own read connection.

This replaces the close-backup timing referenced by ADR 0053. ADR 0061 already
removed its saved startup view. There is no new user setting or maintenance task.
