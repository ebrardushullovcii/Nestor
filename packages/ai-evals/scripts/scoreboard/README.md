# Functionality scenario scoreboard

From the repository root, with dependencies installed and Node 24 or newer:

```sh
/Users/ebrardushullovci/Projects/nestor-agent-work/bin/heavy --cool node packages/ai-evals/scripts/scoreboard/run.ts
/Users/ebrardushullovci/Projects/nestor-agent-work/bin/heavy --cool node packages/ai-evals/scripts/scoreboard/run.ts --scenario captcha
```

On macOS the runner waits for cooling through `heavy --cool` without holding the build slot. Its optional build alone runs through `heavy`. You can build once with `heavy node packages/ai-evals/scripts/isolated-app/cli.mjs build`, then run the scoreboard with `heavy --cool node packages/ai-evals/scripts/scoreboard/run.ts --no-build`. On Windows run Node directly. It starts fresh isolated live-AI apps one at a time, uses local replicas, writes results outside the repo and stops its own processes. `--no-build` requires a matching stamped build. Deadlines are per scenario: observed high-water durations from the November 6 effort study (including the owner's 377-second Greenhouse run), plus 75% headroom and 30 seconds, rounded up to a minute. Unmeasured sign-in rows borrow the multi-step observation. `--timeout SECONDS` explicitly overrides those defaults. Time spent importing the profile, building and cleaning up is reported separately from scenario time.

Setup enables the scale manifest's existing loopback aliases. Each replica site has its own `127.0.0.x` host, so unrelated employers can prepare in parallel; a board's listing and apply page retain the same origin. The isolated-app write guard is unchanged.

The **Our own limits** row reads structured `self_limit_hit` records from this run's step and app/worker logs. Zero events passes; any event fails and lists its limit, kind, value and code location. An invalid event record also fails; missing logs remain unmeasured. Safety stops, actual dead connections and the person's own settings do not generate these bug events.

Set `NESTOR_SEARCH_PROFILE=1` to add search screening, HTTP read, browser read, queue and rendering-wait timings to the isolated app log. The existing AI usage records contain each model turn's start/end, purpose and token counts. Read/queue durations overlap with model turns and across sources; do not add their summed durations to infer wall time. Timing records contain no page text, prompts or credentials.

Use `--list` for scenario IDs, or `--out /absolute/outside-repo/path` for a different result directory. Default output is `~/Projects/nestor-agent-work/functionality-hill-climb/scoreboard/YYYYMMDD-HHMM/`. An existing scoreboard is never overwritten. `scoreboard.json` is saved after every scenario; `scoreboard.md` has the table, failures, persona and every question. `steps/<scenario>.log` records actions, state and questions. Driver proof is under the run's isolated-instance subfolder. Only failures take screenshots. Exit codes are 0 for requested passes, 1 for scenario failures, 2 for setup/driver/cleanup failures. Three additional rows measure Google sign-in, saved-password sign-in and synthetic browser import.

## What is measured

The original nine rows cover standard Fill on both `/employer-a/apply/1` and Greenhouse, Workday's four steps to Review, the Lever fake CAPTCHA, Gatekeeper's eight-second interstitial, restart with an already filled application, ten approved jobs queued across seven sites, autonomous replica Send plus a duplicate Apply request, question quality, and seven-source search with Stop/Continue/restart. Fill scenarios never press final Submit. Send is restricted by the existing driver to its local replicas. The duplicate request uses the same typed preload method as Apply again; submitted applications intentionally have no Retry button.

All model-dependent work uses `--ai live`. The synthetic Jamie resume is imported with the native picker. Work authorization (EU and Germany), no sponsorship, remote/hybrid, remote eligibility, a 30-day notice period (one month), Original resume level and pay Pause for me are set through visible controls. Persisted notice/sponsorship/remote/pay values are checked before each scenario starts. The actual completed model/provider identifiers are retained in JSON; no keys or authenticated state are included.

Application scenarios have fixed preconditions independent of search: synthetic listing rows and **unapproved** Original resume rows are inserted into the isolated store. Each resume is then approved through the app before Apply, except in the Send row, which applies from To review with the resume unapproved and checks that the application records the file with `approvedAt` null. Titles, companies, locations, URLs, listing text and application pages come from the unchanged replicas. If search already found a listing, that row is reused. This does not measure search, fit or resume generation. Search runs first and excludes seeded fixture rows from its counts. The automatic setup search is stopped; any results already saved are retained and reported separately.

Workday account creation is performed as the synthetic person using made-up credentials, if the app requests sign-in. The driver may answer the job source (Job board), a made-up street address/postcode and experience start month (2018-01), and known authorization/notice questions through Needs you, without remembering them. Those questions are still counted; known-profile questions fail. Save POSTs are counted separately from final application POSTs. The driver never presses ordinary Save/Continue steps on the employer form to make the scenario pass. CAPTCHA recovery is measured after ticking the fake box, without a Continue action. Whether the browser was already shown is recorded before the driver opens it.

Batch dead ends mean failed, stopped, uncertain, missing or still-running applications, or a Needs you state with no question. Unnecessary questions and ordinary-step handoffs are counted separately as unnecessary holds; either kind fails the batch.

Question audit rules are deliberately visible in `report.ts`. They classify known contact, EU authorization, sponsorship, notice and remote-work asks. Unknown, foreign-country, country-unspecified authorization, mixed sensitive, pay, consent and date questions are left unclassified. Sponsorship uses the explicit saved No; unrestricted authorization requires a named EU country or region. The resulting count is conservative; review the full question text and country metadata before drawing conclusions. Exact normalized repeats within the same instance and question kind are counted. Eligibility questions also require the same resolved country, or identical normalized job location text when no country is known; different unresolved locations stay separate. Country/location metadata is retained in JSON and the question table; new isolated instances have no prior sign-in or saved answer to reuse. One shared Needs you item linked to several applications is one question. The quality row aggregates the other rows, so its counts must not be added again. Live-model results can vary even with the same persona and fixtures.

During setup the isolated driver holds its configured replica GET reads. Stop aborts those requests normally; setup then releases the hold before the measured search starts. The release survives the scenario's app restart. The driver currently matches its base origin exactly, so distinct replica aliases can return early results during setup. The journey records the retained inventory before the measured search without deleting results. Alias-aware setup holding belongs to the separate isolated-driver change.

The driver location is confined to `DRIVER_PATHS` in `run.ts`, preferring `packages/ai-evals/scripts/isolated-app/` and falling back to the old verify-nestor driver. Journey code is self-contained here and has no imports from the removable skill.

## Checks

```sh
pnpm exec tsc -p packages/ai-evals/scripts/scoreboard/tsconfig.json
pnpm exec eslint packages/ai-evals/scripts/scoreboard --ext .ts
pnpm exec vitest run packages/ai-evals/scripts/scoreboard/report.test.ts --maxWorkers=2
```

## Sign-in and import rows

`--scenario google` uses #384's Google mock and pinned host mapping. Profile email is set through Profile to the matching invented account; Google permission is enabled in Settings while site-password sign-in stays off. Two accounts are offered. It requires the matching selection, basic confirmation, Ready, and zero email/password input events. A second application with Google off must produce one sign-in item and no provider writes or credential inputs. Input instrumentation retains counts and synthetic account indices only.

`--scenario saved-sign-in` pre-creates an invented Workday account on the fresh replica. It enables site sign-in in Settings and imports the exact-origin login through the real Saved passwords CSV picker. The agent must make one successful sign-in (observed as the replica’s HTTP 303 response) and reach the authenticated application form without a sign-in question. Personal form questions after sign-in are reported separately.

`--scenario browser-import` generates a Chrome-shaped macOS schema-24 cookie database and Login Data database: seven cookie rows (three usable on three hosts; expired, partitioned, unsupported and corrupt rows) and two saved logins. The isolated process's profile discovery points only to the synthetic home, and its exact Chrome Safe Storage read returns the fixture key. The normal production importer, IPC routes and visible import controls perform the import. Counts and explanations must match, both logins must appear in the vault, and a Workday session issued before import must reach the authenticated form without another sign-in. This covers Chrome schema parsing, AES decryption, filtering, import UI, Nestor vault and session reuse. It does **not** verify real Chrome profile discovery, macOS Keychain consent or a real browser's current encryption scheme. No real profiles or Keychain entries are read or changed.

Standard application accepts Ready or a genuine unresolved question asked once: unknown-country work authorization, own words, consent, or pay Pause for me. Known-profile questions, repeated questions, ordinary-step handoffs and dead ends still fail. Every question remains in the report.
