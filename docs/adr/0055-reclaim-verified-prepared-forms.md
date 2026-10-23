# ADR 0055: Reclaim prepared forms only after verifying an exact refill

Status: accepted (2026-10-23).

## Context

The owner chose to release the oldest prepared form when browser capacity is
needed, then refill it when opened. The former seven-working/fifteen-total
reservation limits and 768 MiB waiting-form admission gate could stop unrelated
work for minutes. Ten replica forms measured about 1.3 GiB working set and
265 MiB private memory on a 16 GiB PC. Five mixed real-board and replica pages
settled at 836 MiB working set and 362 MiB private memory. A real board alone
used 269 MiB working set; a single per-tab estimate does not describe every site.

## Decision

- The native host owns capacity, including reservations. It allows sixteen
  working tabs and sixty-four total. Waiting forms release working capacity.
  Two GiB of waiting-form working sets is a reclamation target, not an
  admission gate. Unknown process metrics do not block unrelated work.
- Hidden retained pages with no active work freeze without discarding their
  DOM or files. Reads, automation commands and displaying a page wake it first. Browser commands
  wait for waking; lifecycle requests are serialized. Active work stays
  load-capable and uses normal background throttling between commands.
- At the target or near the total limit, try prepared forms oldest first.
  Never evict a page being worked on, displayed, lent, or used by the person.
  Before releasing a form, open a guarded duplicate, refill every supported
  native field and known verified attachment, and compare its structure and
  values with the original. Check again that the person has not taken over
  and that the original has not changed. Only then close both renderers and
  keep the small recovery snapshot in main-process memory.
- Opening that application recreates its exact verified form, under the same
  prepare-only guard, and binds the new page to the same application key.
  This makes no model calls and adds no submission authority. Attachment
  bytes are loaded through their original integrity-verifying loaders.
- Passwords, frames, custom widgets, unavailable attachments and forms whose
  structure changes on reopening keep their original page. Multi-step flows
  are not replayed by clicking through old actions. Full AI preparation is
  not retried just to reclaim memory. Recovery snapshots are not persisted
  or exported, and browser Close clears them with the normal page lifecycle.

## Consequences

ADRs 0017, 0024 and 0033 still govern ownership and handoff. ADR 0033's kept-page
rule now permits verified reconstruction of an idle prepared form; it never
permits replacing a sign-in, security check, or page the person is using. If
the site changes after eviction, exact reconstruction fails closed instead of
presenting an incomplete form as ready. Unsupported forms can still reach the
hard resource limits; replaying those needs a separate design and measurement.
