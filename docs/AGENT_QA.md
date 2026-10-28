# Agent QA tools

Use the installed **Playwright and Electron APIs** for testing. The `qa` command
only handles an isolated launch, local fixtures, diagnostics and cleanup. It does
not restrict actions, choose the test flow or decide whether the product works.
No additional tool installation, service, model integration or release process is
required. Existing `ui:*` scripts and focused tests remain available.

## Start

Coordinate the desktop build and launch mode with other agents first, then run:

```sh
pnpm --filter @nestor/desktop qa --doctor
pnpm --filter @nestor/desktop qa
```

The second command opens a Node REPL with top-level `await`. Allocate a terminal
in your agent tool and reuse it. `qa.page`, `qa.context` and `qa.app` are the real
Playwright Page, BrowserContext and ElectronApplication. `.exit` or Ctrl-D closes
only this session's processes and retains the printed temporary directory.

Each launch uses fresh synthetic user data and copies the existing desktop build
so another build cannot replace its main/preload/renderer files mid-test. It does
not rebuild. Dependencies and native parser tools still use the checkout. The
session manifest records which output was copied; its checkout revision does not
prove the output includes unbuilt changes. Coordinate one desktop build before
verifying changed app code, then start a new session. `qa.restart()` reuses the
same private build and data. Previously saved Page/locator handles become stale.

The launcher defaults `NESTOR_BROWSER_HOST` to `embedded` in both AI modes,
including when test hooks are enabled. Explicit environment or `env` overrides
are preserved. Without this selection, the app's test hooks retain the legacy
external Chrome host for compatibility (ADR 0017). `qa.browserHost`, startup output
and `session.json` record the requested host, not proof of the running browser.
For browser-flow checks, verify `browserSession.driver` is
`embedded_browser_agent` and inspect the live embedded `webContents`. Earlier
external-host runs do not establish that the in-app browser works.

Default AI is deterministic. Add `--provider configured` for the app's real AI
configuration. This reads the existing environment files without copying secrets
into artifacts and enables the live-AI test flags for both modules. The selected
mode overrides inherited live-AI test flags. Neither mode restricts browsing. Keep data synthetic. Agent
applications may send only to the local replica job sites; everywhere else they stay
`prepare_only` with `submitAuthorized: false`, as in `TESTING.md`.
Label which provider actually ran; deterministic results cannot prove model quality.

To check production behavior without test hooks, set `NESTOR_ENABLE_TEST_API=0`
before the command. Use `--provider configured` as well when testing real AI.
The raw Playwright/Electron tools still work with test hooks disabled.

## Use the existing APIs

```js
await qa.page.locator("body").ariaSnapshot();
await qa.page.getByRole("button", { name: "Home", exact: true }).click();
await qa.capture("home");
await qa.page.evaluate(() => window.nestor.launchContext());
await qa.page.evaluate(() => Object.keys(window.nestor.jobFinder.test));
qa.context.pages().map((p) => p.url());
await qa.app.evaluate(({ app }) => app.getAppMetrics());
await qa.app.evaluate(({ webContents }) =>
  webContents
    .getAllWebContents()
    .map((w) => ({ id: w.id, type: w.getType(), url: w.getURL() })),
);
```

Normal Playwright capabilities remain available: mouse/keyboard, uploads,
file choosers, downloads, dialogs, frames, open shadow roots, request routing,
CDP and traces. Use Electron main evaluation for native window and backend
inspection; do not change the production renderer's typed bridge boundary.
Use the existing computer-use tools for OS permissions, native pickers, global
shortcuts or actual microphone testing. Browser evidence cannot establish those work.

For a repeatable probe, use a normal JavaScript module outside the repo:

```js
// /tmp/check-home.mjs
export default async function (qa) {
  await qa.page.getByRole("button", { name: "Home", exact: true }).click();
  // Inspect the current UI and wait for its relevant loaded state.
  console.log(await qa.page.locator("body").ariaSnapshot());
  await qa.capture("home");
}
```

```sh
pnpm --filter @nestor/desktop qa --script /tmp/check-home.mjs
```

Use this script mode from Claude Code's Bash tool when it cannot send input to an
existing terminal. Put the connected flow in one module so the same app and data
remain available throughout it. The interactive REPL requires a tool that can
write to its existing terminal; starting another shell command does not reconnect
to that REPL.

Existing probes can import `createAgentSession` from
`apps/desktop/scripts/agent-qa/session.mjs` and close it in `finally`. Options are
`provider`, `env`, `fixtures`, `trace`, `parallelGroup` and `sessionId`. Use `env` for existing app fault hooks
or a local model-server stub. There is no custom scenario language or assertion API.

## Test the right thing

- **Setup and backend:** use existing test APIs and contract schemas for synthetic
  seeds. Inspect the relevant store rows before testing. Match seeded
  titles, companies and locations to the selected local site's actual listing.
- **User flows:** press real controls for Apply, search and save. Raw preload calls
  can skip screen state updates and produce false stale-UI findings.
  Test flags also change some behavior, such as Settings diagnostics cancellation.
  Read the current accessible tree before choosing controls. Include retrying an
  existing application and following the resulting next screen when testing Apply;
  a new seeded record alone does not cover that path.
- **Failures:** use `qa.context.route(...)`, `setOffline(...)` and service-level
  fault injection. The old `failNextSave` test hook is gone. Chromium
  network controls do not affect Node-side AI requests; use a local HTTP stub or
  service-level inspection for that layer. Verify recovery as well as the error.
- **Local sites:** `qa.sites.url` is a private random-port fixture server;
  `qa.sites.log` holds its synthetic POST receipts. It covers account gates,
  uploads, consent, new tabs, autosaves and multi-step forms. See the fixture
  README for routes. Direct local fixture submissions do not authorize live sends.
- **Design:** wait for the screen to load and inspect screenshots. `qa.capture`
  saves a PNG and accessible tree. Test keyboard focus, scrolling, overflow,
  themes and relevant empty/loading/error states. Resize the real window with
  `const win = await qa.app.browserWindow(qa.page)` then
  `await win.evaluate(w => w.setContentSize(1100, 760))`. Current minimum height
  is 720. For shared-shell changes, check both Job Finder and Live Assistant.

If a long run loses its Page connection, inspect events and `qa.app.windows()`
before restarting. Electron main may still be reachable through `qa.app.evaluate`;
enumerate `webContents` as above and use the observed ID for `executeJavaScript`
or `capturePage()` when diagnosing the embedded browser. A successful main-process
read does not prove the UI is responsive. Avoid restarting just to obtain a new
handle: prepared browser tabs disappear across a restart even when saved records
remain. Likewise, stubbing a native file picker or suppressing focus changes makes
that particular run unsuitable for proving native picker or keyboard-focus behavior.

## Evidence and cleanup

`events.jsonl` records console/errors, crashes, failed requests, HTTP errors and
process output. Known credential values are redacted; arbitrary page content is
not a secrets detector. Keep test data synthetic. `--trace` saves standard
Playwright traces per app launch; view them with
`pnpm --filter @nestor/desktop exec playwright show-trace <path>`. Traces can contain request data, so leave them off
for authenticated live browsing. Scenario failures capture the current screen.

The launcher defaults to an exclusive shared lease and detects older Playwright
sessions on macOS/Linux. For an explicitly coordinated parallel run, give every
session the same `--parallel-group` and a distinct `--session-id`, for example
`qa --parallel-group job-finder-check --session-id lane-01`. Programmatic launches
use `createAgentSession({ parallelGroup: 'job-finder-check', sessionId: 'lane-01' })`.
Each session still has a private build copy, user data and random-port replica
server; Playwright and the embedded browser allocate their own debug ports. Other
groups and exclusive launches remain blocked until every group member closes.
Build once before launching the group. Older scripts do not acquire its lease, so
coordination still matters. Windows uses the lease without conflict discovery but
does record the owned Electron PID tree for cleanup. A forced termination can
leave a lease or short-lived `.mutation` lock: inspect its owner record and verify
every recorded PID exited before removing that specific lock. Never sweep
Electron processes.

Report UI outcomes and persisted/backend outcomes separately, with provider/build
context and gaps. A screenshot, seeded record or launch alone is not a passed flow.

```sh
pnpm --filter @nestor/desktop qa:test
# Only with the shared Electron slot free; does not rebuild:
pnpm --filter @nestor/desktop qa --script scripts/agent-qa/smoke.mjs --trace
```
