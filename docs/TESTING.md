# Testing

## Automated checks by change

| Change                       | Run                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| package-local code           | `pnpm validate:package <alias>` (`desktop`, `job-finder`, `browser-agent`, `browser-runtime`, `contracts`) |
| contracts or IPC             | `pnpm validate:contracts` plus typecheck of affected packages                                              |
| discovery or source-debug    | `pnpm source-generic:check` plus focused package tests                                                     |
| desktop UI                   | `pnpm validate:desktop` plus the matching `ui:*` harness from `apps/desktop/package.json`                  |
| broad cross-package behavior | `pnpm verify:affected`                                                                                     |

Other entry points: `pnpm test:correctness`, `pnpm test:coverage`, `pnpm format`, `pnpm knip`, `pnpm structure:check`.

## Keep checks proportional

Builds and full suites are the slowest part of most changes. CI runs lint, typecheck and the test suite on every pull request, so locally:

- Run the row above that matches the change, not `pnpm test` or a full suite by habit. When shared contracts, IPC or several packages change, run their checks or `pnpm verify:affected`.
- Batch related fixes, then check once per batch. Don't rerun a passing check after an edit that cannot affect it.
- Build the desktop app once per batch, and only when you will run the built app. After that build, use the `:built` harness variants instead of the ones that rebuild. `verify-nestor up` refuses a build whose stamp doesn't match the source; `qa` and the `:built` harnesses don't check freshness, so rebuild after changing build inputs before using them. The stamp covers tracked changes and the names of untracked files, not their contents. Restarting an instance reuses its copied build, so start a fresh instance after a rebuild.
- In the app, prove a change through the feature it affects: that feature's recipe in `.claude/skills/verify-nestor/features/` or one journey stage. Run the combined `full-check` journey (about 25 minutes plus a 12-minute batch, with live model calls) only when asked or when a change touches most of the app.
- Use `--ai deterministic` to prove screens and flow. Use `--ai live` only when the result depends on the model (search, fit, resume, apply).

## Stop rules

- Never stop a process you did not start. Stop only the Electron instance you launched, through its own handle or PID tree, and report survivors instead of sweeping. Pattern kills (`pkill -f electron`, `killall Electron`) hit the user's own dev instance and every other Electron app.
- Do not rerun a broad failing command unchanged; isolate the failing package or command first.
- If a failure is pre-existing and unrelated, report it once and switch to focused validation.
- Builds and full suites heat the laptop. Batch related fixes and build once per batch.

## Testing the built app

- To drive the built app like a user, use the `verify-nestor` skill (see `AGENTS.md`): an isolated instance with synthetic data, replica-only sends and saved evidence. `pnpm --filter @nestor/desktop qa` ([Agent development QA](AGENT_QA.md)) is an interactive Playwright alternative with fault injection; don't run both against one checkout at the same time. Existing focused harnesses remain available.

- Build first, but never in the owner's main checkout: its `out/` feeds their running `pnpm desktop:dev`, and verify-nestor's `build` refuses there. Build in a worktree with verify-nestor's `build` (`node .claude/skills/verify-nestor/bin/lib/cli.mjs build`), which runs `pnpm --filter @nestor/desktop build` and stamps the result for `up`. If the task must stay in the main checkout, drive the existing build only when it matches the source; otherwise report fresh-build verification as blocked. Don't bypass the guard. Scripts that launch `out/main/index.cjs` run whatever was last built.
- Use a temporary user-data directory and synthetic data (`apps/desktop/test-fixtures/job-finder/resume-import-sample.txt`, or the synthetic personas in `apps/desktop/test-fixtures/job-finder/resume-import-personas/` in PDF, DOCX, TXT and Markdown), never the user's real workspace or a real person's resume.
- Serialize isolated Electron launches unless a coordinated parallel run explicitly uses the QA launcher's shared `--parallel-group` with distinct `--session-id` values (see [Agent development QA](AGENT_QA.md)). Build once before starting the group and audit only the processes you own.
- Harness commands live in `apps/desktop/package.json` (`ui:*`, `test:embedded-browser`, `test:live-assistant-*`). `:built` variants use the existing build; the others rebuild.
- For an isolated production import without a native picker: `node apps/desktop/scripts/seed-product-quality-audit.mjs --user-data-dir <dir> --resume <synthetic-resume>`.

## Safety rules

- Never submit to a real employer site. Final submits, from an apply harness or the assistant, are allowed only against the local replica job sites (below): the harness must fail before sending if any application target is not a loopback replica origin. Every other apply harness keeps `submitAuthorized: false` and `accountCreationAuthorized: false` and fails if any attempt, job, or application record reaches `submitted`.
- Live prepare-only runs use a temporary user-data directory, a fake profile, and an approved synthetic resume. Anonymous Workday must stop at the account gate with a sign-in item in Needs you; never attempt credentials.
- Live Assistant harnesses default to deterministic providers with AI credentials blanked. Live providers require `UI_LIVE_ASSISTANT_PROVIDER_MODE=configured` (see `docs/AI_PROVIDER_SETUP.md`).
- Never add personal resumes, live workspaces, credentials, or authenticated browser state to benchmark corpora.
- Approve store resumes through `approve_resume` (or the store test seed for a precondition); never bypass approval when Apply is the behavior under test.

## Fit judging

- The model judges fit (ADR 0041); there is no rule scorer to calibrate. Tests fake the fit model and check its verdict, with eligibility caps for blocked or unresolved permission. `LISTING_FIT_SCORER_VERSION` retires indexed listing fits; `MATCH_ASSESSMENT_SCORER_VERSION` covers legacy assessments. Stored verdicts remain visible while relevant profile, goals or listing changes are judged again.

## Benchmarks

- Resume import: `pnpm --filter @nestor/desktop benchmark:resume-import`
- Resume quality: `pnpm --filter @nestor/ai-evals resume-lane`.
- AI capabilities: `pnpm ai:benchmark plan | full <lane> | canary luna_high | full-report`. Keep each lane serial. Deterministic fallbacks are reported separately and never credited to the model.

## Assistant

- Unit and host tests: `pnpm validate:package job-finder` (session host, grants, change diff, action inventory) and `pnpm validate:package agent-runtime`.
- Eval lane: `pnpm --filter @nestor/ai-evals assistant-lane` runs the scripted-model cases; add `-- --model live` for the configured assistant model (serial; `--case <id prefix>`, `--out <dir>`). Report actual passes and failures, not percentages.
- Built app: use the verify-nestor feature recipes in `.claude/skills/verify-nestor/features/` for the sidebar, selection, Needs you and replica sends. The old `test-job-finder-assistant*.mjs` harnesses were retired with the workspace. Set `--ai live` for configured model checks.

## Local replica job sites

From the repo root, run `node apps/desktop/test-fixtures/job-sites/serve.mjs` with Node 22 or newer. Open `http://127.0.0.1:47950/` for the index; set `PORT` to override the port. Each listing URL below is a Job Finder source. The original five sites each have ten fictional software jobs; the fifteen new sites add 1,234 listings across ten fields. Use `PORT=0` to pick a free port and read the address from startup output.

`http://127.0.0.1:47950/board/` exercises age badges, job details, the `/employer-a/apply/<id>` handoff, hidden resume upload, cover letter and required certification.

`http://127.0.0.1:47950/lever/` exercises location selection and autocomplete, opacity-zero resume upload, background-check consent and a fake CAPTCHA with an inline error.

`http://127.0.0.1:47950/greenhouse/` exercises attachment buttons and a drop zone, optional cover-letter upload, custom questions, yes/no radios and optional EEO selects.

`http://127.0.0.1:47950/workday/` exercises application choices, account creation/sign-in, four steps, repeatable work experience, simulated resume autofill, review and required terms. Use made-up credentials; accounts and saved steps live in server memory until restart. Saved steps do not restore after reload.

`http://127.0.0.1:47950/gatekeeper/` exercises a cookie overlay, chat bubble, eight-second security interstitial, new-tab application, per-field autosaves and in-page confirmation after fetch submission.

`http://127.0.0.1:47950/atlas/` has 300 jobs and exercises page numbers, query filters, sorting, duplicate jobs, sponsored cards and discovery decoys.

`http://127.0.0.1:47950/ripple/` has 300 jobs and exercises load more, query filters, duplicate jobs, initials-only companies and a local ATS redirect.

`http://127.0.0.1:47950/brindle/` has 120 jobs and exercises department filters, four steps, resume prefill and repeatable work and education.

`http://127.0.0.1:47950/folio/` has 36 jobs and exercises portfolio URLs, a required cover-letter upload and a limited rich text answer.

`http://127.0.0.1:47950/harbor-health/` has 48 jobs and exercises five steps, phone codes, availability dates, skill experience and voluntary diversity.

`http://127.0.0.1:47950/lessonloom/` has 42 jobs and exercises three steps, upload or paste a resume, education rows and teaching motivation.

`http://127.0.0.1:47950/parcelpath/` has 60 jobs and exercises four steps, searchable country picker, phone codes, dates and salary currency.

`http://127.0.0.1:47950/clientnest/` has 45 jobs and exercises single page, searchable comboboxes, yes/no questions and multiple skill checkboxes.

`http://127.0.0.1:47950/ledgerleaf/` has 40 jobs and exercises six steps, work history, salary expectations, notice period and review.

`http://127.0.0.1:47950/marketmoss/` has 50 jobs and exercises resume text alternative, validated URLs and a rich answer with a character counter.

`http://127.0.0.1:47950/peoplepetal/` has 36 jobs and exercises three steps, voluntary EEO answers, declarations and an unticked marketing option.

`http://127.0.0.1:47950/cedar-ats/` has 55 jobs and exercises local ATS handoff, guest/account choice, resume prefill and session timeout recovery.

`http://127.0.0.1:47950/framehire/` has 30 jobs and exercises same-origin application iframe with inline validation and receipt.

`http://127.0.0.1:47950/slowgrove/` has 28 jobs and exercises three-to-eight-second page responses and a three-step application.

`http://127.0.0.1:47950/pacer/` has 44 jobs and exercises short HTTP 429 cooldown with Retry-After and a single-page application.

Run `node apps/desktop/test-fixtures/job-sites/check.mjs` for the HTTP self-check. It starts its own server on a random port, visits every original job/application, walks every new listing page, opens representative details and forms, submits one synthetic application per site, checks confirmations and POST logs, then stops that server. It also checks filters, duplicates, unavailable jobs, local redirects, validation, delays and HTTP 429 recovery. It checks iframe and wizard markup but does not execute browser JavaScript.

Every parsed POST is logged as JSON to stdout and the gitignored `apps/desktop/test-fixtures/job-sites/submissions.log`; passwords are redacted and uploads record metadata only. A logged POST proves receipt of a request, not acceptance of an application: validation failures and intermediate saves are logged too. Submission tests must separately assert the server's accepted-application count and the app's outcome, then verify that retries or restarts add no acceptance. All content is local and synthetic. Agent runs may send applications to these fixtures, and only to them. Runs against any other site stay prepare-only. See the fixture folder's `README.md` for details.
