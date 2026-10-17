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
// The owner's own checkout, where `pnpm desktop:dev` usually runs.
export const mainCheckout = path.join(os.homedir(), "Projects/Personal/Nestor");
export const workRoot =
  process.env.NESTOR_VERIFY_WORK ||
  path.join(os.homedir(), "Projects/nestor-agent-work");

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
  try {
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

/** PIDs with an open file inside our own private data folder, nothing else. */
export function holdersOf(dir) {
  if (!dir || !existsSync(dir)) return [];
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
