# ADR 0031: A rate-limited listing read waits only as long as the site asked

Status: partly superseded: search HTTP reads use host-scoped Retry-After pauses and up to three retries (b2338ff9), replacing the two-retry, 40-total, 90-second pass limits and 30-second deferral rule. Server-requested backoff remains.

## Context

ADR 0016 retries a failed listing read once an hour. HTTP 429 later gained its own `Retry-After` time, but the hour still applied on top of it, and one pass allowed a single retry for all pages together. A board that asked for a two-second pause kept its listings unread for more than an hour, and the job pane described the 429 as a sign-in wall.

## Decision

- A 429 read is due again as soon as the site's own `Retry-After` time has passed. The hour-long back-off stays for failures that name no time.
- Within one pass, each rate-limited page is asked again up to two times after the shared pause, with at most 40 such retries and 90 seconds of waiting per pass. A rate-limited job counts as still to read on the next search, not as a page that gave nothing. A pause longer than 30 seconds defers the rest of the queue to the next search.
- The job pane says the site asked Job Finder to slow down and that the listing is read on the next search. The sign-in wording is kept for 401 and 403.
