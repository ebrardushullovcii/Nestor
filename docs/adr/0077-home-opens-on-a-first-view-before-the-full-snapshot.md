# ADR 0077: Home opens on a first view before the full snapshot

Status: accepted (2026-10-24). Builds on [ADR 0065](0065-screen-reads-before-evidence-conversion.md) and [ADR 0075](0075-find-jobs-reads-its-page-from-queries.md).

## Context

Home's counts paint from the database within about 1.5 s of launch
(ADR 0065), but its Next step, its problems and the tiles' detail lines waited
for the full workspace snapshot. On the 12,000-job copy a clean start built
that snapshot in main for about 7 s (most of it every saved job, the Find jobs
lists made from them and their transfer), so Home was complete only after
about 11 s. Home itself needs the shortlisted jobs, applications, documents
and search runs: a few hundred rows. Of the Find jobs lists it uses
two numbers, which the queries already give exactly.

## Decision

- After the bootstrap the window asks for Home's first view
  (`getWorkspaceHome`), then for the full snapshot. The first view is the
  same snapshot builder over only the jobs past Find jobs (every status but
  discovered and archived, plus any job an application points at), read by id
  through the read index. Its Find jobs lists are empty and marked deferred
  (`discovery_jobs`), so screens that need them keep their launch view.
- The first view writes nothing: no plan reconcile or progress, no company
  grouping, no stale-blocker repair, no fit re-binding. Those need every job
  and stay with the full snapshot. It shows the plan's stored progress.
- Home renders in full from it and takes "jobs to look through" and "weaker
  matches" from the launch queries (default list total, and all bands minus
  it), the numbers the lists give. Shortlisted and Applications open from it
  too, since their collections are complete.
- A press made before the full snapshot lands waits for it quietly and then
  runs; it fails with "still finishing its initial load" only if loading has
  not finished after two minutes. A press on a loaded workspace still reaches
  main in the same turn.
- A workspace with no plan yet (the first full snapshot creates it) gets no
  first view; the window waits for the full snapshot as before.

## Consequences

Home no longer waits for the Find jobs lists. The full snapshot still loads
behind it and replaces the first view with the same numbers and the same Next
step, so nothing moves or changes when it lands. Anything that reads Find jobs
rows from the workspace (Ctrl+K, the Hidden list) still waits for
it.
