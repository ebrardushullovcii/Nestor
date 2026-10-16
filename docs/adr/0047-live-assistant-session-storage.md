# ADR 0047: Live Assistant retains session bodies separately

Status: accepted (2026-10-13).

## Context

Each captured segment reparsed and rewrote the full JSON archive, then sent it to every application window. Work during a live interview grew with all previous interviews and competed with Job Finder in the same main process.

## Decision

Store Live Assistant metadata, the archive index, and complete session bodies in a dedicated SQLite sidecar beside the legacy workspace JSON. Ordinary mutations validate and write the active session and workspace metadata. Archived bodies are read only for explicit review, annotation, prep-artifact creation, or export, and rewritten only when changed. Live IPC contains scalar archive summaries without transcripts, chat, saved-job bodies, or profile snapshots; workspace events go only to Live Assistant surfaces.

Migrate the legacy JSON, including the old module name, in one transaction. The workspace row is the committed migration marker. Keep the legacy file untouched; a failed migration commits no imported rows and retries from that file. Reject duplicate session ids rather than silently collapsing retained bodies. Canonical repository load/save still provides complete snapshots for lossless export/import; replacements commit atomically or leave the prior archive intact.

## Consequences

No history or transcript retention cap is introduced. Restart recovery still archives the complete interrupted session and leaves capture stopped. Review loads the requested full body through the typed preload bridge. Capture work follows the active session rather than historical transcript volume; full archive operations remain proportional to the archive by design. The SQLite sidecar becomes authoritative after migration; the retained legacy file is the original migration source, not a current backup.
