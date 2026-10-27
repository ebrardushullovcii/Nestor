// `perf`: measures Nestor's speed on synthetic hunts of a given size, in the
// built app, the way a person uses it. Run `perf --help` for usage.
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkout,
  desktopDir,
  requireDesktop,
  tempRoot,
  workRoot,
} from "./common.mjs";

const HELP = `perf: Nestor speed on a synthetic hunt, in the built app

Usage:
  pnpm perf [--sizes 300,20000] [--launches 5] [--only launch|screens] [--out <dir>]
  pnpm perf --search

Build first (pnpm --filter @nestor/desktop build); perf runs apps/desktop/out
as is. Each size gets its own private data folder, seeded before launch with a
finished setup, that many jobs across every stage (40% hidden, 2% shortlisted,
1% with an approved resume, 1% applied) and job sites: 30 sites for up to
1,000 jobs, 900 above. Nothing leaves the machine: the verify-nestor send guard
refuses every non-loopback request, and the sites are on example.test.

Per size it reports:
  launch    process start to a usable Home (the Home numbers and the shell
            both shown): --launches cold runs (fresh app files, no Chromium
            caches, like the first start after an update), then as many warm.
  screens   one warm session: first visit to every screen (click to a painted heading),
            three rounds of screen switches, Find jobs scrolling, 50 triage
            keys, 20 row clicks, Applications board drags, palette search, and
            reads of the Profile route. For each phase: interaction latency
            (Event Timing, input to next paint) p95 and max, long tasks over
            50 ms, and long animation frames. Memory is the total working set of
            every app process, idle and after all screens.
  search    with --search only: a fresh instance (bin/up --ai live) imports
            the synthetic resume, adds the replica board and searches it
            (journeys/search-memory.mjs). Reports memory across every app
            process before, at its peak and 10 s after, and the browser pages
            still open. It makes real model calls with this checkout's keys.

Targets (D2): launch < 1 s; clicks and switches <= 100 ms p95; no long task over
50 ms; the same work at 300 and 20,000 jobs (within 1.2x); search under 800 MB
with no browser page left open after it.

Options:
  --sizes     job counts to measure, comma-separated (default 300,20000)
  --sites     job sites per size, comma-separated (default by size, see above)
  --launches  cold and warm launches each (default 5)
  --only      launch or screens, to run one part
  --search    measure a replica search instead of the sizes (see above)
  --cpu-profile  record renderer CPU profiles of one more warm launch and of
            each first visit (.cpuprofile files, open in Chrome DevTools) and
            print their busiest functions; profiling slows what it records
  --out       folder for perf-<time>.json (default ~/Projects/nestor-agent-work/perf)
  --keep      keep the seeded data folders (printed) for a later look
  --seed-into <dir>  only seed that (empty) data folder with the first size and
            stop; launch it yourself with NESTOR_USER_DATA_DIR=<dir>
  --help      this text

Machine load skews every number: run it on a quiet machine, alone, and say so
with the results.`;

function parseArgs(argv) {
  const options = {
    sizes: [300, 20000],
    launches: 5,
    only: null,
    out: path.join(workRoot, "perf"),
    keep: false,
    sites: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--sizes") options.sizes = value().split(",").map(Number);
    else if (arg === "--sites") options.sites = value().split(",").map(Number);
    else if (arg === "--launches") options.launches = Number(value());
    else if (arg === "--only") options.only = value();
    else if (arg === "--out") options.out = path.resolve(value());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--search") options.search = true;
    else if (arg === "--cpu-profile") options.cpuProfile = true;
    else if (arg === "--seed-into") options.seedInto = path.resolve(value());
    else throw new Error(`Unknown option ${arg}; see --help`);
  }
  if (options.sizes.some((n) => !Number.isInteger(n) || n < 0))
    throw new Error("--sizes takes whole numbers");
  if (options.only && !["launch", "screens"].includes(options.only))
    throw new Error("--only takes launch or screens");
  return options;
}

async function seed(dataDir, jobs, sites) {
  const { createServer } = requireDesktop("vite");
  const src = (dir) => path.join(checkout, "packages", dir, "src");
  const server = await createServer({
    root: checkout,
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
    resolve: {
      alias: [
        {
          find: "@nestor/contracts",
          replacement: path.join(src("contracts"), "index.ts"),
        },
        {
          find: /^@nestor\/db\/job-store$/,
          replacement: path.join(src("db"), "job-store/job-store.ts"),
        },
        {
          find: /^@nestor\/db\/applications$/,
          replacement: path.join(src("db"), "job-store/applications.ts"),
        },
        {
          find: /^@nestor\/db$/,
          replacement: path.join(src("db"), "index.ts"),
        },
      ],
    },
  });
  try {
    const { seedPerfWorkspace } = await server.ssrLoadModule(
      path.join(import.meta.dirname, "perf-seed.ts"),
    );
    return await seedPerfWorkspace({
      file: path.join(dataDir, "job-finder.sqlite"),
      jobs,
      sites,
    });
  } finally {
    await server.close();
  }
}

function appCopy() {
  const dir = mkdtempSync(path.join(tempRoot, "nestor-perf-app-"));
  cpSync(path.join(desktopDir, "out"), path.join(dir, "out"), {
    recursive: true,
  });
  cpSync(path.join(desktopDir, "package.json"), path.join(dir, "package.json"));
  symlinkSync(
    path.join(desktopDir, "node_modules"),
    path.join(dir, "node_modules"),
    "junction",
  );
  return dir;
}

// The send guard's state and evidence go inside the app copy, removed with it.
function launchEnv(appDir, dataDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key) ||
      key.startsWith("NESTOR_") ||
      [
        "NODE_OPTIONS",
        "ELECTRON_RUN_AS_NODE",
        "ELECTRON_RENDERER_URL",
      ].includes(key)
    )
      delete env[key];
  return {
    ...env,
    NESTOR_USER_DATA_DIR: dataDir,
    NESTOR_BROWSER_HOST: "embedded",
    NESTOR_VERIFY_NET: "replica",
    NESTOR_VERIFY_STATE: mkdtempSync(path.join(appDir, "state-")),
    NESTOR_VERIFY_EVIDENCE: mkdtempSync(path.join(appDir, "evidence-")),
  };
}

async function launch(appDir, dataDir, { profileFile } = {}) {
  const { _electron } = requireDesktop("playwright");
  const app = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: ["-r", path.join(import.meta.dirname, "instance-patch.cjs"), appDir],
    cwd: desktopDir,
    env: {
      ...launchEnv(appDir, dataDir),
      // The main process notes its startup steps in the data folder.
      ...(profileFile ? { ELECTRON_ENABLE_LOGGING: "1" } : {}),
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  // Attached as soon as the window exists, so it holds the startup scripts.
  const cdp = profileFile ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  if (process.platform === "win32")
    await app
      .browserWindow(page)
      .then((w) => w.evaluate((win) => win.setPosition(-6000, 0)))
      .catch(() => {});
  await page.waitForFunction(
    () =>
      performance.getEntriesByName("job-finder:home:numbers-shown").length >
        0 &&
      performance.getEntriesByName("job-finder:shell:mounted").length > 0,
    null,
    { timeout: 60_000 },
  );
  const mainStart = await app.evaluate(
    () => Date.now() - process.uptime() * 1000,
  );
  let top;
  let mainSteps;
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(profileFile, JSON.stringify(profile));
    top = topFunctions(profile, 15);
    const log = path.join(dataDir, "startup-diagnostics.log");
    if (existsSync(log)) {
      mainSteps = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [at, ...words] = line.split(" ");
          return `${words.join(" ").trim()} ${Math.round(Date.parse(at) - mainStart)}`;
        });
      rmSync(log, { force: true });
    }
  }
  const marks = await page.evaluate(() => ({
    origin: performance.timeOrigin,
    home: performance.getEntriesByName("job-finder:home:numbers-shown")[0]
      .startTime,
    shell: performance.getEntriesByName("job-finder:shell:mounted")[0]
      .startTime,
    fetched: Math.max(
      0,
      ...performance
        .getEntriesByType("resource")
        .filter((e) => /\/assets\/index-.*\.(js|css)$/.test(e.name))
        .map((e) => e.responseEnd),
    ),
    scripts:
      performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,
  }));
  // mainMs: process start until the window's page began loading;
  // rendererMs: from there until Home is usable.
  const rendererMs = Math.round(Math.max(marks.home, marks.shell));
  const mainMs = Math.round(marks.origin - mainStart);
  return {
    app,
    page,
    launchMs: mainMs + rendererMs,
    mainMs,
    rendererMs,
    // Renderer steps: startup files fetched, then run, shell, Home numbers.
    steps: [marks.fetched, marks.scripts, marks.shell, marks.home].map(
      Math.round,
    ),
    top,
    mainSteps,
  };
}

const memory = (app) =>
  app.evaluate(({ app: a }) => {
    const metrics = a.getAppMetrics();
    return {
      totalMB: Math.round(
        metrics.reduce((n, p) => n + p.memory.workingSetSize, 0) / 1024,
      ),
      // Windows only: memory no other process can share, what Task Manager
      // shows. The working set also counts the mapped database file.
      privateMB: Math.round(
        metrics.reduce((n, p) => n + (p.memory.privateBytes ?? 0), 0) / 1024,
      ),
      byProcess: Object.fromEntries(
        metrics.map((p, i) => [
          `${p.type}${p.name ? `:${p.name}` : ""}#${i}`,
          Math.round(p.memory.workingSetSize / 1024),
        ]),
      ),
    };
  });

async function measureLaunches(dataDir, runs, { cpuProfileDir } = {}) {
  const cold = [];
  const warm = [];
  const coldSplit = [];
  const warmSplit = [];
  for (let i = 0; i < runs; i += 1) {
    const appDir = appCopy();
    for (const dir of [
      "Code Cache",
      "GPUCache",
      "DawnGraphiteCache",
      "DawnWebGPUCache",
    ])
      rmSync(path.join(dataDir, dir), { recursive: true, force: true });
    const run = await launch(appDir, dataDir);
    cold.push(run.launchMs);
    coldSplit.push([run.mainMs, ...run.steps]);
    await run.app.close().catch(() => {});
    rmSync(appDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const appDir = appCopy();
  for (let i = 0; i < runs; i += 1) {
    const run = await launch(appDir, dataDir);
    warm.push(run.launchMs);
    warmSplit.push([run.mainMs, ...run.steps]);
    await run.app.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  let profiled;
  if (cpuProfileDir) {
    const run = await launch(appDir, dataDir, {
      profileFile: path.join(cpuProfileDir, "warm-launch.cpuprofile"),
    });
    profiled = {
      launchMs: run.launchMs,
      top: run.top,
      mainSteps: run.mainSteps,
      steps: [run.mainMs, ...run.steps],
    };
    await run.app.close().catch(() => {});
  }
  rmSync(appDir, { recursive: true, force: true });
  return { cold, warm, coldSplit, warmSplit, profiled };
}

// The busiest functions in a renderer CPU profile, by self time.
function topFunctions(profile, count = 12) {
  const self = new Map();
  const interval =
    (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
  const hits = new Map();
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1);
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    if (["(idle)", "(program)", "(root)"].includes(functionName)) continue;
    const key = `${functionName || "(anonymous)"} ${url.split("/").pop()}:${lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (hits.get(node.id) ?? 0) * interval);
  }
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, us]) => `${Math.round(us / 1000)} ms ${key}`);
}

async function measureScreens(dataDir, { cpuProfileDir } = {}) {
  const appDir = appCopy();
  const { app, page } = await launch(appDir, dataDir);
  try {
    await page.evaluate(() => {
      const perf = (window.__perf = {
        long: [],
        loaf: [],
        events: [],
        phases: [],
      });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          perf.long.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: "longtask", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          perf.loaf.push({
            start: e.startTime,
            dur: e.duration,
            scripts: (e.scripts ?? [])
              .slice(0, 3)
              .map(
                (s) =>
                  `${(s.sourceURL ?? "").split("/").pop()}:${s.sourceFunctionName ?? ""} ${Math.round(s.duration)}`,
              ),
          });
      }).observe({ type: "long-animation-frame", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          if (e.interactionId)
            perf.events.push({
              start: e.startTime,
              dur: e.duration,
              name: e.name,
            });
      }).observe({ type: "event", buffered: true, durationThreshold: 16 });
      window.__phase = (name) =>
        perf.phases.push({ name, at: performance.now() });
    });
    const phase = (name) => page.evaluate((n) => window.__phase(n), name);
    const heading = (name) =>
      page
        .getByRole("heading", { level: 1, name })
        .first()
        .waitFor({ timeout: 30_000 });
    const nav = (name) =>
      page.getByRole("button", { name, exact: true }).first().click();
    // A real click to the first frame painted with the screen usable: its
    // heading shown and nothing in the page still loading. Timed inside the
    // page, from the press: Playwright's own role queries cost tens of ms on
    // a big screen.
    await page.evaluate(() => {
      window.__visit = (name) =>
        new Promise((resolve) => {
          // Screens stay mounted once visited, so only what is visible
          // counts. A list's "Loading more…" footer is not a loading screen.
          const visible = (el) => el?.checkVisibility() ?? false;
          const loadingText = () => {
            const walker = document.createTreeWalker(
              document.querySelector("main") ?? document.body,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode())
              if (
                /Loading\b(?! more)/.test(node.data) &&
                visible(node.parentElement)
              )
                return node.data;
            return null;
          };
          const usable = () =>
            [...document.querySelectorAll("h1")].some(
              (h) => h.textContent.includes(name) && visible(h),
            ) &&
            ![...document.querySelectorAll("[aria-busy='true']")].some(
              visible,
            ) &&
            !loadingText();
          addEventListener(
            "pointerdown",
            (event) => {
              const check = () => {
                if (performance.now() - event.timeStamp > 15_000)
                  return resolve(
                    `stuck: visible h1 ${[...document.querySelectorAll("h1")]
                      .filter(visible)
                      .map((h) => h.textContent)
                      .join(
                        " / ",
                      )}; busy ${[...document.querySelectorAll("[aria-busy='true']")].filter(visible).length}; ${loadingText() ?? ""}`,
                  );
                if (!usable()) return requestAnimationFrame(check);
                requestAnimationFrame(() =>
                  setTimeout(() =>
                    resolve(Math.round(performance.now() - event.timeStamp)),
                  ),
                );
              };
              requestAnimationFrame(check);
            },
            { once: true, capture: true },
          );
        });
    });
    const navButton = (name) =>
      page.getByRole("button", { name, exact: true }).first().elementHandle();
    const visit = async (name, button) => {
      button ??= await navButton(name);
      const box = await button.boundingBox();
      await page.evaluate((n) => {
        window.__visitDone = window.__visit(n);
      }, name);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return Promise.race([
        page.evaluate(() => window.__visitDone),
        new Promise((resolve) =>
          setTimeout(() => resolve("stuck: the press never arrived"), 20_000),
        ),
      ]);
    };
    await page.waitForTimeout(8000);
    const idle = await memory(app);

    const firstVisits = [];
    const cdp = cpuProfileDir ? await page.context().newCDPSession(page) : null;
    await phase("firstVisits");
    for (const name of [
      "Find jobs",
      "Shortlisted",
      "Applications",
      "Profile",
      "Settings",
      "Home",
    ]) {
      const button = await navButton(name);
      if (cdp) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
      }
      const shown = { name, ms: await visit(name, button) };
      if (cdp) {
        await page.waitForTimeout(300);
        const { profile } = await cdp.send("Profiler.stop");
        writeFileSync(
          path.join(
            cpuProfileDir,
            `first-visit-${name.replace(/ /g, "-")}.cpuprofile`,
          ),
          JSON.stringify(profile),
        );
        shown.top = topFunctions(profile);
      }
      await heading(name);
      // Elements on the page: what a screen renders, whatever is on screen.
      shown.elements = await page.evaluate(
        () => document.getElementsByTagName("*").length,
      );
      firstVisits.push(shown);
      await page.waitForTimeout(600);
    }

    await phase("scroll");
    await nav("Find jobs");
    await heading("Find jobs");
    const list = page
      .getByRole("list")
      .filter({ has: page.locator("li") })
      .first();
    await list.locator("li").first().waitFor({ timeout: 30_000 });
    await list.hover();
    for (let i = 0; i < 60; i += 1) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);

    await phase("triage");
    await page.mouse.wheel(0, -100000);
    await list.locator("li").first().click();
    await page.waitForTimeout(400);
    for (let i = 0; i < 50; i += 1) {
      await page.keyboard.press(i % 2 ? "s" : "h");
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(600);

    await phase("rowClicks");
    for (let i = 0; i < 20; i += 1) {
      await list
        .locator("li")
        .nth(i % 10)
        .click();
      await page.waitForTimeout(300);
    }

    await phase("switches");
    const switches = [];
    for (let round = 0; round < 3; round += 1)
      for (const name of [
        "Home",
        "Find jobs",
        "Shortlisted",
        "Applications",
        "Profile",
        "Settings",
      ]) {
        switches.push({ name, ms: await visit(name) });
        await page.waitForTimeout(400);
      }

    await phase("drag");
    await nav("Applications");
    await heading("Applications");
    await page
      .getByText("Board", { exact: true })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(1000);
    const columns = page.locator("[aria-label='Applications by stage'] > *");
    const columnCount = await columns.count();
    let drags = 0;
    for (let i = 0; i < 10 && columnCount > 1; i += 1) {
      const card = page.locator("[draggable='true']").nth(i);
      if (!(await card.count())) break;
      await card
        .dragTo(columns.nth((i % (columnCount - 1)) + 1))
        .catch(() => {});
      drags += 1;
      await page.waitForTimeout(400);
    }

    await phase("palette");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    await page.keyboard.type("Engineer");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Escape");

    await phase("profileReads");
    const profileReads = await page.evaluate(async () => {
      const times = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        await window.nestor.profileWorkflow.run({ type: "read" });
        times.push(Math.round(performance.now() - started));
      }
      return times;
    });
    await phase("end");
    const afterScreens = await memory(app);
    const perf = await page.evaluate(() => window.__perf);
    return {
      idle,
      afterScreens,
      firstVisits,
      switches,
      drags,
      profileReads,
      phases: summarize(perf),
    };
  } finally {
    await app.close().catch(() => {});
    rmSync(appDir, { recursive: true, force: true });
  }
}

const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  );
};
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
};

function summarize(perf) {
  const phases = perf.phases;
  const out = {};
  for (let i = 0; i < phases.length - 1; i += 1) {
    const { name, at } = phases[i];
    const end = phases[i + 1].at;
    const within = (e) => e.start >= at && e.start < end;
    const events = perf.events.filter(within).map((e) => e.dur);
    const long = perf.long.filter(within).map((e) => e.dur);
    const loaf = perf.loaf.filter(within).filter((e) => e.dur > 50);
    out[name] = {
      interactions: events.length,
      p95Ms: p95(events),
      maxMs: events.length ? Math.round(Math.max(...events)) : null,
      longTasks: long.length,
      longestTaskMs: long.length ? Math.round(Math.max(...long)) : null,
      longFrames: loaf.length,
      worstFrames: loaf
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 3)
        .map((e) => `${Math.round(e.dur)} ms ${e.scripts.join(" | ")}`),
    };
  }
  return out;
}

const timed = (visits) =>
  visits.map((v) => v.ms).filter((ms) => typeof ms === "number");

function print(size, result) {
  const lines = [
    `\n${size.jobs} jobs / ${size.sites} sites (seeded in ${result.seed.seedMs} ms)`,
  ];
  if (result.launch)
    lines.push(
      `  launch cold ms: ${result.launch.cold.join(", ")} (median ${median(result.launch.cold)}; main | fetched, scripts run, shell, Home ${result.launch.coldSplit.map(([m, ...r]) => `${m} | ${r.join(", ")}`).join("; ")})`,
      `  launch warm ms: ${result.launch.warm.join(", ")} (median ${median(result.launch.warm)}; main | fetched, scripts run, shell, Home ${result.launch.warmSplit.map(([m, ...r]) => `${m} | ${r.join(", ")}`).join("; ")})`,
    );
  if (result.launch?.profiled)
    lines.push(
      `  profiled warm launch ${result.launch.profiled.launchMs} ms (main | fetched, scripts run, shell, Home ${result.launch.profiled.steps[0]} | ${result.launch.profiled.steps.slice(1).join(", ")}); main steps ms: ${result.launch.profiled.mainSteps?.join(", ") ?? "none logged"}`,
      `    busiest: ${result.launch.profiled.top.join("; ")}`,
    );
  if (result.screens) {
    const s = result.screens;
    lines.push(
      `  first visits ms: ${s.firstVisits.map((v) => `${v.name} ${v.ms} (${v.elements} elements)`).join(", ")}`,
      ...s.firstVisits
        .filter((v) => v.top)
        .map((v) => `    ${v.name} busiest: ${v.top.slice(0, 6).join("; ")}`),
      `  switches ms: p95 ${p95(timed(s.switches))}, max ${Math.max(...timed(s.switches))} (${s.switches.map((v) => `${v.name} ${v.ms}`).join(", ")})`,
      ...[...s.firstVisits, ...s.switches]
        .filter((v) => typeof v.ms !== "number")
        .map((v) => `  ${v.name} ${v.ms}`),
      `  Profile reads ms: ${s.profileReads.join(", ")}`,
      `  memory MB (working set; private): idle ${s.idle.totalMB}; ${s.idle.privateMB}, after screens ${s.afterScreens.totalMB}; ${s.afterScreens.privateMB}`,
    );
    for (const [name, p] of Object.entries(s.phases))
      lines.push(
        `  ${name}: ${p.interactions} interactions, p95 ${p.p95Ms ?? "-"} ms, max ${p.maxMs ?? "-"} ms, long tasks ${p.longTasks}${p.longestTaskMs ? ` (longest ${p.longestTaskMs} ms)` : ""}, long frames ${p.longFrames}`,
      );
  }
  console.log(lines.join("\n"));
}

function measureSearch() {
  const cli = path.join(import.meta.dirname, "cli.mjs");
  const env = {
    ...process.env,
    NESTOR_VERIFY_LABEL: `perf-search-${process.pid}`,
  };
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  run("up", "--ai", "live");
  try {
    return JSON.parse(
      run(
        "drive",
        "run",
        path.join(import.meta.dirname, "../../journeys/search-memory.mjs"),
      ),
    );
  } finally {
    run("down");
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(HELP);
  process.exit(0);
}
if (options.search) {
  mkdirSync(options.out, { recursive: true });
  const result = measureSearch();
  const types = Object.entries(result.peak?.byTypeMB ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  console.log(
    [
      `search: ${Object.entries(result.stageMs)
        .map(([k, v]) => `${k} ${v} ms`)
        .join(", ")}`,
      `  memory MB (working set): before ${result.beforeMB}, peak ${result.peak?.totalMB} (${types}; private ${result.peak?.privateMB}), 10 s after ${result.afterMB}`,
      `  browser pages left open: ${result.pagesLeftOpen.length ? result.pagesLeftOpen.map((p) => `${p.type} ${p.url}`).join(", ") : "none"}`,
    ].join("\n"),
  );
  const file = path.join(
    options.out,
    `perf-search-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify({ at: new Date().toISOString(), search: result }, null, 2),
  );
  console.log(`\nfull results: ${file}`);
  process.exit(0);
}
if (options.seedInto) {
  mkdirSync(options.seedInto, { recursive: true });
  const jobs = options.sizes[0];
  console.log(
    await seed(
      options.seedInto,
      jobs,
      options.sites?.[0] ?? (jobs > 1000 ? 900 : 30),
    ),
  );
  process.exit(0);
}
if (!existsSync(path.join(desktopDir, "out", "main"))) {
  console.error(
    "No built app in apps/desktop/out. Run pnpm --filter @nestor/desktop build first.",
  );
  process.exit(1);
}
mkdirSync(options.out, { recursive: true });
const report = {
  at: new Date().toISOString(),
  cpus: os.cpus().length,
  loadAverage: os.loadavg(),
  sizes: [],
};
for (const [index, jobs] of options.sizes.entries()) {
  const sites = options.sites?.[index] ?? (jobs > 1000 ? 900 : 30);
  const dataDir = mkdtempSync(path.join(tempRoot, `nestor-perf-${jobs}-`));
  try {
    const result = { seed: await seed(dataDir, jobs, sites) };
    const cpuProfileDir = options.cpuProfile
      ? mkdtempSync(path.join(options.out, `cpu-${jobs}-`))
      : undefined;
    if (options.only !== "screens")
      result.launch = await measureLaunches(dataDir, options.launches, {
        cpuProfileDir,
      });
    if (options.only !== "launch")
      result.screens = await measureScreens(dataDir, { cpuProfileDir });
    if (cpuProfileDir) console.log(`  CPU profiles: ${cpuProfileDir}`);
    report.sizes.push({ jobs, sites, ...result });
    print({ jobs, sites }, result);
  } finally {
    if (options.keep) console.log(`  data kept: ${dataDir}`);
    else rmSync(dataDir, { recursive: true, force: true });
  }
}
const file = path.join(
  options.out,
  `perf-${report.at.replace(/[:.]/g, "-")}.json`,
);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nfull results: ${file}`);
