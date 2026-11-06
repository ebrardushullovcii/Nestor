import { selfLimitTimeout } from "@nestor/core/self-limit";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DesktopBrowserBridge } from "@nestor/contracts";
import {
  makeProfile,
  LOGIN,
  SAFE_STORAGE,
} from "../../../../apps/desktop/test-fixtures/scoreboard-browser/profile.ts";
import type { App } from "./app.ts";
import type { Job, Result } from "./types.ts";

type Trace = {
  credentialInputs: number;
  accounts: string[];
  siteSignIns: number;
};
type BridgeWindow = Window & { nestor: { browser: DesktopBrowserBridge } };

async function permission(app: App, name: string, enabled: boolean) {
  await app.go("Settings");
  app.log(`set ${name}: ${enabled}`);
  const toggle = (await app.ctx.page).getByRole("switch", {
    name,
    exact: true,
  });
  await toggle.setChecked(enabled);
  assert.equal(await toggle.isChecked(), enabled);
  await app.ctx.sleep(500);
}

async function openBrowser(app: App, url: string) {
  // Use the public typed browser command to establish a synthetic precondition.
  await (
    await app.ctx.page
  ).evaluate(async (url) => {
    await (window as unknown as BridgeWindow).nestor.browser.command({
      type: "open",
      url,
    });
  }, url);
  await app.until(
    async () =>
      (await app.ctx.browserPages()).find((p) => p.url === url.split("?")[0]),
    30,
    "synthetic browser page opens",
  );
}

async function trace(app: App, reset = false): Promise<Trace> {
  return app.ctx.app.evaluate(
    ({ app: electronApp, webContents, session }, reset) => {
      const key = "__scoreboardSignInTrace";
      let state = Reflect.get(globalThis, key) as Trace | undefined;
      if (!state) {
        state = { credentialInputs: 0, accounts: [], siteSignIns: 0 };
        Reflect.set(globalThis, key, state);
        // Observe successful sign-in redirects without replacing request policy.
        session
          .fromPartition("persist:nestor-browser")
          .webRequest.onBeforeRedirect((details) => {
            if (
              details.method === "POST" &&
              details.statusCode === 303 &&
              /^\/workday\/account\/signin\/\d+$/.test(
                new URL(details.url).pathname,
              )
            )
              (Reflect.get(globalThis, key) as Trace).siteSignIns++;
          });
        const attach = (contents: Electron.WebContents) => {
          contents.on("console-message", (_event, _level, message) => {
            const current = Reflect.get(globalThis, key) as Trace;
            if (message === "SCOREBOARD_CREDENTIAL_INPUT")
              current.credentialInputs++;
            if (message.startsWith("SCOREBOARD_ACCOUNT:"))
              current.accounts.push(
                message.slice("SCOREBOARD_ACCOUNT:".length),
              );
          });
          contents.on("dom-ready", () => {
            // Record actions only: no input values, cookies or passwords.
            void contents
              .executeJavaScript(
                `(() => {
            document.addEventListener('input', event => {
              const input = event.target;
              if (input instanceof HTMLInputElement && (input.type === 'password' || input.type === 'email')) console.log('SCOREBOARD_CREDENTIAL_INPUT');
            }, true);
            document.addEventListener('click', event => {
              const button = event.target.closest('button[name="account"]');
              if (button && location.hostname === 'accounts.google.com') console.log('SCOREBOARD_ACCOUNT:' + button.value);
            }, true);
          })()`,
              )
              .catch(() => {});
          });
        };
        for (const contents of webContents.getAllWebContents())
          attach(contents);
        electronApp.on("web-contents-created", (_event, contents) =>
          attach(contents),
        );
      }
      if (reset) {
        state.credentialInputs = 0;
        state.accounts = [];
        state.siteSignIns = 0;
      }
      return { ...state, accounts: [...state.accounts] };
    },
    reset,
  );
}

async function applicationFixture(app: App, id: number, apply: string) {
  const job = await app.fixture("board", id);
  const db = new DatabaseSync(
    path.join(app.ctx.userDataDir, "job-finder.sqlite"),
  );
  try {
    db.prepare("UPDATE jobs SET apply_url=? WHERE id=?").run(apply, job.id);
  } finally {
    db.close();
  }
  job.apply_url = apply;
  return job;
}

async function closeBrowser(app: App) {
  await (await app.ctx.page).keyboard.press("Escape");
}

export async function google(app: App, r: Result) {
  assert.ok(app.provider, "pinned Google fixture was launched");
  const { employerOrigin, configPath } = app.provider;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    nonce: string;
  };
  await app.go("Profile");
  const p = await app.ctx.page;
  await p.getByRole("tab", { name: /^Basics/ }).click();
  await p
    .getByLabel("Email", { exact: true })
    .fill("robin.synthetic@example.test");
  await p.getByLabel("Email", { exact: true }).press("Tab");
  await app.until(
    () =>
      app.read<{ email: string }>("SELECT email FROM profile WHERE id=1")[0]
        ?.email === "robin.synthetic@example.test",
    20,
    "Profile email matches synthetic Google account",
  );
  await permission(app, "Use Google to sign in or sign up", true);
  await permission(app, "Sign in to websites", false);
  const probe = `https://accounts.google.com/__nestor_probe/${config.nonce}`;
  await openBrowser(app, probe);
  const browser = (await app.ctx.browserPages()).find((p) => p.url === probe)!;
  await app.ctx.app.evaluate(
    async (_electron, input) => {
      const fixture = Reflect.get(globalThis, "__nestorVerify") as {
        armProviderFixture(id: number, nonce: string): Promise<unknown>;
      };
      await fixture.armProviderFixture(input.id, input.nonce);
    },
    { id: browser.id, nonce: config.nonce },
  );
  await closeBrowser(app);
  await trace(app, true);
  const writes = async () => {
    const requests = (await fetch(`${employerOrigin}/__metrics`).then((r) =>
      r.json(),
    )) as { method: string; path: string }[];
    return requests.filter(
      (item) => !["GET", "HEAD", "OPTIONS"].includes(item.method),
    );
  };
  const on = await applicationFixture(app, 1, `${employerOrigin}/login/two`);
  await app.queue(on);
  await app.settle([on]);
  const onTrace = await trace(app);
  const onWrites = await writes();
  r.metrics.googleOn = {
    state: app.application(on).state,
    ...onTrace,
    providerWrites: onWrites,
  };
  // Always measure off even when on fails, retaining both observations.
  await permission(app, "Use Google to sign in or sign up", false);
  await trace(app, true);
  const off = await applicationFixture(app, 2, `${employerOrigin}/login/one`);
  await app.queue(off);
  await app.settle([off]);
  await app.ctx.sleep(2000);
  app.capture();
  const offTrace = await trace(app);
  const offQuestions = r.questions.filter((q) =>
    q.applicationIds.includes(app.application(off).id),
  );
  const offWrites = (await writes()).slice(onWrites.length);
  r.metrics.googleOff = {
    state: app.application(off).state,
    items: offQuestions.length,
    providerWrites: offWrites.length,
    ...offTrace,
  };
  r.metrics.summary = `on=${app.application(on).state}, account=${onTrace.accounts.join(",") || "none"}, credential inputs=${onTrace.credentialInputs}; off=${app.application(off).state}, items=${offQuestions.length}, provider writes=${offWrites.length}`;
  assert.equal(app.application(on).state, "ready", "Google-on reaches Ready");
  assert.deepEqual(
    onTrace.accounts,
    ["account-0"],
    "only the Profile-matching account was picked",
  );
  assert.equal(
    onTrace.credentialInputs,
    0,
    "Google-on never typed email/password",
  );
  assert.deepEqual(
    onWrites.map((w) => w.path),
    ["/select", "/confirm"],
  );
  assert.equal(app.application(off).state, "needs_you");
  assert.equal(offQuestions.length, 1, "Google-off asks once");
  assert.equal(offQuestions[0].kind, "sign_in");
  assert.equal(offWrites.length, 0, "Google-off has no provider writes");
  assert.equal(offTrace.credentialInputs, 0);
}

/** Account creation is a declared precondition, never performed by the agent. */
async function register(app: App) {
  const response = await fetch(app.replica("workday/account/register/1"), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: LOGIN.username,
      password: LOGIN.password,
      verifyPassword: LOGIN.password,
      agree: "yes",
    }),
  });
  assert.equal(
    response.status,
    303,
    "synthetic account pre-created on exact replica origin",
  );
  const session = /fixture_session=([^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  assert.ok(session);
  return session;
}

async function importCsv(app: App) {
  const file = path.join(app.ctx.evidenceDir, "synthetic-passwords.csv");
  writeFileSync(
    file,
    `url,username,password\n${new URL(app.replica("workday/")).origin},${LOGIN.username},${LOGIN.password}\n`,
  );
  await openBrowser(app, app.replica("workday/apply/1?stage=signin"));
  const p = await app.ctx.page;
  await p.getByRole("button", { name: "Saved passwords", exact: true }).click();
  app.ctx.pick(file);
  await p
    .getByRole("button", { name: "Import password CSV…", exact: true })
    .click();
  const status = p
    .getByRole("status")
    .filter({ hasText: /Added \d+, updated/ });
  await selfLimitTimeout(
    status.waitFor({ timeout: 20000 }),
    20000,
    "packages/ai-evals/scripts/scoreboard/sign-in.ts:273",
  );
  const message = await status.innerText();
  assert.match(message, /1/);
  await p.getByRole("button", { name: "Close passwords", exact: true }).click();
  await closeBrowser(app);
  return message;
}

async function reachesWorkday(app: App, job: Job, r: Result, prefix: string) {
  await app.queue(job);
  await app.until(
    async () => {
      app.capture();
      const signIn = r.questions.find(
        (q) =>
          q.kind === "sign_in" &&
          q.applicationIds.includes(app.application(job).id),
      );
      if (signIn) throw Error(`Saved sign-in handed to person: ${signIn.text}`);
      // The driver's public inventory intentionally removes query strings.
      // Inspect only a boolean from this job's real authenticated DOM instead.
      return app.ctx.app.evaluate(async ({ webContents }, apply) => {
        const expected = new URL(apply);
        for (const contents of webContents.getAllWebContents()) {
          if (
            contents.isDestroyed() ||
            !contents.getURL().startsWith(expected.origin + expected.pathname)
          )
            continue;
          if (
            await contents
              .executeJavaScript(
                'Boolean(document.querySelector("#workday-form"))',
              )
              .catch(() => false)
          )
            return true;
        }
        return false;
      }, job.apply_url);
    },
    app.timeout,
    `${prefix}: authenticated Workday form is present`,
  );
  app.capture();
}

export async function savedSignIn(app: App, r: Result) {
  await register(app);
  await permission(app, "Sign in to websites", true);
  await permission(app, "Use Google to sign in or sign up", false);
  r.metrics.csvMessage = await importCsv(app);
  await trace(app, true);
  const job = await app.fixture("workday", 1);
  // Workday's sign-in landing explicitly offers the pre-existing account.
  const db = new DatabaseSync(
    path.join(app.ctx.userDataDir, "job-finder.sqlite"),
  );
  try {
    db.prepare("UPDATE jobs SET apply_url=? WHERE id=?").run(
      `${job.apply_url}?stage=signin`,
      job.id,
    );
  } finally {
    db.close();
  }
  job.apply_url += "?stage=signin";
  await reachesWorkday(app, job, r, "CSV vault login");
  const actions = await trace(app);
  const posts = actions.siteSignIns;
  r.metrics.summary = `authenticated form=true; sign-in posts=${posts}; sign-in questions=${r.questions.filter((q) => q.kind === "sign_in").length}`;
  r.metrics.credentialInputs = actions.credentialInputs;
  assert.equal(posts, 1, "agent used the exact-origin saved login once");
  assert.equal(r.questions.filter((q) => q.kind === "sign_in").length, 0);
}

export async function browserImport(app: App, r: Result) {
  const session = await register(app);
  // Source ids encode the absolute path and have a 200-character limit.
  // Use a normal-length private path; deep evidence directories exceed it.
  const profileDir = mkdtempSync("/tmp/nestor-scoreboard-profile-");
  try {
    const fixture = makeProfile(
      profileDir,
      new URL(app.replica("workday/")).origin,
      session,
    );
    r.metrics.coverage =
      "Synthetic macOS Chrome schema/AES with injected fixture home and Safe Storage key; excludes real Chrome discovery and macOS Keychain consent.";
    r.metrics.expected = fixture.expected;
    // Redirect only this isolated process's discovery and exact Safe Storage read.
    // The unchanged production importer, IPC handlers and UI still do the work.
    await app.ctx.app.evaluate(
      (_electron, input) => {
        const os = process.getBuiltinModule("node:os");
        const cp = process.getBuiltinModule("node:child_process");
        const { syncBuiltinESMExports, createRequire } =
          process.getBuiltinModule("node:module");
        const { promisify } = process.getBuiltinModule("node:util");
        os.homedir = () => input.home;
        const original = cp.execFile;
        const isKeyRead = (args: unknown[]) => {
          if (args[0] !== "/usr/bin/security") return false;
          if (
            (args[1] as string[]).join(" ") !==
            "find-generic-password -w -s Chrome Safe Storage"
          )
            throw Error("Only the synthetic Chrome key may be requested");
          return true;
        };
        cp.execFile = ((...args: unknown[]) => {
          if (isKeyRead(args)) {
            const callback = args.at(-1) as (
              error: null,
              out: string,
              err: string,
            ) => void;
            queueMicrotask(() => callback(null, input.key + "\n", ""));
            return undefined;
          }
          return Reflect.apply(original, cp, args) as unknown;
        }) as typeof original;
        // execFile's promisified API returns {stdout,stderr}, unlike a regular
        // Node callback. Keep that contract for the production import module.
        const nativeAsync = promisify(original);
        Reflect.set(cp.execFile, promisify.custom, (...args: unknown[]) =>
          isKeyRead(args)
            ? Promise.resolve({ stdout: input.key + "\n", stderr: "" })
            : (Reflect.apply(nativeAsync, cp, args) as unknown),
        );
        syncBuiltinESMExports();
        // The importer may have loaded while the browser UI was mounting. Evict
        // that one lazy module so it captures this fixture-only key reader.
        const require = createRequire(
          _electron.app.getAppPath() + "/main/index.cjs",
        );
        for (const file of Object.keys(require.cache))
          if (/[/\\]browser-profile-import-[^/\\]+\.cjs$/.test(file))
            delete require.cache[file];
      },
      { home: fixture.home, key: SAFE_STORAGE },
    );
    await permission(app, "Sign in to websites", true);
    await openBrowser(app, app.replica("workday/apply/1?stage=signin"));
    const p = await app.ctx.page;
    await p
      .getByRole("button", { name: "More browser actions", exact: true })
      .click();
    await p.getByRole("menuitem", { name: /Bring sign-ins from/ }).click();
    const source = p
      .getByRole("listitem")
      .filter({ hasText: "Scoreboard synthetic" });
    await source.click();
    const result = p.locator(".browser-import-result");
    await selfLimitTimeout(
      result.waitFor({ timeout: 20000 }),
      20000,
      "packages/ai-evals/scripts/scoreboard/sign-in.ts:431",
    );
    const message = await result.innerText();
    r.metrics.cookieMessage = message;
    await p.getByRole("button", { name: "Done", exact: true }).click();
    await p
      .getByRole("button", { name: "Saved passwords", exact: true })
      .click();
    await p
      .getByText("Import directly from a browser", { exact: true })
      .click();
    await p
      .getByRole("button")
      .filter({ hasText: /Google Chrome.*Scoreboard synthetic/ })
      .click();
    const passwordMessage = p
      .getByRole("status")
      .filter({ hasText: /Added \d+, updated/ });
    await selfLimitTimeout(
      passwordMessage.waitFor({ timeout: 20000 }),
      20000,
      "packages/ai-evals/scripts/scoreboard/sign-in.ts:452",
    );
    r.metrics.passwordMessage = await passwordMessage.innerText();
    await p
      .getByRole("button", { name: "Manage all saved logins", exact: true })
      .click();
    const saved = await p.evaluate(async () =>
      (window as unknown as BridgeWindow).nestor.browser.passwords.list({}),
    );
    r.metrics.savedLogins = saved.credentials.length;
    await p
      .getByRole("button", { name: "Close passwords", exact: true })
      .click();
    await closeBrowser(app);
    // No agent login is needed: prove the imported HttpOnly Workday cookie works.
    await trace(app, true);
    const job = await app.fixture("workday", 1);
    await reachesWorkday(app, job, r, "imported session");
    const signIns = (await trace(app)).siteSignIns;
    const cookies = await app.ctx.app.evaluate(async ({ session }) => {
      const imported = (
        await session.fromPartition("persist:nestor-browser").cookies.get({})
      ).filter((c) =>
        ["fixture_session", "synthetic_a", "synthetic_b"].includes(c.name),
      );
      return {
        count: imported.length,
        sites: new Set(imported.map((c) => c.domain)).size,
      };
    });
    r.metrics.importedCookies = cookies;
    r.metrics.summary = `cookies=${cookies.count}/${fixture.expected.cookies}; sites=${cookies.sites}/${fixture.expected.sites}; logins=${saved.credentials.length}/${fixture.expected.logins}; excluded=4 with reasons; session reused=${signIns === 0}`;
    assert.equal(cookies.count, fixture.expected.cookies);
    assert.equal(cookies.sites, fixture.expected.sites);
    assert.match(message, /Found 7 cookies/);
    assert.match(message, /Imported 3 cookies for 3 sites/);
    assert.match(message, /1 use unsupported encryption/);
    assert.match(message, /1 could not be decrypted/);
    assert.match(message, /2 expired, partitioned or invalid/);
    assert.equal(saved.credentials.length, fixture.expected.logins);
    assert.equal(
      signIns,
      0,
      "imported session reached form without another sign-in",
    );
    assert.equal(r.questions.filter((q) => q.kind === "sign_in").length, 0);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}
