# ADR 0052: Nestor rebrand

Status: accepted (2026-10-17). Changes the product name set by ADR 0040; ADR 0040's data-migration rules still apply.

## Context

The owner renamed the product from Nordri to Nestor, after the wise old counselor in Homer's Iliad: the app is a calm advisor next to the person while they look for work. The modules keep their names, Job Finder and Live Assistant.

As in ADR 0040, several identifiers that carried the old name are also where existing data lives: Electron derives the default user-data directory from the app name, renderer preferences sit under `nordri.`-prefixed storage keys, the embedded browser keeps its sign-ins in a named persistent partition, and release evidence manifests record their kind.

## Decision

- **One name everywhere current.** Packages are `@nestor/*`, environment variables are `NESTOR_*`, the preload bridge is `window.nestor`, the app id is `com.nestor.desktop`, the embedded browser partition is `persist:nestor-browser`, and the product and wordmark read Nestor. The mark (a bold O holding three stones) and the app icon stay as they were; the wordmark uses that mark as its O. The GitHub repositories are `ebrardushullovcii/Nestor` and `ebrardushullovcii/nestor-marketing`, and the website is https://trynestor.netlify.app (`nestor.netlify.app` belongs to someone else). Earlier ADRs use the new name; their decisions are unchanged.
- **Existing data moves once, never merges, newest name first.** At startup main moves the newest pre-rename user-data directory that exists (`@nordri/desktop`, then `@unemployed/desktop` in development; `Nordri`, then `UnEmployed` packaged) to the new one, under ADR 0040's rules: only at the default, name-derived location and never into a directory that already holds data. Inside it, the embedded browser partition `nordri-browser`, or else the older `unemployed-browser`, becomes `nestor-browser`.
- **Old keys are read, then retired.** The renderer copies `nordri.*` and then `unemployed.*` storage keys to `nestor.*` once, without overwriting newer values. The evidence collector accepts the `nordri-` and `unemployed-` manifest kinds.
- **History stays as recorded.** Dated records under `docs/audits/` and ADR 0040 keep the names they were written with.

## Consequences

Legacy strings remain only in the migration code, its tests, ADR 0040, this ADR and `docs/audits/`. Local `.env` files and shell profiles that still set `NORDRI_*` variables are ignored until renamed. The old website address https://nordri.netlify.app stops working when the Netlify site is renamed. Product videos and website screenshots captured before the rename still show the old wordmark until they are re-recorded.
