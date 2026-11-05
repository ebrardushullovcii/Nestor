# Functionality scenario scoreboard

From the repository root, with dependencies installed and Node 24 or newer:

```sh
node packages/ai-evals/scripts/scoreboard/run.ts
node packages/ai-evals/scripts/scoreboard/run.ts --scenario captcha
```

The command builds the desktop through `~/Projects/nestor-agent-work/bin/heavy`, runs each scenario in a fresh isolated live-AI app, one at a time, using the existing local replicas, writes the scoreboard, and stops its own processes. Fresh instances prevent shared host sign-in/CAPTCHA items from contaminating later scenarios. It never attaches to a development app. `--no-build` requires an already matching stamped build. `--timeout 240` sets the application deadline in seconds; search has a 240-second minimum and the ten-job batch a 420-second minimum. Time spent importing the profile, building and cleaning up is reported separately from scenario time.

Use `--list` for scenario IDs, or `--out /absolute/outside-repo/path` for a different result directory. Default output is `~/Projects/nestor-agent-work/functionality-hill-climb/scoreboard/YYYYMMDD-HHMM/`. An existing scoreboard is never overwritten. `scoreboard.json` is saved after every scenario; `scoreboard.md` has the table, failures, persona and every question. `steps/<scenario>.log` records actions, state and questions. Driver proof is under the run's isolated-instance subfolder. Only failures take screenshots. Exit codes are 0 for requested v1 passes, 1 for scenario failures, 2 for setup/driver/cleanup failures. The v2 row says **not built yet**.

## What is measured

The nine v1 rows cover standard Fill on both `/employer-a/apply/1` and Greenhouse, Workday's four steps to Review, the Lever fake CAPTCHA, Gatekeeper's eight-second interstitial, restart with an already filled application, ten approved jobs queued across seven sites, autonomous replica Send plus a duplicate Apply request, question quality, and seven-source search with Stop/Continue/restart. Fill scenarios never press final Submit. Send is restricted by the existing driver to its local replicas. The duplicate request uses the same typed preload method as Apply again; submitted applications intentionally have no Retry button.

All model-dependent work uses `--ai live`. The synthetic Jamie resume is imported with the native picker. Work authorization (EU and Germany), no sponsorship, remote/hybrid, remote eligibility, a 30-day notice period (one month), Original resume level and pay Pause for me are set through visible controls. Persisted notice/sponsorship/remote/pay values are checked before each scenario starts. The actual completed model/provider identifiers are retained in JSON; no keys or authenticated state are included.

Application scenarios have fixed preconditions independent of search: synthetic listing rows and **unapproved** Original resume rows are inserted into the isolated store. Each resume is then approved through the app before Apply. Titles, companies, locations, URLs, listing text and application pages come from the unchanged replicas. If search already found a listing, that row is reused. This does not measure search, fit or resume generation. Search runs first and excludes seeded fixture rows from its counts. The automatic setup search is stopped; any results already saved are retained and reported separately.

Workday account creation is performed as the synthetic person using made-up credentials, if the app requests sign-in. The driver may answer the job source (Job board) and a made-up street address/postcode and known authorization/notice questions through Needs you, without remembering them. Those questions are still counted; known-profile questions fail. The driver never presses ordinary Save/Continue steps on the employer form to make the scenario pass. CAPTCHA recovery is measured after ticking the fake box, without a Continue action. Whether the browser was already shown is recorded before the driver opens it.

Batch dead ends mean failed, stopped, uncertain, missing or still-running applications, or a Needs you state with no question. Unnecessary questions and ordinary-step handoffs are counted separately as unnecessary holds; either kind fails the batch.

Question audit rules are deliberately visible in `report.ts`. They classify known contact, EU authorization, sponsorship, notice and remote-work asks. Unknown, foreign-country, country-unspecified authorization, mixed sensitive, pay, consent and date questions are left unclassified. Sponsorship uses the explicit saved No; unrestricted authorization requires a named EU country or region. The resulting count is conservative; review the full question text and country metadata before drawing conclusions. Exact normalized repeats within the same instance, question kind and country are counted; new isolated instances have no prior sign-in or saved answer to reuse. One shared Needs you item linked to several applications is one question. The quality row aggregates the other rows, so its counts must not be added again. Live-model results can vary even with the same persona and fixtures.

The driver location is confined to `DRIVER_PATHS` in `run.ts`, preferring `packages/ai-evals/scripts/isolated-app/` and falling back to the old verify-nestor driver. Journey code is self-contained here and has no imports from the removable skill.

## Checks

```sh
pnpm exec tsc -p packages/ai-evals/scripts/scoreboard/tsconfig.json
pnpm exec eslint packages/ai-evals/scripts/scoreboard --ext .ts
pnpm exec vitest run packages/ai-evals/scripts/scoreboard/report.test.ts
```
