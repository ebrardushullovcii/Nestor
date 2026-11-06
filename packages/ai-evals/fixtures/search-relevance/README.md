# Public-board search relevance eval

Manual eval; the model run is not part of CI. Personas are entirely synthetic.
Recordings contain public employer pages and feeds, never a candidate workspace,
resume, cookies or credentials. Original URLs, capture times and response statuses
are kept with each response. `corpus.json` checksums the gzip recordings.

```sh
pnpm search:eval
pnpm search:eval --live --tape .tmp/new-search-tape.json --out .tmp/new-search-report.json
```

The default command replays `fit-region-tape.json.gz` with all network access
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

The 2026-10-26 corpus has 59 labelled vacancies (22 broad positives, eight close
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
preserves the earlier results. New tapes pin `assessmentDate`, so replay uses the
same eligibility date rather than silently changing the fit request each day.

The 2026-11-06 scorer 8 fit refresh uses the same frozen listings, personas, labels and
screen/read replies before and after the fit change. The configured route was
OpenCode Go / Muse Spark Contributor, Responses API, with the default low fit
effort. Only the 18 fit calls were refreshed. No listing or label was changed.

| Persona       | Before recall | After recall | Before relevant in top 10 | After relevant in top 10 |
| ------------- | ------------- | ------------ | ------------------------- | ------------------------ |
| High-volume   | 21/22 (95.5%) | 22/22 (100%) | 8/10                      | 9/10                     |
| Close-matches | 7/8 (87.5%)   | 8/8 (100%)   | 6/10                      | 8/10                     |

These numbers hold for screening/fit and end-to-end collection. Coverage honesty
was 10/10 before and after. The old fit response schema allowed values such as
`annually` and `salary` that its validator rejected; the refreshed contract gives
every status, interval and pay basis its actual allowed values. Invalid rows get
one repair with their validation issues. Repeated response truncation is an error,
not an empty or partially accepted answer. Fit still uses model judgment, not a
rule scorer.

Provider input plus output tokens per persona/search, including the same recorded
screen/read calls and all fit repairs, were:

| Persona       | Before median/board | After median/board | Before total | After total |
| ------------- | ------------------: | -----------------: | -----------: | ----------: |
| High-volume   |            16,311.5 |             16,108 |      209,376 |     202,926 |
| Close-matches |              15,627 |           15,451.5 |      271,918 |     202,402 |

These include the empty board. The current medians exceed the former 10k target;
the earlier 2026-10 medians used older prompts and route settings. A small
stratified cohort is not a cost projection for all configured job sources.

Label correction (2026-10-29): the PostHog Product Engineer posting has USA address metadata, but its text does not state an Americas/Europe hiring area. Grafana 6130907004 specifies US/Canada candidates with an EST-time-zone qualification; Chicago is Central and the text does not offer hours overlap as an alternative. It needs clarification for these personas. The label manifest retains that correction. The 2026-11-06 refresh replaces fit replies; the public page recordings and labels remain unchanged.

The scorer 9 region/authorization refresh starts from repository head
795ac0d25ed453a54abcbc7631bee6723803c25a with the same 59 frozen vacancies,
labels, personas and assessment date. The Muse Spark Contributor Responses
route remains configured for low fit effort; its live fit route now requests
temperature zero. Screening was refreshed with the larger 8,000-character
profession cards, and metadata reads were refreshed on the same public pages.
The final tape reuses those exact screen/read replies and refreshes all 18 fit
calls with the final prompt. No vacancy or label changed.

| Persona       | Scorer 8 recall | Scorer 9 recall | Scorer 8 relevant in top 10 | Scorer 9 relevant in top 10 |
| ------------- | --------------- | --------------- | --------------------------- | --------------------------- |
| High-volume   | 22/22           | 22/22           | 9/10                        | 10/10                       |
| Close-matches | 8/8             | 8/8             | 8/10                        | 8/10                        |

These results hold for screening/fit and collection-inclusive recall; coverage
honesty remains 10/10. The Europe-labelled Resend Backend Engineer previously
ranked fifth at 91 for the US-only persona. It now scores 39 with an explicit
Europe/US location limitation. Separate synthetic eligibility tests cover
US-only, Europe-only, US-remote and worldwide-remote jobs, the EU-to-US mirror,
and unknown or conflicting authorization requirements. Matching core duties
remain distinct from a missing tool/workflow and from a different professional
practice; eligibility uncertainty is capped after the model's work-fit judgment.

The current artifacts are fit-region-tape.json.gz and fit-region-report.json.gz.
The scorer 8 fit-quality artifacts remain historical. Exact offline replay
passes with 42 logical requests (41 unique recordings), zero fresh calls. The
report's repositoryHead is the base checkout above; these changes were not yet
committed at capture time. Fit retains complete postings and confirmed profile
evidence; the unused excerpt-based provider APIs were removed. Ungrounded pay
quotes now leave pay unknown without discarding an otherwise valid fit.
