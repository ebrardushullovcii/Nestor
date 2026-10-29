# ADR 0020: Streamed model requests with idle and total budgets

## Status

Accepted.

## Context

Every Job Finder model call (structured JSON, tool-calling agent turns, resume
and browser vision) went through one `fetch` with a single fixed deadline
(60–120s) and no streaming. Three things went wrong with that on the bundled
OpenCode Go route:

- Muse Spark at `xhigh` legitimately thinks for minutes. A 60s deadline turned
  a healthy generation into "timed out", and the app fell back to the built-in
  writer, which testers read as "the AI failed".
- A dropped Wi-Fi link, a stalled gateway, and a model that was still thinking
  all looked identical: no bytes until the deadline. Nothing could tell a dead
  connection from a slow answer, so nothing was retried.
- Retries only covered transient errors on the first bytes, with a two-second
  cap, which is shorter than a laptop reconnecting to Wi-Fi.

Probing the gateway showed what the transport can rely on: Chat Completions
streams `reasoning_content` deltas continuously; the Responses API streams
nothing while the model reasons unless `reasoning.summary: "auto"` is set, in
which case a summary event arrives every 4–15 seconds. A streamed 150-second
`xhigh` run completed with `response.completed`; an earlier attempt was cut by
the gateway after a 20-second gap without a completion event.

## Decision

- All model requests go through `performModelRequest` in
  `packages/ai-providers/src/model-request-transport.ts`.
- Requests stream by default. The Responses API is asked for reasoning
  summaries; the text is discarded and only serves as a liveness signal.
- Two clocks per request. An idle clock (default 120s without model progress) presumes the
  connection dead and retries. A total clock (per operation: 300s for
  structured calls, agent turns and resume import stages, 600s for resume drafts, 240s
  for search-results extraction, 600s for vision) is the most a user waits.
  Model progress means non-whitespace text, tool arguments or reasoning deltas;
  SSE keepalives and whitespace-only JSON output do not restart the idle clock.
  Low-effort resume import stages default to 30s without progress (two missed
  4–15s reasoning-summary intervals), preserving their total budget for retries.
  An explicit idle-timeout setting still wins.
  Resume import also caps each extraction attempt at 60s: the Oct 29 failure
  streamed roughly 130 KB without completing for 300s, so an idle clock alone
  cannot recover it. Healthy one-page reads measured 8–33s. The attempt cap
  retries a non-terminating read inside the existing total budget; it does not
  shorten the total budget or cap resume writing and other model operations.
- Retries with capped exponential backoff (1s doubling to 20s, jitter,
  `Retry-After` honoured) for network errors, idle timeouts, streams closed
  before completion, and HTTP 408/409/425/429/5xx. Never for 4xx validation
  errors, a caller abort, or once the remaining budget cannot fit a retry.
- A gateway that ignores `stream: true` and answers with JSON is still read.
- Timeouts keep the "Model request timed out after Ns" wording the provenance
  and studio copy already key on; an idle timeout says "of silence".
- Operators can tune `NESTOR_AI_IDLE_TIMEOUT_MS`,
  `NESTOR_AI_MAX_ATTEMPTS`, `NESTOR_AI_STREAMING`, and
  `NESTOR_AI_RETRY_BASE_DELAY_MS`; `NESTOR_AI_TIMEOUT_MS` and the
  resume-specific timeout remain the total budgets.

## Consequences

- Slow generations finish instead of being cut; dead connections are noticed
  within the idle window and retried automatically, including mid-generation.
- Fallbacks to the deterministic path now mean the budget was exhausted or
  the failure was permanent, not that a healthy request was abandoned.
- Reasoning summaries add a small token cost on the Responses route.
- Live Assistant keeps its own transport for now; moving it onto the shared
  one is a follow-up.

## Rejected alternatives

- Longer fixed deadlines without streaming: a dead connection would then take
  the whole budget to notice, and mid-generation drops still could not retry.
- Retrying timeouts blindly: doubles the wait on a genuinely slow answer; the
  idle clock retries only when the service has gone quiet.
