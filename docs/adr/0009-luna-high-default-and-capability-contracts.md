# ADR 0009: Luna High default and contract-first AI capabilities

## Status

Partly superseded by ADR 0019 for model selection and ADR 0012 for user-scoped submission authority; the contract-first capability and temporary-draft boundaries remain accepted.

## Context

The 2026-08-12 configured-model benchmark completed 330 synthetic outcomes across eleven product capabilities. Sol Low had the best aggregate technical result against the current integrations, while Luna High remained close on overall latency and reliability. Luna Max was materially slower without an overall quality gain.

The product owner selected Luna High for every compatible generative text and vision capability because its price profile is materially preferable. Audio transcription remains a separate local Whisper or explicit audio-model role because Luna does not accept audio input.

The benchmark also showed that model selection is not the main blocker in several workflows. Typed-output mismatches, hidden deterministic fallbacks, browser-loop exhaustion, incomplete URL normalization, and weak evidence attribution prevented valid product-level comparisons.

## Decision

- Use `gpt-5.6-luna` with `high` reasoning as the default for every compatible generative text and vision capability.
- Keep audio transcription behind its existing local Whisper or explicit audio-model boundary.
- Run Luna High inside a small product-specific agent harness. The agent can read the current task state, call narrow typed tools, edit a temporary draft, validate it, inspect errors, and try again. It does not receive unrestricted database, filesystem, browser, or application APIs.
- Let the agent finish a valid temporary draft or review proposal, but require deterministic product code and the existing user-review rules to commit canonical profile, résumé, application, or interview state.
- Replace capability-specific parsing/fallback conventions with a shared contract-first execution boundary that records transport, parse, validation, guard, repair, fallback, and final-product outcomes separately.
- Require every agent tool write to target a temporary transaction, reference stable evidence where factual claims are involved, and pass the same domain validation used by manual edits.
- Replace ordinary fixed step counts with progress-aware run control. Time, cost, cancellation, repeated no-progress, task completion, and safety stop normal work; a generous hard turn ceiling remains only as a runaway circuit breaker.
- Keep canonical agent progress in durable typed task state rather than relying on chat history. Model context is rehydrated from that state, and structured tool results use stable handles or pagination instead of character-level truncation.
- Classify failures before retrying. Retry transient provider or network failures with bounded backoff; return schema and validation failures to the agent for repair; refresh stale browser state; pause for user-action boundaries; stop permanent failures.
- Allow bounded concurrency only for independent read-only work. Serialize navigation and state changes within a browser page or task transaction.
- Checkpoint long work at safe milestones and allow an explicit user-initiated resume. Never automatically replay external actions after interruption.
- Use deterministic validation as the normal reviewer. Add a fresh, evidence-scoped model review only for ambiguous or high-impact proposals where independent judgment is valuable.
- Give tools explicit permission levels: unrestricted reads within task scope, reversible draft writes, feature-approved undoable local commits, reviewed canonical changes, and user-only external actions.
- Keep final submission, account creation, credentials, MFA, CAPTCHA, and legal consent outside model authority.

## Consequences

### Positive

- Production configuration matches the owner's price and quality preference.
- Every AI surface has consistent attribution, observability, repair, fallback, and safety behavior.
- Models can correct their own formatting or validation mistakes instead of losing an otherwise useful answer because one large JSON response was imperfect.
- Model upgrades can be evaluated without confusing deterministic recovery with model quality.
- Product state remains deterministic, reviewable, and safe even when model output is malformed.

### Negative

- Luna High is not the aggregate benchmark winner; the accepted product decision prioritizes price and sufficient quality over the benchmark's Sol Low lead.
- A meaningful refactor is required across contracts, AI providers, browser agent, Job Finder, Live Assistant, diagnostics, and UI state.
- Existing prompts and adapters cannot all remain backward-compatible internally.

### Mitigations

- Migrate one capability family at a time behind contract tests and replayable synthetic fixtures.
- Preserve deterministic fallbacks until each replacement passes direct-output checks and a run in the built app.
