---
name: verify-nestor
description: Drive the real Nestor desktop app (Electron) and the public website the way a person would, and keep proof. Covers Job Finder (resume import, job sources, search and fit, shortlist, tailored resume, apply and send to the local replica job sites only) and Live Assistant (setup and a session), each run in its own isolated instance with a private data folder, its own ports and synthetic data. Use it to prove a change works in the app, reproduce a bug on a screen, or collect screenshots, step logs and the SQLite rows an action wrote. Safe beside the owner's own `pnpm desktop:dev` and other agents' instances.
---

# verify-nestor

Proof means using the app the way a person would, action by action, and keeping what you saw: screenshots, the step log, and the database rows each action wrote. All commands run from the root of the checkout under test. Helpers live in `.claude/skills/verify-nestor/bin/`; below, `V=.claude/skills/verify-nestor/bin`.

## Rules (read first)

- **Isolated instance only.** Every `up` makes a fresh `/tmp/nestor-verify-<label>-*` user-data folder (`%TEMP%\nestor-verify-<label>-*` on Windows) and refuses anything else. Never point an instance at the default data location (`~/Library/Application Support/@nestor/desktop`, `%APPDATA%\@nestor\desktop` on Windows, or the older `@nordri/desktop` that the owner's next normal start migrates). Never attach to, drive or stop the owner's `pnpm desktop:dev`.
- **Synthetic data only.** Use the resumes in `apps/desktop/test-fixtures/job-finder/` (`resume-import-sample.txt`, `resume-import-personas/`). Never a real resume, real credentials or a signed-in browser state, in the instance or in the evidence.
- **Send only to the replica sites.** Each instance runs its own copy of `apps/desktop/test-fixtures/job-sites` on a free port. A send guard inside the app refuses every request to a non-loopback host (`--net replica`, the default) and logs it to `blocked-requests.jsonl`; `up` proves the guard with a self-test before anyone drives. Add only replica URLs as job sources. With `--net web` the app can read real sites, but every non-GET request to them is still refused, so a real employer gets nothing: anything outside the replica stays `prepare_only` (ADR 0012, 0024, `docs/TESTING.md`).
- **Kill only what the run started.** `down` stops the recorded driver, Electron and replica-site PIDs (checked against their recorded start times) with their children, plus any process holding this instance's own data folder. Never `pkill`, `killall` or kill an Electron found by name.
- **Never build in the main checkout** (`~/Projects/Personal/Nestor` on the Mac, `D:\Projects-Personal\Nestor` on the Windows PC; `NESTOR_VERIFY_MAIN_CHECKOUT` overrides): its `out/` feeds the owner's dev instance. `bin/build` refuses there. Driving from it is fine.
- **Machine load.** The Mac is shared with NEX. One build or full suite at a time; a few instances side by side are fine.
- **Don't touch the focus or permission switches.** Instances never become the front app (see Gotchas). Turning on the microphone, system audio or screenshots in Live Assistant raises real macOS permission prompts on the owner's screen: leave them off unless the owner asked.

## Launch

```sh
V=.claude/skills/verify-nestor/bin
export NESTOR_VERIFY_LABEL=<ticket-or-topic>   # names the instance and its evidence folder
$V/build                                        # once per source change: pnpm build + a stamp of the commit
$V/up                                           # deterministic AI
$V/up --ai live                                 # the app's real AI (needed for search, fit, resume, apply)
```

On Windows the `bin/` scripts run from Git Bash as written. From PowerShell, call the same commands through node: `node .claude/skills/verify-nestor/bin/lib/cli.mjs up` (and `build`, `doctor`, `drive`, `db`, `down`; `website` is `bin/lib/website.mjs`).

`up` prints `ready: label <label>` with the replica-sites URL, the private user-data folder and the evidence folder once the main window has loaded `window.nestor`, the user-data path is confirmed, and the send guard self-test passed. Measured 2026-10-17: about 2 s warm, 20 s cold.

Options: `--ai deterministic|live`, `--net replica|web`, `--video` (Playwright video of every window into `videos/`), `--no-test-api` (production preload, no `window.nestor.*.test`), `--reuse-data` (start on the folder a previous `down --keep-data` kept, for example to keep a passed Cloudflare check), `--allow-stale` (run a build that does not match the source; say so in the proof).

- `up` refuses when the build's stamp differs from the current commit or uncommitted app changes (`apps/desktop`, `packages`). Rebuild with `$V/build`. It copies `apps/desktop/out` into the instance, so a later build never changes a running instance.
- `--ai live` reads `NESTOR_*` keys from this checkout's `.env.local`/`.env` (root and `apps/desktop`), then from the main checkout's, without printing them. Deterministic mode blanks every key. Deterministic AI cannot search (`AI client does not support tool calling`), so Job Finder search and everything after it needs `--ai live`. Each live search, resume and apply is a real model call.
- Side by side: give each instance its own `NESTOR_VERIFY_LABEL`. Each gets its own data folder, replica-sites port, driver port and Playwright debug ports. Measured: two instances (one live, one deterministic) running journeys at the same time on 2026-10-17.
- Default label: `verify-<checkout folder name>`.

## Doctor

```sh
$V/doctor
```

Read-only. Checks: build stamp against the source; driver, Electron and replica-site PIDs alive and ours (start times match); the replica sites answer; the user-data folder is the private temp one, both on record and inside the app; the send guard self-test passed; the driver answers and names the current screen; nothing else holds the data folder; the instance is not the front app. It also lists other live instances and the load. Exit 1 means fix before driving. Run it first, and whenever something looks off.

## Drive

`drive` sends one command to the instance's driver and appends a line to `steps.log` (command, result, time, current screen heading). A failed command saves `shots/NNN-failure-<cmd>.png` and exits 1.

```sh
$V/drive see                                   # accessibility tree of the main window (the selector reference)
$V/drive click "Find jobs"                     # first visible button/link/tab/menuitem/radio/checkbox/... with that name, then label, then text
$V/drive click "No" --within "Would you need employer visa sponsorship?"   # inside a named dialog/region/group/form/article/list
$V/drive click "Remote" --role checkbox        # exact role; --nth 2 for the third match; --exact false for substring
$V/drive click "/^Shortlist /"                 # /regex/ works wherever a name does
$V/drive fill "Careers or job-board URL" "http://127.0.0.1:<port>/board/"
$V/drive press Enter
$V/drive wait "Search now" 600 --role button   # wait up to 600 s for something visible
$V/drive pick test-fixtures/x.pdf              # the next native open dialog returns these files (paths resolve from the cwd)
$V/drive shot search-results                   # shots/NNN-search-results.png + .aria.txt (main window)
$V/drive shot form --target browser --url /apply/   # an in-app browser page
$V/drive shot popups --target overlay          # Live Assistant answer and transcript popups
$V/drive click Submit --page browser --url /apply/  # click/fill/see/wait/press inside an in-app browser page
$V/drive browser                               # list every webContents (id, type, URL)
$V/drive eval 'return (await workspace()).profile.fullName'   # Node side; use page.evaluate(() => ...) for the renderer
$V/drive run .claude/skills/verify-nestor/journeys/job-finder-replica.mjs [stage]
$V/drive restart                               # close and relaunch on the same data (prepared browser pages are lost)
$V/drive status
```

Handles: accessible names from `drive see`. They match the app's `aria-label`s and headings. Navigation is by the sidebar buttons ("Home", "Profile", "Find jobs", "Shortlisted", "Applications", "Safeguards", "Settings"); the module switch is the banner button "Job Finder, switch module" and then the menu item "Open Live Assistant". Setting `location.hash` from a script does not navigate like a click does; use the controls.

`eval` and journeys get the same helpers: `page` (the current main window, looked up again on every command because the app can replace it), `app` (Playwright `ElectronApplication`; `app.evaluate` runs in the main process), `click`, `fill`, `press`, `waitFor`, `see`, `shot(name, { target, url })`, `pick(...files)`, `note(...)` (a line in `steps.log`), `db(table, { limit, pattern, name })` (newest rows, also saved as evidence), `tables()`, `workspace()`, `pageFor({ page: "browser", url })`, `browserPages()`, `sites` (`url`, `log`, `submissions()`), `userDataDir`, `evidenceDir`, `desktopDir`, `checkout`, `ai`, `args`, `sleep`.

A journey is a module whose default export takes that context:

```js
export default async ({ click, waitFor, shot, db }) => {
  await click("Shortlisted", {
    role: "button",
    within: "Job Finder sidebar destinations",
  });
  await waitFor("Shortlisted", 15, { role: "heading" });
  await shot("shortlisted");
  return db("saved_jobs", { limit: 3 });
};
```

Put one-off journeys in your evidence folder, not in the repo.

### Saved journeys

| journey                                                                                | needs          | what it proves                                                                                                                                                                                                                                                       | measured                                                                   |
| -------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `journeys/job-finder-replica.mjs [setup\|search\|shortlist\|resume\|apply\|send\|all]` | `up --ai live` | import a synthetic resume through the picker, guided setup with the replica board as the only source, search with fit verdicts, shortlist, tailored resume, prepare, and press the replica's own Submit. Asserts a row at every step and exactly one replica receipt | 2 min uninterrupted on 2026-10-17 (search 40 s, resume 30 s, prepare 20 s) |
| `journeys/live-assistant-session.mjs`                                                  | either AI mode | notices, quick check, start, one typed question answered in the window and the popups, end, post-session review, the stored session                                                                                                                                  | about 30 s                                                                 |
| `journeys/website.mjs` (with `bin/website run`)                                        | nothing        | hero, early-access signup posted to the local server, the tour, phone width with no sideways scroll                                                                                                                                                                  | about 3 s                                                                  |

A single stage assumes the earlier ones already ran on this instance.

### Website

`apps/website` is static. `bin/website` serves this checkout's copy on a free loopback port and drives it in headless Chromium, with no app instance:

```sh
$V/website shot / home --width 390 --height 844 --full
$V/website run .claude/skills/verify-nestor/journeys/website.mjs
```

Every request outside the local server is refused except Google Fonts GETs, so the signup forms never reach Netlify; posted fields land in `website-posts.jsonl`. Never submit on https://trynestor.netlify.app.

## Evidence

Everything goes to `~/Projects/nestor-agent-work/<label>/verify/`, outside the checkout, and survives `down` and removal of the worktree:

- `steps.log`: every `up`, drive command, journey note and `down`, with time and screen. The action record.
- `shots/NNN-<name>.png` with `.aria.txt`: the screen and its accessibility tree. Take one before an action and one of the result, not just the final screen. Retina, so 2x pixels.
- `db-<time>-<table>.json`: rows read with `db` (helper or `$V/db <table> [limit] [pattern]`). This is how a side effect is proven: the row the click wrote, with its status. `$V/db tables` lists row counts.
- `submissions.jsonl`: every POST the replica sites received (fields, upload names and sizes). The proof of a send.
- `blocked-requests.jsonl`: every request the send guard refused (the first is the self-test).
- `dialogs.jsonl`, `opened.jsonl`, `exports/`: what the stubbed native dialogs returned, every link the app tried to open outside, and saved exports.
- `final-data/`: the instance's SQLite files and diagnostics, copied at `down`. `$V/db` reads them after the instance is gone.
- `logs/`: the driver and app logs, with key values redacted.

Proof standards:

- Exercise the real user path: the buttons, fields and pickers a person uses. The picker stub answers the native dialog only (the production boundary); the click that opens it is real. Seed through `window.nestor.*.test` only for a precondition you are not proving, and say so.
- Prove side effects as well as screens: the `db` row with its status, the replica receipt, the export file.
- Say what ran: label, build stamp (clean or dirty), AI mode (`deterministic` proves flow, not model quality), net mode.
- Report UI outcome and stored outcome separately. A screenshot alone is not a passed flow.
- A missing precondition is a blocked recipe with the reason, never a weaker journey.

## Cleanup

```sh
$V/down               # stop everything this instance started, keep the evidence, delete the data folder and build copy
$V/down --keep-data   # also keep the data folder for `up --reuse-data`
```

`down` asks the driver to close the app, then stops whatever is left of the recorded PIDs and their children, and any process holding the instance's own data folder. It copies the final databases and logs into the evidence, then deletes the data folder and `~/Projects/nestor-agent-work/.verify-state/<label>/`. Survivors are reported with their PIDs, the state is kept, and it exits 1; look at them, never sweep. Run `down` after every failed attempt too.

## Helpers

| command                                                                                  | what it does                                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `$V/build [--force]`                                                                     | `pnpm --filter @nestor/desktop build`, then stamp `apps/desktop/out/.verify-build.json` with the commit and an uncommitted-changes hash |
| `$V/up [--ai live] [--net web] [--video] [--no-test-api] [--reuse-data] [--allow-stale]` | start an isolated instance with its replica sites and driver; wait until it is usable                                                   |
| `$V/doctor`                                                                              | read-only health check of this label's instance                                                                                         |
| `$V/drive <command> ...`                                                                 | act on the instance (commands above)                                                                                                    |
| `$V/db [tables \| <table> [limit] [pattern]]`                                            | newest rows from the instance's SQLite files (live copy, or `final-data` after `down`); saved as evidence; exit 1 when nothing matches  |
| `$V/website [shot [path] [name] \| run <journey>]`                                       | the public website from this checkout in headless Chromium                                                                              |
| `$V/down [--keep-data]`                                                                  | stop what this instance started; keep the evidence                                                                                      |

Internals, for fixing the helpers: `bin/lib/cli.mjs` (commands), `bin/lib/driver.mjs` (the long-lived per-instance process that owns Playwright, Electron and the replica sites; never start it by hand), `bin/lib/instance-patch.cjs` (loaded into the app's main process with `-r`: quiet windows, dialog and link stubs, send guard), `bin/lib/sqlite.mjs`, `bin/lib/website.mjs`. State (ports, PIDs, token, build copy, logs) lives in `~/Projects/nestor-agent-work/.verify-state/<label>/`; read `driver.log` and `app.log` there when `up` fails.

## Feature map

`features/README.md` lists the user-facing features, how to reach, drive and judge each one. Before calling a change proven, read the feature's file: a proof through one convenient entry point is incomplete when the map lists others. When the app changes, update the map (`/maintain-verification-skill`).

## Gotchas

- **Focus.** macOS activates a regular app whenever it shows a window, even with `showInactive`. Instances therefore run from an APFS clone of the checkout's Electron.app marked `LSUIElement` (`.verify-state/_electron/<version>/`, instant, shares disk blocks), and the patch turns `show`/`focus`/`moveTop`/always-on-top into quiet versions. Consequences: no Dock icon or menu bar for the instance; a run cannot prove keyboard focus, always-on-top popups or the native pickers. Playwright input still reaches the unfocused window.
- **Windows.** The window patch alone keeps instances in the background (`showInactive` does not activate there); they do get taskbar buttons. `doctor` checks the foreground window instead of the front app. With no `ps` or `lsof`, process start times and children come from PowerShell (`Get-CimInstance Win32_Process`), and "holds the data folder" means a process whose command line names it (every Chromium child carries `--user-data-dir`). That makes `doctor` and `down` take about 10 s. Measured 2026-10-17 on the Windows PC: build 2 min, `up` 6 s, Live Assistant journey 4 s.
- **Unfocused means backstage.** While a run is going and the window is unfocused, the embedded browser parks its pages in a hidden panel window (by design). `shot --target browser` still captures them through `capturePage`.
- **`navigator.webdriver` is true** in the in-app browser under Playwright. Google sign-in rejects at the email step and Cloudflare challenges it. Neither matters for the replica sites; do not conclude a real site is broken from this.
- **The Job Finder browser peek is a modal.** After "Open the Job Finder browser" it covers the app; `drive press Escape` closes it before you click elsewhere.
- **A shortlisted job may already be `drafting`**: shortlisting can start the resume draft in the background.
- **Restarts close browser pages.** Open restores a saved Ready form when it can verify the fields and attachments. Otherwise it queues a fresh Fill-only preparation for review. A waiting sign-in card reopens the original application entry; credentials, CAPTCHA and MFA stay with the person.
- **After an "Apply to all" batch** (seen 2026-09-23), a pending quality sample review in Safeguards blocks every later search with "Something unexpected stopped this search". Mark it in Safeguards first.
- **Cold first `up`** after a reboot or Electron upgrade takes about 20 s; warm ones about 2 s.
- **`pnpm --filter @nestor/desktop qa`** (docs/AGENT_QA.md) is the repo's one-shot Playwright session. It takes an exclusive lease per checkout, keeps its artifacts in `/tmp`, has no focus patch, and treats a running verify instance in the same checkout as a conflict. Use one or the other per checkout at a time.
