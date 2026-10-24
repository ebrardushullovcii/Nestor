# ADR 0068: Discovery commands return run facts

Status: accepted (2026-10-24).

Find jobs follows committed row changes. Search and Stop therefore expose typed
command replies containing only the terminal outcome, run identity, new-job
count and cancellation acknowledgement. They execute the existing pipeline,
plan terminal accounting and company reconciliation without constructing a
workspace snapshot. Activity events retain their live run identity and progress.

While search runs, legacy windows receive one final refresh nudge instead of a
nudge per activity event. Main listeners still receive updates. An explicit
legacy display read reuses its previous complete projection when available;
canonical reads, recovery and exports remain complete and current. A window
without a previous projection can obtain its first complete view. Query pages
remain current through the independent read process and transactional feed.
