# Visible-First Live Assistant

Status: accepted

The default Live Assistant experience keeps the visible conversation in the main application window and also opens visible answer and transcript popup windows when an interview starts. The answer popup is an equally valid compact interaction surface for explicit text sends, temporary image attachments, screen context, and assistant responses; the transcript popup remains a dedicated live reading surface. Schema-validated workspace events synchronize all windows without renderer reloads so background audio updates do not destroy in-progress input. The popup lifecycle, global hotkeys, tray controls, and panic-hide initialize by default, with `NESTOR_INTERVIEW_ADVANCED_SURFACES=0` retained as an explicit visible-chat-only fallback.

This supersedes the default presentation choice in [ADR 0003](0003-live-assistant-live-session-architecture.md), while retaining its user-started session, typed provider roles, explicit capture consent, bounded context, transient media, structured retention, and adapter-ownership decisions.

## Considered Options

- Keeping overlay-only answers as the default was rejected because it hid the primary output, made ordinary chat and attachment workflows awkward, and let protection mechanics dominate basic product acceptance.
- Removing the popup implementation was rejected because live answer and transcript surfaces are now part of the ordinary started-interview workflow.
- Persisting raw attachment bytes in conversation history was rejected because visual context can be processed transiently and retained as bounded metadata/observations.

## Consequences

- `apps/desktop` owns the visible conversation UI, typed preload bridge, media permissions, and default popup-window startup and lifecycle.
- Popup placement, size, visibility, and reopening remain native-window concerns; popup chat and attachment operations use the same typed Live Assistant APIs and retention rules as the main conversation.
- `packages/live-assistant` owns deterministic session mutation ordering, explicit chat turns, cue generation, transcript context, and transient visual processing.
- `packages/contracts` owns bounded chat, attachment, and turn schemas; raw image bytes exist only at the send/provider boundary.
- Default acceptance tests must prove both popup windows are visible after session start alongside the visible chat and audio paths. Deeper capture-protection tests remain separate evidence.
