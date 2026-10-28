# Live Assistant Live-Session Architecture

Status: partly superseded by [ADR 0008](0008-visible-first-live-assistant.md): visible main-window chat replaces overlay-only presentation; user-started sessions, capture boundaries and adapter ownership remain accepted.

Live Assistant live assistance is built around an explicit user-started Interview live session rather than ambient background listening, with a setup gate, rehearsal checklist, dual microphone plus meeting/system audio transcription, conservative cue triggers, temporary screenshot batches, two screen-share-private overlays, structured retention, and post-session review. We chose this shape because the feature needs low-latency help during interviews while keeping capture boundaries visible, auditable, adapter-owned, recoverable across Windows, macOS, and Linux, and intentionally open to future authorized full capture exclusion without baking hiding behavior into session logic.

## Considered Options

- Ambient always-on listening was rejected because it makes consent, retention, model spend, and user trust harder to reason about.
- Hotkey-only capture was rejected because it weakens live transcript continuity and question detection.
- A single combined overlay was rejected because answer reading and transcript/capture review have different interaction and visibility needs.
- One shared multimodal model role was rejected because speech-to-text latency, cue-card generation, and screenshot interpretation need narrow provider contracts and separate readiness/failure states.
- Full transcript resend for every cue was rejected because long interviews need rolling cue context with compact session summaries.
- Embedding capture-hiding behavior directly in overlay UI or session orchestration was rejected because stronger future capture protection must remain an explicit, authorized OS or platform adapter capability.

## Consequences

- `packages/live-assistant` owns deterministic live-session state, cue triggers, rolling cue context, and retained session history.
- `packages/os-integration` owns global hotkeys, overlay window policy, capture protection, and platform differences.
- `packages/ai-providers` owns narrow Interview model roles for STT, cue-card chat, and screenshot vision.
- Future authorized full capture exclusion should be added as new capture-protection adapter capabilities once the relevant user, app, company, platform, or meeting-system approvals exist.
