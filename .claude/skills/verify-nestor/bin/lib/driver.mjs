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
  holdersOf,
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const launch = JSON.parse(
  readFileSync(path.join(stateDir, "launch.json"), "utf8"),
);
const shotsDir = path.join(evidenceDir, "shots");
mkdirSync(shotsDir, { recursive: true });

let env;
let app = null;
let sites = null;
let generation = 0;

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
    if (key.startsWith("NESTOR_VERIFY_") && key !== "NESTOR_VERIFY_LABEL")
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
  // Only processes holding this instance's own private data folder.
  const holders = holdersOf(launch.userDataDir);
  for (const pid of holders) {
    step(`orphan: stopping pid ${pid} that held ${launch.userDataDir}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  return holders;
}

async function startApp() {
  generation += 1;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (killOrphans().length) await sleep(1500);
    try {
      app = await _electron.launch({
        executablePath: launch.electronPath,
        args: ["-r", patchPath, launch.appDir],
        cwd: desktopDir,
        env,
        timeout: 60000,
        ...(launch.video
          ? { recordVideo: { dir: path.join(evidenceDir, "videos") } }
          : {}),
      });
      const child = app.process();
      child.stdout?.on("data", (c) =>
        appendFileSync(path.join(stateDir, "app.log"), redact(c, env)),
      );
      child.stderr?.on("data", (c) =>
        appendFileSync(path.join(stateDir, "app.log"), redact(c, env)),
      );
      const page = await mainPage(60);
      // Windows: park the window off-screen so it never covers the owner's
      // screen; it keeps rendering for screenshots and Playwright input.
      if (process.platform === "win32")
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
      return;
    } catch (error) {
      lastError = error;
      step(
        `launch attempt ${attempt} failed: ${String(error.message).split("\n")[0]}`,
      );
      if (String(error.message).startsWith("Refusing")) break;
      if (app) await app.close().catch(() => {});
      app = null;
    }
  }
  throw lastError;
}

async function stopApp() {
  if (!app) return [];
  const pid = app.process().pid;
  const owned = descendants(pid);
  await Promise.race([app.close().catch(() => {}), sleep(20000)]);
  for (let i = 0; i < 40 && owned.some(isAlive); i += 1) await sleep(250);
  for (const p of owned.filter(isAlive))
    try {
      process.kill(p, "SIGTERM");
    } catch {}
  await sleep(500);
  app = null;
  return owned.filter(isAlive);
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

/** `--page browser` targets the newest in-app browser page (or the one whose URL contains `--url`). */
async function pageFor({ page: which, url } = {}) {
  if (which !== "browser") return mainPage();
  for (let i = 0; i < 20; i += 1) {
    const pages = app
      .context()
      .pages()
      .filter(
        (p) =>
          !p.isClosed() &&
          /^https?:/.test(p.url()) &&
          (!url || p.url().includes(url)),
      );
    if (pages.length) return pages.at(-1);
    await sleep(500);
  }
  throw new Error(
    `No in-app browser page${url ? ` with ${url} in its URL` : ""} is open. Open the Job Finder browser first.`,
  );
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

async function shot(name, { target = "main", url } = {}) {
  const images = await app.evaluate(
    async ({ BrowserWindow, webContents }, input) => {
      const find = eval(input.finder);
      let targets;
      if (input.target === "browser") {
        targets = webContents
          .getAllWebContents()
          .filter(
            (w) =>
              !w.isDestroyed() &&
              /^https?:/.test(w.getURL()) &&
              (!input.url || w.getURL().includes(input.url)),
          )
          .slice(-1);
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
        out.push({
          url: w.getURL().split("?")[0],
          png: image.isEmpty() ? null : image.toPNG().toString("base64"),
        });
      }
      return out;
    },
    { finder: WINDOW_FINDER, target, url },
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
  const { locator, count } = await find(text, opts);
  await locator.click({ timeout: opts.timeout ?? 10000 });
  return count > 1 ? `clicked the first of ${count} matches` : "clicked";
}

async function fill(label, value, opts = {}) {
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
  try {
    if (app) return await shot(`failure-${cmd}`);
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
  const survivors = await stopApp().catch(() => []);
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

try {
  ({ env } = buildEnv());
  sites = await startSites();
  update({
    sitesUrl: sites.url,
    sitesPid: sites.pid,
    sitesStart: startTime(sites.pid),
  });
  await startApp();
  // Prove the guard is live before anyone drives: a POST to a non-loopback host must be refused.
  const guardProbe = await app.evaluate(async ({ session }) => {
    try {
      await session
        .fromPartition("persist:nestor-browser")
        .fetch("https://guard-selftest.invalid/apply", {
          method: "POST",
          body: "x",
        });
      return "sent";
    } catch (error) {
      return String(error.message);
    }
  });
  const blockedLog = path.join(evidenceDir, "blocked-requests.jsonl");
  const guardOk =
    existsSync(blockedLog) &&
    readFileSync(blockedLog, "utf8").includes("guard-selftest.invalid");
  if (!guardOk)
    throw new Error(
      `Send guard self-test failed (${guardProbe}); refusing to drive this instance.`,
    );
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
