# ADR 0056: Resume autosaves share a history step

Status: accepted (2026-10-23).

## Decision

Resume Studio's consecutive autosaves share one revision while the same editor session keeps typing, with at most two minutes between meaningful saves. The revision retains the exact draft before the first save, its original id, timestamp and parent; its final hash and diff describe the latest saved draft. Restoring it returns to the start of that editing step and clears export approval as before.

A new studio visit, restart, explicit save, template or language change, approval, restore or AI mutation starts another step. A group is reused only while the current draft timestamp and content hash still match the last autosave and its revision is still the latest. Existing history is not regrouped or migrated; the newest 100 revisions remain the retention limit.

The repository atomically writes the draft, validation, asset and grouped revision. It checks the current draft timestamp and, for replacement, the latest revision's exact stored bytes. A failed check changes nothing. The first snapshot cannot be replaced while grouping.

Pure draft parsing, sanitization, validation, revision computation and preview HTML rendering run in a host worker. The worker owns no database or AI client. Main retains orchestration, authority, profile-revision checks and the asynchronous Electron PDF page-count step, while persistence remains behind the database repository.

## Reason

Autosaving every pause as a separate revision consumed the history limit during ordinary typing. Large draft validation and repeated schema reads also held Electron main for hundreds of milliseconds. Grouping keeps undo steps useful; the worker and bounded preparation between event-loop turns keep the editor responsive.
