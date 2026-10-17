# ADR 0046: Discovery history is stored as rows

Status: accepted (2026-10-13)

## Context

Discovery kept active state, recent runs, activity, browser checkpoints, pending jobs, and the listing ledger in one SQLite JSON value. A search with thousands of listings made that value tens of megabytes. Every checkpoint parsed, copied, validated, and rewrote the whole history, including records that had not changed. Display reads also brought checkpoint payloads into JavaScript to remove them afterward.

## Decision

- Keep only small session, run status, and source-debug state in the discovery singleton. Store runs, target executions, activity, checkpoints, ledger entries, and pending jobs as indexed SQLite rows. The repository still exposes one complete `JobFinderDiscoveryState` for canonical reads, export, reset, and recovery.
- Migrate the existing singleton inside one SQLite transaction. Preserve historical runs, ledger order, pending jobs, and checkpoints. Reset and import replace all discovery rows inside their existing workspace transaction.
- Ordinary discovery updaters borrow frozen canonical rows. They return new rows for changes and reuse untouched rows. The repository validates and writes changed rows inside the same immediate transaction as any saved-job delta. Caller-owned mutable copies come from `getDiscoveryState`.
- Display reads never select checkpoint rows. Reuse unchanged validated display rows until a local trigger or another database connection changes them. Transaction reads are not cached across rollback.

## Consequences

Checkpoint cost follows the records changed rather than the size of previous search history. The repository retains one frozen canonical view for transaction updaters and rebuilds it after an external connection changes the database. Changing a borrowed row in place fails; callers must construct a new row. Whole-workspace import, export, and reset still process the complete state by design.
