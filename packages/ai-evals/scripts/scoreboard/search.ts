import assert from "node:assert/strict";
import type { App } from "./app.ts";
import type { Result } from "./types.ts";
import { SOURCES } from "./profile.ts";

interface Search {
  id: string;
  started_at: number;
  state: string;
  error: string | null;
  sources_total: number;
  sources_done: number;
}
interface Found {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
}
interface Source {
  source_id: string;
  url: string;
  state: string;
  message: string | null;
}

export async function search(app: App, r: Result) {
  const latest = () =>
    app.read<Search>(
      "SELECT * FROM searches ORDER BY started_at DESC LIMIT 1",
    )[0];
  const found = () =>
    app.read<Found>(
      "SELECT id,title,company,location,url FROM jobs WHERE source_label <> 'Scoreboard fixture' ORDER BY id",
    );
  const initial = found();
  const initialIds = new Set(initial.map((j) => j.id));
  r.metrics.setupListings = initial.length;
  r.metrics.sources = SOURCES;
  await app.go("Find jobs");
  let p = await app.ctx.page;
  app.log("start measured seven-source search");
  const started = Date.now();
  await p
    .getByRole("region", { name: "Search", exact: true })
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await app.until(() => latest()?.state === "running", 20, "search running");
  const firstStarted = latest().started_at;
  let firstSeconds: number | null = null;
  r.metrics.timeToFirstResultSeconds = null;
  const end = Date.now() + Math.max(app.timeout, 240) * 1000;
  let stopped = false;
  let continued = false;
  let restarted = false;
  let beforeStop: number[] = [];
  let beforeRestart: number[] = [];
  let lostAfterRestart: number[] = [];
  let searchError: unknown;
  try {
    while (Date.now() < end) {
      const jobs = found();
      if (
        r.metrics.timeToFirstResultSeconds === null &&
        jobs.some((j) => !initialIds.has(j.id))
      ) {
        firstSeconds = (Date.now() - started) / 1000;
        r.metrics.timeToFirstResultSeconds = firstSeconds;
        app.log("first new listing", {
          seconds: r.metrics.timeToFirstResultSeconds,
          count: jobs.length,
        });
      }
      if (
        !stopped &&
        latest().state === "running" &&
        jobs.some((j) => !initialIds.has(j.id))
      ) {
        beforeStop = jobs.map((j) => j.id);
        app.log("Stop search", { retainedIds: beforeStop });
        await p
          .getByRole("button", { name: "Stop search", exact: true })
          .click();
        await app.until(
          () => latest().state !== "running",
          30,
          "search stopped",
        );
        stopped = latest().state === "stopped";
        const after = new Set(found().map((j) => j.id));
        r.metrics.lostOnStop = beforeStop.filter((id) => !after.has(id));
      }
      if (stopped && !continued) {
        const control = p.getByRole("button", {
          name: /^(Continue unfinished sites|Keep reading (?:it|them))$/,
        });
        app.log("Continue unfinished sites");
        await control.click({ timeout: 15000 });
        await app.until(
          () => latest().state === "running",
          20,
          "continued search running",
        );
        continued = true;
        await app.ctx.sleep(2000);
      }
      if (continued && !restarted && latest().state === "running") {
        beforeRestart = found().map((j) => j.id);
        app.log("restart during search", { retainedIds: beforeRestart });
        await app.ctx.restart();
        restarted = true;
        p = await app.ctx.page;
        await app.go("Find jobs");
        const after = new Set(found().map((j) => j.id));
        lostAfterRestart = beforeRestart.filter((id) => !after.has(id));
        // Restart can leave a truthful paused search. Use its existing Continue
        // control; a new Search would not prove recovery of the interrupted run.
        if (latest().state === "stopped") {
          const resume = p.getByRole("button", {
            name: /^(Continue unfinished sites|Keep reading (?:it|them))$/,
          });
          if (await resume.count()) {
            app.log("Continue after restart");
            await resume.click();
          }
        }
      }
      app.capture();
      const state = latest().state;
      if (state !== "running" && (restarted || !stopped)) break;
      await app.ctx.sleep(1000);
    }
  } catch (error) {
    searchError = error;
  }
  const final = found();
  const urlCounts = new Map<string, number>();
  const identityCounts = new Map<string, number>();
  for (const job of final) {
    const url = new URL(job.url);
    url.hash = "";
    const identity = [job.title, job.company, job.location]
      .map((s) => s.toLowerCase().replace(/\s+/g, " ").trim())
      .join("|");
    urlCounts.set(url.href, (urlCounts.get(url.href) ?? 0) + 1);
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }
  const duplicates = [...identityCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const urlDuplicates = [...urlCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const searches = app.read<Search>(
    "SELECT * FROM searches WHERE started_at>=? ORDER BY started_at",
    firstStarted,
  );
  const sourceRows = app.read<Source>(
    "SELECT * FROM search_sources WHERE search_id IN (SELECT id FROM searches WHERE started_at>=?) ORDER BY id",
    firstStarted,
  );
  const latestSources = new Map(
    sourceRows.map((source) => [source.source_id, source]),
  );
  const sourceFailures = [...latestSources.values()].filter(
    (source) => source.state === "failed",
  );
  r.metrics = {
    ...r.metrics,
    listings: final.length,
    newListings: final.length - initial.length,
    timeToFinishSeconds:
      latest().state === "done" ? (Date.now() - started) / 1000 : null,
    elapsedSeconds: (Date.now() - started) / 1000,
    stopped,
    continued,
    restarted,
    beforeStopCount: beforeStop.length,
    beforeRestartCount: beforeRestart.length,
    lostAfterRestart,
    duplicates,
    urlDuplicates,
    searches,
    sourceRows,
    sourceFailures,
    summary: `${final.length} listings; first=${firstSeconds ?? "none"}s; state=${latest().state}; source failures=${sourceFailures.length}; dup=${duplicates}; Stop/Continue/restart=${stopped}/${continued}/${restarted}`,
  };
  if (latest().state === "running") {
    app.log("stop timed-out search before other scenarios");
    const stop = p.getByRole("button", { name: "Stop search", exact: true });
    if (await stop.count()) await stop.click();
    searchError ??= Error("Search did not finish before the scenario deadline");
  }
  if (searchError)
    throw searchError instanceof Error
      ? searchError
      : new Error("Search action failed");
  assert.equal(
    latest().state,
    "done",
    `Search ${latest().state}: ${latest().error ?? ""}`,
  );
  assert.ok(final.length > 0, "search saved listings");
  assert.notEqual(
    r.metrics.timeToFirstResultSeconds,
    null,
    "measured search produced a new listing",
  );
  assert.ok(
    stopped && continued && restarted,
    "Stop, Continue and mid-search restart were all exercised",
  );
  assert.ok(
    beforeStop.length > 0 && beforeRestart.length > 0,
    "recovery was exercised with saved results",
  );
  assert.deepEqual(r.metrics.lostOnStop, []);
  assert.deepEqual(lostAfterRestart, []);
  assert.equal(duplicates, 0, "duplicate title/company/location listings");
  assert.equal(urlDuplicates, 0);
  // Continue deliberately starts a run of only the unfinished sites, so the
  // denominator belongs to the whole continuation chain, not its last run.
  assert.equal(latestSources.size, 7, "all seven sources were included");
  assert.equal(
    sourceFailures.length,
    0,
    `Sources failed: ${sourceFailures.map((s) => `${new URL(s.url).pathname}: ${s.message ?? "no detail"}`).join("; ")}`,
  );
  assert.ok(
    [...latestSources.values()].every((s) =>
      ["done", "empty"].includes(s.state),
    ),
    "every source finished in the continuation chain",
  );
}
