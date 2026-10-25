# ADR 0075: Find jobs reads its page from queries; searches follow the change feed

Status: accepted (2026-10-24). Builds on [ADR 0060](0060-indexed-workspace-queries-and-a-durable-change-feed.md) and [ADR 0068](0068-discovery-commands-return-run-facts.md).

## Context

During a search every progress event made the window sync the whole
workspace. On a 6,000-job workspace a replica search sent 274 syncs that cost
main 74 s in total (one took 15.8 s), held main's loop for up to 4.6 s and left
J/K at 70 ms p95 and 478 ms worst. Find jobs derived its list (bands, order,
filters, facets, pages) from every saved job in renderer memory, so each
shortlist or hide also re-derived the whole list. The query read model
(ADR 0060) now matches that list exactly on both owner-data copies.

## Decision

- Find jobs asks `queryJobList` for the page it shows: filters, search, order
  and page are the request; rows, total, facets, counts, the band outline and
  the ordered ids come back in one SQLite transaction. The open job is read by
  id. Row wording is computed from the row's own columns (`presentFitFacts`,
  `getDiscoveryRowView`), the same wording the inspector uses.
- The ordered ids (a few hundred KB at most) cover what a page cannot: select
  all, the selected job's page, J/K and triage across pages, and the
  Assistant's filtered list. Band dividers count whole runs from the outline.
- The page refetches from the change feed: at once for the person's own
  changes, at most once a second while a search writes jobs. During a search
  the rows already shown keep their places and new jobs join the end of the
  page; the ranked order applies once the search ends. The decided open job
  stays in its place until another job opens.
- Main announces only a search's first event to windows. While a search runs,
  the workspace snapshot syncs only where a screen still shows the search from
  it (Home for jobs, at most every 1.5 s; Find jobs and Profile
  for progress, at most every 4 s) and for other work (resumes, applications).
  Elsewhere the sidebar badges come from `getListCounts`.

## Consequences

Find jobs no longer reads `discoveryJobs`. Other screens still do, so the
snapshot keeps them until they move; the `NESTOR_QUERY_LISTS` seam stays off.
Hidden jobs, Home and the shell badges outside a search still use the
snapshot.
