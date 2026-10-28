# ADR 0016: Listing bodies are prepared over plain HTTP during collection

Status: partly superseded by [ADR 0041](0041-the-model-reads-the-page.md): collection, full listing reads and merged-job fit now use the job-store pipeline (a1cdeb6b), replacing buffered read-ahead and the final scoring pass; source-generic HTTP reads remain.

## Context

Compact discovery (ADR 0013) stops at the target job count after reading listing cards: title, employer, link. It does not open each listing. A card carries none of what the product is for: the fit score checks requirements the card does not state, the "worth opening" band stays empty, and a tailored resume has nothing to be tailored toward. In a live search against a board, every one of fifteen retained jobs was "title match · not yet checked", and the AI draft for a shortlisted one had to fall back to the original wording because there was no listing text.

Opening every listing inside the managed browser during the scan would multiply run time and browser steps, and it is what the bounded agent was designed not to do.

A trial that read and judged listings during source collection reduced search time, but its fit bands differed more than repeated controls on identical inputs. The changed scheduling also changed fit batch composition. Read-ahead now prepares page facts without changing working jobs or their collection-time fit batches. The normal final pass applies the prepared facts after collection. With the shared fit rubric, an identical-input replay met the retained-job recommendation and band agreement gate against repeated controls.

## Decision

- While sources collect, Job Finder prepares listing-page facts for the person's picked or supplied older jobs within the existing older-job allowance. Whenever a source finishes, jobs already retained by the run, including checkpoints from other sources, can enter read-ahead. Ordinary older jobs wait for the final pass so they cannot spend the allowance before new jobs arrive. Reads start over plain HTTP from the main process. After collection, the final pass applies prepared facts only to a matching job id, listing URL and title, and reads the remaining selected pages before declaring completion. Preparing facts neither persists them nor changes fit scheduling. A stopped run discards its buffer. The same read runs once for a job when it is shortlisted, if the run left it unread.
- The reader is source-generic (ADR 0007). It reads the schema.org `JobPosting` record most job pages publish as JSON-LD, and falls back to the visible text of the page. It knows HTML, not boards.
- The body replaces the card's stand-in description; employer, location, pay, posting date and employment type fill only gaps or placeholders. The job is then re-scored by the same assessment session the run used, so "Search finished" means scored results.
- Every attempt is recorded on the job (`listingDetailFetch`: outcome, method, when) so the product can say "read", "wanted a sign-in", "no listing text" or "could not be reached" instead of "not captured", and so no page is re-read more than once a day (once an hour after a failure).
- Bounds are fixed in code: per-request timeout, capped concurrency and one shared count allowance for early and final reads, including sighting routes. A started read owns its slot; later higher-ranked arrivals do not displace it, and an identity change does not refund an unusable read. The final pass prioritizes unread jobs within the remaining allowance. Preparation and application share rate-limit pauses, retries and long-pause deferral (ADR 0031). A failed read never fails the run.
- The read happens only when the host hands the service a reader. The desktop composes the plain-HTTP reader in; tests and other hosts do not, so a fixture URL is never fetched for real.

## Consequences

- A scan-time "only cards were read" warning is removed from a target and from the run once any of its retained jobs has a body.
- The AI draft is never asked to tailor toward a card-only posting; that case is recorded as `listing_text_missing` and keeps the original wording with a plain explanation, not a model failure.
- A first tailored draft gets the extraction timeout (120 seconds), not the generic 60, and long listings are compacted for the model with requirement paragraphs kept and boilerplate dropped first.
- Pages behind a sign-in still read as cards; the managed browser session is not used for reading, by design.
