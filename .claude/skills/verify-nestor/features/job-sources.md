# Job sources

Job Finder searches only the sites the person adds: an employer's careers page or a job board they already use. A site added is turned on for search straight away; each row can be turned off, edited or found by search. Sources are source-generic by design (ADR 0007): no per-board logic, so any replica board is a fair stand-in for a real one.

## Sub-features

- `sources-add-setup`: Guided setup › Job targets › "Job sources": "Source name (optional)", "Careers or job-board URL", "Add and turn on", "Done adding".
- `sources-add-profile`: Profile › Job sources: a textarea labelled ADD SOURCES plus "Add N sources" (several at once).
- `sources-toggle`: checkbox "Include <name> in searches" per row.
- `sources-edit`: "Edit <name>" per row.
- `sources-find`: searchbox "Find a source" once there are sources.
- `sources-sign-in`: sites that need a sign-in prompt for it (`ui:source-sign-in-prompts` covers the screens).

## How to get to it (user POV)

- During setup, the Job targets step.
- Later, Profile › Job sources.
- Find jobs › "Roles, places & sources".

## Driving it with verify-nestor

Preconditions: baseline. Use only this instance's replica URLs (`sites` in journeys, or the URL `up` printed).

- **Add in setup.** `$V/drive fill "Source name (optional)" "Replica board"`, `$V/drive fill "Careers or job-board URL" "<sites>/board/"`, `$V/drive click "Add and turn on"`, `$V/drive wait "/^Added Replica board/"`. Proof: a row "Replica board" with "127.0.0.1:<port>/board" and a checked "Include Replica board in searches".
- **Several boards.** Add `/lever/`, `/greenhouse/` and so on the same way; each new site in `test-fixtures/job-sites/README.md` exercises a different listing shape (pagination, load more, filters, 429s, iframes).
- **Toggle.** `$V/drive click "Include Replica board in searches" --role checkbox`, then search: the source is skipped.
- **Profile › Job sources** has not been run through this skill yet: open Profile, read `drive see` for the section, add with the textarea and "Add N sources", then search.

## Gotchas

- `--net replica` (default) refuses every non-loopback request from the app, so a real board added as a source fails to load. Use `--net web` only for read-only checks of a real board, and never apply there.
- The replica sites' job dates are relative to the server's start day, and job identities are fixed by seed, so results are stable across runs.
- A source URL must be a full http(s) address; "Add and turn on" stays disabled otherwise.
