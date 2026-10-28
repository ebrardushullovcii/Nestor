# Search and fit

Find jobs collects listing cards over HTTP wherever possible and uses a separate bounded browser queue for sites that need it. Related listings are read in full, merged and scored. Relevant profile, goals or listing changes trigger bounded background fit checks, visible jobs first; contact edits keep scores. Results appear while other sites are still running. Repeat searches skip saved URLs and remembered unrelated cards before detail reads, while refreshing stale fit judgments.

## Sub-features

- Search: Quick/Thorough, Any fit/Good/Strong, Week/Month/Any time, an optional request and the enabled-site picker. All sites uses a compact selection; the picker reads pages of 25.
- Progress: completed sites, new jobs, scored jobs, HTTP/browser active and waiting counts, and sites needing the person. The app remains usable while searching.
- What each site found: paged site results, text/status filters, total listings, new jobs, saved hidden, new related, unrelated and already seen. A repeat can have many listings and zero new jobs.
- Fit: one stable score with role, preferences and coverage explanations. Work mode and other preference gaps affect fit; they do not discard reasonably related work.
- Conditional permits: the model compares stated hours, dates, permitted work and future sponsorship with each listing. Missing permission is uncertain; contradictory conditions are blocked.
- Numeric fit filters show assessed jobs only, with checking/re-checking status above the list. An empty fit-filtered list explains dominant limits and links to Profile work eligibility.
- Date retention: widening Week/Month/Any time restores only age-owned hides, clears their note, and keeps person hides and closed listings hidden.
- Closed listings: full text is retained, but explicit closure or an expired published deadline saves the vacancy Hidden with a Closed reason. Closed cards can also retire previously Found jobs without another detail read.
- Access: a gated site creates one source item in Needs you. Other sites continue. Opening it and Retry reruns that site; ordinary repeats leave the outstanding item alone.

## How to get to it (user POV)

- Finish setup and find jobs.
- Sidebar > Find jobs > choose search settings > Search.
- Open What each site found for source details; Hidden contains closed or age-filtered results and their reasons.

## Driving it with verify-nestor

Use a production build, an isolated live-AI instance and synthetic profile/replica sources. Import may be seeded when search is the feature under test; report that precondition.

- Search from the screen, navigate away and back while running, inspect jobs before completion, then inspect full descriptions and fit in the store.
- Repeat unchanged. Assert zero AI calls, zero detail reads, unchanged fit and listing totals consistent with the already-seen count. After changing eligibility, repeat with zero new jobs and verify refreshed scores, the checking status, and that phone edits preserve fit.
- Add sources in Profile while Find jobs remains mounted; return without restarting and check the picker count and its 25-row pages.
- With Priya's UX Researcher/Product Designer goals, Remote preference and UK authorization, search atlas/?q=designer and ripple/?q=designer with Thorough/Any fit/Any time. Their vacancy 291 must be Hidden with a Closed reason. Atlas vacancy 111 remains Found despite hybrid work in Manchester.
- For scale, the replica's `/__scale__/manifest` starts 900 mixed boards on twelve loopback hosts. Compare saved URLs with its independently enumerated expected Dev/Lina jobs; record first/repeat duration, actual provider tokens, peak process memory and source-detail reads. Check the picker and per-site result pages at this scale.

## Gotchas

- Deterministic AI cannot establish search or fit quality. Use live AI and keep checks modest.
- A successful local scale run proves these synthetic HTML/JSON-LD, JavaScript, gate and retry scenarios. It does not prove every real ATS or anti-bot service.
- Source access and application access share Needs you; only source items carry a source reference and use retry_need; application browser steps use check_need.
