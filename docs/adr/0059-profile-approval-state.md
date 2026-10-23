# ADR 0059: Profile saves defer resume body writes

Status: accepted (2026-10-23).

## Decision

Store bulk resume invalidation in `resume_draft_approval_state`, keyed by draft id. It owns only the stale reason and timestamp; its presence means stale status and cleared approval fields. `tailored_asset_file_state` similarly marks an asset's file path as cleared at its saved timestamp. A full document write or deletion removes its separate state in the same SQLite operation.

Canonical repository reads, export, recovery and ordering compose this state with the full draft. Display reads share the already validated, frozen body and replace only the approval fields. The unchanged body's validation mark remains valid. An explicit profile save commits its profile, optional search preferences and affected approval state atomically, including export and tailored-file invalidation. Submitted drafts remain protected.

Immediately after saving, background work folds the state into the original JSON bodies, one row per event-loop turn. Each row and its state deletion commit together. Cached display bodies keep their nested data when only these known metadata fields change; a concurrent or external body edit still takes the normal validation path. Startup finishes interrupted folds before publishing repository reads; graceful close drains pending folds before backup and close.

Older builds read the original bodies. They see the correct stale reasons and cleared approval/file fields once folding finishes or after graceful quit. A forced kill before folding finishes leaves a short downgrade window: an older build can still read approval fields from the remaining unfurled bodies, although export records were invalidated atomically. Starting this build again completes the pending work. This is a compatibility limit of deferring those writes, not a safety guarantee for immediate downgrade after a crash.

Source-only edits do not launch job reassessment when the assessment inputs are identical. Required reassessment starts on a later event-loop turn and processes bounded slices; canonical reads continue to wait for it.

## Reason

The owner's 200 drafts contained about 140 MB of JSON. A profile save rewrote that body data merely to change approval fields, then parsed and validated it again for display. Separate approval state removes that work from the save while preserving complete canonical documents and an atomic commit. Bounded folding performs the body writes afterward for older readers. Existing workspaces gain an empty state table; no document migration or truncation is needed.
