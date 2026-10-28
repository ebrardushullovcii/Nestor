# ADR 0032: Search settings change what a search keeps

Status: partly superseded by [ADR 0041](0041-the-model-reads-the-page.md): pickiness filters displayed fit scores rather than discarding related listings, and search plans are retired (a1cdeb6b, 242cc067). The saved remote-location preference still affects fit.

## Context

ADR 0025 put "How picky a search is" and "Count remote jobs as any location" in Settings. A built-app check ran the same search under all six combinations and got the same ten jobs, the same scores and the same list every time. Only the search agent's instructions changed, and a card scan saves every card whatever the instructions say. Best matches only did skip two jobs, but a low-yield rescue put them back because fewer than six had passed.

## Decision

- Best matches only drops every job whose title, place, or work mode misses the saved preferences, as the Settings copy says. The low-yield rescue is removed. In the other two modes the triage skips only closed listings, talent pools, sign-in pages and excluded places, and none of those should come back.
- Cast a wide net opens Find jobs with the weaker matches shown, following the rule that picks the run's own mode: wide net runs broad, best matches runs precise, and the middle setting defers to the plan's mode.
- With "Count remote jobs as any location" off, a remote listing counts as a location match only when it names a saved place, or when the person saved "Remote" or "Worldwide" as a place. A remote region ("Remote, Europe") or the whole world no longer covers a saved city, and a remote work-mode preference no longer settles the place. On (the default) is unchanged. This applies in the strict triage and in scoring, so the setting changes both what Best matches only keeps and how the other modes rank.
- The remote setting stays stored only in `settings.aiBehavior`. The search and the shortlist listing read copy it into `searchPreferences.discovery.remoteCountsAsAnyLocation` when they load the preferences, and only an explicit off is written, so workspaces that never turned it off keep their score fingerprints.

## Consequences

- Best matches only can now save nothing from a source. That is the person's choice, and the run summary counts the skipped jobs.
- Turning the remote setting off rescores saved jobs on the next search, because the scoring context changes.
