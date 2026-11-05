// Samples for `perf --load` and `perf --observe`: memory, CPU and browser
// pages across every app process, and the state of a search or Apply batch.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Counts every page that isn't an app window as it opens and closes, so a
 * page that lives less than a sample still counts. Safe to call twice.
 */
export const countPages = (app) =>
  app.evaluate(({ app: electronApp, BrowserWindow, webContents }) => {
    if (globalThis.__perfPages) return;
    // App windows are not browser pages; every other page is, whatever its
    // type (tabs are WebContentsViews inside the app window).
    const isAppWindow = (w) =>
      BrowserWindow.getAllWindows().some((win) => win.webContents === w);
    const counter = (globalThis.__perfPages = {
      live: 0,
      most: 0,
      opened: 0,
      // When each page opened (main's performance.now()), to line up with
      // slow frames on the app's window.
      openedAt: [],
    });
    const track = (w) => {
      if (isAppWindow(w)) return;
      counter.live += 1;
      counter.opened += 1;
      counter.openedAt.push(performance.now());
      counter.most = Math.max(counter.most, counter.live);
      w.once("destroyed", () => {
        counter.live -= 1;
      });
    };
    for (const w of webContents.getAllWebContents())
      if (!w.isDestroyed()) track(w);
    electronApp.on("web-contents-created", (_event, w) => track(w));
  });

/** One sample of every app process and every page that isn't an app window. */
export const sampleApp = (app) =>
  app.evaluate(({ app: electronApp, BrowserWindow, webContents }) => {
    // The most pages open at once since the last sample.
    const counter = globalThis.__perfPages;
    const most = counter ? counter.most : null;
    const opened = counter ? counter.opened : null;
    if (counter) counter.most = counter.live;
    const mb = (kb) => Math.round(kb / 1024);
    let workingSet = 0;
    let own = 0;
    let cpu = 0;
    const byType = {};
    for (const p of electronApp.getAppMetrics()) {
      workingSet += p.memory.workingSetSize;
      own += p.memory.privateBytes ?? 0;
      cpu += p.cpu.percentCPUUsage;
      const type = byType[p.type] ?? { count: 0, mb: 0, cpu: 0 };
      type.count += 1;
      type.mb += mb(p.memory.workingSetSize);
      type.cpu += Math.round(p.cpu.percentCPUUsage);
      byType[p.type] = type;
    }
    const pages = webContents
      .getAllWebContents()
      .filter(
        (w) =>
          !w.isDestroyed() &&
          !BrowserWindow.getAllWindows().some((win) => win.webContents === w),
      )
      .map((w) => w.getURL().split("?")[0]);
    return {
      at: Date.now(),
      workingSetMB: mb(workingSet),
      privateMB: mb(own),
      cpuPercent: Math.round(cpu),
      byType,
      pages: pages.length,
      pagesMost: most ?? pages.length,
      pagesOpened: opened,
      urls: pages,
    };
  });

export const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  );
};
export const median = (values) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    : null;

/** Peak, typical and released figures from a run's samples. */
export function summarizeSamples(samples, { idle, doneAt }) {
  const during = samples.filter((s) => !doneAt || s.at <= doneAt);
  const after = doneAt ? samples.filter((s) => s.at > doneAt) : [];
  const peak = during.reduce(
    (top, s) => (s.workingSetMB > (top?.workingSetMB ?? -1) ? s : top),
    null,
  );
  const near = (s) =>
    s.workingSetMB <= idle.workingSetMB * 1.1 + 30 && s.pages === 0;
  const released = after.find(near);
  return {
    samples: samples.length,
    peakMB: peak?.workingSetMB ?? null,
    peakPrivateMB: Math.max(0, ...during.map((s) => s.privateMB)),
    peakByType: peak?.byType ?? null,
    typicalMB: median(during.map((s) => s.workingSetMB)),
    cpuMedianPercent: median(during.map((s) => s.cpuPercent)),
    cpuP95Percent: p95(during.map((s) => s.cpuPercent)),
    pagesMax: Math.max(0, ...during.map((s) => s.pagesMost ?? s.pages)),
    pagesOpened: samples.at(-1)?.pagesOpened ?? null,
    pagesAfter: (after.at(-1) ?? samples.at(-1))?.pages ?? null,
    pagesAfterUrls: after.at(-1)?.urls ?? [],
    memoryAfterMB: (after.at(-1) ?? samples.at(-1))?.workingSetMB ?? null,
    backNearIdleSeconds: released
      ? Math.round((released.at - doneAt) / 100) / 10
      : null,
  };
}

/** The work's own state, read through the app's preload bridge. */
export const workState = (page, kind) =>
  page.evaluate(async (k) => {
    if (k === "search") {
      const status = await window.nestor.jobs.run("search_status", {});
      return {
        running: status.search?.state === "running",
        detail: status.search
          ? `${status.search.state} ${status.search.sourcesDone}/${status.search.sourcesTotal} sites, ${status.search.found} found, ${status.search.added} added`
          : "no search",
        progress: status.progress,
      };
    }
    const rows = [];
    let cursor = null;
    do {
      const page = await window.nestor.jobFinder.listApplications({
        limit: 200,
        cursor,
      });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    const counts = {};
    for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
    return {
      running: rows.some((r) => r.state === "queued" || r.state === "running"),
      detail: [
        Object.entries(counts)
          .map(([state, n]) => `${state} ${n}`)
          .join(", "),
        ...new Set(rows.map((r) => r.error).filter(Boolean)),
      ]
        .slice(0, 3)
        .join("; "),
    };
  }, kind);

/**
 * The busiest functions in a CPU profile, by self time; with `windows`
 * (profile microseconds, [from, to] pairs) only the samples inside them.
 */
export function topFunctions(profile, count = 12, windows = null) {
  const self = new Map();
  const interval =
    (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
  const hits = new Map();
  let at = profile.startTime;
  for (const [index, id] of profile.samples.entries()) {
    at += profile.timeDeltas?.[index] ?? interval;
    if (windows && !windows.some(([from, to]) => at >= from && at <= to))
      continue;
    hits.set(id, (hits.get(id) ?? 0) + 1);
  }
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    if (["(idle)", "(program)", "(root)"].includes(functionName)) continue;
    const key = `${functionName || "(anonymous)"} ${url.split("/").pop()}:${lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (hits.get(node.id) ?? 0) * interval);
  }
  return [...self.entries()]
    .filter(([, us]) => us > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, us]) => `${Math.round(us / 1000)} ms ${key}`);
}

/**
 * Watches the main process's event loop: every stall over 100 ms, with when
 * it began (main's performance.now()). Main runs the app's IPC and draws
 * nothing itself, but a busy main delays every screen's response.
 */
export const watchMainStalls = (app) =>
  app.evaluate(() => {
    if (globalThis.__perfStalls) return;
    const stalls = (globalThis.__perfStalls = []);
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - last > 120)
        stalls.push({ at: last, ms: Math.round(now - last - 20) });
      last = now;
    }, 20).unref?.();
  });

export const readMainStalls = (app) =>
  app.evaluate(() => globalThis.__perfStalls ?? []);

/** Starts a CPU profile of the main process through its own inspector. */
export const startMainProfile = (app) =>
  app.evaluate(async () => {
    const inspector = process.getBuiltinModule("node:inspector");
    const session = new inspector.Session();
    session.connect();
    const post = (method, params = {}) =>
      new Promise((resolve, reject) =>
        session.post(method, params, (error, result) =>
          error ? reject(error) : resolve(result),
        ),
      );
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 500 });
    await post("Profiler.start");
    globalThis.__perfProfiler = { session, post, startedAt: performance.now() };
  });

/** Stops it: the profile, and main's performance.now() when it began. */
export const stopMainProfile = (app) =>
  app.evaluate(async () => {
    const { session, post, startedAt } = globalThis.__perfProfiler;
    const { profile } = await post("Profiler.stop");
    session.disconnect();
    return { profile: JSON.stringify(profile), startedAt };
  });

/**
 * Memory of a process and all its descendants, as Windows reports it:
 * private working set (the Memory column in Task Manager), working set
 * (which counts memory shared between processes once per process) and
 * commit (private bytes). The same for Nestor and for plain Chromium.
 */
export async function processTreeMemory(rootPid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine
$ids = @(${rootPid}); $added = $true
while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }
$perf = Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $ids -contains $_.IDProcess }
$types = @{}
foreach ($q in $perf) { $cmd = ($all | Where-Object { $_.ProcessId -eq $q.IDProcess }).CommandLine; $t = if ($cmd -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }; if ($cmd -match '--utility-sub-type=([A-Za-z.]+)') { $t = $Matches[1] }; $types[$t] = [int64]$types[$t] + [int64]$q.WorkingSetPrivate }
@{ count = @($perf).Count; pws = ($perf | Measure-Object WorkingSetPrivate -Sum).Sum; ws = ($perf | Measure-Object WorkingSet -Sum).Sum; commit = ($perf | Measure-Object PrivateBytes -Sum).Sum; types = $types } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
  );
  const { count, pws, ws, commit, types } = JSON.parse(stdout);
  const mb = (bytes) => Math.round(Number(bytes) / 2 ** 20);
  return {
    processes: count,
    // Private working set by process kind: main, renderer, gpu-process...
    byTypeMB: Object.fromEntries(
      Object.entries(types ?? {}).map(([k, v]) => [k, mb(v)]),
    ),
    privateWorkingSetMB: mb(pws),
    workingSetMB: mb(ws),
    commitMB: mb(commit),
  };
}

/**
 * Counts what crosses IPC between main and the app's windows, per channel:
 * calls and bytes (as JSON) of invoke answers and of messages main sends.
 */
export const countIpc = (app) =>
  app.evaluate(({ ipcMain, BrowserWindow }) => {
    if (globalThis.__perfIpc) return;
    const counts = (globalThis.__perfIpc = {});
    const add = (channel, value, ms = 0) => {
      let bytes = 0;
      try {
        bytes = JSON.stringify(value ?? null)?.length ?? 0;
      } catch {
        bytes = -1;
      }
      const entry = (counts[channel] ??= {
        calls: 0,
        bytes: 0,
        largest: 0,
        slowestMs: 0,
        totalMs: 0,
      });
      entry.calls += 1;
      entry.bytes += bytes;
      entry.largest = Math.max(entry.largest, bytes);
      entry.slowestMs = Math.max(entry.slowestMs, Math.round(ms));
      entry.totalMs += ms;
    };
    const handlers = ipcMain._invokeHandlers;
    if (handlers instanceof Map)
      for (const [channel, handler] of handlers)
        handlers.set(channel, async (...args) => {
          // How long main took to answer, from the handler's start.
          const started = performance.now();
          const result = await handler(...args);
          add(`invoke ${channel}`, result, performance.now() - started);
          return result;
        });
    for (const win of BrowserWindow.getAllWindows()) {
      const send = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, ...args) => {
        add(`send ${channel}`, args);
        return send(channel, ...args);
      };
    }
  });

export const readIpc = (app) =>
  app.evaluate(() =>
    Object.entries(globalThis.__perfIpc ?? {})
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 15),
  );

/** JS heap and native memory of main, and the JS heap of the app's window. */
export async function heapUsage(app, page) {
  const main = await app.evaluate(() => {
    const m = process.memoryUsage();
    return {
      rss: m.rss,
      heapUsed: m.heapUsed,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    };
  });
  const renderer = await page.evaluate(() => ({
    heapUsed: performance.memory?.usedJSHeapSize ?? null,
    heapTotal: performance.memory?.totalJSHeapSize ?? null,
    elements: document.getElementsByTagName("*").length,
  }));
  const mb = (n) => (n === null ? null : Math.round(n / 2 ** 20));
  return {
    mainRssMB: mb(main.rss),
    mainHeapMB: mb(main.heapUsed),
    mainExternalMB: mb(main.external),
    rendererHeapMB: mb(renderer.heapUsed),
    rendererElements: renderer.elements,
  };
}

/** A V8 heap snapshot of the main process, written to `file`. */
export const mainHeapSnapshot = (app, file) =>
  app.evaluate(async (_electron, target) => {
    const inspector = process.getBuiltinModule("node:inspector");
    const { createWriteStream } = process.getBuiltinModule("node:fs");
    const session = new inspector.Session();
    session.connect();
    const out = createWriteStream(target);
    session.on("HeapProfiler.addHeapSnapshotChunk", (m) =>
      out.write(m.params.chunk),
    );
    await new Promise((resolve, reject) =>
      session.post("HeapProfiler.takeHeapSnapshot", {}, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await new Promise((resolve) => out.end(resolve));
    session.disconnect();
  }, file);

/** A heap snapshot of the app's window through the DevTools protocol. */
export async function rendererHeapSnapshot(page, file) {
  const { createWriteStream } = await import("node:fs");
  const cdp = await page.context().newCDPSession(page);
  const out = createWriteStream(file);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (m) => out.write(m.chunk));
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await new Promise((resolve) => out.end(resolve));
  await cdp.detach();
}

/** Self size by constructor in a heap snapshot: what fills a heap. */
export async function snapshotSummary(file, count = 12) {
  const { readFileSync } = await import("node:fs");
  try {
    const snap = JSON.parse(readFileSync(file, "utf8"));
    const fields = snap.snapshot.meta.node_fields;
    const types = snap.snapshot.meta.node_types[0];
    const width = fields.length;
    const [typeAt, nameAt, sizeAt] = ["type", "name", "self_size"].map((f) =>
      fields.indexOf(f),
    );
    const byName = new Map();
    let total = 0;
    for (let i = 0; i < snap.nodes.length; i += width) {
      const type = types[snap.nodes[i + typeAt]];
      const name =
        type === "object" || type === "native"
          ? snap.strings[snap.nodes[i + nameAt]]
          : `(${type})`;
      const size = snap.nodes[i + sizeAt];
      total += size;
      byName.set(name, (byName.get(name) ?? 0) + size);
    }
    return {
      totalMB: Math.round(total / 2 ** 20),
      top: [...byName]
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([name, size]) => `${Math.round(size / 2 ** 20)} MB ${name}`),
    };
  } catch (error) {
    return { error: error.message };
  }
}

/** Main's clock and when each browser page opened, in that clock. */
export const readPageOpenings = (app) =>
  app.evaluate(() => ({
    now: performance.now(),
    openedAt: globalThis.__perfPages?.openedAt ?? [],
  }));
