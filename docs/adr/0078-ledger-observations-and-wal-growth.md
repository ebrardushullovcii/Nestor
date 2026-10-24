# ADR 0078: Ledger observations use columns and checkpoints follow WAL growth

Status: accepted (2026-10-24).

## Context

A daily search rewrote 43.9 MB of ledger JSON to change about 1 MB of field
values. Its WAL advanced by 365.5 MB. The checkpoint size cap also treated the
WAL's retained high-water file size as new growth, requesting 715 checkpoints
even though SQLite had recycled the log 487 times. These are attribution
observations, not timing acceptance measurements.

## Decision

Migration 30 keeps stable ledger evidence and order in `discovery_ledger`, and
stores `lastSeenAt`, `inactiveAt`, `titleTriageOutcome` and `listingScreen` in
`discovery_ledger_observations`. Timestamp-only sightings update the small table
without rewriting evidence. SQL NULL for the optional screen means absent;
JSON `null` remains an explicit null. Both tables commit and roll back together.
Canonical repository reads reconstruct the complete entry. Reset, import,
export, recovery, external full-row edits and display invalidation retain the
same fields and decisions. The conversion has an immutable pre-migration backup.

Urgent checkpoints follow WAL growth since the previous completed checkpoint,
not its retained file size. A repeated same-size request is skipped. Idle
checkpointing remains, and a log that keeps growing still triggers checkpoints.
The read-only hint uses SQLite's documented WAL-index committed-frame and
backfill counters, checks its duplicate headers, and resets across salt changes.
If that hint is unavailable, further file growth and the idle timer remain the
fallback. A reader that pins the log permits a retry per cap of new frames.
Checkpoint execution stays on the worker; the SQLite commit durability policy
and recovery authority do not change.

## Consequences

The storage layout needs a join for complete ledger reads. Activity and query
change tracking must observe the observation table too. Full evidence changes
still write the body; sighting frequency alone does not. Windowed replay and
exact canonical audits remain necessary before claiming a responsiveness gain.
