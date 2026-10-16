# Architecture

## Workspaces

- `apps/desktop`: Electron main, preload, renderer
- `apps/website`: the public landing page, static and outside the pnpm workspace; Netlify deploys it from `main`
- `packages/contracts`: schemas, DTOs, typed IPC
- `packages/core`: small shared helpers and result types
- `packages/db`: persistence and repository boundaries
- `packages/knowledge-base`: ingestion, chunking, retrieval
- `packages/browser-runtime`: browser lifecycle and generic automation primitives
- `packages/browser-agent`: browser workflow policy, prompts, tool use, structured outputs
- `packages/job-finder`: discovery, source-debug, resume, apply orchestration
- `packages/live-assistant`: prep, live session, transcript, cues
- `packages/ai-providers`: provider interfaces and adapters for chat, vision, STT, and embeddings
- `packages/os-integration`: tray, hotkeys, windows, capture-policy adapters
- `packages/testing`: fixtures, fakes, harness helpers

## Boundary Rules

- renderer talks to Electron main through typed preload APIs only
- cross-package contracts live in `packages/contracts`
- package public APIs are the only supported import surface
- `browser-runtime` stays generic; site or workflow policy belongs higher
- `job-finder` discovery, source-debug, and apply preparation stay source-generic; do not add per-board route builders, query maps, triage overrides, or policy branches that only make sense for one job source
- source-specific code is acceptable only for reusable provider adapters or contained `browser-agent` extraction/navigation quirks
- reusable provider adapters currently include public Ashby board ingestion and exact-job Workday candidate-experience ingestion; they normalize provider payloads into shared discovery contracts without adding board-specific workflow policy
- `pnpm source-generic:check` guards the browser/discovery boundary
- interview conversation/session state belongs to `live-assistant`; Electron media permissions and optional overlay windows stay in desktop adapters, while reusable OS capture/hotkey policy belongs to `os-integration`
- native helpers are a last resort and must stay behind `packages/os-integration`

See [ADR 0007](adr/0007-source-generic-browser-workflows.md) for the source-generic browser decision.

## Main Flows

- desktop: renderer -> preload -> Electron main -> package services
- resume import: desktop ingress -> parser/text/vision branches -> review candidates -> accepted canonical writes
- discovery: the model owns each search and source-check run on `runAgentLoop`
  with general page tools plus `extract_jobs`, `saved_jobs`, and `finish`
  (ADR 0023); job details come from the model reading the page (ADR 0041). `browser-agent` owns the source-generic search policy,
  prompts, and structured outputs; `job-finder` owns budgets, canonical merge,
  matching, dedupe, ledger, persistence, and run truth. Each checkpoint's new
  postings use the same canonical merge path as final collection.
- applications: the apply agent fills the form and sends it only under Send
  for me or on the person's Send press under Ask before sending (ADR 0024,
  ADR 0027). Browser packages own generic observation and execution hands;
  `job-finder` owns authority envelopes, preflight, idempotency, revocation,
  lineage, capacity, and tri-state outcome truth. Models and heuristics may
  propose typed actions but cannot grant authority or prove external outcomes.
- approved application answers: Profile owns mutable reusable answer content;
  Electron main is the only approval boundary. Main canonicalizes the current
  non-empty answer bank, computes its content digest, and appends an immutable
  snapshot through `packages/db`. Authority/preflight records bind only the
  snapshot revision and digest. Renderer readiness receives counts, kinds,
  status, and lifecycle identity but never raw answer text or a caller-supplied
  digest. An approved snapshot does not grant, arm, or execute anything.
- product actions: schema-validated local tools call a narrow injected subset of the `job-finder` workspace service. They never expose raw IPC, browser primitives, arbitrary navigation, or filesystem access; the retired Profile Copilot's proposal-only calls persist reviewable patch groups without applying them
- assistant (ADR 0037-0039): renderer sidebar -> typed preload `assistant` bridge -> `job-finder:assistant:*` IPC -> the main-process session host in `packages/job-finder/src/assistant`. The host runs `runConversationTurn` from `packages/agent-runtime` (product-neutral: steering at tool boundaries, per-tool deadlines, generation fencing, streaming) with Job Finder tools that call the workspace service and desktop ports (searches, application runs, sends, files, the lent browser tab). Conversations, events, operations, change receipts, grants, plans, result sets and checkpoints persist in `assistant.sqlite` through `packages/db`'s assistant repository. Renderer screens publish context references (route, focus, list ids, editor snapshots) and never call tools. Model routes and streaming come from `packages/ai-providers` (`NORDRI_AI_ASSISTANT_*`).
- source-debug: `job-finder` orchestrates phases and artifacts, `browser-agent` returns structured attempts, `db` persists runs and evidence
- browser visual evidence: `browser-runtime` owns screenshot capture and cleanup; `browser-agent` owns generic trigger policy and interpretation; `job-finder` persists only schema-validated summaries
- interview live session: visible chat/audio UI -> typed preload -> Electron main-hosted `live-assistant` service -> typed AI/audio/screenshot adapters -> visible responses, source-labeled transcript, and post-session review
- generative AI: domain services -> a small product-specific agent harness -> `packages/ai-providers` -> OpenCode Go. Muse Spark 1.3 Contributor handles text, tool, and image work through the Responses API with requested `xhigh` reasoning; DeepSeek V4.1 Flash handles aggressive resume tailoring through Chat Completions with `high` reasoning (ADR 0019). The harness gives the model narrow typed read/write/validate tools over a temporary task transaction, records every call, and separates direct work, correction, validation, fallback, and final product output. Domain code still owns canonical state and user-review rules. Local Codex bridges remain replaceable loopback development transports. Audio transcription stays a separate local Whisper or explicit audio-model role.

### Persistence safety

- Repository collection reads are lossless by default. Explicit `limit` and
  `offset` options are stable pages for display or traversal; paged results must
  never feed a destructive whole-collection replacement.
- Ordinary saved-job mutations use transactional row-local deltas/upserts. The
  update callback runs against the current rows inside the SQLite immediate
  transaction, so concurrent settings, discovery, and application work cannot
  replay a stale full snapshot over unrelated jobs.
- Resume-affecting job changes and approval invalidation are one atomic commit.
  A crash or concurrent write cannot leave a changed job paired with approval
  derived from its previous facts.
- Whole-collection replacement APIs are reserved for authoritative reset/import
  boundaries whose caller owns the complete collection. They are not product
  read-modify-write primitives.
- Singleton profile, search, setup, and settings writes update only their owned
  SQLite value. Discovery keeps its small active state in a singleton and its
  runs, activity, checkpoints, ledger, and pending jobs in rows; ordinary
  discovery commits write changed rows atomically with saved-job deltas.
- Employer-application capacity uses an immutable SQLite-backed start mark on
  the exact apply result before browser/session work. In-flight reservations
  are serialized in memory within the desktop singleton process; persisted
  marks provide restart durability, while legacy uncertainty remains explicit
  rather than being converted into fabricated start facts.

### Campaign and CRM ownership

- `packages/contracts` owns campaign, dashboard, activity-control, CRM, custom-stage, reminder, interview, timeline, and export shapes, plus campaign-rule and funnel projections, schedule state/pause windows/run facts, campaign digests, in-app campaign notifications, and the job-finder intelligence state (outcome events and analytics, resume strategies and per-job selections, company entities and merge review, and safeguard records).
- `packages/db` persists campaign collections beside the existing workspace state. SQLite migration 10 backfills one default campaign for an existing workspace without rewriting its jobs or applications. CRM data remains an optional schema-defaulted part of each application record, so old records still load.
- `packages/job-finder` owns campaign selection, discovery/job membership, dashboard projection, preparation limits and stop rules, global activity gates, serialized CRM updates, no-response automation, duplicate hints, and export content, plus campaign-rule evaluation and truthful funnel projection, schedule/digest/notification derivation, outcome recording and analytics, collision-safe outcome identity resolution, resume-strategy recommendation and per-job selection, company reconciliation and merge review, and safeguard gate operations. Its automatic safeguard path derives idempotent technical discovery/source-debug evidence and leaves explicit user-owned blockers out of the technical sample; grouped-answer contradiction evidence is persisted as an advisory local fact.
- `packages/job-finder` also owns the derived `companyJobs` projection over the complete company-linked saved-job collection and the atomic exact-employer exclusion mutation. The projection is not limited to the active discovery list. A job belongs to a company only through its exact normalized canonical name or a user-approved merge alias; legacy aliases and domains are non-authoritative. Domains remain corroborating, conflicting, or research evidence and do not create ownership or domain-wide exclusion policy. Reconciliation does not destructively migrate SavedJob domains.
- Company salary/offer mutations cross a repository commit boundary that reads
  transaction-current intelligence, the exact SavedJob, and the exact optional
  ApplicationRecord under one write transaction. `packages/job-finder`
  validates current ownership and lineage there, uses monotonic timestamps, and
  commits all or nothing.
- Electron main owns typed IPC, local save dialogs, and the desktop campaign scheduler service (interval-driven due-run evaluation with power suspend/resume). Preload exposes only schema-checked campaign, activity, CRM, rule/funnel, schedule/digest/notification, outcome/strategy/company/safeguard actions. The renderer never writes the database or filesystem directly.
- Active-campaign list scoping is a renderer projection over authoritative campaign job IDs. Workspace-wide search deliberately keeps all local entities and changes the active campaign before navigating to an item from another campaign.
- Manual CRM stages do not change apply-run authority, browser outcomes,
  external-write evidence, or submission receipts. Final submission is
  governed only by the typed authority envelope from ADR 0012, which the saved
  apply mode creates and updates (ADR 0024).
- Outcome recording resolves the campaign and application identity for the exact job. Omitted identities are accepted only when the job has one unambiguous campaign or application record; multiple matches require an explicit identifier and conflicting identifiers are rejected before the event is written. Outcome events remain user-controlled local facts and never create apply or submission evidence.

## Resume Safety

- tailored mode requires a current approved resume export before apply; original-CV mode requires the imported source file to remain available on disk
- browser apply runtimes receive one typed application-resume artifact whose source is either `tailored_export` or `original_upload`; orchestration must not fabricate a tailored export for an original file
- stale drafts cannot be used as approved exports
- every canonical experience remains represented in the editor even when excluded from recruiter-facing output
- named resume strategies resolve a base resume document plus headline, skills, coverage, tailoring-strength, and evidence-boundary policies into generation context. This context is advisory input to résumé generation; strategy selection never approves, readies, or unstales an artifact.
- `submitAuthorized` is true only under an `autonomous_submit` envelope or the
  person's Send press under `confirm_before_submit`, after preflight;
  `prepare_only` never sends, and legacy flags do not acquire that meaning
- intermediate field saves are allowed by default to the origin the form's
  frame saves to, in a 10-second, 40-request window after each field change;
  a saved envelope may narrow the origins, and no final send, DOM submit, or
  navigation mutation passes (ADR 0024). None of this grants a final action
- Browser Runtime keeps Playwright `Page` private and exposes optional typed
  application observation/exact-one-action hands only to main-process
  composition. Job Finder owns the authority/preflight/idempotency policy around
  those mechanics through the explicit
  `@nordri/job-finder/application-submission-runtime-main` subpath. No
  renderer, preload, IPC, or legacy apply route calls that seam; browser-local
  action facts can record only `not_submitted` or `outcome_uncertain`, never
  prove `submitted`
- uncertain outcomes are a durable stop state. Applications may resolve one only
  from an explicit two-step user confirmation after the user checks the employer
  site. Renderer input carries no evidence id, timestamp, revision, URL, or
  retry decision; Electron main derives those facts from current persisted
  lineage and `packages/db` commits the original uncertainty, resolved outcome,
  idempotency, ApplyJobResult receipt/state, and exact ApplicationRecord
  projection atomically. This recovery channel records external operator
  evidence but grants no browser action or submission authority
- prepare-only browser execution installs page and network mutation guards before filling fields. A separate `intermediateMutationsAuthorized` capability may allow autosave/draft/non-final ATS traffic, but it never permits DOM form submission, `requestSubmit`, a final-control click, navigation mutation, beacon, WebSocket, EventSource, or WebTransport; omitted authorization remains false. The capability is field-scoped: one exact grounded field action opens a same-origin 10-second/40-request window, only fetch/XHR `POST`/`PUT`/`PATCH` traffic with explicit draft/autosave/save/update/field/answer/upload/progress semantics can pass, and final-action, cross-origin, ambiguous, late, or exhausted traffic is blocked and journaled. Both the page wrapper and Playwright route enforce the boundary. Observed external writes and receipt attestations describe Job Finder's own authority and actions — they cannot confirm an external site outcome, which only the user can verify on the site
- prepare-only execution continuously rechecks application-origin service-worker registration through the run sentinel plus an in-page scan, with explicit rechecks before safe-advance clicks and at the preparation step limit, and pauses untouched before any further field or click action when a worker can influence the origin; a failed employer-page goto is classified once as the technical `application_page_unreachable` blocker carrying only causal-free user copy, while its raw transport detail stays in session diagnostics
- exact provider job URLs are prioritized before per-source collection caps so a configured vacancy cannot silently degrade into an unrelated board result
- authentication remains owned by the browser session. The default desktop browser uses sandboxed Electron tabs and a persistent session; main may bring sign-ins over from a browser profile the user picks from a discovered list, but cookie values, profile paths and credentials must never enter renderer state, prompts or logs. Opening a source does not prove authentication; the user explicitly confirms sign-in before a source-scoped retry. See [ADR 0017](adr/0017-embedded-job-finder-browser.md) for browser ownership, handover and import boundaries
- staleness rules live in `packages/job-finder/src/internal/resume-workspace-staleness.ts`

## Interview Capture Protection

Live Assistant defaults to the ordinary visible main window. Advanced overlay windows and global/tray controls initialize only when `NORDRI_INTERVIEW_ADVANCED_SURFACES=1`. When enabled, overlay capture exclusion remains adapter-owned capability state: Electron `BrowserWindow.setContentProtection(true)` is a request, while real platform-specific verification and any future authorized stronger capture-exclusion path must stay behind `packages/os-integration`.

See [ADR 0003](adr/0003-live-assistant-live-session-architecture.md) and [ADR 0008](adr/0008-visible-first-live-assistant.md).

See [ADR 0010](adr/0010-opencode-go-mixed-text-and-vision-routing.md) for configured text/vision routing and [ADR 0009](adr/0009-luna-high-default-and-capability-contracts.md) for the contract-first AI boundary that remains in force.

## Known Debt

- keep watching for any `browser-runtime` dependency on `browser-agent`; runtime should stay lower-level than workflow policy
- keep `browser-runtime` limited to page mechanics now that the fixed
  preparation script is gone (ADR 0021), and search runs no deterministic pass
  before the model sees the page (ADR 0023)
- remaining source-named discovery debt from the browser substrate evaluation must not expand to other sources
