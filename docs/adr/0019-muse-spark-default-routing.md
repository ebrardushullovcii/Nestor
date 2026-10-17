# ADR 0019: Muse Spark default routing with DeepSeek V4.1 Flash for aggressive tailoring

## Status

Accepted; supersedes the model selection in ADR 0010. The separate text and
vision route configuration from ADR 0010 stays.

## Context

AI access ships bundled with the product: users never enter a key or choose a
model, so the code defaults are what a packaged build runs with. ADR 0010 chose
DeepSeek V4 Flash for text and GPT-5.6 Luna for images. Since then the owner has
run Muse Spark Contributor on OpenCode Go for every surface, including images,
and routed only aggressive resume tailoring to DeepSeek. OpenCode Go now offers
`deepseek-v4.1-flash`.

## Decision

- Default text, tool-calling, and every vision route (resume scan, browser
  visual analysis, Live Assistant) to `muse-spark-1.3-contributor` through
  the Responses API with `xhigh` reasoning.
- Default aggressive resume tailoring to `deepseek-v4.1-flash` through Chat
  Completions with `high` reasoning, on its own route so the whole aggressive
  lifecycle stays on one provider (ADR 0018).
- Keep every route independently overridable through the existing env vars.
- Keep local Whisper or an explicit audio model for transcription.

## Consequences

- A packaged build with only `NESTOR_AI_API_KEY` set behaves like the
  owner's dogfood setup; no local env file is needed to reproduce it.
- `.env.example`, `docs/AI_PROVIDER_SETUP.md`, and the routing sentences in
  `docs/ARCHITECTURE.md` and `docs/PRODUCT.md` describe this default.
- Missing AI is presented to the user as a temporary outage, never as setup
  they failed to do (the product has no user-facing AI settings).

## References

- ADR 0010: OpenCode Go mixed text and vision routing
- ADR 0018: Aggressive tailoring user-owned claim relaxations
