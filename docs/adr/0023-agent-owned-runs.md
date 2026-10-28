# ADR 0023: Agent-owned runs

Status: partly superseded by [ADR 0041](0041-the-model-reads-the-page.md): ordinary search collects mechanically and judges merged jobs, rather than giving the model ownership of every search run (a1cdeb6b). Apply, source-check and browser fallback still use the shared agent loop.

Date: 2026-09-14

Supersedes the first point of ADR 0013 for search and source-check runs, and narrows ADR 0021's executor to safety.

## Context

Each browser workflow (job search, source check, apply) grew a layer of deterministic decisions around the model: step quotas, candidate-hold and yield-exhaustion arms that ended a search on the host's judgement, a resolver that decided which link was the Apply link before the model saw the page, phrase lists that turned a page into a "blocker", a guard that treated a new tab opened by the model's own click as the site misbehaving, and raw browser-automation errors that ended runs and reached the person verbatim.

Each rule was written for a case it had seen. Each then failed a case it had not: an Apply button plainly on the page that the run said did not exist, a job board whose Apply opens the employer's site in a new tab, a source ended at step five while it still had pages to read. In every case the model, given the page and the tools, would have done what a person would.

The models these runs use sit between Sonnet and Opus in capability. A harness that trusts such a model to write code does not second-guess which button it may press.

## Decision

- The model owns the run. Search, source check, and apply are one loop each: the model is told the goal, given general browser tools (observe the whole page, read, navigate, follow links, click anything, type, select, upload, scroll, wait, go back) plus domain tools (save jobs, list saved jobs, look up the person's answer for a field, say the form is complete), and decides where to go and when it is done.
- Deterministic code is for safety and nothing else: no account creation, sign-in, security checks, or codes; the prepare-only network guard; final-submit authority and preflight (ADR 0012); the origin allowlist when the person wrote one; idempotency. A stall gets one warning turn and only then ends the run. Time and step figures are ceilings far above an honest run, never budgets.
- Whatever the model's own click causes is the model's doing. A new tab it opens is followed in the working tab and reported to it, not treated as an attack. A browser failure under a step is handed back to the model as a fact about the page, in plain words, with a fresh look at the page. Only a browser that keeps failing ends the run.
- The model writes the copy. When a run stops, the person reads the model's own report of which page it was on, what it tried, what the site did, and what they must do. Phrase-list detections (sign-in page, security check, paid overlay) are facts handed to the model, never automatic stops or the source of the person's message. Raw automation error text never reaches the person.
- Deterministic accelerators (API-first catalog reads, compact card scans, fast extraction) stay where they save time, as tools or pre-passes whose results are handed to the model. They do not end a run or decide what the model may see.

## Shape

- `packages/agent-runtime` exports `runAgentLoop`: the one loop. It hands tool results back, warns once on a stall, turns a browser exception into a plain fact for the model, ends the run only on a time ceiling, three browser failures in a row, or a safety stop, and trims a long conversation while keeping its own turn notes.
- `packages/browser-agent` exports `createPageTools`: the browser powers as tools over the runtime's page hands, shared by every agent that works a page. A tab the model's click opens is adopted into the working tab; an address outside the person's scope is refused with the reason; a write against a page that changed since the model looked is refused once and the page shown again.
- `runJobSearchAgent` runs search and source check on that loop with those tools plus `extract_jobs`, `scan_cards`, `saved_jobs`, and `finish`. The card scanner and the extractor are tools; nothing runs before the model sees the page.
- A search run lives on its source site but may leave it. The agent states a specific reason with the move; a second model call reviews that reason against the goal and allows or refuses it (`createMoveReviewer`). An origin allowed once stays allowed for the run. A move without a reason, or one the review refuses, is refused with the verdict and the run goes back. This is the pattern for any power the agent should have but not use casually: a stated reason, reviewed by a second agent, never a fixed rule.
- The apply agent moves onto the same loop next; the old discovery loop and its tooling are retired once nothing but the evaluation lane calls them.

## Consequences

- Search runs no longer stop on candidate-hold, yield-exhaustion, stagnation, near-step-limit, or early forced-finish arms; those were removed with the tests that pinned them. The stall warning, the time ceiling, and the model's own finish remain.
- New tabs opened by a clicked control are followed in place; only downloads and the page sending the form on its own still stop a prepare-only run.
- Every layer that reports a run's end prefers the model's reason; wrappers add one plain sentence of their own when they must add anything.
- Future failures are fixed by widening what the agent can see and do, not by adding another rule.

## Related Decisions

- ADR 0007, ADR 0012, ADR 0013, ADR 0021, ADR 0022
