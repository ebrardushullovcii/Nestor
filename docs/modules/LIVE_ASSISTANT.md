# Live Assistant

Parked: no new work until the owner picks it up again.

## Purpose

Owns target-context setup, rehearsal, live-session state, transcript-first cue context, visual cue augmentation, overlay view models, retention, post-session review, export, annotations, and hard-delete behavior.

## How it is shaped

- Setup uses a general interview target or supplied target context; the old Applications entry point is gone. Core disclosure acceptance is separate from microphone, meeting/system-audio, and screenshot consent, so a system-audio-only session is valid.
- A live session begins empty: no synthetic rehearsal text, non-speech STT markers are ignored, and sub-two-second recorder tails are not transcribed. Browser capture rotates complete five-second recorder instances so every local-STT chunk is independently decodable.
- Cue generation uses bounded source-labeled transcript windows, schema validation, one retry, then deterministic fallback. Unsupported personal stories become fill-in STAR scaffolds; attachment placeholders are never presented as analyzed images.
- Starting a desktop interview opens separate answer and transcript popup windows that behave as ordinary resizable windows and restore their saved bounds. `NESTOR_INTERVIEW_ADVANCED_SURFACES=0` selects the visible-chat-only fallback; `=1` enables the overlay windows and tray/global controls (ADR 0008).
- Post-session review supports export, annotations, delete, and explicit Job Finder follow-up actions. Live content never writes back automatically.

## Hard Rules

- Capture, screenshots, model calls, retention, and Job Finder write-back stay explicit and user-started.
- Raw audio, raw provider payloads, raw prompts, full transcripts, and unpinned screenshots are not retained by default.
- The answer popup and main conversation share one persisted bounded chat; attachment bytes stay transient. The main window must not imply its content is capture-excluded.
- Capture exclusion is adapter-owned capability state behind `packages/os-integration`; `setContentProtection(true)` is a request, not proof (ADR 0003).
- Harnesses default to deterministic providers with credentials blanked; live providers require the explicit opt-in described in `docs/TESTING.md`.

Platform coverage so far is Windows through Electron; macOS and Linux audio, display-server, and capture-protection behavior need target hosts.
