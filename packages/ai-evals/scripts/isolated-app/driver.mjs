// The long-lived driver for one instance. `up` starts it detached; it owns the
// replica sites server and the Electron app, and answers `drive` commands on a
// private loopback port. Never start it by hand.
import childProcess, { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkout,
  descendants,
  desktopDir,
  evidenceDir,
  ownedProcessTree,
  stillOurs,
  isAlive,
  loadAiEnv,
  readState,
  redact,
  requireDesktop,
  startTime,
  stateDir,
  step,
  writeState,
} from "./common.mjs";
import { rows, saveRows, tables } from "./sqlite.mjs";
import { record } from "./trace.mjs";
import { profileProvenance, assertLiveProfile } from "./live-profile.mjs";
import { readNativeIdentity, startNativeApp } from "./native-app.mjs";

const { _electron } = requireDesktop("playwright");

// Windows: the driver runs detached with no console, and Playwright starts
// Electron through `cmd /c`, so every launch opened a visible terminal on the
// owner's screen. Hide the console of everything this process spawns.
if (process.platform === "win32") {
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) =>
    args === undefined || Array.isArray(args)
      ? realSpawn(command, args ?? [], { ...options, windowsHide: true })
      : realSpawn(command, { ...args, windowsHide: true });
}
const patchPath = path.join(import.meta.dirname, "instance-patch.cjs");
const { loadProviderFixture, providerArgs } = requireDesktop(
  path.join(import.meta.dirname, "provider-fixture.cjs"),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const launch = JSON.parse(
  readFileSync(path.join(stateDir, "launch.json"), "utf8"),
);
const providerFixturePath = process.env.NESTOR_VERIFY_PROVIDER_FIXTURE;
const providerFixture = loadProviderFixture(providerFixturePath, {
  label: path.basename(stateDir),
  userDataDir: launch.userDataDir,
  testApi: launch.testApi !== false,
  net: launch.net,
});
if (providerFixture && launch.launch === "native")
  throw new Error(
    "The synthetic provider fixture currently requires the isolated Playwright backend.",
  );
const shotsDir = path.join(evidenceDir, "shots");
mkdirSync(shotsDir, { recursive: true });

let env;
let app = null;
let sites = null;
let generation = 0;
let applicationKey = process.env.NESTOR_TRACE_APPLICATION_KEY || null;

function update(values) {
  writeState({ ...readState(), ...values });
}

// --- Environment ----------------------------------------------------------
function buildEnv() {
  const base = { ...process.env };
  let aiSources = [];
  if (launch.ai === "live") {
    const { loaded, sources } = loadAiEnv();
    aiSources = sources;
    Object.assign(base, { ...loaded, ...base });
  }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "NODE_OPTIONS",
  ])
    delete base[key];
  for (const key of Object.keys(base))
    if (
      key.startsWith("NESTOR_VERIFY_") &&
      !["NESTOR_VERIFY_LABEL", "NESTOR_VERIFY_WINDOWS"].includes(key)
    )
      delete base[key];
  const live = launch.ai === "live" ? "1" : "0";
  if (launch.ai !== "live")
    for (const key of Object.keys(base))
      if (/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) base[key] = "";
  return {
    env: {
      ...base,
      NESTOR_ENABLE_TEST_API: launch.testApi === false ? "0" : "1",
      NESTOR_TEST_API_USE_LIVE_AI: live,
      NESTOR_INTERVIEW_TEST_USE_LIVE_AI: live,
      NESTOR_USER_DATA_DIR: launch.userDataDir,
      // Always the in-app browser: the external Chrome host runs outside the send guard.
      NESTOR_BROWSER_HOST: "embedded",
      ELECTRON_ENABLE_LOGGING: "1",
      NESTOR_VERIFY_STATE: stateDir,
      NESTOR_VERIFY_EVIDENCE: evidenceDir,
      NESTOR_VERIFY_NET: launch.net,
      NESTOR_VERIFY_AI: launch.ai,
      ...(providerFixture
        ? { NESTOR_VERIFY_PROVIDER_FIXTURE: providerFixturePath }
        : {}),
    },
    aiSources,
  };
}

// --- Replica sites --------------------------------------------------------
async function startSites() {
  const child = spawn(
    process.execPath,
    [path.join(desktopDir, "test-fixtures/job-sites/serve.mjs")],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: path.join(
          evidenceDir,
          "submissions.jsonl",
        ),
      },
      stdio: ["ignore", "ignore", "pipe"],
      // The driver runs detached without a console; without this the sites
      // server opens a visible terminal window on the owner's screen.
      windowsHide: true,
    },
  );
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Replica sites did not start: ${output}`)),
      15000,
    );
    child.once("exit", (code) =>
      reject(new Error(`Replica sites exited ${code}: ${output}`)),
    );
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  child.stderr.resume();
  return {
    url,
    pid: child.pid,
    child,
    log: path.join(evidenceDir, "submissions.jsonl"),
  };
}

// --- Electron -------------------------------------------------------------
function killOrphans() {
  const state = readState();
  const owned = ownedProcessTree([[state?.electronPid, state?.electronStart]]);
  for (const [pid, started] of owned) {
    if (!stillOurs(pid, started)) continue;
    step(`orphan: stopping recorded instance pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  return [...owned.keys()];
}

async function startApp() {
  assertLiveProfile(launch.userDataDir, launch.net);
  record("run_header", {
    build: readState()?.build,
    machine: {
      hostname: (await import("node:os")).hostname(),
      platform: process.platform,
      arch: process.arch,
    },
    ai: launch.ai,
    network: launch.net,
    profile: profileProvenance(launch.userDataDir),
    liveApplyAuthorized: process.env.NESTOR_LIVE_APPLY_AUTHORIZED === "1",
    testApi: launch.testApi,
    applicationKey,
  });
  generation += 1;
  let lastError;
  const native = launch.launch === "native";
  for (let attempt = 1; attempt <= (native ? 1 : 4); attempt += 1) {
    if (killOrphans().length) await sleep(1500);
    try {
      app = native
        ? await startNativeApp(launch, env, patchPath, {
            requireDesktop,
            cwd: desktopDir,
            onSpawn: (child, started) =>
              update({
                electronPid: child.pid,
                electronStart: started,
                generation,
              }),
            log: (chunk) =>
              appendFileSync(
                path.join(stateDir, "app.log"),
                redact(chunk, env),
              ),
          })
        : await _electron.launch({
            executablePath: launch.electronPath,
            args: [
              ...providerArgs(providerFixture),
              "-r",
              patchPath,
              launch.appDir,
            ],
            cwd: desktopDir,
            env,
            timeout: 60000,
            ...(launch.video
              ? { recordVideo: { dir: path.join(evidenceDir, "videos") } }
              : {}),
          });
      const child = app.process();
      if (!native)
        child.stdout?.on("data", (c) =>
          appendFileSync(path.join(stateDir, "app.log"), redact(c, env)),
        );
      if (!native)
        child.stderr?.on("data", (c) =>
          appendFileSync(path.join(stateDir, "app.log"), redact(c, env)),
        );
      const page = await mainPage(60);
      // Windows: park the window off-screen so it never covers the owner's
      // screen; it keeps rendering for screenshots and Playwright input.
      if (process.platform === "win32")
        if (native)
          await app.evaluate(({ BrowserWindow }) => {
            for (const win of BrowserWindow.getAllWindows())
              win.setPosition(-6000, 0);
          });
        else
          await app
            .browserWindow(page)
            .then((win) => win.evaluate((w) => w.setPosition(-6000, 0)))
            .catch(() => {});
      await page.waitForFunction(
        () => Boolean(window.nestor?.jobFinder),
        null,
        { timeout: 60000 },
      );
      const actual = await app.evaluate(({ app }) => app.getPath("userData"));
      if (path.resolve(actual) !== path.resolve(launch.userDataDir)) {
        await app.close().catch(() => {});
        throw new Error(
          `Refusing: the app opened user data at ${actual}, not ${launch.userDataDir}`,
        );
      }
      update({
        electronPid: child.pid,
        electronStart: startTime(child.pid),
        generation,
      });
      await verifyGuard();
      if (native) {
        const prior = await page.evaluate(() =>
          window.nestor.browser.getState(),
        );
        let probeTab;
        try {
          if (!prior.tabs.length) {
            const opened = await page.evaluate(
              (url) => window.nestor.browser.command({ type: "open", url }),
              sites.url,
            );
            probeTab = opened.activeTabId;
          }
          // Product navigation is asynchronous; inspect only its own partition.
          let samples;
          for (let n = 0; n < 40; n++) {
            try {
              samples = await readNativeIdentity(app);
              break;
            } catch (error) {
              if (!String(error.message).includes("no embedded page"))
                throw error;
              await sleep(100);
            }
          }
          if (!samples)
            throw new Error("Refusing: native identity probe did not load.");
          update({
            nativeIdentity: samples,
            nativeIdentityAt: new Date().toISOString(),
          });
        } finally {
          if (probeTab)
            await page.evaluate(
              (tabId) =>
                window.nestor.browser.command({ type: "close_tab", tabId }),
              probeTab,
            );
        }
      }
      return;
    } catch (error) {
      lastError = error;
      if (error.survivors?.length) update({ survivors: error.survivors });
      step(
        `launch attempt ${attempt} failed: ${String(error.message).split("\n")[0]}`,
      );
      // Keep the launch error; record cleanup survivors instead of throwing.
      if (app)
        await stopApp().catch((cleanup) =>
          update({ survivors: cleanup.survivors ?? [] }),
        );
      app = null;
      if (native || String(error.message).startsWith("Refusing")) break;
    }
  }
  throw lastError;
}

async function stopApp() {
  if (!app) return [];
  if (launch.launch === "native") {
    const stopped = await app.close();
    app = null;
    return stopped;
  }
  const pid = app.process().pid;
  const owned = ownedProcessTree([[pid, startTime(pid)]]);
  await Promise.race([app.close().catch(() => {}), sleep(20000)]);
  for (
    let i = 0;
    i < 40 && [...owned].some(([pid, started]) => stillOurs(pid, started));
    i += 1
  )
    await sleep(250);
  for (const [p, started] of owned)
    if (stillOurs(p, started))
      try {
        process.kill(p, "SIGTERM");
      } catch {}
  await sleep(500);
  app = null;
  return [...owned]
    .filter(([pid, started]) => stillOurs(pid, started))
    .map(([pid]) => pid);
}

/** The app can replace its main window; always talk to the current one. */
async function mainPage(seconds = 30) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const open = app
      .windows()
      .filter(
        (p) =>
          !p.isClosed() &&
          /renderer\/index\.html/.test(p.url()) &&
          !p.url().includes("/live-assistant/overlay/"),
      );
    if (open.length) return open[0];
    await sleep(500);
  }
  throw new Error(
    "No main Nestor window is open. Try `drive restart`, then `doctor`.",
  );
}

/** Resolve the application's own prepared-page binding, never the last tab. */
async function browserTargets({
  url,
  applicationKey: key = applicationKey,
} = {}) {
  return app.evaluate(
    async ({ webContents, session }, input) => {
      const pages = webContents
        .getAllWebContents()
        .filter(
          (w) =>
            !w.isDestroyed() &&
            w.session === session.fromPartition("persist:nestor-browser") &&
            /^https?:/.test(w.getURL()),
        );
      const targets = [];
      for (const w of pages) {
        const binding = await w
          .executeJavaScript("window.__nestorPreparedApplication || null")
          .catch(() => null);
        if (input.key && binding !== input.key) continue;
        if (input.url && !w.getURL().includes(input.url)) continue;
        targets.push({ id: w.id, url: w.getURL(), applicationKey: binding });
      }
      return targets;
    },
    { key, url },
  );
}
async function pageFor({ page: which, url, applicationKey: key } = {}) {
  if (which !== "browser") return mainPage();
  if (launch.launch === "native")
    throw new Error(
      "Native launch does not expose embedded page input. Use the app's scoped browser workflow; capturePage shots remain available.",
    );
  for (let i = 0; i < 20; i++) {
    const targets = await browserTargets({
      url,
      applicationKey: key ?? applicationKey,
    });
    if (targets.length > 1)
      throw new Error(
        "Several application tabs match. Use drive bind <application_N_attempt_N> or --url to identify this application's tab.",
      );
    if (targets.length === 1) {
      const matches = app
        .context()
        .pages()
        .filter((p) => !p.isClosed() && p.url() === targets[0].url);
      for (const page of matches) {
        const binding = await page
          .evaluate(() => window.__nestorPreparedApplication || null)
          .catch(() => null);
        if (binding === targets[0].applicationKey) return page;
      }
    }
    await sleep(500);
  }
  throw new Error("No matching application tab is open.");
}

// Main-process window lookup still works when Playwright's page handle has died.
const WINDOW_FINDER = `(BrowserWindow, kind) => BrowserWindow.getAllWindows()
  .filter((w) => !w.isDestroyed() && /renderer\\/index\\.html/.test(w.webContents.getURL()))
  .filter((w) => (kind === "overlay") === w.webContents.getURL().includes("/live-assistant/overlay/"))
  .sort((a, b) => a.id - b.id)`;

function nextShotName(name) {
  const counter = path.join(stateDir, "shot-counter");
  const n =
    (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  writeFileSync(counter, String(n));
  return `${String(n).padStart(3, "0")}-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

async function shot(
  name,
  { target = "main", url, applicationKey: key = applicationKey } = {},
) {
  const selected =
    target === "browser"
      ? await browserTargets({ url, applicationKey: key })
      : null;
  if (selected && selected.length !== 1)
    throw new Error(
      "A browser screenshot needs exactly one application tab; bind its key or give --url.",
    );
  const images = await app.evaluate(
    async ({ BrowserWindow, webContents, nativeImage }, input) => {
      const find = eval(input.finder);
      let targets;
      if (input.target === "browser") {
        targets = [webContents.fromId(input.contentsId)].filter(
          (w) => w && !w.isDestroyed(),
        );
      } else
        targets = find(BrowserWindow, input.target)
          .slice(0, input.target === "overlay" ? 2 : 1)
          .map((w) => w.webContents);
      const out = [];
      for (const w of targets) {
        // A window that has not painted yet (a popup that just opened) fails or
        // comes back empty; give it up to 5 s.
        let image = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          image = await w.capturePage().catch(() => null);
          if (image && !image.isEmpty()) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!image) throw new Error(`Could not capture ${w.getURL()}`);
        // Mask credential/code controls in the bitmap; never mutate the live DOM.
        const rects = await w
          .executeJavaScript(
            `Array.from(document.querySelectorAll('input[type="password"],input[name*="password" i],input[autocomplete*="password" i],input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="mfa" i],input[name*="token" i],input[name="code" i],input[name="passcode" i],iframe')).map(e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight}})`,
          )
          .catch(() => []);
        if (rects.length && image && !image.isEmpty()) {
          const size = image.getSize();
          const bitmap = image.toBitmap();
          for (const r of rects) {
            const sx = size.width / r.vw,
              sy = size.height / r.vh;
            for (
              let y = Math.max(0, Math.floor(r.y * sy));
              y < Math.min(size.height, Math.ceil((r.y + r.height) * sy));
              y++
            )
              bitmap.fill(
                0,
                (y * size.width + Math.max(0, Math.floor(r.x * sx))) * 4,
                (y * size.width +
                  Math.min(size.width, Math.ceil((r.x + r.width) * sx))) *
                  4,
              );
          }
          image = nativeImage.createFromBitmap(bitmap, size);
        }
        out.push({
          url: w.getURL(),
          visibleText: await w
            .executeJavaScript("document.body.innerText")
            .catch(() => null),
          contentsId: w.id,
          png: image.isEmpty() ? null : image.toPNG().toString("base64"),
        });
      }
      return out;
    },
    { finder: WINDOW_FINDER, target, url, contentsId: selected?.[0]?.id },
  );
  if (!images.length)
    throw new Error(`Nothing to capture for target ${target}`);
  const files = [];
  for (const [i, image] of images.entries()) {
    if (!image.png)
      throw new Error(
        `Capture of ${image.url} came back empty (window hidden or page backstage)`,
      );
    const base = path.join(
      shotsDir,
      nextShotName(images.length > 1 ? `${name}-${i + 1}` : name),
    );
    writeFileSync(`${base}.png`, Buffer.from(image.png, "base64"));
    files.push(`${base}.png`);
    record("driver_snapshot", {
      applicationKey: key,
      target,
      path: `${base}.png`,
      url: image.url,
      visibleText: image.visibleText,
      contentsId: image.contentsId,
    });
  }
  if (target === "main") {
    const tree = await see().catch(() => null);
    if (tree) writeFileSync(files[0].replace(/\.png$/, ".aria.txt"), tree);
  }
  return files;
}

async function see(opts = {}) {
  return (await pageFor(opts)).locator("body").ariaSnapshot();
}

async function heading() {
  try {
    const page = await mainPage(2);
    return await page.evaluate(
      () => document.querySelector("main h1, h1")?.textContent?.trim() ?? "",
    );
  } catch {
    return "";
  }
}

// --- Locators -------------------------------------------------------------
const ROLES = [
  "button",
  "link",
  "tab",
  "menuitem",
  "radio",
  "checkbox",
  "switch",
  "option",
  "treeitem",
  "combobox",
];
const SCOPES = [
  "dialog",
  "alertdialog",
  "region",
  "group",
  "radiogroup",
  "form",
  "article",
  "navigation",
  "complementary",
  "main",
  "list",
  "listitem",
  "tabpanel",
];
const toName = (text) => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(text);
  return m ? new RegExp(m[1], m[2]) : text;
};

function candidates(page, text, { role, exact = true } = {}) {
  const name = toName(text);
  const opts = typeof name === "string" ? { name, exact } : { name };
  if (role) return [page.getByRole(role, opts)];
  return [
    ...ROLES.map((r) => page.getByRole(r, opts)),
    page.getByLabel(name, typeof name === "string" ? { exact } : {}),
    page.getByText(name, typeof name === "string" ? { exact } : {}),
  ];
}

async function find(
  text,
  { timeout = 10000, nth, within, page: which, url, ...opts } = {},
) {
  const page = await pageFor({ page: which, url });
  const scope = within
    ? SCOPES.map((r) => page.getByRole(r, { name: toName(within) }))
        .reduce((a, b) => a.or(b))
        .first()
    : page;
  const deadline = Date.now() + timeout;
  while (true) {
    for (const locator of candidates(scope, text, opts)) {
      const count = await locator.count();
      if (!count) continue;
      const pick =
        nth !== undefined ? locator.nth(Number(nth)) : locator.first();
      if (await pick.isVisible().catch(() => false))
        return { locator: pick, count };
    }
    if (Date.now() > deadline)
      throw new Error(
        `Nothing visible matches ${JSON.stringify(text)}${opts.role ? ` (role ${opts.role})` : ""}`,
      );
    await sleep(250);
  }
}

async function click(text, opts = {}) {
  if (opts.page === "browser")
    record("operator_action", {
      applicationKey,
      source: "driver browser click",
    });
  const { locator, count } = await find(text, opts);
  await locator.click({ timeout: opts.timeout ?? 10000 });
  return count > 1 ? `clicked the first of ${count} matches` : "clicked";
}

async function fill(label, value, opts = {}) {
  if (opts.page === "browser")
    record("operator_action", {
      applicationKey,
      source: "driver browser fill",
    });
  const page = await pageFor(opts);
  const name = toName(label);
  const tries = [
    page.getByLabel(name, typeof name === "string" ? { exact: true } : {}),
    ...["textbox", "searchbox", "combobox", "spinbutton"].map((r) =>
      page.getByRole(r, { name }),
    ),
    page.getByPlaceholder(name),
  ];
  const deadline = Date.now() + (opts.timeout ?? 10000);
  while (true) {
    for (const locator of tries)
      if ((await locator.count()) && (await locator.first().isVisible())) {
        await locator.first().fill(String(value));
        return "filled";
      }
    if (Date.now() > deadline)
      throw new Error(`No visible field labelled ${JSON.stringify(label)}`);
    await sleep(250);
  }
}

async function waitFor(text, seconds = 30, opts = {}) {
  await find(text, { ...opts, timeout: Number(seconds) * 1000 });
  return "visible";
}

// --- Commands -------------------------------------------------------------
const show = (args) =>
  args
    .filter((a) => a !== undefined)
    .map((a) => JSON.stringify(a))
    .join(" ")
    .slice(0, 200);
/** Journey and eval helpers write one steps.log line per action, like drive commands do. */
const logged =
  (name, fn) =>
  async (...args) => {
    const started = Date.now();
    try {
      const result = await fn(...args);
      step(`  ${name} ${show(args)}  ok ${Date.now() - started}ms`);
      return result;
    } catch (error) {
      step(
        `  ${name} ${show(args)}  FAILED ${Date.now() - started}ms: ${String(error.message).split("\n")[0]}`,
      );
      throw error;
    }
  };

function context(extra = {}) {
  return {
    get page() {
      return mainPage();
    },
    // A getter, like page: a restart replaces the app.
    get app() {
      return app;
    },
    sites: sites && {
      url: sites.url,
      log: sites.log,
      submissions: () => readJsonl(sites.log),
    },
    userDataDir: launch.userDataDir,
    evidenceDir,
    checkout,
    desktopDir,
    ai: launch.ai,
    shot: logged("shot", (name, opts) => shot(name, opts)),
    see,
    click: logged("click", click),
    fill: logged("fill", fill),
    waitFor: logged("wait", waitFor),
    press: logged("press", async (key, opts) =>
      (await pageFor(opts)).keyboard.press(key),
    ),
    pageFor,
    pick: (...files) => {
      writeFileSync(
        path.join(stateDir, "next-open.txt"),
        files.flat().join("\n"),
      );
      step(`  pick ${files.flat().join(" ")}`);
    },
    note: (...parts) => step(`note  ${parts.join("  ")}`),
    db: (table, opts) => {
      const result = rows(
        launch.userDataDir,
        path.join(stateDir, "db-copy"),
        table,
        opts,
      );
      const file = saveRows(evidenceDir, result, opts?.name ?? table);
      step(
        `  db ${table} ${result.rows.length} row(s) -> ${path.basename(file)}`,
      );
      return result.rows;
    },
    tables: () => tables(launch.userDataDir, path.join(stateDir, "db-copy")),
    bindApplication: (key) => {
      applicationKey = key;
      record("application_bound", { applicationKey });
    },
    operatorActed: (note) =>
      record("operator_action", { applicationKey, note }),
    browserPages: () =>
      app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((w) => ({
          id: w.id,
          type: w.getType(),
          url: w.getURL().split("?")[0],
        })),
      ),
    sleep,
    // Close and relaunch on the same data, as `drive restart` does.
    restart: () => commands.restart(),
    ...extra,
  };
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const commands = {
  bind: (key) => {
    applicationKey = key;
    record("application_bound", { applicationKey });
    return key;
  },
  operator: (note = "Operator acted") => {
    record("operator_action", { applicationKey, note });
    return "recorded";
  },
  async status() {
    const appPid = app?.process().pid ?? null;
    return {
      label: readState()?.label,
      generation,
      appPid,
      appAlive: isAlive(appPid),
      userDataDir: launch.userDataDir,
      ai: launch.ai,
      net: launch.net,
      launch: launch.launch ?? "playwright",
      sites: sites?.url ?? null,
      heading: app ? await heading() : null,
      windows: app
        ? app
            .windows()
            .map((p) =>
              p.url().replace(/^file:\/\/.*\/renderer\//, "renderer/"),
            )
        : [],
    };
  },
  see: (opts) => see(opts),
  shot: (name = "screen", opts = {}) => shot(name, opts),
  click: (text, opts) => click(text, opts),
  fill: (label, value, opts) => fill(label, value, opts),
  press: async (key, opts) => (
    (await pageFor(opts)).keyboard.press(key),
    "pressed"
  ),
  wait: (text, seconds, opts) => waitFor(text, seconds, opts),
  pick: (...files) => {
    for (const f of files)
      if (!existsSync(f)) throw new Error(`No such file: ${f}`);
    writeFileSync(path.join(stateDir, "next-open.txt"), files.join("\n"));
    return `the next file picker returns ${files.join(", ")}`;
  },
  browser: () => context().browserPages(),
  identity: () => {
    if (launch.launch !== "native")
      throw new Error("identity requires --launch native");
    return readNativeIdentity(app);
  },
  async eval(source) {
    const ctx = context();
    const page = await ctx.page;
    const names = ["page", ...Object.keys(ctx).filter((k) => k !== "page")];
    const AsyncFunction = (async () => {}).constructor;
    return new AsyncFunction(...names, source)(
      page,
      ...names.slice(1).map((k) => ctx[k]),
    );
  },
  async run(file, ...args) {
    const module = await import(
      `${pathToFileURL(path.resolve(file)).href}?t=${Date.now()}`
    );
    if (typeof module.default !== "function")
      throw new Error("A journey exports default async function (ctx)");
    return module.default(context({ args }));
  },
  async restart() {
    const survivors = await stopApp();
    if (survivors.length)
      throw new Error(
        `App processes survived the stop: ${survivors.join(", ")}`,
      );
    await startApp();
    return "restarted with the same data";
  },
};

async function failureShot(cmd) {
  // Live workspaces contain personal data; never save automatic screenshots.
  if (launch.net === "live" && !process.env.NESTOR_RUN_TRACE_DIR) return null;
  try {
    if (app) {
      const files = await shot(`failure-${cmd}`);
      if (process.env.NESTOR_RUN_TRACE_DIR) {
        try {
          files.push(
            ...(await shot(`failure-${cmd}-application`, {
              target: "browser",
            })),
          );
        } catch (error) {
          record("driver_snapshot_error", {
            applicationKey,
            error: String(error.message),
          });
        }
      }
      return files;
    }
  } catch {}
  return null;
}

// --- Server ---------------------------------------------------------------
const token = randomBytes(16).toString("hex");
let queue = Promise.resolve();
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const survivors = await stopApp().catch((error) => {
    update({
      cleanupError: "Owned app cleanup failed; state retained for down.",
    });
    return error.survivors ?? readState()?.survivors ?? [];
  });
  if (sites) {
    sites.child.kill("SIGTERM");
    await sleep(300);
  }
  update({ driverStopped: new Date().toISOString(), survivors });
  step(
    `driver stopped${survivors.length ? `; survivors ${survivors.join(", ")}` : ""}`,
  );
  process.exit(code);
}
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

const server = http.createServer(async (req, res) => {
  if (req.headers["x-verify-token"] !== token) {
    res.statusCode = 403;
    return res.end("wrong token");
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { cmd, args = [] } = JSON.parse(body || "{}");
  if (cmd === "stop") {
    res.end(JSON.stringify({ ok: true, result: "stopping" }));
    return shutdown();
  }
  const run = async () => {
    const started = Date.now();
    const shown =
      cmd === "eval"
        ? `${String(args[0]).slice(0, 160).replace(/\s+/g, " ")}`
        : args
            .map((a) =>
              typeof a === "string" ? JSON.stringify(a) : JSON.stringify(a),
            )
            .join(" ");
    try {
      if (!commands[cmd]) throw new Error(`Unknown command ${cmd}`);
      if (!app && cmd !== "status")
        throw new Error(
          "The app is not running. Run `drive restart` or `down` then `up`.",
        );
      const result = await commands[cmd](...args);
      if (cmd !== "status" && cmd !== "see")
        step(
          `${cmd} ${shown}  ok ${Date.now() - started}ms  [${await heading()}]`,
        );
      return { ok: true, result };
    } catch (error) {
      const failure = await failureShot(cmd);
      step(
        `${cmd} ${shown}  FAILED ${Date.now() - started}ms: ${String(error.message).split("\n")[0]}`,
      );
      console.error(error);
      return {
        ok: false,
        error: String(error.message ?? error),
        failureShot: failure,
      };
    }
  };
  const out =
    cmd === "status" ? await run() : await (queue = queue.then(run, run));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out, null, 1));
});

async function verifyGuard() {
  if (launch.net === "live") {
    const authorized = await app.evaluate(
      ({ session }) =>
        process.env.NESTOR_LIVE_APPLY_AUTHORIZED === "1" &&
        globalThis.__nestorVerify?.netMode === "live" &&
        globalThis.__nestorVerify.guardInstalled(
          session.fromPartition("persist:nestor-browser"),
        ),
    );
    if (!authorized)
      throw new Error("Live network authorization check failed.");
    update({ guard: "verified" });
    return;
  }
  const probePath = `/apply/${randomBytes(8).toString("hex")}`;
  const guardProbe = await app.evaluate(async ({ session }, probePath) => {
    try {
      await session
        .fromPartition("persist:nestor-browser")
        .fetch(`https://guard-selftest.invalid${probePath}`, {
          method: "POST",
          body: "x",
        });
      return "sent";
    } catch {
      return "blocked";
    }
  }, probePath);
  const events = readJsonl(path.join(evidenceDir, "blocked-requests.jsonl"));
  if (
    guardProbe !== "blocked" ||
    !events.some(
      (event) =>
        event.origin === "https://guard-selftest.invalid" &&
        event.path === probePath &&
        event.method === "POST",
    )
  )
    throw new Error(
      "Send guard self-test failed; refusing to drive this instance.",
    );
  update({ guard: "verified" });
}

try {
  ({ env } = buildEnv());
  sites = await startSites();
  update({
    sitesUrl: sites.url,
    sitesPid: sites.pid,
    sitesStart: startTime(sites.pid),
  });
  await startApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  update({
    driverPort: server.address().port,
    token,
    guard: "verified",
    readyAt: new Date().toISOString(),
  });
  step(
    `up  ready: ai=${launch.ai} net=${launch.net} sites=${sites.url} data=${launch.userDataDir}`,
  );
} catch (error) {
  update({ startError: String(error.stack ?? error) });
  step(`up  FAILED: ${String(error.message).split("\n")[0]}`);
  await shutdown(1);
}
