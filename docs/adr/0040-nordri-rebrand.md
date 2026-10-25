# ADR 0040: Nordri rebrand

Status: accepted (2026-09-29). Product name changed by [ADR 0052](0052-nestor-rebrand.md): Nordri is now Nestor; the data-migration rules here still apply.

## Context

The product was called UnEmployed, which does not market well, and its second module was called Interview Helper. The owner renamed the product to Nordri (in Norse myth, the dwarf who holds up the northern corner of the sky: the app helps a person find their north) and the module to Live Assistant.

Several identifiers that carried the old names are also where existing data lives: Electron derives the default user-data directory from the app name, renderer preferences sit under `unemployed.`-prefixed storage keys, the Live Assistant workspace file stores its module name, and release evidence manifests record their kind and are digested.

## Decision

- **One name everywhere current.** Packages are `@nordri/*`, environment variables are `NORDRI_*`, the preload bridge is `window.nordri`, the app id is `com.nordri.desktop`, the product and wordmark read Nordri, and the module, its package, routes, IPC channels and files are Live Assistant / `live-assistant`. Earlier ADRs use the new names; their decisions are unchanged.
- **Existing data moves once, never merges.** At startup, before the single-instance lock, main moves the pre-rename user-data directory (`@unemployed/desktop` in development, `UnEmployed` packaged) to the new one when the new one is missing or empty, and renames `interview-helper-workspace.json` and `interview-helper-screenshots`. It runs only at the default, name-derived location, so an overridden directory (`NORDRI_USER_DATA_DIR`, `--user-data-dir`) never adopts the real workspace, and it never merges into a directory that already holds data.
- **Old keys are read, then retired.** The renderer copies `unemployed.*` storage keys to `nordri.*` once without overwriting newer values; the Live Assistant repository reads a saved `module: "interview-helper"` as `live-assistant`; the evidence collector accepts the old manifest kind.

## Consequences

Legacy strings remain only in the migration code, its tests, and the ADR. Shell profiles or local `.env` files that still set `UNEMPLOYED_*` variables are ignored until renamed. The migration code can be removed once no pre-rename workspace is expected.
