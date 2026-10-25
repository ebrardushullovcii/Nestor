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

One compact identity-key index is built once per run and updated for changed
rows. Its keys retain today's exact identity logic: URLs, provider identifiers,
listing facts and the existing content digest. Each unique key points to a
numeric row token; only collisions allocate a set of tokens. Rich alias objects
and duplicate global alias caches are removed. Existing
intersection, cross-source compatibility and content collision checks still
decide matches. No database query or transaction is needed for an identity
lookup; no additional process is introduced.
Postings carry prepared text, compact keys and fingerprints in an internal
enumerable symbol slot. Ordinary copies carry it; JSON omits it. Feed workers
transfer explicit typed preparation and main attaches it to the created rows.
Exact input fields, including mutable arrays, invalidate preparation after a
material change. Only foreign frozen inputs need a weak fallback. There is no
text cache or URL peer cache. Read-path owns durable saved-job fingerprints.
Search stores preparation computed from legacy rows through one bounded batch
writer into that same fingerprint table. It checks transaction-current inputs;
the existing interned body hash proves unchanged text without loading it.
Normal later job writes recompute or delete preparation. No startup backfill
is required. Preparation changes invalidate the existing borrowed projection
so the next search receives those persisted facts even in the same app session.
Scoped borrowed updates read root fields and relations separately, loading all
required bodies in one indexed batch only when the updater or write uses them.
Prepared SQL statements belong to the connection, rather than to each job.

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
normalization remain a separate storage change. Migration 29 separates each
run's static header from its small changing progress column and stores source
health in individual rows. A progress update writes neither the target-id
list nor unchanged source health. The canonical reader reconstructs the same
run, with Activity and recovery checkpoints intact. A database backup precedes
the forward migration.

## Verification

Correctness checks cover kept jobs and verdicts, progress, Stop, Pause,
progressive judging, deduplication, repeat runs and search breadth. Runtime
`nestor.discovery.bookkeeping` telemetry remains available for investigation;
CI does not enforce wall-clock budgets or run scale acceptance tests.
