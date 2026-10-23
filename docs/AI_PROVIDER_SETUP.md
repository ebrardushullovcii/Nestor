# AI provider setup

Nestor uses a mixed OpenCode Go route:

- Muse Spark 1.3 Contributor with `xhigh` reasoning handles text, tool-based
  agent work, and image-capable résumé, browser, and Live Assistant analysis
  through the Responses API.
- DeepSeek V4.1 Flash with `high` reasoning handles aggressive resume tailoring
  only, through Chat Completions.
- Audio transcription remains local Whisper or an explicit audio-model concern.

These are also the code defaults, so a packaged build behaves this way with
only an API key. See ADR 0019; the contract-first agent boundaries from ADR
0009 are unchanged.

## Recommended production setup

Create an OpenCode Go key, then use the same key for both text and vision:

```dotenv
NESTOR_AI_API_KEY=your-opencode-go-key
NESTOR_AI_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_MODEL=muse-spark-1.3-contributor
NESTOR_AI_API_MODE=responses
NESTOR_AI_REASONING_EFFORT=xhigh
# "Read and assess" (a full listing read) uses the effort above. Muse resume
# writing uses medium; other writers keep their route's effort. An optional
# NESTOR_AI_RESUME_WRITER_REASONING_EFFORT overrides either writer.
# Other repeated work has its own variable (code defaults shown).
# Search and source-check turns:
NESTOR_AI_SEARCH_REASONING_EFFORT=low
# Reading the jobs on a page:
NESTOR_AI_PAGE_READ_REASONING_EFFORT=low
# Fit judged in batches during and after a search:
NESTOR_AI_FIT_REASONING_EFFORT=medium
# Fact checks of resume lines and of written application answers:
NESTOR_AI_CLAIM_CHECK_REASONING_EFFORT=medium
# Application form turns, reading a form's questions, and checking short
# form values (a date, a number, a chosen option) that are not about
# eligibility, pay or a declaration:
NESTOR_AI_APPLY_REASONING_EFFORT=low
# "Read and assess"; unset means NESTOR_AI_REASONING_EFFORT:
# NESTOR_AI_LISTING_READ_REASONING_EFFORT=high
# Other tool-calling work (resume import sections, the profile and resume
# assistants, letters). It does not change the tasks above.
NESTOR_AI_AGENT_REASONING_EFFORT=low

# Aggressive resume tailoring runs on its own dedicated route so the whole
# aggressive lifecycle (draft, re-tailor, and model-backed review/regenerate)
# stays on one provider. Its writer and edits use this route's effort, except
# Muse writing as described above. Fact checks use the check effort.
NESTOR_AI_AGGRESSIVE_MODEL=deepseek-v4.1-flash
NESTOR_AI_AGGRESSIVE_API_MODE=chat_completions
NESTOR_AI_AGGRESSIVE_REASONING_EFFORT=high

NESTOR_AI_VISION_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_VISION_MODEL=muse-spark-1.3-contributor
NESTOR_AI_VISION_API_MODE=responses
NESTOR_AI_VISION_REASONING_EFFORT=xhigh
NESTOR_RESUME_VISION_MODEL=muse-spark-1.3-contributor
NESTOR_RESUME_VISION_REASONING_EFFORT=xhigh
NESTOR_BROWSER_VISION_MODEL=muse-spark-1.3-contributor
NESTOR_BROWSER_VISION_REASONING_EFFORT=xhigh
NESTOR_INTERVIEW_AI_MODEL=muse-spark-1.3-contributor
NESTOR_INTERVIEW_AI_API_MODE=responses
NESTOR_INTERVIEW_REASONING_EFFORT=xhigh
NESTOR_INTERVIEW_VISION_MODEL=muse-spark-1.3-contributor
NESTOR_INTERVIEW_VISION_API_MODE=responses
NESTOR_INTERVIEW_VISION_REASONING_EFFORT=xhigh
```

Use the raw API model IDs shown above. The `opencode-go/...` prefix is only for
OpenCode's own configuration file, not direct HTTP API requests. Provider
output remains locally parsed and schema-validated before it can modify Job
Finder state.

Audio configuration is intentionally not included in this mixed provider routing.
Keep local Whisper or an explicit audio-capable transcription model configured
for Live Assistant audio.

## Muse Contributor route details

Muse Spark Contributor is the product route for shared text, tool-based agent
work, and image-capable surfaces. Muse Contributor accepts image input on this
route, so Luna is not needed (the block below shows the 1.2 ids; 1.3 is the
current default):

```dotenv
NESTOR_AI_API_KEY=your-opencode-go-key
NESTOR_AI_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_MODEL=muse-spark-1.2-contributor
NESTOR_AI_API_MODE=responses
NESTOR_AI_REASONING_EFFORT=xhigh

NESTOR_AI_VISION_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_VISION_MODEL=muse-spark-1.2-contributor
NESTOR_AI_VISION_API_MODE=responses
NESTOR_AI_VISION_REASONING_EFFORT=xhigh
```

The shared text variables cover Job Finder generative work, browser-agent
tool loops, and Live Assistant text unless a narrower override is present.
The shared vision variables cover resume visual analysis, browser visual
analysis, and Live Assistant screenshot analysis unless a narrower override
is present. Audio transcription remains local Whisper or a separately
configured audio model.

OpenCode Go serves `muse-spark-1.2-contributor` on the Responses API
(`https://opencode.ai/zen/go/v1/responses`). Chat Completions is the wrong
transport for this model and can drop tool-call streams. This is a temporary
dogfood override, not an end-to-end capability, quality, privacy, or release
acceptance result.

`muse-spark-1.2-contributor` is the discounted Go contributor model, not the
zero-cost Zen route `muse-spark-1.2-contributor-free`. OpenCode's published
terms state that prompts and completions on the contributor route may be used
to train future Meta models. Do not send a private resume, credentials,
application answers, interview media, or other personal/confidential data
through this route without explicit informed user consent. Use synthetic data
for initial testing. Keep the API key only in ignored `.env.local`, never
documentation or tracked examples, and rotate any temporary key shared through
a conversation.

Live Job Finder search during a desktop test-API session also requires
`NESTOR_TEST_API_USE_LIVE_AI=1` for model/tool escalation.
`NESTOR_ENABLE_TEST_API=1` alone forces the deterministic client (no
`chatWithTools`). Discovery still runs the ADR 0013 compact-first page scan and
can finish with zero-new / already-saved results when that scan finds listings;
model escalation is unavailable until live AI is enabled.

ADR 0010 remains the accepted production route until synthetic capability
tests, privacy review, and owner acceptance justify a new routing decision.
If Muse Contributor on Go is adopted beyond temporary dogfood, update ADR 0010
(or supersede it), the recommended production setup above, `.env.example`, and
provider acceptance evidence together.

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

Keep Go with Muse Contributor on the Responses API:

```dotenv
NESTOR_AI_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_MODEL=muse-spark-1.2-contributor
NESTOR_AI_API_MODE=responses
NESTOR_AI_VISION_BASE_URL=https://opencode.ai/zen/go/v1
NESTOR_AI_VISION_MODEL=muse-spark-1.2-contributor
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
because they execute offline. The release acceptance harness additionally
strips every `NESTOR_INTERVIEW_*_API_KEY` variable plus the shared
`NESTOR_AI_API_KEY`, `NESTOR_AI_VISION_API_KEY`, and
`NESTOR_RESUME_VISION_API_KEY` keys (and this opt-in) from its launch
environment, so no ambient developer-shell credential can win. The Job Finder
resume benchmarks keep their own documented `--use-configured-ai`
`NESTOR_TEST_API_USE_LIVE_AI` exceptions; this Live Assistant switch is
separate and narrower.

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

## Compatibility fallback

A legacy provider can still be used explicitly:

```dotenv
NESTOR_AI_API_MODE=chat_completions
```

That mode is now the intended DeepSeek text route. Keep Luna image work on the
separate Responses route.

## Reliability on slow or dropping connections

Every Job Finder model call (structured JSON, agent tool turns, resume and
browser vision) goes through one transport
(`packages/ai-providers/src/model-request-transport.ts`, ADR 0020):

- Requests are streamed. On the Responses route the model is asked for
  reasoning summaries, whose events keep the connection visibly alive while
  it thinks; on Chat Completions the reasoning deltas do the same.
- Two clocks: an idle clock (`NESTOR_AI_IDLE_TIMEOUT_MS`, default 120s of
  silence) retries an attempt that has gone quiet, and a total clock
  (`NESTOR_AI_TIMEOUT_MS`, default 300s; `NESTOR_AI_RESUME_TIMEOUT_MS`,
  default 600s) caps the whole wait across attempts.
- Retries (`NESTOR_AI_MAX_ATTEMPTS`, default 5) cover network errors, idle
  timeouts, streams the gateway closed before completing, and HTTP
  408/409/425/429/5xx, with backoff from `NESTOR_AI_RETRY_BASE_DELAY_MS`
  (default 1s) doubling to 20s and honouring `Retry-After`. Validation errors
  (4xx) and user cancellations are never retried.
- `NESTOR_AI_STREAMING=0` sends plain JSON requests; use it only for a
  gateway that rejects `stream: true`, since it removes the liveness signal.

When a call still fails, the deterministic fallback runs and the note says
"timed out after Ns" (budget exhausted) or "of silence" (the service went
quiet), so the cause is visible in the studio and in import notes.

## Verification

With a configured OpenCode Go key:

1. confirm `GET https://opencode.ai/zen/go/v1/models` is reachable;
2. run `pnpm validate:package ai-providers`;
3. open Settings and confirm the normal provider reports
   `deepseek-v4-flash`;
4. use synthetic candidate data for the first resume, vision, and tool-loop
   smoke checks;
5. preserve the application safety boundary: final submission authorization
   stays false regardless of provider.
