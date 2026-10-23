# ADR 0036: Parallel application preparation

Status: accepted (2026-09-26).

Amended 2026-10-23 for the owner's Apply speed work: preparation uses up to 16
workers, bounded by the browser's working-tab capacity. The environment override
accepts 1 through 16; site ownership and serialized final sends are unchanged.
The ten-job run ceiling from ADR 0012 is replaced by a 1,000-job safety ceiling;
the saved daily limit still controls admission and defaults to twenty. Apply to
all can therefore start every selected job that fits the person's daily limit.

A model may request `finishWhenReady` with its final `fill_fields` call. The same
live readiness, answer, attachment and submission preflight checks run; this
combines the model's fill and finish decisions without granting send authority.
Duplicate observations after an already observed Continue are not repeated;
fresh observations before writes and at final verification remain mandatory.

An answer explicitly saved for reuse is also applied to unanswered matching
questions in other open applications of that batch, using their own durable
answer records and normal continuation path. Question kind, choices and control
type must match; eligibility also keeps the same job location. Application-only
answers and existing peer answers are preserved. Running applications refresh
the shared answer bank before proposing a write; semantic and authority checks
remain in the executor.

Supersedes the sequential-applying paragraph of ADR 0035.

## Context

The owner asked to prepare applications concurrently and test higher limits without changing the existing applying modes or adding routine interactions. The old queue and browser lock assumed one active application.

## Decision

- Apply to all prepares up to two applications concurrently. The browser enforces the limit across runs. An internal environment override allows one through five workers for controlled testing; there is no new user setting.
- Each application owns its page and result. Different sites can overlap; applications on the same site share one execution slot. Site ownership follows navigation and redirects before further form work. Waiting for another site releases the previous site's ownership to avoid crossed-redirect deadlocks.
- A prepared, parked, or person-held page stays protected after its worker finishes. The first useful application page replaces the empty startup tab's selection; later background tabs preserve the selected page. New application tabs reserve capacity and leave one of the embedded browser's eight slots for a popup. A full browser waits briefly, then reports that a tab must be closed; it never evicts another form.
- Batch counts come from saved job results, irrespective of finish order. A job needing the person or failing releases its worker so other eligible jobs can continue. Finish current lets active preparations finish and pauses new starts. Stop cancels active work. Cleanup waits for all workers.
- Final sends are serialized across the workspace, including a person's Send press. Each send rechecks current settings, the matching active permission, resume and page binding, then runs the existing preflight and durable submission protocol. Cancellation while waiting cannot bypass this gate. An uncertain submission remains uncertain and is never retried automatically.
- A final send holds its prepared page's site slot before entering the workspace authority gate. Additive job grants and reviewed ATS origins use that same authority gate. This order lets preparation request a reviewed origin without waiting behind a send that is itself waiting for the site. An envelope already used by a preflight is replaced atomically, preserving its scope and answer policy while adding only reviewed permissions. Explicit revocation and Settings changes can still veto a send.
- Concurrent permission extensions merge against the latest saved scope. A stale prepared page can follow only a replacement made by this process; revocation gives it no replacement to follow. Changing the application mode does not carry permission from the previous mode into the new one.

## Consequences

The existing one-press batch and three application modes remain. Parallel preparation does not authorize sending, creating accounts, or answering a person's security checks. Shared-site serialization, provider limits, and occupied tabs can reduce throughput below the worker limit. Five preparation workers are an experiment rather than a promise that every five-site combination can run together.
