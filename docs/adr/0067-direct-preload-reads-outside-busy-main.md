# ADR 0067: Read screens outside the main event loop

Status: superseded: job-store reads run through typed main-process commands; the utility reader, private MessagePort and startup migration worker were removed with the old workspace (145ad266).

After evidence conversion and inventory removal, a clean 12k launch still delayed
ready query replies by about 1.26 seconds while main opened its canonical service.
Warm bounded queries take about 20 ms. This satisfies ADR 0060's condition for
moving reads out of main; the service also continues to own search/apply work.

An Electron utility process owns one read-only SQLite connection. Main authorizes
the attached window's current main frame and transfers a MessagePort directly to
preload and the reader. Preload retains the port behind the existing typed query
API. No Node, Electron, SQL or port primitive reaches renderer code. The reader
validates requests, and the app trusts its typed query results. Writes and the
per-window legacy update-mode switch remain in main.

Context and inventory readiness remain separate. The temporary migration worker
releases each gate; canonical recovery still opens in main. Main's existing
commit notification wakes the reader, which sends durable change batches directly
to preload without a recurring poll. Queries and reply delivery then continue
while main is busy. A reader exit rejects pending queries; reload reconnects.
Shutdown awaits reader exit before the canonical writer checkpoints and records
its clean-close fingerprint.

A small bootstrap entry retains environment, user-data migration and single-
instance locking in their existing order. It starts the migration worker before
loading the application graph, so parsing main does not postpone database work.
It introduces no saved startup snapshot or second canonical database.

This supersedes the ordinary-main-IPC transport paragraphs of ADRs 0060 and 0065.
The bounded DTOs, transactional feed, canonical ownership and migration backup
requirements remain. Both owner-data copies opened in the built app. During
three deliberate one-second main-thread blocks per copy, page reads completed
inside each block: 7–9 ms on 6k and 24–27 ms on 12k. Invalid requests rejected.
These checks establish read independence, not the separate launch budget.
