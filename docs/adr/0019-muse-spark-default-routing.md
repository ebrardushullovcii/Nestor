# ADR 0019: DeepSeek V4.1 Flash product routing

## Status

Accepted; amended 2026-11-04 by the owner-selected functionality campaign.
This replaces the earlier Muse text/vision and implicit MiMo title-screen defaults.
Independent role overrides and the separate transcription route remain.

## Context

The earlier default was Muse Contributor via Responses with DeepSeek only for
aggressive tailoring; ADR 0037 later moved the sidebar to DeepSeek. The owner
now selects DeepSeek V4.1 Flash for every product inference role. Baseline search
requests were pinned to this model, so they did not prove normal defaults.
Some HTTP 200 fit responses exhausted output in reasoning or were unusable;
these are incomplete judgments, not evidence that no jobs fit or a provider
outage. Simple synthetic image inputs were accepted by the gateway, while the
assistant's capability table still refused them.

## Decision

- Default text, tools and image routes to `deepseek-v4.1-flash` via Chat
  Completions. Use the existing DeepSeek sidebar's low-effort general default;
  this is a routing baseline, not a quality conclusion from a search contrast.
- Every task follows the person's main reasoning effort unless an explicit
  task or role override is configured. Earlier lower-effort defaults were
  measured under output caps and no longer override that choice. Aggressive
  resume writing retains its independently configured route.
- Declare accepted image-input transport without claiming OCR or visual-task
  accuracy. Keep local Whisper or an explicit audio model for transcription.
- Retain full listing evidence and valid judgments when a row is malformed.
  Retry only unfinished jobs in smaller groups. Saved unfinished fit work has
  an explicit Retry fit action and honest inactive/remaining status.
- Preserve explicit Muse Responses strict-schema handling independently of the
  default constant, so changing defaults cannot accidentally grant a different
  model that verified adapter behavior.

## Consequences

A key-only installation uses the selected route. Existing local overrides need
separate reconciliation; changing source does not change a configured model.
Development probes establish parseability and routing only. Fresh built-app
judgments, continuation, cancellation and later independent grading still
establish whether the search outcome improved. No application authority,
eligibility rule, board-specific policy or release gate changes here.
