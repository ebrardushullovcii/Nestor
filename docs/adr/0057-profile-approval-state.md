# ADR 0057: Profile saves change resume approval state without rewriting bodies

Status: accepted (2026-10-23).

## Decision

Store bulk resume invalidation in `resume_draft_approval_state`, keyed by draft id. It owns only the stale reason and timestamp; its presence means stale status and cleared approval fields. `tailored_asset_file_state` similarly records the invalidated asset's file path and timestamp. The original document bodies remain intact. A full document write or deletion removes its separate state in the same SQLite operation.

Canonical repository reads, export, recovery and ordering compose this state with the full draft. Display reads share the already validated, frozen body and replace only the approval fields. The unchanged body's validation mark remains valid. An explicit profile save commits its profile, optional search preferences and affected approval state atomically, including export and tailored-file invalidation. Submitted drafts remain protected.

Source-only edits do not launch job reassessment when the assessment inputs are identical. Required reassessment starts on a later event-loop turn and processes bounded slices; canonical reads continue to wait for it.

## Reason

The owner's 200 drafts contained about 140 MB of JSON. A profile save rewrote that body data merely to change approval fields, then parsed and validated it again for display. Separate approval state removes that work while preserving complete canonical documents and an atomic save. Existing workspaces gain an empty state table; no document migration or truncation is needed.
