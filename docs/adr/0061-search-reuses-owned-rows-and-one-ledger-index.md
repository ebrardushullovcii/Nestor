# ADR 0061: Search reuses owned rows and one ledger index

Status: accepted (2026-10-24). Amends ADR 0046's validation of internal updates.

## Context

Search prepared every saved listing in workers before knowing which listings
needed work. That read full evidence from SQLite, copied it into messages and
hashed it again for the search. Working assessment views then spread lazy detail
properties into full records. The ledger maintained two equivalent identity
indexes, plus another eagerly warmed index for a possible future Hide action.
Typed checkpoint writes parsed and copied rows that had already crossed the
feed, model or IPC trust boundary.

## Decision

Remove the eager inventory worker lane. Existing feed workers still validate
external feed data. Assessments retain their existing fingerprints and verdict
policy. Read-only assessment views preserve detail getters. Comparing a working
row with its baseline skips a detail getter only when both descriptors name the
same getter, which represents the same immutable SQLite version.

One versioned ledger identity index serves both current lookups and concurrent
sources' captured baselines. Replacing an entry closes its old version; active
baseline readers retain that version until they release it. Do not eagerly
build a third ledger index after every checkpoint for a future feedback action.

Typed discovery updates and saved-job deltas trust their domain values. Decode
stored JSON without another schema walk in these paths. Migrations, imports,
external feed/model results and renderer IPC retain validation. ID-preservation
checks, atomic transactions, immutable borrowed rows, and rollback remain.
Canonical export/import and the other repository readers retain their existing
contracts. A changed discovery row is serialized once for storage; unchanged
rows retain their identities.

Keep complete activity, source accounting, checkpoints used for restart, and
run reports: the Activity screen and search decisions read them. No history
pruning or new process is part of this decision. Sources, plans and query-column
normalization remain a separate storage change.

## Verification

The acceptance budget is milliseconds of bookkeeping per batch and no main
block over 100 ms, with main heap below 800 MB. Sample batch timings through
`nestor.discovery.bookkeeping` distinguish triage, merge and repository commits
from external waits. Fixed-feed replay checks kept jobs and verdicts; progress,
Stop, Pause, progressive judging, deduplication, repeat runs and search breadth
remain required behavior checks. Removing work does not establish those budgets
without production measurements.
