// Paths, labels and state shared by every verify-nestor helper.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const skillDir = path.resolve(import.meta.dirname, "../..");
export const checkout = path.resolve(skillDir, "../../..");
export const desktopDir = path.join(checkout, "apps/desktop");
export const requireDesktop = createRequire(
  path.join(desktopDir, "package.json"),
);
export const isWindows = process.platform === "win32";
// The owner's own checkout, where `pnpm desktop:dev` usually runs: on the Mac, then on the Windows PC.
const ownerCheckouts = [
  path.join(os.homedir(), "Projects/Personal/Nestor"),
  "D:/Projects-Personal/Nestor",
];
export const mainCheckout =
  process.env.NESTOR_VERIFY_MAIN_CHECKOUT ||
  ownerCheckouts.find((dir) => existsSync(dir)) ||
  ownerCheckouts[0];
export const workRoot =
  process.env.NESTOR_VERIFY_WORK ||
  path.join(os.homedir(), "Projects/nestor-agent-work");
// Instance data folders: /tmp on the Mac (as before), the user's temp folder elsewhere.
export const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
// Where the app keeps the owner's real data; an instance never goes there.
export const appDataRoot =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support")
    : isWindows
      ? process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const label =
  process.env.NESTOR_VERIFY_LABEL || `verify-${path.basename(checkout)}`;
if (!LABEL.test(label))
  throw new Error(`NESTOR_VERIFY_LABEL must match ${LABEL}: ${label}`);

export const evidenceDir = path.join(workRoot, label, "verify");
export const stateDir = path.join(workRoot, ".verify-state", label);
export const statePath = path.join(stateDir, "state.json");
export const stampPath = path.join(desktopDir, "out", ".verify-build.json");

export function ensureDirs() {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
}

export function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function step(line) {
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(
    path.join(evidenceDir, "steps.log"),
    `${new Date().toISOString()}  ${line}\n`,
  );
}

export function isMainCheckout() {
  try {
    return realpathSync(checkout) === realpathSync(mainCheckout);
  } catch {
    return false;
  }
}

/** A fresh `nestor-verify-*` folder in the temp root, never the owner's data. */
export function isPrivateDataDir(dir) {
  if (!dir) return false;
  const roots =
    process.platform === "darwin" ? [tempRoot, "/private/tmp"] : [tempRoot];
  return roots.some((root) =>
    dir.startsWith(path.join(root, "nestor-verify-")),
  );
}

/** Windows has no ps or lsof; ask PowerShell for the process table instead. */
function windowsProcesses(filter = "") {
  const script = `Get-CimInstance Win32_Process ${filter} | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }`;
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, start] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), start };
    });
}

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Start time as ps prints it; a recycled PID has a different one. */
export function startTime(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "";
  try {
    if (isWindows)
      return windowsProcesses(`-Filter "ProcessId=${pid}"`)[0]?.start ?? "";
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

/** A recorded PID still belongs to us when it is alive with the same start time. */
export function stillOurs(pid, recordedStart) {
  return (
    isAlive(pid) && Boolean(recordedStart) && startTime(pid) === recordedStart
  );
}

export function descendants(rootPid) {
  if (isWindows) return windowsDescendants(rootPid);
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [child, parent] of rows)
      if (owned.has(parent) && !owned.has(child)) {
        owned.add(child);
        changed = true;
      }
  }
  return [...owned];
}

// Windows keeps a dead parent's PID on its children and reuses PIDs, so a child
// only counts when it started after the parent it names.
function windowsDescendants(rootPid) {
  let rows;
  try {
    rows = windowsProcesses();
  } catch {
    return [rootPid];
  }
  const started = new Map(rows.map((r) => [r.pid, r.start]));
  const owned = new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { pid, ppid, start } of rows)
      if (
        owned.has(ppid) &&
        !owned.has(pid) &&
        start >= (started.get(ppid) ?? "")
      ) {
        owned.add(pid);
        changed = true;
      }
  }
  return [...owned];
}

/** PIDs with an open file inside our own private data folder, nothing else. */
export function holdersOf(dir) {
  if (!dir || !existsSync(dir)) return [];
  if (isWindows) return windowsHoldersOf(dir);
  try {
    return execFileSync("lsof", ["-t", "+D", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

// No lsof on Windows: the processes whose command line names the folder. Every
// Chromium child of the app carries --user-data-dir=<folder>. The folder goes in
// through the environment so the query's own command line does not match.
function windowsHoldersOf(dir) {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:NESTOR_VERIFY_HOLDER_DIR, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }";
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, NESTOR_VERIFY_HOLDER_DIR: path.resolve(dir) },
      },
    )
      .split(/\r?\n/)
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

/** PID of the app the owner is looking at, to prove an instance did not take the front. */
export function frontPid() {
  try {
    if (process.platform === "darwin") {
      const front = execFileSync("lsappinfo", ["front"], {
        encoding: "utf8",
      }).trim();
      const info = execFileSync("lsappinfo", ["info", "-only", "pid", front], {
        encoding: "utf8",
      });
      return Number((info.match(/pid\s*=\s*(\d+)/) ?? [])[1]) || null;
    }
    if (isWindows) {
      const script =
        'Add-Type -Namespace VerifyNestor -Name Win -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint pid);\'; $p = [uint32]0; [void][VerifyNestor.Win]::GetWindowThreadProcessId([VerifyNestor.Win]::GetForegroundWindow(), [ref]$p); $p';
      return (
        Number(
          execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", windowsHide: true },
          ).trim(),
        ) || null
      );
    }
  } catch {}
  return null;
}

export function git(args) {
  try {
    return execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** What the source looks like now: commit plus a hash of uncommitted app changes. */
export function sourceFingerprint() {
  const head = git(["rev-parse", "HEAD"]);
  const diff = git(["diff", "HEAD", "--", "apps/desktop", "packages"]);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "apps/desktop/src",
    "packages",
  ]);
  const dirty =
    diff || untracked
      ? createHash("sha256")
          .update(diff)
          .update(untracked)
          .digest("hex")
          .slice(0, 12)
      : null;
  return { head, dirty };
}

export function readStamp(file = stampPath) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Load .env files the way the desktop app does (first defined value wins). */
export function loadAiEnv() {
  const { parse } = requireDesktop("dotenv");
  const loaded = {};
  const sources = [];
  for (const root of [checkout, mainCheckout])
    for (const dir of [root, path.join(root, "apps/desktop")])
      for (const name of [".env.local", ".env"]) {
        const file = path.join(dir, name);
        if (!existsSync(file)) continue;
        sources.push(file);
        for (const [key, value] of Object.entries(parse(readFileSync(file))))
          loaded[key] ??= value;
      }
  return { loaded, sources };
}

export function redact(text, env) {
  let out = String(text);
  for (const [key, value] of Object.entries(env ?? {}))
    if (/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value && value.length > 3)
      out = out.split(value).join("[redacted]");
  return out.replace(/(Bearer\s+)\S+/gi, "$1[redacted]");
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
