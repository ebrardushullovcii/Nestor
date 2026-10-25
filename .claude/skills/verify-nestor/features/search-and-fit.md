# Search and fit

Find jobs runs a search over the enabled sources with the model as the browsing agent, saves what it finds locally, and shows each job with an overall fit percentage, a verdict ("Strong fit", "Original resume is credible", ...) and the main reason. The model judges fit (ADR 0041); a job's fit can change after the listing is read in full.

## Sub-features

- `search-run`: "Search now", "Stop search", progress text "Checking <source>. N of M sources done.", the notification "Search finished · N new jobs saved."
- `search-focus`: "Search focus (optional)" and "Prefer recent".
- `search-results`: list "Results" with checkboxes, "Find a job", "Filters", sort (Best match, Newest first, Company A to Z).
- `fit-verdict`: per job "Overall fit: N percent <verdict>" and a reason line; details panel "How this was scored".
- `fit-reassess`: "Read and assess listing" and the background "Assessing listing" after shortlisting ("your fit changed from 86% to 74%").
- `search-failure`: an alert explaining why a search stopped ("Live search needs AI ...").
- `job-actions`: "Shortlist job", "Not interested", "Open listing", "Copy link", "View <company> in Companies".

## How to get to it (user POV)

- "Finish setup and find jobs" at the end of setup (starts a search).
- Sidebar › Find jobs › "Search now".

## Driving it with verify-nestor

Preconditions: baseline, `up --ai live`, setup finished with a replica source.

- **Search.** `$V/drive click "Search now"` (or finish setup), then `$V/drive wait "Search now" 600 --role button` (it is replaced by "Stop search" while running). Measured: 40 s for `/board/` (10 jobs, 5 matched). Proof: `shot`, results with fit lines, `$V/db discovery_runs 1`, `$V/db saved_jobs 10`.
- **Fit.** `$V/drive see` and read each result's "Overall fit: N percent ..." text; click a result to open "Job details" with the reason and "How this was scored". With the sample resume and target "Frontend Engineer", the three Frontend jobs came out 85-86% "Strong fit" and full-stack jobs 75-78%.
- **Failure path.** On a deterministic instance, "Search now" shows the alert "Live search needs AI, which is not available right now." This proves the error state, not search.
- Whole flow: `journeys/job-finder-replica.mjs search` (after `setup`).

## Gotchas

- Deterministic AI cannot search (`AI client does not support tool calling`). Always `--ai live` for this feature.
- A search that "stopped before finishing" can still leave partial results; read the alert in the shot.
- Big boards (`/atlas/`, `/ripple/`, 300 jobs) take much longer; use `/board/` unless pagination is what you are proving.
