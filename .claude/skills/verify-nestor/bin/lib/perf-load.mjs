// `perf --load`: memory, CPU and browser pages while Job Finder searches
// hundreds of replica sites or runs an Apply batch, with a scripted model, and
// how smooth the open screen stays meanwhile. Also the sampler `perf --observe`
// attaches to a running verify-nestor instance.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { desktopDir, requireDesktop, tempRoot } from "./common.mjs";
import { startPerfModel } from "./perf-model.mjs";
import {
  countIpc,
  countPages,
  heapUsage,
  mainHeapSnapshot,
  processTreeMemory,
  readIpc,
  rendererHeapSnapshot,
  snapshotSummary,
  p95,
  readMainStalls,
  readPageOpenings,
  sampleApp,
  startMainProfile,
  stopMainProfile,
  summarizeSamples,
  topFunctions,
  watchMainStalls,
  workState,
} from "./perf-sample.mjs";

const SAMPLE_MS = 1000;
const RUN_LIMIT_MS = 20 * 60_000;
const RELEASE_LIMIT_MS = 60_000;
// The four-at-once Apply cap is per site, and a site is a hostname, so the
// batch is spread across the replica's alias hosts 127.0.0.2-12.
const APPLY_SITES = ["greenhouse", "greenhouse", "greenhouse", "workday"];

export async function startReplicaSites(logDir) {
  const child = spawn(
    process.execPath,
    [path.join(desktopDir, "test-fixtures/job-sites/serve.mjs")],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: path.join(logDir, "submissions.jsonl"),
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Replica sites did not start: ${output}`)),
      15_000,
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
  // Asking for the manifest also starts the alias hosts 127.0.0.2-12.
  const manifest = await (
    await fetch(new URL("__scale__/manifest", url))
  ).json();
  return {
    url,
    manifest,
    metrics: async () =>
      (await fetch(new URL("__scale__/metrics", url))).json(),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill();
      }),
  };
}

/**
 * An even spread of the 900 replica sites, `count` of them: every kind, and
 * (by stepping a little within each stride) all twelve hostnames.
 */
export function pickSites(manifest, count) {
  const step = manifest.sources.length / count;
  return Array.from(
    { length: count },
    (_, i) =>
      manifest.sources[Math.floor(i * step) + (i % Math.floor(step))].url,
  );
}

export function applyUrls(sitesUrl, count) {
  const port = new URL(sitesUrl).port;
  return Array.from({ length: count }, (_, i) => {
    const site = APPLY_SITES[i % APPLY_SITES.length];
    return `http://127.0.0.${2 + (i % 11)}:${port}/${site}/apply/${1 + (i % 10)}`;
  });
}

/**
 * Samples every second while `kinds` run, moving around the app like a
 * person meanwhile, then until memory is back near idle.
 */
async function runWork({ app, page, kinds, start, profileDir, memoryDir }) {
  await page.evaluate(() => {
    const perf = (window.__load = { long: [], events: [] });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        perf.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: "longtask" });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.interactionId)
          perf.events.push({
            start: e.startTime,
            dur: e.duration,
            name: e.name,
            // Input delay, handlers, then the wait for the next frame.
            delay: e.processingStart - e.startTime,
            handlers: e.processingEnd - e.processingStart,
          });
    }).observe({ type: "event", durationThreshold: 16 });
  });
  await countPages(app);
  await watchMainStalls(app);
  if (memoryDir || profileDir) await countIpc(app);
  // Where memory goes: heap use and, with --memory-detail, heap snapshots
  // of main and the app's window before, at the end of the work and after.
  const memoryPoints = {};
  const memoryPoint = async (name) => {
    memoryPoints[name] = await heapUsage(app, page);
    if (!memoryDir) return;
    const mainFile = path.join(memoryDir, `main-${name}.heapsnapshot`);
    const rendererFile = path.join(memoryDir, `renderer-${name}.heapsnapshot`);
    await mainHeapSnapshot(app, mainFile);
    await rendererHeapSnapshot(page, rendererFile);
    memoryPoints[name].mainHeap = await snapshotSummary(mainFile);
    memoryPoints[name].rendererHeap = await snapshotSummary(rendererFile);
  };
  await page.waitForTimeout(8000);
  const idle = await sampleApp(app);
  await memoryPoint("before");
  const pid = app.process().pid;
  const idleTree = await processTreeMemory(pid);
  const samples = [];
  const treeSamples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      samples.push(await sampleApp(app));
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    }
  })();
  // Task Manager's figure takes Windows a few seconds to read; sampled apart.
  const treeSampler = (async () => {
    while (sampling) treeSamples.push(await processTreeMemory(pid));
  })();
  const cdp = profileDir ? await page.context().newCDPSession(page) : null;
  // A Chromium trace of every process (GPU, compositor, raster) when asked:
  // what a JS profile cannot see.
  if (process.env.NESTOR_PERF_TRACE && profileDir)
    await app.evaluate(({ contentTracing }) =>
      contentTracing.startRecording({
        included_categories: [
          "toplevel",
          "cc",
          "gpu",
          "viz",
          "blink",
          "benchmark",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
        ],
      }),
    );
  let rendererProfiledAt = 0;
  if (profileDir) {
    await startMainProfile(app);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
    await cdp.send("Profiler.start");
    rendererProfiledAt = await page.evaluate(() => performance.now());
  }
  const stallsBefore = (await readMainStalls(app)).length;
  const startedAt = Date.now();
  const startedPerf = await page.evaluate(() => performance.now());
  const started = await start(page);
  // A person on Find jobs: scrolling, opening jobs, switching screens.
  // Which screen each click opened, in the window's clock, so a slow
  // interaction can be named.
  const navLog = [];
  const nav = async (name) => {
    navLog.push({ name, at: await page.evaluate(() => performance.now()) });
    await page
      .getByRole("button", { name, exact: true })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  };
  // Never the same screen twice in a row: a click that changes nothing has
  // no frame of its own, and Event Timing then waits for an unrelated one
  // (that read as a one-second stall).
  const screens = ["Find jobs", "Home", "Applications"];
  let doneAt = null;
  let state = {};
  for (let tick = 0; Date.now() - startedAt < RUN_LIMIT_MS; tick += 1) {
    if (tick % 6 === 0) await nav(screens[(tick / 6) % screens.length]);
    else await page.mouse.wheel(0, tick % 2 ? 400 : -400);
    await page.waitForTimeout(500);
    if (tick % 4 !== 3) continue;
    const states = await Promise.all(kinds.map((k) => workState(page, k)));
    state = Object.fromEntries(kinds.map((k, i) => [k, states[i].detail]));
    if (states.every((s) => !s.running)) {
      doneAt = Date.now();
      break;
    }
  }
  const endedPerf = await page.evaluate(() => performance.now());
  await memoryPoint("end");
  const ipc = memoryDir || profileDir ? await readIpc(app) : null;
  const stalls = (await readMainStalls(app)).slice(stallsBefore);
  const traceFile =
    process.env.NESTOR_PERF_TRACE && profileDir
      ? await app.evaluate(
          ({ contentTracing }, file) => contentTracing.stopRecording(file),
          path.join(profileDir, "trace.json"),
        )
      : null;
  let mainProfile = null;
  if (profileDir) {
    const { profile, startedAt: profiledAt } = await stopMainProfile(app);
    writeFileSync(path.join(profileDir, "main.cpuprofile"), profile);
    const parsed = JSON.parse(profile);
    // Main's performance.now() (ms) to profile time (µs).
    const toProfile = (ms) => parsed.startTime + (ms - profiledAt) * 1000;
    mainProfile = {
      file: path.join(profileDir, "main.cpuprofile"),
      busiest: topFunctions(parsed, 15),
      inStalls: topFunctions(
        parsed,
        15,
        stalls.map((x) => [toProfile(x.at), toProfile(x.at + x.ms)]),
      ),
    };
  }
  // Released: memory back near idle with no page left, or a minute passed.
  while (Date.now() - (doneAt ?? Date.now()) < RELEASE_LIMIT_MS) {
    await page.waitForTimeout(SAMPLE_MS);
    const last = samples.at(-1);
    if (
      last &&
      last.at > (doneAt ?? 0) &&
      last.pages === 0 &&
      last.workingSetMB <= idle.workingSetMB * 1.1 + 30
    )
      break;
  }
  sampling = false;
  await sampler;
  await treeSampler;
  await memoryPoint("after");
  const peakTree = treeSamples.reduce(
    (top, t) =>
      t.privateWorkingSetMB > (top?.privateWorkingSetMB ?? -1) ? t : top,
    null,
  );
  const taskManager = {
    idleMB: idleTree.privateWorkingSetMB,
    idleByType: idleTree.byTypeMB,
    peakByType: peakTree?.byTypeMB ?? null,
    afterByType: treeSamples.at(-1)?.byTypeMB ?? null,
    peakMB: Math.max(...treeSamples.map((t) => t.privateWorkingSetMB)),
    afterMB: treeSamples.at(-1)?.privateWorkingSetMB ?? null,
    samples: treeSamples.length,
  };
  const screen = await page.evaluate(
    ({ from, to }) => {
      const within = (e) => e.start >= from && e.start <= to;
      const events = window.__load.events.filter(within);
      const slow = [...events].sort((a, b) => b.dur - a.dur).slice(0, 3);
      return {
        events: events.map((e) => e.dur),
        slowestWindows: slow.map((e) => [e.start, e.start + e.dur]),
        slowest: events
          .sort((a, b) => b.dur - a.dur)
          .slice(0, 5)
          .map((e) => ({
            atSeconds: Math.round((e.start - from) / 100) / 10,
            at: e.start,
            name: e.name,
            ms: Math.round(e.dur),
            delayMs: Math.round(e.delay),
            handlersMs: Math.round(e.handlers),
            frameMs: Math.round(e.dur - e.delay - e.handlers),
          })),
        long: window.__load.long.filter(within).map((e) => e.dur),
      };
    },
    { from: startedPerf, to: endedPerf },
  );
  for (const slow of screen.slowest)
    slow.screen =
      navLog.filter((n) => n.at <= slow.at + 50).at(-1)?.name ?? null;
  // Browser pages that opened while each slow interaction waited for its
  // frame: main's and the window's clocks lined up through "now".
  const openings = await readPageOpenings(app);
  const windowNow = await page.evaluate(() => performance.now());
  const toWindow = (mainMs) => mainMs - openings.now + windowNow;
  for (const slow of screen.slowest)
    slow.pagesOpened = openings.openedAt
      .map(toWindow)
      .filter((at) => at >= slow.at - 100 && at <= slow.at + slow.ms).length;
  let rendererProfile = null;
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    const file = path.join(profileDir, "renderer.cpuprofile");
    writeFileSync(file, JSON.stringify(profile));
    // Renderer performance.now() (ms) to profile time (µs).
    const toProfile = (ms) =>
      profile.startTime + (ms - rendererProfiledAt) * 1000;
    rendererProfile = {
      file,
      busiest: topFunctions(profile, 15),
      inSlowest: topFunctions(
        profile,
        15,
        screen.slowestWindows.map(([from, to]) => [
          toProfile(from),
          toProfile(to),
        ]),
      ),
    };
  }
  return {
    started,
    traceFile,
    windowClockAtStart: startedPerf,
    taskManager,
    memoryPoints,
    ipc,
    rendererProfile,
    finished: doneAt !== null,
    runSeconds: Math.round(((doneAt ?? Date.now()) - startedAt) / 1000),
    state,
    idleMB: idle.workingSetMB,
    idlePrivateMB: idle.privateMB,
    ...summarizeSamples(samples, { idle, doneAt }),
    interactions: screen.events.length,
    interactionP95Ms: p95(screen.events),
    interactionMaxMs: screen.events.length
      ? Math.round(Math.max(...screen.events))
      : null,
    slowestInteractions: screen.slowest,
    mainStalls: stalls.length,
    longestMainStallMs: Math.max(0, ...stalls.map((x) => x.ms)),
    mainStallSeconds:
      Math.round(stalls.reduce((n, x) => n + x.ms, 0) / 100) / 10,
    mainProfile,
    longTasks: screen.long.length,
    longestTaskMs: screen.long.length
      ? Math.round(Math.max(...screen.long))
      : null,
    timeline: samples.map((s) => ({
      t: Math.round((s.at - startedAt) / 1000),
      mb: s.workingSetMB,
      cpu: s.cpuPercent,
      pages: s.pages,
    })),
  };
}

// A synthetic persona's resume from the fixtures, for Apply to attach.
function syntheticResume(dataDir) {
  const file = path.join(dataDir, "riley-okafor-resume.pdf");
  copyFileSync(
    path.join(
      desktopDir,
      "test-fixtures/job-finder/resume-import-personas/priya-raman.pdf",
    ),
    file,
  );
  return file;
}

/** Main-process memory before and after loading Playwright, as on first use. */
async function measurePlaywrightLoad(app, appDir) {
  const read = () =>
    app.evaluate(() => {
      const { rss, heapUsed } = process.memoryUsage();
      return { rss, heapUsed };
    });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const before = await read();
  const ms = await app.evaluate((_electron, dir) => {
    const { createRequire } = process.getBuiltinModule("node:module");
    const started = performance.now();
    createRequire(`${dir}/package.json`)("playwright");
    return Math.round(performance.now() - started);
  }, appDir);
  const after = await read();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const later = await read();
  const mb = (bytes) => Math.round(bytes / 2 ** 20);
  return {
    ms,
    rssMB: mb(after.rss - before.rss),
    heapMB: mb(after.heapUsed - before.heapUsed),
    rssLaterMB: mb(later.rss - before.rss),
  };
}

/**
 * Opens the oldest Ready application, whose page the waiting-form cap
 * closed: how long until Open answers and the refill settles, and how many
 * model calls the refill made.
 */
async function measureRefill(app, page, model) {
  // The oldest waiting page, Ready or stopped at Needs you: the cap closed it.
  const ready = await page.evaluate(async () => {
    for (const state of ["ready", "needs_you"]) {
      const list = await window.nestor.jobFinder.listApplications({
        state,
        limit: 200,
      });
      const oldest = [...list.rows].sort((a, b) =>
        a.updatedAt.localeCompare(b.updatedAt),
      )[0];
      if (oldest) return { id: oldest.id, state };
    }
    return null;
  });
  if (!ready)
    return { opened: false, reason: "no Ready or Needs-you application" };
  const calls = () => Object.values(model.counts).reduce((n, c) => n + c, 0);
  const pagesBefore = (await sampleApp(app)).pages;
  const callsBefore = calls();
  const started = Date.now();
  const opened = await page.evaluate(
    (id) => window.nestor.jobFinder.openApplication({ id }),
    ready.id,
  );
  const openMs = Date.now() - started;
  // Settled: no model call for three seconds, or a minute passed.
  let last = calls();
  let quietSince = Date.now();
  while (Date.now() - quietSince < 3000 && Date.now() - started < 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (calls() !== last) {
      last = calls();
      quietSince = Date.now();
    }
  }
  return {
    state: ready.state,
    opened,
    openMs,
    settledMs: quietSince - started,
    modelCalls: calls() - callsBefore,
    pagesBefore,
    pagesAfter: (await sampleApp(app)).pages,
  };
}

const startSearch = (page) =>
  page.evaluate(() =>
    window.nestor.jobs
      .run("start_search", {
        depth: "quick",
        postedWithin: "any",
        sites: { all: true, except: [] },
      })
      .then((status) => status.search?.sourcesTotal ?? null),
  );
const startApply = (ids) => (page) =>
  page.evaluate(
    (jobIds) =>
      window.nestor.jobFinder.applyJobs({ selection: { ids: jobIds } }),
    ids,
  );

/**
 * One load run: seed `jobs` and `sites` replica sites (and the Apply jobs),
 * launch the built app on the scripted model, run `kinds` and measure.
 */
export async function measureLoad({
  jobs,
  sites,
  kinds,
  applyCount = 20,
  shortlistResumes,
  profileDir,
  memoryDir,
  seed,
  appCopy,
  launch,
}) {
  const dataDir = mkdtempSync(path.join(tempRoot, `nestor-perf-load-${jobs}-`));
  const appDir = appCopy();
  const replica = await startReplicaSites(appDir);
  const model = await startPerfModel();
  let run;
  try {
    const seeded = await seed(dataDir, jobs, sites, {
      siteUrls: pickSites(replica.manifest, sites),
      shortlistResumes,
      resumeFile: kinds.includes("apply")
        ? syntheticResume(dataDir)
        : undefined,
      applyUrls: kinds.includes("apply")
        ? applyUrls(replica.url, applyCount)
        : [],
    });
    run = await launch(appDir, dataDir, { extraEnv: model.env });
    const starters = {
      search: startSearch,
      apply: startApply(seeded.applyIds),
    };
    // What loading Playwright early would cost an idle app.
    const playwright = kinds.includes("apply")
      ? await measurePlaywrightLoad(run.app, appDir)
      : null;
    const result = await runWork({
      app: run.app,
      page: run.page,
      kinds,
      profileDir,
      memoryDir,
      start: async (page) =>
        Object.fromEntries(
          await Promise.all(
            kinds.map(async (k) => [k, await starters[k](page)]),
          ),
        ),
    });
    const refill = kinds.includes("apply")
      ? await measureRefill(run.app, run.page, model)
      : null;
    return {
      jobs,
      sites,
      kinds,
      ...result,
      playwright,
      refill,
      modelCalls: { ...model.counts },
      unrecognizedModelCalls: model.unknown,
      replica: await replica.metrics(),
    };
  } finally {
    await run?.app.close().catch(() => {});
    await model.close();
    await replica.stop();
    rmSync(appDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export function printLoad(result) {
  return [
    `\n${result.kinds.join(" + ")}: ${result.jobs} jobs, ${result.sites} sites, ${result.runSeconds} s${result.finished ? "" : " (did not finish)"}; ${Object.entries(
      result.state,
    )
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ")}`,
    `  Task Manager memory MB (private working set, all processes): idle ${result.taskManager.idleMB}, peak ${result.taskManager.peakMB}, after ${result.taskManager.afterMB} (${result.taskManager.samples} readings)`,
    `    by process kind, idle → peak → after: ${Object.keys(
      result.taskManager.peakByType ?? {},
    )
      .map(
        (k) =>
          `${k} ${result.taskManager.idleByType?.[k] ?? 0} → ${result.taskManager.peakByType[k]} → ${result.taskManager.afterByType?.[k] ?? 0}`,
      )
      .join(", ")}`,
    `  working set MB (all processes): idle ${result.idleMB}, peak ${result.peakMB} (private ${result.peakPrivateMB}), typical ${result.typicalMB}, after ${result.memoryAfterMB}; back near idle in ${result.backNearIdleSeconds ?? "-"} s`,
    `  peak by process type: ${Object.entries(result.peakByType ?? {})
      .map(([k, v]) => `${k} ${v.count}x ${v.mb} MB`)
      .join(", ")}`,
    ...Object.entries(result.memoryPoints ?? {}).map(
      ([name, m]) =>
        `  ${name}: main ${m.mainRssMB} MB (JS heap ${m.mainHeapMB}, external ${m.mainExternalMB}), window JS heap ${m.rendererHeapMB} MB, ${m.rendererElements} elements${m.mainHeap?.top ? `; main heap: ${m.mainHeap.top.slice(0, 6).join(", ")}; window heap: ${m.rendererHeap.top.slice(0, 6).join(", ")}` : ""}`,
    ),
    ...(result.ipc
      ? [
          `  IPC by bytes: ${result.ipc
            .slice(0, 8)
            .map(
              ([c, v]) =>
                `${c} ${v.calls}x ${Math.round(v.bytes / 1024)} KB (largest ${Math.round(v.largest / 1024)} KB, slowest ${v.slowestMs} ms)`,
            )
            .join("; ")}`,
        ]
      : []),
    `  CPU % of one core: median ${result.cpuMedianPercent}, p95 ${result.cpuP95Percent}`,
    `  browser pages: at most ${result.pagesMax} at once, ${result.pagesOpened} opened in all, ${result.pagesAfter} left after${result.pagesAfterUrls.length ? ` (${[...new Set(result.pagesAfterUrls)].slice(0, 4).join(", ")})` : ""}`,
    `  open screen: ${result.interactions} interactions, p95 ${result.interactionP95Ms ?? "-"} ms, max ${result.interactionMaxMs ?? "-"} ms, long tasks ${result.longTasks}${result.longestTaskMs ? ` (longest ${result.longestTaskMs} ms)` : ""}`,
    `  slowest: ${result.slowestInteractions.map((e) => `${e.name}${e.screen ? ` (after opening ${e.screen})` : ""} at ${e.atSeconds} s ${e.ms} ms, ${e.pagesOpened ?? 0} browser pages opened meanwhile (input delay ${e.delayMs}, handlers ${e.handlersMs}, to frame ${e.frameMs})`).join("; ") || "-"}`,
    `  main process: ${result.mainStalls} stalls over 100 ms, longest ${result.longestMainStallMs} ms, ${result.mainStallSeconds} s in all`,
    ...(result.mainProfile
      ? [
          `  main busiest: ${result.mainProfile.busiest.slice(0, 8).join("; ")}`,
          `  main in stalls: ${result.mainProfile.inStalls.slice(0, 8).join("; ")}`,
          `  main profile: ${result.mainProfile.file}`,
        ]
      : []),
    ...(result.rendererProfile
      ? [
          `  renderer busiest: ${result.rendererProfile.busiest.slice(0, 8).join("; ")}`,
          `  renderer in slowest interactions: ${result.rendererProfile.inSlowest.slice(0, 8).join("; ")}`,
          `  renderer profile: ${result.rendererProfile.file}`,
        ]
      : []),
    ...(result.refill
      ? [
          result.refill.reason
            ? `  refill on Open: not measured, ${result.refill.reason}`
            : `  refill on Open (${result.refill.state}): ${result.refill.opened ? "opened" : "not opened"} in ${result.refill.openMs} ms, settled after ${result.refill.settledMs} ms, ${result.refill.modelCalls} model calls; pages ${result.refill.pagesBefore} before, ${result.refill.pagesAfter} after`,
        ]
      : []),
    ...(result.playwright
      ? [
          `  loading Playwright in main: ${result.playwright.ms} ms; main process +${result.playwright.rssMB} MB working set (+${result.playwright.heapMB} MB heap), +${result.playwright.rssLaterMB} MB 5 s later`,
        ]
      : []),
    `  scripted model calls: ${Object.entries(result.modelCalls)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  ].join("\n");
}

/** The replica pages an Apply batch opens: its application forms. */
function comparisonUrls(sitesUrl, _manifest, count) {
  return applyUrls(sitesUrl, count);
}

/**
 * Plain Chromium (Playwright's build, a real window, its own profile) with
 * `count` of the same replica pages open at once, measured across all its
 * processes the way the app is.
 */
export async function measureChromium(count, realUrls = null) {
  if (process.platform !== "win32")
    throw new Error("--chromium measures process trees on Windows only");
  const logDir = mkdtempSync(path.join(tempRoot, "nestor-perf-sites-"));
  const replica = await startReplicaSites(logDir);
  const { chromium } = requireDesktop("playwright");
  // A server, so its root process is known for the process-tree reading.
  const server = await chromium.launchServer({
    headless: false,
    args: ["--window-position=-6000,0"],
  });
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    const pid = server.process().pid;
    const context = await browser.newContext();
    await context.newPage();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const blank = await processTreeMemory(pid);
    // Real pages are only read (GET), never filled in.
    const urls = realUrls
      ? Array.from({ length: count }, (_, i) => realUrls[i % realUrls.length])
      : comparisonUrls(replica.url, replica.manifest, count);
    await Promise.all(
      urls.map(async (url) => {
        const page = await context.newPage();
        await page
          .goto(url, { waitUntil: "load", timeout: 60_000 })
          .catch(() => {});
      }),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, realUrls ? 15_000 : 5000),
    );
    const open = await processTreeMemory(pid);
    return {
      chromium: browser.version(),
      real: Boolean(realUrls),
      urls: [...new Set(urls)],
      pages: count,
      blank,
      open,
      ...perPage(blank, open, count),
    };
  } finally {
    await browser.close();
    await server.close();
    await replica.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
}

const perPage = (blank, open, count) => ({
  perPagePrivateWorkingSetMB: Math.round(
    (open.privateWorkingSetMB - blank.privateWorkingSetMB) / count,
  ),
  perPageWorkingSetMB: Math.round(
    (open.workingSetMB - blank.workingSetMB) / count,
  ),
});

const treeLine = (m) =>
  `${m.privateWorkingSetMB} MB private working set (${m.workingSetMB} working set, ${m.processes} processes)`;

export const printChromium = (r) =>
  [
    `\n${r.app ?? `plain Chromium ${r.chromium}`}, ${r.pages} ${r.real ? "real job-site" : "replica"} pages at once (all processes):`,
    `  before: ${treeLine(r.blank)}`,
    `  with the pages: ${treeLine(r.open)}`,
    `  per page ${r.perPagePrivateWorkingSetMB} MB private working set (${r.perPageWorkingSetMB} working set)`,
  ].join("\n");

/**
 * The same pages in Nestor's own browser: the built app (with the real
 * pages, read only: the send guard refuses every non-GET request to them)
 * opens `count` tabs and is measured like plain Chromium.
 */
export async function measureNestorPages(
  count,
  realUrls,
  { seed, appCopy, launch },
) {
  const dataDir = mkdtempSync(path.join(tempRoot, "nestor-perf-pages-"));
  const appDir = appCopy();
  const replica = await startReplicaSites(appDir);
  let run;
  try {
    await seed(dataDir, 300, 30);
    run = await launch(appDir, dataDir, {
      extraEnv: realUrls ? { NESTOR_VERIFY_NET: "web" } : {},
    });
    const pid = run.app.process().pid;
    await run.page.waitForTimeout(8000);
    const blank = await processTreeMemory(pid);
    const urls = realUrls
      ? Array.from({ length: count }, (_, i) => realUrls[i % realUrls.length])
      : comparisonUrls(replica.url, replica.manifest, count);
    for (const url of urls)
      await run.page.evaluate(async (target) => {
        await window.nestor.browser.command({ type: "new_tab" });
        await window.nestor.browser.command({ type: "navigate", url: target });
      }, url);
    await run.page.waitForTimeout(realUrls ? 15_000 : 5000);
    const open = await processTreeMemory(pid);
    const tabs = await run.page.evaluate(
      async () => (await window.nestor.browser.getState()).tabs.length,
    );
    return {
      app: "Nestor's browser",
      real: Boolean(realUrls),
      urls: [...new Set(urls)],
      pages: count,
      tabs,
      blank,
      open,
      ...perPage(blank, open, count),
    };
  } finally {
    await run?.app.close().catch(() => {});
    await replica.stop();
    rmSync(appDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Attaches to a running verify-nestor instance (`bin/up`) and samples it
 * while its search or Apply batch runs, until both stop or `seconds` pass.
 */
export function observe(label, seconds = 900) {
  const cli = path.join(import.meta.dirname, "cli.mjs");
  const out = execFileSync(
    process.execPath,
    [
      cli,
      "drive",
      "run",
      path.join(import.meta.dirname, "../../journeys/observe.mjs"),
      String(seconds),
    ],
    {
      env: { ...process.env, NESTOR_VERIFY_LABEL: label },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 2 ** 20,
    },
  );
  return { label, ...JSON.parse(out) };
}

export const printObserved = (r) =>
  [
    `\nobserved ${r.label} for ${r.seconds} s: ${r.state}`,
    `  Task Manager memory MB (private working set, all processes): before ${r.taskManager.beforeMB}, peak ${r.taskManager.peakMB}, after ${r.taskManager.afterMB}`,
    `  memory MB (all processes, working set): before ${r.idleMB}, peak ${r.peakMB} (private ${r.peakPrivateMB}), typical ${r.typicalMB}, after ${r.memoryAfterMB}; back near idle in ${r.backNearIdleSeconds ?? "-"} s`,
    `  peak by process type: ${Object.entries(r.peakByType ?? {})
      .map(([k, v]) => `${k} ${v.count}x ${v.mb} MB`)
      .join(", ")}`,
    `  CPU % of one core: median ${r.cpuMedianPercent}, p95 ${r.cpuP95Percent}`,
    `  browser pages: at most ${r.pagesMax} at once, ${r.pagesAfter} left after`,
    `  open screen: ${r.interactions} interactions, p95 ${r.interactionP95Ms ?? "-"} ms, long tasks ${r.longTasks}`,
    `  timeline: ${r.timelineFile}`,
  ].join("\n");
