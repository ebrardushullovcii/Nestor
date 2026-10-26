# Public-board search relevance eval

Manual eval; the model run is not part of CI. Personas are entirely synthetic.
Recordings contain public employer pages and feeds, never a candidate workspace,
resume, cookies or credentials. Original URLs, capture times and response statuses
are kept with each response. `corpus.json` checksums the gzip recordings.

```sh
pnpm search:eval
pnpm search:eval --live --tape .tmp/new-search-tape.json --out .tmp/new-search-report.json
```

The default command replays the committed model tape with all network access
disabled. It still executes production collection, screening, full-text reading
and fit. A changed prompt, input or model route cannot reuse an old answer: a
missing exact request hash fails the run. Replay tokens describe the original
provider usage; fresh calls and replay wall time are reported separately.

`--live` uses the configured `NESTOR_AI_*` provider, recorded job pages only,
and at most 40 logical model calls. It refuses to overwrite a tape. Each completed
turn is saved immediately so an interrupted baseline is not silently lost.
Do not run it in a loop. The two personas together are one baseline run.

The labelled cohort is a bounded, deliberately stratified sample, not a claim
of whole-board relevance recall. Frozen observed card facts let ranking be
measured independently of collection coverage. Full original inventories and
the sampled full descriptions are recorded separately. Labels and their reasons
are fixed before the model run. Include related roles, transferable stacks,
country restrictions, management, sales and seniority near misses when extending
the corpus; do not relabel a miss to match a model answer.

The primary end-to-end recall also requires the production collector to find the
listing URL in its recorded inventory. Screening/fit recall is shown separately
to isolate ranking from collection failures. Targets must pass both.

Screening/fit recall counts labelled relevant jobs that survive screening and reading and
receive a fit. Ranking uses all scored, non-hidden sample jobs across boards,
descending score, URL as a deterministic tie-break. Targets: at least 90% recall
and at least eight relevant jobs in the first ten. An unscored job is a miss.
The JSON report includes every disposition and fit, not just summary scores.

Each board gets exact provider tokens by stage (screen, metadata read, fit),
logical calls, model time and local elapsed time. Per-board fitting intentionally
keeps cost attribution exact; the app can batch across boards, so this is not a
900-site cost projection. Provider retries may add usage not present in the
successful reply. Collection is replayed over the full recorded inventories;
missing recordings are explicit failures. A source claiming complete coverage
with no reads or no observed vacancies fails coverage honesty. An empty public
careers page must report incomplete coverage under this conservative invariant.

When refreshing, save only public response bodies and selected observed cards
in the existing recording format, update checksums, then review every sampled
full description and both labels before running AI. Keep past baseline reports
so changes can be compared; record the engine commit and model route each time.

The 2026-10-26 corpus has 59 labelled vacancies (23 broad positives, nine close
positives): Grafana/Greenhouse, Metabase/Lever, Linear, Resend, PostHog and
Ashby on Ashby, Genesys/Workday, Runware/Workable, and plain careers pages at
Automattic and 37signals. 37signals explicitly had no vacancies. Provider feeds
are full inventories; only the labelled cohort is screened and fitted. Workday
and Workable card snapshots come from public inventories, with their public
detail HTML/JSON/Markdown saved alongside. They remain scoreable even if current
collection fails; that failure lowers end-to-end recall. Workable Markdown is
the provider-published full description, not a summary.
