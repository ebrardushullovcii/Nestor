# ADR 0060: Screens query columns and follow committed row changes

Status: accepted (2026-10-24).

## Decision

Job Finder list reads use a bounded repository query over indexed SQLite columns.
The list DTO is `WorkspaceJobListRow`, not an incomplete `SavedJob`. Listing text,
assessment evidence and other large fields are read by id only when opened.
Home and badge counts query stored facts without constructing a workspace.

The typed preload `jobFinder.queries` API uses ordinary IPC. A separate process is
not justified until measurements show that small queries still wait on main after
unnecessary work is removed. Input is validated at IPC; typed app-owned results
are trusted and are not schema-parsed on each read.

Persistent SQLite triggers maintain the query columns and append table, stable id,
operation and a monotonic revision to `workspace_changes` in the writer's own
transaction. Rollbacks also roll back changes. The feed contains no row bodies.
Readers use one SQLite transaction for page, total, counts and revision. Windows
receive committed identity batches and refetch mounted pages; the same cursor can
later support synchronization without implementing remote sync now.

## Why each piece exists

- The column read model makes page cost independent of listing-body size.
- The bounded query contract prevents a screen from requesting a whole inventory.
- The transactional feed keeps all existing write paths visible to readers.
- Plain IPC keeps transport and lifecycle code small.

The old workspace API remains available during screen migration. The main-process
`NESTOR_QUERY_LISTS=1` seam suppresses its three inventory arrays once those screens
use queries. This is an integration seam, not a product setting. Remove remaining
whole-projection caches and sync when their final consumers are moved.

ADRs 0046 and 0011 still govern canonical discovery and independent plan semantics.
Older builds need not open a migrated database; forward migrations require backup
and post-migration count checks.
