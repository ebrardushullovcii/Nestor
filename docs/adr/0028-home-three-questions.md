# ADR 0028: Home answers three questions, and the person's files live in Profile

Status: partly superseded: Home is a job-store dashboard with charts and several next steps (424992b9), replacing the single-card layout, workspace task model and batch controls. Counts still come from their stores and files remain under Profile.

## Context

Home had grown into a dashboard nobody read: a source-health badge row, four stat tiles that repeated the sidebar badges, a "Recommended next" card, a second search box under the header's own search, a "Results so far" pane, a "Background work" pane, and a Notifications panel that said "Nothing here yet" on almost every visit. Walked through every state a person passes (fresh, setup half done, first search running, results in, shortlisted, resumes written, applying, done, failed), the recommended action was wrong or stale in most of them: it still said "Run your first search" while that search ran, "Review 3 shortlisted jobs" after their resumes were written, "3 applications are ready for approval" while they were still being filled in, and "Find jobs" after a search had just filled Find jobs with ten results. Resume writing never showed up at all. The "Results" tile counted ten jobs beside a Find jobs page that listed nine.

Documents was a destination of its own, under a "Workspace" group with Settings, with three pickers per file (type, consent scope, retention), a confirm dialog before Trash, and a restore-retention picker. Every file imported there was imported in order to be attached to an application, and nobody opened the page on their own.

## Decision

- Home answers exactly three questions. What is going on: one sentence under the title (the running work, or the last search and its counts, or the setup gap). What to do next: one card, one primary action, and the action completes the step in place when it can (Search now runs the search, Create N resumes writes them, Apply to all N starts the batch, Try again retries the failed ones); otherwise it opens the one page where the step happens. Where you are: three tiles, Find jobs / Shortlisted / Applications, whose numbers are the sidebar's own count owners, each with a one-line breakdown the badge cannot carry ("2 need a resume · 1 ready to apply", "1 ready to send · 2 applied").
- The next step is chosen in one fixed order by a pure model (`job-search-home-model.ts`): unfinished setup, no enabled source, Needs you, applications ready to send, applications to try again, resumes to review, ready jobs to apply to, missing resumes, then the search loop (first search; look through results; nothing found; search failed or stopped early; all caught up, search again). While a search, resume run, or application run is in flight and nothing else is waiting, the card says so and offers the page to watch.
- Work in flight lists under "Happening now" from the same task model the header's Tasks popover reads, each row with Stop and the page it belongs to. The global pause lives there too, and Resume replaces it in the header while paused. A failing enabled source, or a search outcome that needs the person, is one line with its one fix.
- Pausing an application batch from Home lets the current application reach a safe checkpoint and holds the remaining, untouched jobs. Resume continues the same batch, including after an app restart. Prepared pages without a supported saved snapshot become a clear retry after a cold restart; supported snapshots can be refilled without AI or sending (ADR 0055). Work that may have submitted is never replayed.
- Removed from Home: the source-health badge row, the second search box (the header has one), Background work (Happening now has it), and the standing Notifications panel.
- Find jobs' badge, tile, and page count the same population: the rows Find jobs lists by default, without the weaker matches behind "Show weaker matches". The tile names the hidden count.
- The person's files are a Profile tab, "Files", not a destination. Adding a file asks one thing, what it is; it is always attachable and kept until removed. Remove is one press with no dialog, and the file sits in a "Removed" list on the same tab for seven days with Restore. `/job-finder/documents` redirects there. The consent-scope and retention contract fields remain, with those values as defaults, so the main-process loader, lifecycle, and purge behaviour are unchanged.

## Consequences

- Home renders a model; every count on it comes from `destination-counts.ts`, `needs-you-count.ts`, the Shortlisted readiness predicates, and the Applications state resolver, so it can only disagree with a page by reading a different owner, which no longer happens.
- The dashboard's own `recommendedNextAction` is no longer rendered anywhere; the main-process summary still computes it for its other consumers.
- The Documents screen, its candidate-asset component, and their tests are deleted; `settings-candidate-assets.tsx` is replaced by `profile-files-tab.tsx`.

Rejected alternatives: keeping four tiles including Needs you (it is the header pill and, when non-zero, the next step); a "Today" or "Overview" name for the page (the sidebar noun is Home, and neither name describes a next step); putting files under Applications (they are about the person, added before any application exists, and Profile already holds the resume).

## Related Decisions

- ADR 0022, ADR 0026, ADR 0027

## Update (2026-10-01)

The owner wants permissions, not prohibitions: the person already chose to run automatic batches. They can review prepared applications in Applications when they want. Stall and safety guards remain, including final submission authority under ADR 0012 and ADR 0024.

## Update (2026-10-21)

Resumes to review now come before applications to try again and filled-in forms that closed. With 196 Aggressive resumes waiting, "Check 4 applications whose form closed" led Home, although reading the resumes is what lets the person apply. The review step's button opens the first resume in Resume Studio's review pass; a failed batch to retry stays one press beside it, and closed forms are a quiet line under the buttons.
