# AI provider setup

The owner-selected default for all product inference is `deepseek-v4.1-flash`
on OpenCode Go through Chat Completions. Text, tools, assistant, resume vision,
browser vision and Live Assistant text/screenshots use this route unless an
explicit existing role override is configured. There is no implicit MiMo or
Contributor fallback. Audio transcription remains local Whisper or an explicit
audio model.

## Production defaults and overrides

Only `NESTOR_AI_API_KEY` is needed for the code defaults. Existing local model,
API and effort variables still override code defaults; updating source does not
change a configured installation. Check those role overrides when adopting this
route. Keep credentials in ignored local configuration, never in evidence.

```dotenv
NESTOR_AI_API_KEY=your-opencode-go-key
NESTOR_AI_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_MODEL=deepseek-v4.1-flash
NESTOR_AI_API_MODE=chat_completions
NESTOR_AI_REASONING_EFFORT=low
NESTOR_AI_AGENT_REASONING_EFFORT=low
NESTOR_AI_FIT_REASONING_EFFORT=none
NESTOR_AI_LISTING_SCREEN_REASONING_EFFORT=none
NESTOR_AI_SEARCH_REASONING_EFFORT=low
NESTOR_AI_PAGE_READ_REASONING_EFFORT=low
NESTOR_AI_APPLY_REASONING_EFFORT=low
NESTOR_AI_CLAIM_CHECK_REASONING_EFFORT=medium
# Unset listing-read and resume-writer effort inherits the route's effort.
NESTOR_AI_AGGRESSIVE_MODEL=deepseek-v4.1-flash
NESTOR_AI_AGGRESSIVE_API_MODE=chat_completions
NESTOR_AI_AGGRESSIVE_REASONING_EFFORT=high
NESTOR_AI_VISION_MODEL=deepseek-v4.1-flash
NESTOR_AI_VISION_API_MODE=chat_completions
NESTOR_AI_VISION_REASONING_EFFORT=low
# Narrow overrides, if set, must also name the intended route:
# NESTOR_RESUME_VISION_MODEL=deepseek-v4.1-flash
# NESTOR_RESUME_VISION_API_MODE=chat_completions
# NESTOR_BROWSER_VISION_MODEL=deepseek-v4.1-flash
# NESTOR_BROWSER_VISION_API_MODE=chat_completions
# NESTOR_AI_ASSISTANT_MODEL=deepseek-v4.1-flash
# NESTOR_AI_ASSISTANT_API_MODE=chat_completions
# NESTOR_INTERVIEW_AI_MODEL=deepseek-v4.1-flash
# NESTOR_INTERVIEW_AI_API_MODE=chat_completions
# NESTOR_INTERVIEW_VISION_MODEL=deepseek-v4.1-flash
# NESTOR_INTERVIEW_VISION_API_MODE=chat_completions
```

Fit batches and title screens have role-specific effort so structured judgments
can finish within the answer budget. A provider's HTTP 200 with incomplete
output is unfinished technical work, not a score or evidence of exhaustion.
Valid fit rows are retained; incomplete rows stay unscored. **Retry fit** in Find
jobs scores saved full listings without rereading sites; **Stop fit** sends no
more. A fit request already sent is paid for, so after Stop, or when a new
search takes over, it finishes and keeps its answers; only quitting the app
cancels it. A later Search also picks up unfinished fits while reusing unchanged
listings, and never asks again about a listing whose request is still out or
whose stored answer is for the same inputs.

The gateway accepted simple synthetic image input on this DeepSeek route. The
assistant capability declares that transport support; it does not establish
resume OCR, browser grounding or Live Assistant quality. Each feature still
needs its own acceptance. Explicit Contributor alternatives below are legacy
operator choices, not automatic fallback or the production default. Muse's
verified strict-schema Responses adapter remains available only when explicitly
selected. It must not be inferred from the new default model name.

Live Job Finder search during a desktop test-API session also requires
`NESTOR_TEST_API_USE_LIVE_AI=1` for model/tool escalation.
`NESTOR_ENABLE_TEST_API=1` alone forces the deterministic client (no
`chatWithTools`). Discovery still runs the ADR 0013 compact-first page scan and
can finish with zero-new / already-saved results when that scan finds listings;
model escalation is unavailable until live AI is enabled.

ADR 0019 supersedes ADR 0010 for model selection; the independent text and
vision configuration remains.

## Manual Zen fallback when Go quota is exhausted

This is **operational guidance for agents and developers**, not application
behavior. Nestor does **not** auto-switch AI routes, rotate models, or
recover from quota errors at runtime. When Go usage is exhausted or rate
limited, edit ignored `.env.local` manually and restart the desktop app.

### Endpoints

| Route              | Base URL                        | Billing                 |
| ------------------ | ------------------------------- | ----------------------- |
| **Go (primary)**   | `https://opencode.ai/zen/go/v1` | Paid contributor quota  |
| **Zen (fallback)** | `https://opencode.ai/zen/v1`    | Free tier (`cost: "0"`) |

The same OpenCode API key works on both endpoints.

### Primary (local dogfood default)

Explicit legacy alternative: Go with Muse Contributor on the Responses API:

```dotenv
NESTOR_AI_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_MODEL=muse-spark-1.3-contributor
NESTOR_AI_API_MODE=responses
NESTOR_AI_VISION_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_VISION_MODEL=muse-spark-1.3-contributor
NESTOR_AI_VISION_API_MODE=responses
```

### When Go quota or rate limit is hit

Switch **all** shared base URLs in `.env.local` to Zen and point each surface
at the appropriate free model:

```dotenv
NESTOR_AI_BASE_URL=https://opencode.ai/zen/v1
NESTOR_AI_MODEL=deepseek-v4-flash-free
NESTOR_AI_API_MODE=chat_completions

NESTOR_AI_VISION_BASE_URL=https://opencode.ai/zen/v1
NESTOR_AI_VISION_MODEL=muse-spark-1.2-contributor-free
NESTOR_AI_VISION_API_MODE=responses
```

- **Text / tool loops:** `deepseek-v4-flash-free` via Chat Completions (no
  vision).
- **Vision surfaces** (resume, browser, Interview screenshots):
  `muse-spark-1.2-contributor-free` via Responses (has vision input).

### Rotating on Zen rate limits

If Zen returns HTTP 429, manually swap the **text** model in `.env.local`:

1. Start with `deepseek-v4-flash-free` (Chat Completions).
2. On rate limit, switch text to `muse-spark-1.2-contributor-free`
   (Responses, `NESTOR_AI_API_MODE=responses`).
3. On the next rate limit, switch back to `deepseek-v4-flash-free`.

Keep vision on `muse-spark-1.2-contributor-free` throughout — DeepSeek Free
does not accept image input. Restart the app after each change.

### Operator caveats

- **Tool calling:** Zen free models may not reliably stream tool calls.
  Discovery and browser-agent loops that depend on `chatWithTools` can fail or
  behave differently on the free tier. Go Muse Contributor is the safer route
  for tool-based work.
- **Not a product feature:** Do not add automatic route rotation, fallback
  env vars, or retry logic to `packages/ai-providers` for this workflow.
- **Signals to watch for:** HTTP 401 with insufficient balance / credits,
  `CreditsError`, or HTTP 429 on Go → time to switch to Zen manually.
- **Privacy:** Zen free contributor models may be used for model training per
  OpenCode terms. Use synthetic data until you accept that tradeoff.

## Desktop test API precedence for Live Assistant

With `NESTOR_ENABLE_TEST_API=1`, Live Assistant providers resolve to the
deterministic runtime regardless of ambient interview or shared credentials.
Live AI during a test-API run requires the explicit, narrowly named opt-in:

```dotenv
NESTOR_INTERVIEW_TEST_USE_LIVE_AI=1
```

Production runs with the test API absent keep configured behavior unchanged,
and explicitly configured local STT commands stay available under the test API
because they execute offline. Job Finder uses
`NESTOR_TEST_API_USE_LIVE_AI=1`; the retained resume-import benchmark also
accepts `--use-configured-ai`. The old resume-quality benchmark hook was
removed; use the resume lane in `docs/TESTING.md`.

## Local Codex subscription proxy

For local evaluation without a separate OpenAI Platform key, use the pinned
[openai-oauth](https://github.com/EvanZhouDev/openai-oauth) npm proxy. It is
an unofficial community integration, so keep it loopback-only and do not
deploy it as a shared service. Version 2.0.0 exposes both /v1/responses and
/v1/chat/completions, discovers the models available to the current Codex
account, and reads the same local Codex OAuth file.

Start and verify the proxy:

    npx --yes openai-oauth@2.0.0 login
    npx --yes openai-oauth@2.0.0 --host 127.0.0.1 --port 10531 --detach
    npx --yes openai-oauth@2.0.0 status
    Invoke-RestMethod http://127.0.0.1:10531/v1/models

If Codex is already signed in locally, the explicit login step may not be
needed. The client key is a non-secret placeholder because the proxy is bound
to loopback:

    NESTOR_AI_API_KEY=unused
    NESTOR_AI_BASE_URL=http://127.0.0.1:10531/v1
    NESTOR_AI_MODEL=gpt-5.6-luna
    NESTOR_AI_API_MODE=responses
    NESTOR_AI_REASONING_EFFORT=high
    NESTOR_RESUME_VISION_MODEL=gpt-5.6-luna

Before using it with candidate data:

- keep the host fixed to 127.0.0.1, never a LAN or public interface;
- pin and review the package version instead of executing an unbounded latest
  version in repeatable workflows;
- verify gpt-5.6-luna appears in /v1/models;
- verify text, image input, structured output, tools, and high reasoning using
  synthetic data;
- do not use this bridge for the normal OpenCode Go production route;
- stop the local proxy when it is no longer needed:

  npx --yes openai-oauth@2.0.0 stop

## Choosing the provider: one env block

The provider is chosen only in the env file (`.env.local`, gitignored). There
is no in-app switcher, setting or runtime toggle. Keep exactly one of the
blocks below uncommented, put that provider's key in its
`NESTOR_AI_API_KEY`, and restart Nestor. Never put keys in docs or evidence.

What each line means:

| Line                                     | Meaning                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NESTOR_AI_API_KEY`                      | The provider's API key.                                                                                                             |
| `NESTOR_AI_BASE_URL`                     | The provider's API root. Vision, the assistant and Live Assistant use it too unless their own `_BASE_URL` is set.                   |
| `NESTOR_AI_MODEL`                        | Model for text, tools, search, fit, screening, apply and resume work.                                                               |
| `NESTOR_AI_API_MODE`                     | Wire protocol: `chat_completions`, `responses` or `messages` (Anthropic).                                                           |
| `NESTOR_AI_REASONING_EFFORT`             | Effort for every task without its own `NESTOR_AI_<TASK>_REASONING_EFFORT` (search, page reads, fit, screening, apply, resume work). |
| `NESTOR_AI_AGENT_REASONING_EFFORT`       | Effort for model requests that name no task.                                                                                        |
| `NESTOR_AI_AGGRESSIVE_*`                 | The separate aggressive resume-tailoring route (ADR 0019).                                                                          |
| `NESTOR_AI_VISION_*`                     | Resume and browser vision, and Live Assistant screenshots.                                                                          |
| `NESTOR_AI_ASSISTANT_MODEL`, `_API_MODE` | The Job Finder assistant sidebar.                                                                                                   |

Task efforts (`NESTOR_AI_FIT_REASONING_EFFORT` and the others above) and the
narrow role overrides (`NESTOR_RESUME_VISION_*`, `NESTOR_BROWSER_VISION_*`,
`NESTOR_INTERVIEW_*`, `NESTOR_AI_VISION_BASE_URL`,
`NESTOR_AI_ASSISTANT_BASE_URL`) apply to whichever block is active. If you set
one, make it name the same provider, or leave it unset to inherit.

### 1. OpenCode Go: DeepSeek V4.1 Flash (default)

The block under "Production defaults and overrides" above, with the code's
default efforts. The roles that block leaves unset (the assistant and the
narrow overrides) already default to this route. To run it at another effort,
change the `_REASONING_EFFORT` lines, for example to `high`.

OpenCode Go caches prompt prefixes on its side; Job Finder sends its
`x-opencode-session` header so a conversation stays on one upstream.

### 2. OpenAI: GPT-6.2 Sol through the Responses API

```dotenv
NESTOR_AI_API_KEY=your-openai-key
NESTOR_AI_BASE_URL=https://api.openai.com/v1
NESTOR_AI_MODEL=gpt-6.2-sol
NESTOR_AI_API_MODE=responses
NESTOR_AI_REASONING_EFFORT=medium
NESTOR_AI_AGENT_REASONING_EFFORT=medium
NESTOR_AI_AGGRESSIVE_MODEL=gpt-6.2-sol
NESTOR_AI_AGGRESSIVE_API_MODE=responses
NESTOR_AI_AGGRESSIVE_REASONING_EFFORT=medium
NESTOR_AI_VISION_MODEL=gpt-6.2-sol
NESTOR_AI_VISION_API_MODE=responses
NESTOR_AI_VISION_REASONING_EFFORT=medium
NESTOR_AI_ASSISTANT_MODEL=gpt-6.2-sol
NESTOR_AI_ASSISTANT_API_MODE=responses
```

Responses streams reasoning summaries, which keep a long thought visibly
alive. JSON tasks use JSON mode; strict schemas are sent only on the verified
Muse route.

### 3. Claude: Opus 5.5 through Anthropic's native Messages API

```dotenv
NESTOR_AI_API_KEY=your-anthropic-key
NESTOR_AI_BASE_URL=https://api.anthropic.com/v1
NESTOR_AI_MODEL=claude-opus-5-5
NESTOR_AI_API_MODE=messages
NESTOR_AI_REASONING_EFFORT=medium
NESTOR_AI_AGENT_REASONING_EFFORT=medium
NESTOR_AI_AGGRESSIVE_MODEL=claude-opus-5-5
NESTOR_AI_AGGRESSIVE_API_MODE=messages
NESTOR_AI_AGGRESSIVE_REASONING_EFFORT=medium
NESTOR_AI_VISION_MODEL=claude-opus-5-5
NESTOR_AI_VISION_API_MODE=messages
NESTOR_AI_VISION_REASONING_EFFORT=medium
NESTOR_AI_ASSISTANT_MODEL=claude-opus-5-5
NESTOR_AI_ASSISTANT_API_MODE=messages
```

Use `messages`, not `chat_completions`, with Anthropic. Anthropic's
OpenAI-compatible endpoint has no prompt caching, rejects
`response_format: json_object` with HTTP 400, ignores `reasoning_effort` and
returns no thinking. That is why the native mode exists: it speaks Messages
through the official `@anthropic-ai/sdk`
(`packages/ai-providers/src/anthropic-messages.ts`) with the same tools,
facts, retries, idle clock and `[AI request]`/`[AI usage]` records as the
other routes:

- **Caching.** One `cache_control` breakpoint closes tools + system on every
  request. A conversation (an agent loop, the assistant, the resume writer:
  any request with tools, or with an earlier assistant turn) also sets
  top-level automatic caching, so each turn's request is the next turn's
  cached prefix. A one-shot request (no tools, or `oneShot` from its caller,
  as fit, screening and page reads send) never caches its per-call end, since
  a cache write costs more than uncached input: only tools + system and the
  messages before its last are cached, plus its `stableLead`, the opening of
  its last message that repeats across the work (fit sends the person's
  facts). Once such a request takes a tool turn it caches as a conversation.
- **Thinking.** Always on (adaptive, summarized so long thoughts keep the
  stream alive). Each assistant turn's content blocks, thinking signatures
  included, return unchanged on the next turn.
- **Append-only history.** The API reads the cache only at breakpoints and
  an edit to an earlier message drops every later thinking block, so each
  reply on this route asks the agent loop to keep the conversation
  append-only: superseded page views are not folded to receipts, and the
  apply agent states its saved-answer library where it changed instead of
  re-adding it at the end of every request. Each turn's request then starts
  with the previous one word for word. A turn the app has rewritten anyway
  (compaction at the model window) is rebuilt without its thinking, and
  `prefix_mismatch_behavior: "drop_block"` keeps that request working.
- **Effort** goes in `output_config.effort` from the route or task effort.
  `none` becomes `low`, the lowest Messages offers.
- **JSON.** A request with a schema uses `output_config.format`, through the
  SDK's schema transform. Other JSON tasks ask for JSON in their prompt. The
  schema is part of the cached prefix, so a schema that changes per request
  is written to the cache each time.
- **Refusals.** `fallbacks: "default"` lets the API retry a policy decline on
  another model inside the request. A refusal after that fails the request
  with its category, without a retry. 401, 402 and 403 are the usual access
  failures.
- **Output.** `max_tokens` is the model's published output limit (128K).
- **Tool schemas.** The API rejects `allOf`, `anyOf` and `oneOf` at the top
  of a tool's `input_schema`. Such a schema (pointer's conditional
  requirements, for example) is sent as one object of every alternative's
  properties, with the original rule in its description; the tool still
  validates its input.

In `[AI usage]`, `inputTokens` includes cache reads and writes, as on the
other routes. `cachedInputTokens` is Anthropic's `cache_read_input_tokens`,
and `cacheWriteInputTokens` is `cache_creation_input_tokens`. `cache-report`
reads the hit rate from the first two. Opus 5.5 bills uncached input at
$4/MTok, cache writes at $5, cache reads at $0.20 and output at $20.

## Compatibility fallback

A legacy provider can still be used explicitly:

```dotenv
NESTOR_AI_API_MODE=chat_completions
```

That mode is the dedicated aggressive DeepSeek route. Keep explicitly selected Muse image work
on the separate Responses route.

## Reliability on slow or dropping connections

Every Job Finder model call (structured JSON, agent tool turns, resume and
browser vision) goes through one transport
(`packages/ai-providers/src/model-request-transport.ts`, ADRs 0020 and 0079):

- Requests are streamed. On the Responses route the model is asked for
  reasoning summaries, whose events keep the connection visibly alive while
  it thinks; on Chat Completions the reasoning deltas do the same.
- The idle clock (`NESTOR_AI_IDLE_TIMEOUT_MS`, default 180s without model
  progress) retries a silent connection. Resume import stages use 30s without
  progress unless explicitly configured. Text, tool arguments and reasoning
  deltas keep a working stream alive; keepalives and whitespace do not.
- Model requests, agent turns/tasks, checker calls and search source/run work
  have no default absolute deadline. Optional operator settings
  `NESTOR_AI_TIMEOUT_MS`, `NESTOR_AI_RESUME_TIMEOUT_MS`,
  `NESTOR_AI_ASSISTANT_TIMEOUT_MS`, `NESTOR_RESUME_VISION_TIMEOUT_MS` and
  `NESTOR_BROWSER_VISION_TIMEOUT_MS` still apply when explicitly set.
  Stop cancels the request, including during reconnect backoff.
- Retries continue until success or Stop for network errors, idle
  timeouts, streams the gateway closed before completing, and HTTP
  408/409/425/429/5xx, with backoff from `NESTOR_AI_RETRY_BASE_DELAY_MS`
  (default 1s) doubling to 20s. A provider's `Retry-After` or advised delay in
  its capacity error body is waited in full, even when longer than 20s.
  Calls sharing the same endpoint, credentials and model share the cooldown.
  The screen says "Waiting for the AI provider" during this wait. Validation
  errors (4xx), rejected credentials and exhausted account quota fail immediately
  with the provider's message. `NESTOR_AI_MAX_ATTEMPTS` no longer limits work.
- `NESTOR_AI_STREAMING=0` sends plain JSON requests; use it only for a
  gateway that rejects `stream: true`, since it removes the liveness signal.

When a call still fails, the error says "of silence" when the service went
quiet, or "timed out after Ns" when an explicit operator timeout was reached. Resume writing and import
report failure rather than silently substituting a rule-made result.

## Verification

With a configured OpenCode Go key:

1. confirm `GET https://opencode.ai/zen/go/v1/models` is reachable;
2. run `pnpm validate:package ai-providers`;
3. check the resolved route against the selected `deepseek-v4.1-flash` default (or an explicit override)
   (or the explicit environment override); Settings has no model picker;
4. use synthetic candidate data for the first resume, vision, and tool-loop
   smoke checks;
5. preserve the application safety boundary: final submission authorization
   stays false regardless of provider.
