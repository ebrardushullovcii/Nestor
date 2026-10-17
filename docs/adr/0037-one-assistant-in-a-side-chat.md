# ADR 0037: One assistant in a side chat

Status: accepted (2026-09-27).

Replaces the Profile Copilot rail and the Resume studio's own assistant panel.

## Context

Job Finder had two chats: one beside the profile and one inside the Resume studio. Each knew only its own screen, proposed changes the person had to accept one by one, and could not act anywhere else. People asked either chat for things the other one owned, or for work on other screens, and got nothing useful.

## Decision

- **One conversation, app-wide.** A right-hand sidebar in Job Finder holds one assistant. It opens only from the Assistant button, ⌘I or an "Ask the assistant" entry point, never by itself. Moving between screens keeps the same conversation, the running work and the page's own state. Below 520 px of remaining page width the sidebar switches between the page and the chat instead of squeezing both.
- **The main process owns the conversation.** The session host (`packages/job-finder/src/assistant/session-host.ts`) keeps conversations, messages, turns, events, operations, change receipts, grants, plans, result sets and compaction checkpoints in its own store (`assistant.sqlite`, `packages/db` `createAssistantRepository`). The renderer reads through the typed preload bridge and follows an event stream from a sequence cursor, so a reload or restart replays instead of losing messages.
- **Context references, not screenshots.** Each sent message carries what the screen means by "this": the route, the focused record, the list's selected, displayed and filtered ids (frozen into result sets at send time so "these" and "the second one" keep their meaning), editor snapshots with unsaved fields and the saved revision, the visible browser tab, selected text, @ mentions and attached files.
- **Asked-for edits apply at once, with Undo.** A clear request edits the real record and adds a change card with a per-change Undo that reverts only that change, and only while the record still holds what the assistant wrote. Suggestions the person did not ask for stay proposals with Apply and Dismiss. An edit never overwrites a field the person has typed into and not saved.
- **Picks respect the person's choices.** Job lists the assistant reads leave out excluded employers, flag a posting already applied to on another site (ADR 0030), and shortlisting or applying holds those back unless the person asks for them by name. Replies report what the records say was saved, not what the model meant to save.
- **Real tools for every visible action.** Tool groups cover profile, files, resumes, jobs, applications, tracking, settings and the browser. `action-inventory.ts` maps every visible Job Finder action and service method to tools, or names why it is excluded; a test keeps the inventory and the catalog in step. The model decides; deterministic code covers safety only (ADR 0023).
- **Work continues across background runs.** A search, resume batch or application run the assistant starts is watched; when it finishes the host continues the same turn's plan without a new message. Stop fences the turn, cancels its runs and releases its browser tab.
- **Bounded context.** Old tool outputs become handles the model can reopen, and long threads compact into validated checkpoints that keep corrections, result order, pending questions, grants and outcomes.
- **Old chats are archived, not dropped.** Profile Copilot and Resume assistant histories migrate once, in order, into read-only archive conversations. Their pending proposals stay actionable from the archive; nothing re-executes.
- **AI is bundled.** The default route is `deepseek-v4.1-flash` over Chat Completions, with `muse-spark-1.3-contributor` over Responses as the alternative (`NESTOR_AI_ASSISTANT_*`). A missing or failing model reads as a temporary outage, never as a setup task.

## Consequences

The profile and studio screens no longer mount their own chats; they publish context and offer "Ask the assistant". The old Profile and Resume chat routes refuse new messages and proposal writes; the archived histories stay readable in the sidebar, where their pending proposals can still be applied. Two-pane screens relax their column minimums while the sidebar is docked (`assistant-docked:` variant).
