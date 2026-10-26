# Public-board search relevance eval

Manual eval; the model run is not part of CI. Personas are entirely synthetic.
Recordings contain public employer pages and feeds, never a candidate workspace,
resume, cookies or credentials. Original URLs, capture times and response statuses
are kept with each response. `corpus.json` checksums the gzip recordings.

```sh
pnpm search:eval
pnpm search:eval --live --tape .tmp/new-search-tape.json --out .tmp/new-search-report.json
```

The default command replays `fit-quality-tape.json.gz` with all network access
disabled. It still executes production collection, screening, full-text reading
and fit under the **recorded model route**. A changed prompt or input cannot
reuse an old answer: a missing exact request hash fails the run. Replay ignores
current provider environment settings and reports historical tokens, not the
cost of a newly configured model. Use an explicit new `--live` recording to
evaluate routing changes. Fresh calls and replay wall time are separate.

`--live` uses the configured `NESTOR_AI_*` provider, recorded job pages only,
with a default budget of 40 logical calls per tape (`--max-calls`, maximum 100).
It refuses an existing tape unless `--resume` is explicit. Resume requires the
same model route and replays every completed judgment; it only calls AI for
missing requests. Each completed turn is saved atomically so an interrupted
baseline is not silently lost.
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

The committed tapes and reports use gzip. The CLI reads JSON or JSON.gz and
writes readable JSON reports. The [original baseline](baseline-2026-10-26.md)
preserves the earlier results. `fit-quality-report.json.gz` records the current
engine: 100% recall for both personas; high-volume top ten 10/10, close-matches
9/10 (previously 7/10). The 18 fit calls were refreshed, with unchanged screen
and metadata requests replayed. Labels and public page recordings are unchanged.

On the same ten boards (including the empty board), provider input plus output
tokens per persona/search are:

| Persona       | Before median/board | After median/board | Before total | After total |
| ------------- | ------------------: | -----------------: | -----------: | ----------: |
| High-volume   |             7,848.5 |              7,702 |       85,872 |      84,400 |
| Close-matches |               5,436 |              5,211 |       63,851 |      64,400 |

Both medians meet the 10k target. The earlier 149,723 total combines two searches,
not one. The schema change has no independently demonstrated large cost saving.
At the observed cohort mean, 897 sites project to **7,570,680** high-volume tokens
or **5,776,680** close-match tokens. These are projections from a small stratified
sample; the actual 897-site total will be measured later during the owner's full
search in the real hunt. Live retries and a different listing volume can change it.
