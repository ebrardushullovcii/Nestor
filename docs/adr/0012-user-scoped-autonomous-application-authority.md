# User-Scoped Autonomous Application Authority

Status: accepted

Supersedes [ADR 0006](0006-safe-non-submitting-apply-boundary.md).

## Context

The prepare-only boundary was intentionally temporary: ADR 0006 required a new
explicit authorization before live submission could become product scope. On
2026-08-26 the product owner explicitly authorized full application automation,
including final submission, when the user has selected and scoped that authority
through product preferences or settings.

The product goal is the outcome, not the current browser loop, state machine, or
UI. This decision does not turn an internal flag or legacy apply mode into
submission permission.

## Decision

Job Finder will support explicit application automation modes:

- `prepare_only`: fill and prepare, then stop before final submission
- `confirm_before_submit`: prepare automatically and require confirmation before
  the final submission action
- `autonomous_submit`: execute and submit within a user-defined authority envelope

The authority envelope must be explicit, inspectable, revocable, and scoped. It
must cover at least job scope, application volume, resume and answer
policy, intermediate employer-site writes, account behavior, final submission,
stop conditions, and expiry. Existing workspaces stay `prepare_only` until the
user chooses a broader mode.

Autonomous mode may perform final submission and other ordinary application
steps that fall inside the saved policy. It must pause rather than guess when a
step falls outside that policy, requires unknown eligibility or legal facts,
needs unavailable credentials or MFA, presents CAPTCHA or anti-bot challenges,
or cannot prove whether an action already occurred. The product must not bypass
security challenges or treat preferences as consent to an unseen material
attestation.

Every external mutation and submission attempt must be idempotent where the site
allows it, bound to one exact application lineage, and recorded with authority,
inputs, observed result, uncertainty, and recovery facts. Internal intent never
proves an employer-site outcome.

Model output alone is never application authority. A model may inspect state and
propose the next bounded action, but a deterministic policy executor must bind
that action to the current page observation, exact application lineage, and
saved authority envelope before any external mutation. Final submission uses a
separate preflight and outcome-verification path and is never retried when the
site outcome is uncertain.

Current discovery, profile editing, resume editing, and browser-control
approaches may be replaced if another design produces better truthful outcomes.

## Consequences

- Contracts, persistence, browser runtime, product copy, receipts and tests
  must distinguish the three modes explicitly.
- Final-submit controls may be used only by the new typed authority path. Legacy
  flags and current prepare-only APIs remain non-submitting.
- Platform terms and account risk must be disclosed without pretending that a
  warning substitutes for user choice or technical safety.
- Product and architecture work should optimize for reliable end-to-end results,
  not preserve the current agent loop or UI structure.

## Update (2026-10-29): opt-in browser access

The owner authorized independent settings for browser agents: solving
CAPTCHAs, signing in, creating website accounts, and using an existing Google
sign-in to sign in or register on a website. All default off, including
for existing profiles. Search, source checks and application preparation read
these permissions separately from sending authority and recheck them before
acting. An enabled step may be attempted using the site's visible controls; an
unavailable password, MFA, an unreadable challenge or an ambiguous action still
hands the exact page to the person. Account and verification POSTs use the exact
observed form action, with no application-send window. A solved challenge or a
successful sign-in never proves an application was sent.

The owner also authorized local password import, explicit save/update offers and
autofill. Secrets stay between the main-owned encrypted vault and the exact-site
browser form; they never become model input, renderer state or diagnostic data.
Agent autofill additionally requires the sign-in permission and one unambiguous
saved account on an existing-account form.

The Google opt-in is independent of password-based sign-in and account creation.
It permits the site's visible Google button and a single already signed-in
Google account choice. An empty password form beside that button does not block
it. Multiple Google accounts, Google credentials, Google account creation and
Google consent/access requests still hand off to the person. It does not grant
application-sending authority.
