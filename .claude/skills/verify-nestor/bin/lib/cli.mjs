// verify-nestor command line: up, doctor, drive, db, down, build.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  checkout,
  descendants,
  desktopDir,
  ensureDirs,
  evidenceDir,
  fail,
  holdersOf,
  isAlive,
  isMainCheckout,
  label,
  loadAiEnv,
  readStamp,
  readState,
  requireDesktop,
  sourceFingerprint,
  stampPath,
  startTime,
  stateDir,
  step,
  stillOurs,
  workRoot,
  writeState,
} from "./common.mjs";
import { rows, saveRows, tables } from "./sqlite.mjs";

if (Number(process.versions.node.split(".")[0]) < 22)
  fail(`Node 22 or newer is needed (found ${process.version}).`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [command, ...rest] = process.argv.slice(2);

function driverUp(state = readState()) {
  return Boolean(
    state?.driverPid && stillOurs(state.driverPid, state.driverStart),
  );
}

function send(cmd, args = []) {
  const state = readState();
  if (!driverUp(state) || !state.driverPort)
    fail(`No running instance for label ${label}. Start one with bin/up.`, 2);
  const body = JSON.stringify({ cmd, args });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: state.driverPort,
        method: "POST",
        headers: {
          "x-verify-token": state.token,
          "content-type": "application/json",
        },
      },
      async (res) => {
        let text = "";
        for await (const chunk of res) text += chunk;
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(text));
        }
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function fingerprintText(f) {
  return f
    ? `${f.head?.slice(0, 10)}${f.dirty ? ` + uncommitted ${f.dirty}` : " (clean)"}`
    : "unknown";
}

// --- build ----------------------------------------------------------------
async function build() {
  if (isMainCheckout() && !rest.includes("--force"))
    fail(
      "Refusing to build in the main checkout: its out/ feeds the owner's pnpm desktop:dev. Use a worktree.",
    );
  const before = sourceFingerprint();
  const result = spawnSync("pnpm", ["--filter", "@nestor/desktop", "build"], {
    cwd: checkout,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`Build failed (exit ${result.status}).`);
  const after = sourceFingerprint();
  if (JSON.stringify(before) !== JSON.stringify(after))
    fail(
      "The source changed during the build; build again so the stamp matches.",
    );
  writeFileSync(
    stampPath,
    JSON.stringify({ ...before, builtAt: new Date().toISOString() }, null, 2),
  );
  console.log(`build stamped: ${fingerprintText(before)}`);
}

// --- up -------------------------------------------------------------------
/**
 * macOS activates a regular app whenever it shows a window, even with showInactive.
 * An agent app (LSUIElement) does not, so instances run from an APFS clone of the
 * checkout's Electron.app marked as one. The clone is instant and shares disk blocks.
 */
function quietElectron() {
  const original = requireDesktop("electron");
  if (process.platform !== "darwin") return original;
  const bundle = original.slice(0, original.indexOf(".app/") + 4);
  const version = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(requireDesktop.resolve("electron")),
        "package.json",
      ),
      "utf8",
    ),
  ).version;
  const clone = path.join(
    workRoot,
    ".verify-state",
    "_electron",
    version,
    "Electron.app",
  );
  const executable = path.join(clone, path.relative(bundle, original));
  if (!existsSync(executable)) {
    rmSync(path.dirname(clone), { recursive: true, force: true });
    mkdirSync(path.dirname(clone), { recursive: true });
    execFileSync("cp", ["-cR", bundle, clone]);
    execFileSync("plutil", [
      "-replace",
      "LSUIElement",
      "-bool",
      "true",
      path.join(clone, "Contents/Info.plist"),
    ]);
  }
  return executable;
}

async function up() {
  const { values } = parseArgs({
    args: rest,
    options: {
      ai: { type: "string", default: "deterministic" },
      net: { type: "string", default: "replica" },
      video: { type: "boolean", default: false },
      "no-test-api": { type: "boolean", default: false },
      "allow-stale": { type: "boolean", default: false },
      "reuse-data": { type: "boolean", default: false },
    },
  });
  if (!["deterministic", "live"].includes(values.ai))
    fail("--ai is deterministic or live");
  if (!["replica", "web"].includes(values.net)) fail("--net is replica or web");
  const previous = readState();
  if (driverUp(previous)) {
    console.log(
      `Already up for label ${label}. Run bin/doctor, or bin/down first.`,
    );
    return;
  }
  if (
    previous?.checkout &&
    previous.checkout !== checkout &&
    existsSync(previous.userDataDir ?? "")
  )
    fail(
      `Label ${label} belongs to ${previous.checkout}. Pick another NESTOR_VERIFY_LABEL.`,
    );

  const source = path.join(desktopDir, "out");
  if (!existsSync(path.join(source, "main/index.cjs")))
    fail("No desktop build. Run bin/build first.");
  const stamp = readStamp();
  const now = sourceFingerprint();
  const fresh = stamp && stamp.head === now.head && stamp.dirty === now.dirty;
  if (!fresh && !values["allow-stale"])
    fail(
      stamp
        ? `The build is from ${fingerprintText(stamp)} but the source is ${fingerprintText(now)}. Run bin/build, or pass --allow-stale and say so in the proof.`
        : "The build has no verify stamp, so nothing proves it matches the source. Run bin/build (or --allow-stale and say so).",
    );

  let aiKeys = [];
  if (values.ai === "live") {
    const { loaded, sources } = loadAiEnv();
    aiKeys = Object.keys({ ...loaded, ...process.env }).filter(
      (k) => /^NESTOR_.*API_KEY$/.test(k) && (process.env[k] || loaded[k]),
    );
    if (!aiKeys.length)
      fail(
        `--ai live found no NESTOR_*_API_KEY in ${sources.join(", ") || "any .env file"}.`,
      );
  }

  ensureDirs();
  rmSync(path.join(stateDir, "app"), { recursive: true, force: true });
  for (const f of ["next-open.txt", "token"])
    rmSync(path.join(stateDir, f), { force: true });
  // A private copy of the build, so a rebuild cannot swap files under a running instance.
  const appDir = path.join(stateDir, "app");
  cpSync(source, path.join(appDir, "out"), { recursive: true });
  cpSync(
    path.join(desktopDir, "package.json"),
    path.join(appDir, "package.json"),
  );
  symlinkSync(
    path.join(desktopDir, "node_modules"),
    path.join(appDir, "node_modules"),
  );

  const electronPath = quietElectron();

  let userDataDir;
  if (
    values["reuse-data"] &&
    previous?.userDataDir &&
    existsSync(previous.userDataDir)
  )
    userDataDir = previous.userDataDir;
  else userDataDir = mkdtempSync(path.join("/tmp", `nestor-verify-${label}-`));
  const defaultLocation = path.join(
    os.homedir(),
    "Library/Application Support",
  );
  if (userDataDir.startsWith(defaultLocation))
    fail("Refusing a user data folder in Application Support.");

  const launch = {
    userDataDir,
    appDir,
    electronPath,
    ai: values.ai,
    net: values.net,
    video: values.video,
    testApi: !values["no-test-api"],
  };
  writeFileSync(
    path.join(stateDir, "launch.json"),
    JSON.stringify(launch, null, 2),
  );
  writeState({
    label,
    checkout,
    evidenceDir,
    startedAt: new Date().toISOString(),
    ...launch,
    build: stamp ?? null,
    source: now,
    aiKeys,
  });
  step(
    `=== up label=${label} checkout=${checkout} build=${fingerprintText(stamp)} source=${fingerprintText(now)} ai=${values.ai} net=${values.net}`,
  );

  const log = openSync(path.join(stateDir, "driver.log"), "a");
  const driver = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "driver.mjs")],
    {
      cwd: desktopDir,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, NESTOR_VERIFY_LABEL: label },
    },
  );
  driver.unref();
  writeState({
    ...readState(),
    driverPid: driver.pid,
    driverStart: startTime(driver.pid),
  });

  const started = Date.now();
  while (Date.now() - started < 240000) {
    await sleep(1000);
    const state = readState();
    if (state.readyAt) {
      console.log(
        [
          `ready: label ${label}`,
          `  ai ${values.ai}${aiKeys.length ? ` (${aiKeys.join(", ")})` : ""}, net ${values.net}, build ${fingerprintText(stamp)}`,
          `  replica sites ${state.sitesUrl}`,
          `  user data ${userDataDir}`,
          `  evidence ${evidenceDir}`,
          `  took ${Math.round((Date.now() - started) / 1000)} s`,
        ].join("\n"),
      );
      return;
    }
    if (state.startError || !isAlive(driver.pid)) {
      console.error(
        `up failed: ${state.startError ?? "the driver exited"}\nLogs: ${path.join(stateDir, "driver.log")}, ${path.join(stateDir, "app.log")}\nRun bin/down to clean up.`,
      );
      process.exit(1);
    }
  }
  fail(`up timed out after 240 s. Logs in ${stateDir}. Run bin/down.`);
}

// --- doctor ---------------------------------------------------------------
async function doctor() {
  const checks = [];
  const check = (ok, name, detail = "") => checks.push({ ok, name, detail });
  const info = (name, detail) => checks.push({ ok: null, name, detail });
  info(
    "checkout",
    `${checkout}${isMainCheckout() ? " (the main checkout: fine to drive, never build here)" : ""}`,
  );
  info("label", `${label}; evidence ${evidenceDir}`);
  const state = readState();
  const now = sourceFingerprint();
  const stamp = readStamp();
  info("source", fingerprintText(now));
  check(
    Boolean(stamp && stamp.head === now.head && stamp.dirty === now.dirty),
    "desktop build matches source",
    stamp ? fingerprintText(stamp) : "no verify stamp; run bin/build",
  );
  if (!state) {
    check(false, "instance", `none for label ${label}; run bin/up`);
  } else {
    if (state.build)
      info("instance build", `${fingerprintText(state.build)} (copied at up)`);
    check(
      driverUp(state),
      "driver process ours and alive",
      `pid ${state.driverPid}`,
    );
    check(
      stillOurs(state.electronPid, state.electronStart),
      "Electron process ours and alive",
      `pid ${state.electronPid}`,
    );
    check(
      stillOurs(state.sitesPid, state.sitesStart),
      "replica sites process ours and alive",
      `pid ${state.sitesPid}`,
    );
    if (state.sitesUrl) {
      const ok = await fetch(state.sitesUrl).then(
        (r) => r.ok,
        () => false,
      );
      check(ok, "replica sites answer", state.sitesUrl);
    }
    check(
      state.userDataDir?.startsWith("/tmp/nestor-verify-") ||
        state.userDataDir?.startsWith("/private/tmp/nestor-verify-"),
      "private user data folder",
      state.userDataDir,
    );
    check(
      state.guard === "verified",
      "send guard self-test passed",
      `net ${state.net}`,
    );
    info(
      "AI",
      state.ai === "live"
        ? `live (${(state.aiKeys ?? []).join(", ")})`
        : "deterministic: results cannot prove model quality",
    );
    if (driverUp(state)) {
      const status = await send("status").catch((e) => ({
        ok: false,
        error: e.message,
      }));
      check(
        status.ok && status.result.appAlive,
        "driver answers and app is running",
        status.ok ? `screen "${status.result.heading}"` : status.error,
      );
      if (status.ok)
        check(
          status.result.userDataDir === state.userDataDir,
          "app user data is the private folder",
        );
      const tree = new Set(
        state.electronPid ? descendants(state.electronPid) : [],
      );
      tree.add(state.driverPid);
      const strangers = holdersOf(state.userDataDir).filter(
        (pid) => !tree.has(pid),
      );
      check(
        strangers.length === 0,
        "nothing else holds the user data folder",
        strangers.join(", "),
      );
    }
    if (
      process.platform === "darwin" &&
      stillOurs(state.electronPid, state.electronStart)
    ) {
      const front = spawnSync(
        "lsappinfo",
        [
          "info",
          "-only",
          "pid",
          spawnSync("lsappinfo", ["front"], { encoding: "utf8" }).stdout.trim(),
        ],
        { encoding: "utf8" },
      ).stdout;
      const frontPid = Number((front.match(/pid\s*=\s*(\d+)/) ?? [])[1]);
      check(
        !descendants(state.electronPid).includes(frontPid),
        "the instance is not the front app (focus patch)",
        `front pid ${frontPid || "?"}`,
      );
    }
  }
  const stateRoot = path.join(workRoot, ".verify-state");
  const others = existsSync(stateRoot)
    ? readdirSync(stateRoot).filter((l) => {
        if (l === label) return false;
        try {
          return driverUp(
            JSON.parse(
              readFileSync(path.join(stateRoot, l, "state.json"), "utf8"),
            ),
          );
        } catch {
          return false;
        }
      })
    : [];
  info("other live instances", others.join(", ") || "none");
  info(
    "load",
    os
      .loadavg()
      .map((n) => n.toFixed(1))
      .join(" "),
  );
  for (const c of checks)
    console.log(
      `${c.ok === null ? "  ·" : c.ok ? " ok" : "  ✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`,
    );
  if (checks.some((c) => c.ok === false)) process.exit(1);
}

// --- drive ----------------------------------------------------------------
async function drive() {
  const [cmd, ...raw] = rest;
  if (!cmd)
    fail(
      "drive <status|see|shot|click|fill|press|wait|pick|eval|run|browser|restart> ...",
    );
  const positional = [];
  const opts = {};
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].startsWith("--")) {
      const key = raw[i].slice(2);
      const next = raw[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else {
        opts[key] = next === "false" ? false : next;
        i += 1;
      }
    } else positional.push(raw[i]);
  }
  if (cmd === "eval" && positional[0] === "-")
    positional[0] = readFileSync(0, "utf8");
  if (cmd === "pick" || cmd === "run")
    positional.forEach(
      (p, i) =>
        (cmd === "pick" || i === 0) && (positional[i] = path.resolve(p)),
    );
  const withOpts = ["shot", "click", "fill", "wait", "see", "press"].includes(
    cmd,
  )
    ? [...positional, opts]
    : positional;
  const out = await send(cmd, withOpts);
  if (!out.ok) {
    console.error(out.error);
    if (out.failureShot)
      console.error(`failure screenshot: ${out.failureShot.join(", ")}`);
    process.exit(1);
  }
  console.log(
    typeof out.result === "string"
      ? out.result
      : JSON.stringify(out.result, null, 2),
  );
}

// --- db -------------------------------------------------------------------
function db() {
  const state = readState();
  const live = state?.userDataDir && existsSync(state.userDataDir);
  const dir = live ? state.userDataDir : path.join(evidenceDir, "final-data");
  if (!existsSync(dir))
    fail(
      `No user data for label ${label} (instance down and no final-data in the evidence).`,
    );
  // Read from a throwaway copy, so a read after `down` leaves no state folder behind.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "nestor-verify-db-"));
  const [table, limit = "5", pattern] = rest;
  let result;
  try {
    if (!table || table === "tables")
      return console.log(JSON.stringify(tables(dir, scratch), null, 2));
    result = rows(dir, scratch, table, { limit, pattern });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const file = saveRows(evidenceDir, result);
  console.log(JSON.stringify(result.rows, null, 2));
  console.error(
    `${result.rows.length} row(s) from ${result.database}${live ? "" : " (final-data)"}; saved ${file}`,
  );
  if (!result.rows.length) process.exit(1);
}

// --- down -----------------------------------------------------------------
async function down() {
  const keepData = rest.includes("--keep-data");
  const state = readState();
  if (!state) return console.log(`Nothing recorded for label ${label}.`);
  if (driverUp(state) && state.driverPort) {
    await send("stop").catch(() => {});
    for (let i = 0; i < 160 && isAlive(state.driverPid); i += 1)
      await sleep(250);
  }
  // Whatever is left: only recorded PIDs whose start time still matches, and their children.
  const recorded = [
    [state.electronPid, state.electronStart],
    [state.sitesPid, state.sitesStart],
    [state.driverPid, state.driverStart],
  ].filter(([pid, start]) => stillOurs(pid, start));
  const targets = new Set(recorded.flatMap(([pid]) => descendants(pid)));
  for (const pid of holdersOf(state.userDataDir)) targets.add(pid);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of targets)
      if (isAlive(pid))
        try {
          process.kill(pid, signal);
        } catch {}
    for (let i = 0; i < 20 && [...targets].some(isAlive); i += 1)
      await sleep(250);
  }
  const survivors = [...targets].filter(isAlive);

  // Keep the proof: final databases, diagnostics and logs go to the evidence folder.
  const finalData = path.join(evidenceDir, "final-data");
  mkdirSync(finalData, { recursive: true });
  if (state.userDataDir && existsSync(state.userDataDir))
    for (const name of readdirSync(state.userDataDir))
      if (
        /\.sqlite(-wal|-shm)?$|\.json$|startup-diagnostics\.log$/.test(name) &&
        statSync(path.join(state.userDataDir, name)).isFile()
      )
        cpSync(path.join(state.userDataDir, name), path.join(finalData, name));
  const logs = path.join(evidenceDir, "logs");
  mkdirSync(logs, { recursive: true });
  for (const name of ["driver.log", "app.log"])
    if (existsSync(path.join(stateDir, name)))
      cpSync(path.join(stateDir, name), path.join(logs, name));

  if (!survivors.length) {
    if (!keepData && state.userDataDir?.includes("/nestor-verify-"))
      rmSync(state.userDataDir, { recursive: true, force: true });
    if (keepData) {
      rmSync(path.join(stateDir, "app"), { recursive: true, force: true });
      writeState({
        label,
        checkout,
        userDataDir: state.userDataDir,
        keptAt: new Date().toISOString(),
      });
    } else rmSync(stateDir, { recursive: true, force: true });
  }
  step(
    `=== down${keepData ? " --keep-data" : ""}${survivors.length ? ` SURVIVORS ${survivors.join(", ")}` : ""}`,
  );
  const files = existsSync(evidenceDir)
    ? readdirSync(evidenceDir, { recursive: true }).length
    : 0;
  console.log(
    `down: label ${label}${survivors.length ? `\n  survivors (not removed, state kept): ${survivors.join(", ")}` : ""}`,
  );
  console.log(`  evidence kept: ${evidenceDir} (${files} entries)`);
  if (keepData)
    console.log(
      `  user data kept: ${state.userDataDir} (bin/up --reuse-data picks it up)`,
    );
  if (survivors.length) process.exit(1);
}

const table = { build, up, doctor, drive, db, down };
if (!table[command]) fail(`Usage: bin/<${Object.keys(table).join("|")}> ...`);
await table[command]();
