# ADR 0059: Profile saves reuse resume bodies and commit approval changes

Status: partly superseded: job-store profile changes invalidate resume approvals and PDFs directly in resume rows, replacing approval overlays and downgrade folds (145ad266). Fact writes and approval invalidation remain atomic, with submitted applications protected.

## Decision

Store bulk resume invalidation in `resume_draft_approval_state`, keyed by draft id. It owns only the stale reason and timestamp; its presence means stale status and cleared approval fields. `tailored_asset_file_state` similarly marks an asset's file path as cleared at its saved timestamp. A full document write or deletion removes its separate state in the same SQLite operation.

Canonical repository reads, export, recovery and ordering compose this state with the full draft. Display reads share the already validated, frozen body and replace only the approval fields. The unchanged body's validation mark remains valid. An explicit profile save commits its profile, optional search preferences and affected approval state atomically, including export and tailored-file invalidation. Submitted drafts remain protected.

Before the Profile transaction commits, fold drafts whose body has approved status, an approval timestamp or an approved export id, and assets with non-null file paths into their original JSON bodies. Each body update removes its side state through the existing trigger. Publish the prepared display-cache patches only after the outer transaction commits; a failed save leaves both bodies and cached fields unchanged. Cached display bodies keep their nested data when only these known metadata fields change; a concurrent or external body edit still takes the normal validation path.

The approval check reuses a validated cached body only while its local change marker and SQLite data version still match. Uncached or changed bodies use SQL to inspect the stored approval fields inside the transaction.

Older builds read the original bodies. They cannot read a newly invalidated draft as approved once the Profile commit is visible, including after a forced kill. Unapproved drafts may still show their previous status, stale reason or timestamp until folding finishes. Background work folds these one row per event-loop turn, and each row and its state deletion commit together. Startup finishes interrupted folds before publishing repository reads; graceful close drains pending folds before backup and close.

Source-only edits do not launch job reassessment when the assessment inputs are identical. Required reassessment starts on a later event-loop turn and processes bounded slices; canonical reads continue to wait for it.

## Reason

The owner's 200 drafts contained about 140 MB of JSON. Rewriting all their bodies in the Profile transaction took about 5 s on the owner-data copy. SQLite updates only bodies that can expose an old approval or file path during downgrade; display reads reuse the validated nested bodies. Already-stale drafts with the same reason and no approval or file are skipped by the service. Deferring approval changes allowed older builds to read an approved body after a crash, so those writes belong in the Profile transaction. Existing workspaces gain an empty state table; no document migration or truncation is needed.
