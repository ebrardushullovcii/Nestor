# ADR 0016: Listing bodies are read over plain HTTP during the search

Status: accepted (2026-09-05); listing reads overlap source collection (2026-10-23).

## Context

Compact discovery (ADR 0013) stops at the target job count after reading listing cards: title, employer, link. It does not open each listing. A card carries none of what the product is for: the fit score checks requirements the card does not state, the "worth opening" band stays empty, and a tailored resume has nothing to be tailored toward. In a live search against a board, every one of fifteen retained jobs was "title match · not yet checked", and the AI draft for a shortlisted one had to fall back to the original wording because there was no listing text.

Opening every listing inside the managed browser during the scan would multiply run time and browser steps, and it is what the bounded agent was designed not to do.

## Decision

- As source checkpoints retain jobs, Job Finder reads their listing pages over plain HTTP from the main process: no browser, no session, no cookies. One bounded pass, up to eight reads at once, overlaps collection and shares rate-limit pauses across its pages. Completed reads join the fit queue immediately; a card awaiting its read does not also spend a fit call unless a retention rule needs its verdict first. The search waits for the reads and fit queue before finishing. The same read runs once for a job when it is shortlisted, if the run left it unread.
- The reader is source-generic (ADR 0007). It reads the schema.org `JobPosting` record most job pages publish as JSON-LD, and falls back to the visible text of the page. It knows HTML, not boards.
- The body replaces the card's stand-in description; employer, location, pay, posting date and employment type fill only gaps or placeholders. The job is then re-scored by the same assessment session the run used, so "Search finished" means scored results.
- Every attempt is recorded on the job (`listingDetailFetch`: outcome, method, when) so the product can say "read", "wanted a sign-in", "no listing text" or "could not be reached" instead of "not captured", and so no page is re-read more than once a day (once an hour after a failure).
- Bounds are fixed in code: per-request timeout, run-wide time budget, capped concurrency, capped count per run. A failed read never fails the run.
- The read happens only when the host hands the service a reader. The desktop composes the plain-HTTP reader in; tests and other hosts do not, so a fixture URL is never fetched for real.

## Consequences

- A scan-time "only cards were read" warning is removed from a target and from the run once any of its retained jobs has a body.
- The AI draft is never asked to tailor toward a card-only posting; that case is recorded as `listing_text_missing` and keeps the original wording with a plain explanation, not a model failure.
- A first tailored draft gets the extraction timeout (120 seconds), not the generic 60, and long listings are compacted for the model with requirement paragraphs kept and boilerplate dropped first.
- Pages behind a sign-in still read as cards; the managed browser session is not used for reading, by design.
