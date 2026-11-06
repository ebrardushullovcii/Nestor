# ADR 0020: Streamed model requests with idle and total budgets

## Status

Accepted.

Status update (2026-11-06): partly superseded by [ADR 0079](0079-job-finder-is-a-harness.md). Its harness decision wins wherever this ADR disagrees; see its per-ADR supersession list for the provisions replaced and retained.

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
- An idle clock (default 180s without model progress) presumes the connection
  dead and retries. Text, tool arguments and reasoning deltas reset it;
  keepalives and whitespace-only output do not. Resume import stages use 30s
  without progress unless an explicit idle setting overrides it.
- Under ADR 0079, working model requests and agent turns/tasks have no default
  total or per-attempt deadline. Resume import, vision, nested checks and
  search source/run work follow the same rule. The previous 60s resume-import
  attempt cap and 300s/600s totals cut healthy streaming answers off and are
  removed. Explicit operator timeout settings still apply, with no default.
- Network errors, idle timeouts, incomplete streams and HTTP 408/409/425/429/5xx
  reconnect with exponential backoff (1s doubling to 20s, jitter and
  `Retry-After`). Under ADR 0079 these reconnects have no attempt budget, including
  repeated idle connections. Provider capacity refusals in successful HTTP error
  bodies also retry. Provider-requested waits are not capped; calls on the same
  endpoint, credentials and model share their cooldown. Caller cancellation,
  exhausted quota, rejected credentials and 4xx validation errors do not retry.
- A gateway that ignores `stream: true` and answers with JSON is still read.
- Timeouts keep the "Model request timed out after Ns" wording the provenance
  and studio copy already key on; an idle timeout says "of silence".
- Operators can tune `NESTOR_AI_IDLE_TIMEOUT_MS`,
  `NESTOR_AI_STREAMING`, and
  `NESTOR_AI_RETRY_BASE_DELAY_MS`; `NESTOR_AI_TIMEOUT_MS` and the
  resume-specific timeout are optional operator deadlines with no default.

## Consequences

- Slow generations finish instead of being cut; dead connections are noticed
  within the idle window and retried automatically, including mid-generation.
- A failed connection reconnects until it succeeds or the person stops it.
  Waiting for the provider is visible progress, and enclosing idle detection
  does not mistake an intentional provider wait for a dead connection.
- Reasoning summaries add a small token cost on the Responses route.
- Live Assistant keeps its own transport for now; moving it onto the shared
  one is a follow-up.

## Rejected alternatives

- Longer fixed deadlines without streaming: a dead connection would then take
  the whole budget to notice, and mid-generation drops still could not retry.
- Retrying timeouts blindly: doubles the wait on a genuinely slow answer; the
  idle clock retries only when the service has gone quiet.
