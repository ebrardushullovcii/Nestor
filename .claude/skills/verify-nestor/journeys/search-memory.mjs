// Memory across every app process while Job Finder searches the replica board,
// and the browser pages still open once it is done. `perf --search` runs it.
//
// Needs `bin/up --ai live`, like job-finder-replica.mjs, whose stages it runs.
// Run: bin/drive run .claude/skills/verify-nestor/journeys/search-memory.mjs [stages]
// stages: comma-separated replica stages (default setup,search, for a fresh instance).
import replica from "./job-finder-replica.mjs";

const SAMPLE_MS = 500;
const SETTLE_MS = 10_000;

export default async function journey(ctx) {
  const stages = (ctx.args[0] ?? "setup,search").split(",");
  const measure = () =>
    ctx.app.evaluate(({ app }) => {
      const byType = {};
      let total = 0;
      let own = 0;
      for (const p of app.getAppMetrics()) {
        total += p.memory.workingSetSize;
        own += p.memory.privateBytes ?? 0;
        byType[p.type] = (byType[p.type] ?? 0) + p.memory.workingSetSize;
      }
      const mb = (kb) => Math.round(kb / 1024);
      return {
        totalMB: mb(total),
        // Windows only: memory no other process can share (Task Manager).
        privateMB: mb(own),
        byTypeMB: Object.fromEntries(
          Object.entries(byType).map(([k, v]) => [k, mb(v)]),
        ),
      };
    });

  const before = await measure();
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      samples.push({ stage: ctx.stage, ...(await measure()) });
      await ctx.sleep(SAMPLE_MS);
    }
  })();
  const stageMs = {};
  try {
    for (const name of stages) {
      ctx.stage = name;
      ctx.args = [name];
      const started = Date.now();
      await replica(ctx);
      stageMs[name] = Date.now() - started;
    }
  } finally {
    sampling = false;
    await sampler;
  }
  await ctx.sleep(SETTLE_MS);
  const peakOf = (stage) =>
    samples
      .filter((s) => !stage || s.stage === stage)
      .reduce((top, s) => (s.totalMB > (top?.totalMB ?? -1) ? s : top), null);
  const pagesAfter = (await ctx.browserPages()).filter(
    (p) => p.type !== "window",
  );
  const result = {
    stageMs,
    beforeMB: before.totalMB,
    peak: peakOf(),
    searchPeak: peakOf("search"),
    afterMB: (await measure()).totalMB,
    samples: samples.length,
    pagesLeftOpen: pagesAfter,
  };
  ctx.note(
    `search memory: before ${result.beforeMB} MB, peak ${result.peak?.totalMB} MB, after ${result.afterMB} MB, ${pagesAfter.length} browser page(s) left open`,
  );
  return result;
}
