// Watches a running instance while a person (or another journey) searches or
// applies: memory, CPU and browser pages every second across every app
// process, and how smooth the open screen is. It never clicks anything.
// `perf --observe <label>` runs it and prints the summary.
//
// Run: bin/drive run .claude/skills/verify-nestor/journeys/observe.mjs [seconds]
// It stops after [seconds] (default 900), or a minute after the search and
// Apply work it saw running have both stopped. The full timeline is saved as
// observe-<time>.json in the evidence folder.
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  countPages,
  p95,
  processTreeMemory,
  sampleApp,
  summarizeSamples,
  workState,
} from "../bin/lib/perf-sample.mjs";

const RELEASE_MS = 60_000;

export default async function journey(ctx) {
  const seconds = Number(ctx.args[0] ?? 900);
  const page = await ctx.page;
  await page.evaluate(() => {
    const perf = (window.__observe = { long: [], events: [] });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        perf.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: "longtask" });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.interactionId)
          perf.events.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: "event", durationThreshold: 16 });
  });
  await countPages(ctx.app);
  const idle = await sampleApp(ctx.app);
  // Task Manager's figure for the whole app, read apart: Windows takes a few
  // seconds per reading.
  const pid = ctx.app.process().pid;
  const tree = [await processTreeMemory(pid)];
  let reading = true;
  const treeReader = (async () => {
    while (reading) tree.push(await processTreeMemory(pid));
  })();
  const startedAt = Date.now();
  const samples = [];
  let sawWork = false;
  let doneAt = null;
  let state = "";
  for (let tick = 0; Date.now() - startedAt < seconds * 1000; tick += 1) {
    samples.push(await sampleApp(ctx.app));
    if (tick % 5 === 4) {
      const [search, apply] = await Promise.all([
        workState(page, "search"),
        workState(page, "apply"),
      ]);
      state = `search ${search.detail}; Apply ${apply.detail || "none"}`;
      const running = search.running || apply.running;
      if (running) {
        sawWork = true;
        doneAt = null;
      } else if (sawWork && doneAt === null) doneAt = Date.now();
      if (doneAt !== null && Date.now() - doneAt > RELEASE_MS) break;
    }
    await ctx.sleep(1000);
  }
  reading = false;
  await treeReader;
  const screen = await page.evaluate(() => ({
    events: window.__observe.events.map((e) => e.dur),
    long: window.__observe.long.map((e) => e.dur),
  }));
  const timelineFile = path.join(
    ctx.evidenceDir,
    `observe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(timelineFile, JSON.stringify(samples));
  const summary = summarizeSamples(samples, { idle, doneAt });
  ctx.note(
    `observe: peak ${summary.peakMB} MB, ${summary.pagesMax} pages at most, ${summary.pagesAfter} left`,
  );
  return {
    seconds: Math.round((Date.now() - startedAt) / 1000),
    state,
    taskManager: {
      beforeMB: tree[0].privateWorkingSetMB,
      peakMB: Math.max(...tree.map((t) => t.privateWorkingSetMB)),
      afterMB: tree.at(-1).privateWorkingSetMB,
    },
    idleMB: idle.workingSetMB,
    ...summary,
    interactions: screen.events.length,
    interactionP95Ms: p95(screen.events),
    longTasks: screen.long.length,
    timelineFile,
  };
}
