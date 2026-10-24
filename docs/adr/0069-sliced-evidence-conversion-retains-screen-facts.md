# ADR 0069: Convert evidence in slices and retain screen facts

Status: accepted (2026-10-24).

## Decision

The temporary startup worker still releases header and inventory reads before
evidence conversion. Saved-job conversion now commits sets of 50 jobs. Resume
conversion commits four drafts or one historical revision at a time. The worker
yields between these transactions. The canonical service continues to wait for
conversion; bounded screen queries have no dependency on that service.

Each committed row has either its complete original representation or its
complete relational representation. Existing canonical decoders support both.
Conversion rereads current rows in its transaction, skips jobs already converted
by a typed write, verifies reconstructed facts and counts, and records the
migration version only after every slice completes. A restart resumes safely
without changing IDs, citations, verdicts, approvals or historical snapshots.
Resume citation conversion preserves pending approval overlays.

The whole async batch shares one consistent pre-conversion backup, including
across event-loop yields. Existing backup filenames and recovery remain intact.

Saved-job conversion retains the scalar index prepared for the window: changing
storage does not change screen facts. It suspends the relevant index writers
only inside each conversion transaction and restores them before commit. Normal
typed writes and the durable change feed remain active afterward. An actual
index rebuild suspends its row-level activity/sort triggers and advances each
revision once for the complete committed rebuild.

This replaces ADR 0065's second index rebuild during evidence conversion. It
adds no canonical cache, second database, renderer setting or new stored shape.
