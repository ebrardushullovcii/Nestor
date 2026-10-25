# ADR 0013: Hybrid Browser Observation and Policy Execution

Status: accepted

Date: 2026-08-26

## Context

Job Finder must discover hundreds or thousands of relevant jobs and complete
applications under the user-scoped authority model in ADR 0012. The current
discovery flow gives one model-owned loop responsibility for navigation,
extraction, stopping, and recovery. The current application flow couples page
observation, answer resolution, writes, final-control classification, and result
construction in one prepare-only driver.

Two disposable serial comparisons measured alternatives. A compact Playwright
snapshot arm retained 36/40 unique jobs across scored synthetic discovery
surfaces versus 0/40 for the current deterministic substrate, completed in about
one fifth of the wall time, and retained 50 jobs versus 4 on one public
Greenhouse pass. Stagehand's useful operations remained provider-gated and did
not prove bounded credential-free local behavior. An explicit application
protocol passed 16/16 invariants; a coupled-driver extension could not represent
stale bindings, ambiguous final controls, externally verified submission, or
post-click uncertainty without duplicate-submission risk.

## Decision

Use a hybrid architecture with these fixed boundaries:

1. Discovery is API-first, deterministic compact-browser observation second,
   and model-escalated third. Deterministic observation owns bounded snapshots,
   typed extraction, pagination candidates, canonicalization, dedupe, and
   explicit unsupported outcomes. A model receives only bounded failed or
   uncertain observations; it does not own the search run.
2. Browser observation produces typed page identity, stable control references,
   candidate actions, blockers, and externally observed effects. Observation
   identity must be rechecked before mutation.
3. Domain orchestration owns budgets, canonical state, application lineage,
   authority envelopes, idempotency, retries, revocation, and terminal outcomes.
4. Models and heuristics may propose one typed action. They never grant authority
   or establish canonical external truth.
5. A deterministic policy executor re-observes, checks exact lineage and the
   current authority revision, binds a durable idempotency key, executes at most
   one external action, and records attempt and verification receipts.
6. Final submission uses preflight plus one execution and ends as `submitted`,
   `not_submitted`, or `outcome_uncertain`. Only fresh external evidence proves
   `submitted`; uncertainty permanently blocks automatic retry for that key.
7. Preserve current canonicalization, merge-key dedupe, learned detail templates,
   JSON-LD normalization, prepare-only containment, missing-answer pauses,
   recovery, and lineage where they fit these boundaries. Do not preserve the
   500-character discovery gate, line-shape completeness assumption, first-match
   final-action rule, or `submitAuthorized` as authority.

## Consequences

- Common discovery and form paths become deterministic, cheaper, and easier to
  test without removing bounded model help for genuinely uncertain pages.
- Browser-runtime packages provide generic observation and execution hands;
  Job Finder retains workflow and authority policy.
- Observation identity, unsupported-layout handling, iframe/upload coverage, and
  external verification channels require explicit implementation and focused
  live testing.
- Stagehand remains a benchmark, not a dependency. Reconsider it only after a
  bounded local adapter proves better measured reliability without weakening
  package ownership or requiring model calls on deterministic paths.

## Rejected Alternatives

- Keep the model-owned discovery loop and tune prompts: measured deterministic
  gates still discarded usable listings and spent more time before fallback.
- Adopt Stagehand as the policy brain: provider dependence and API churn add cost
  without owning domain authority or truth.
- Enable submission inside the coupled driver with a boolean flag: this cannot
  provide fresh authorization, stable identity, idempotency, or honest uncertain
  outcomes.
- Run an MCP browser server inside the product: compact snapshot/reference ideas
  are useful, but another process and protocol are unnecessary around the
  existing Playwright runtime.

## Related Decisions

- ADR 0007: Source-generic browser workflows
- ADR 0012: User-scoped autonomous application authority
