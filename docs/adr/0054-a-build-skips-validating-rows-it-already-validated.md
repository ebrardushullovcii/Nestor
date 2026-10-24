# ADR 0054: A build skips validating rows it already validated

Status: accepted (2026-10-21).

Amended by [ADR 0061](0061-store-evidence-once-and-query-startup-facts.md): startup views and validation marks are removed; typed app-owned rows are trusted on read. Canonical storage is normalized without changing repository contracts.

Amended by [ADR 0057](0057-saved-job-details-stay-in-sqlite.md) on 2026-10-23: saved-job lists validate their facts first, with full unopened rows validated in background slices. The marking and invalidation rules below remain in force.

## Context

Every start read each saved job and resume draft through its schema. With 20,000 saved jobs that was about 3 s of main-process CPU before the workspace could answer, and the 27 large resume drafts of the owner's workspace (18 MB) cost about 0.3 s in one block on every start. Almost every row is stored exactly as the schema returns it, because the app writes what the schema produced.

## Decision

- Main computes a digest of its own build files, read off the main thread at start. Rows are marked with that digest.
- When a full read validates a saved job or a resume draft and the schema's output is exactly the stored JSON (same keys, same order, nothing JSON cannot hold), the row is marked as validated by this build. The read and the marks share one transaction, so a mark never covers text written after it was read.
- The next full read by the same build uses a marked row as stored. Any other build, a row without a mark, or a row whose output differs from its text goes through the schema as before.
- Marks live in the `row_validations` table. Persistent triggers on `saved_jobs` and `resume_drafts` delete a row's mark on any insert, update or delete, from any connection or build. If a trigger is missing when the workspace opens (a table was rebuilt), every mark of that table is dropped and the triggers are made again.
- Without a digest (tests, or a bundle that cannot be read) nothing is marked and every row is validated.

## Consequences

- A second start of the same build reads 20,000 saved jobs in about 3.5 s instead of 8 s; 6,284 in about 1.3 s instead of 2.7 s.
- The first start after an update validates as before, plus about 0.3 s at 20,000 jobs to compare and mark rows.
- A schema change takes effect on old rows because a new build has a new digest. A helper used inside a schema transform is covered the same way, since it is part of the build.
- The database gains one small table and six triggers that older builds carry along without using.

## Related Decisions

- ADR 0053 (the window opens on the last clean view), ADR 0046 (normalized discovery storage).
