import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const desktopDir = path.resolve(import.meta.dirname, "../..");
export const repoRoot = path.resolve(desktopDir, "../..");
const exec = promisify(execFile);
const require = createRequire(path.join(desktopDir, "package.json"));

export function artifactName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes(".."))
    throw new Error(
      "Use a short artifact name with letters, numbers, dots, underscores or hyphens.",
    );
  return name;
}

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export async function ownedProcessIds(pid) {
  let rows;
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ]);
    const processes = JSON.parse(stdout);
    rows = (Array.isArray(processes) ? processes : [processes]).map((item) => [
      item.ProcessId,
      item.ParentProcessId,
    ]);
  } else {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid="]);
    rows = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
  }
  const owned = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of rows) {
      if (owned.has(parent) && !owned.has(child)) {
        owned.add(child);
        changed = true;
      }
    }
  }
  return [...owned];
}

export async function processConflicts({ allowedAppDirs = [] } = {}) {
  if (process.platform === "win32") return [];
  const { stdout } = await exec("ps", ["-axo", "pid=,command="]);
  return stdout
    .split("\n")
    .filter((line) => {
      const command = line.trim().replace(/^\d+\s+/, "");
      if (allowedAppDirs.some((directory) => command.includes(directory)))
        return false;
      return (
        command.includes(repoRoot) &&
        ((/electron(?:\/dist\/Electron.app\/Contents\/MacOS\/Electron|\/dist\/electron)/.test(
          command,
        ) &&
          command.includes("--inspect=0")) ||
          /(?:electron-vite|vite\/bin\/vite).*\bbuild\b/.test(command))
      );
    })
    .map((line) => line.trim());
}

export async function acquireLease(
  root = repoRoot,
  { parallelGroup, sessionId } = {},
) {
  if (sessionId !== undefined && parallelGroup === undefined)
    throw new Error("sessionId requires an explicit parallelGroup");
  sessionId ??= randomUUID();
  if (parallelGroup !== undefined) {
    artifactName(parallelGroup);
    artifactName(sessionId);
  }
  const lock = path.join(
    os.tmpdir(),
    `nestor-agent-qa-${Buffer.from(root).toString("base64url")}.lock`,
  );
  const ownerPath = path.join(lock, "owner.json");
  const guard = `${lock}.mutation`;
  async function mutate(action) {
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        await mkdir(guard);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `QA lease update timed out: ${guard}. Inspect its owner before removing it.`,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      await writeFile(
        path.join(guard, "owner.json"),
        JSON.stringify({ pid: process.pid }),
      );
      return await action();
    } finally {
      await rm(guard, { recursive: true });
    }
  }
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
    ...(parallelGroup === undefined ? {} : { sessionId, parallelGroup }),
  };
  const save = (record) =>
    writeFile(ownerPath, JSON.stringify(record, null, 2));
  const read = () => readFile(ownerPath, "utf8").then(JSON.parse);
  await mutate(async () => {
    try {
      await mkdir(lock);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const record = await read().catch(() => null);
      if (
        parallelGroup === undefined ||
        record?.mode !== "parallel" ||
        record.parallelGroup !== parallelGroup ||
        Object.hasOwn(record.sessions, sessionId)
      )
        throw new Error(
          `Another QA session holds ${lock}\n${JSON.stringify(record, null, 2)}\nDo not stop its processes. If abandoned, verify every recorded owner and Electron PID has exited before removing this lock directory. Parallel sessions require the same explicit group and distinct session IDs.`,
        );
      record.sessions[sessionId] = owner;
      await save(record);
      return;
    }
    await save(
      parallelGroup === undefined
        ? owner
        : { mode: "parallel", parallelGroup, sessions: { [sessionId]: owner } },
    );
  });
  let released = false;
  async function current() {
    if (released) throw new Error("QA lease is released");
    const record = await read();
    const entry =
      parallelGroup === undefined ? record : record.sessions?.[sessionId];
    if (entry?.token !== owner.token)
      throw new Error("QA lease owner changed; refusing to modify it");
    return record;
  }
  return {
    parallelGroup,
    sessionId: parallelGroup === undefined ? undefined : sessionId,
    async owners() {
      return mutate(async () => {
        const record = await current();
        return record.mode === "parallel"
          ? Object.values(record.sessions)
          : [record];
      });
    },
    async update(values) {
      await mutate(async () => {
        const record = await current();
        const entry =
          parallelGroup === undefined ? record : record.sessions[sessionId];
        Object.assign(entry, values);
        await save(record);
      });
    },
    async release() {
      if (released) return;
      await mutate(async () => {
        if (released) return;
        const record = await current();
        if (parallelGroup !== undefined) {
          delete record.sessions[sessionId];
          if (Object.keys(record.sessions).length) await save(record);
          else await rm(lock, { recursive: true });
        } else await rm(lock, { recursive: true });
        released = true;
      });
    },
  };
}

async function inventory(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(directory, name)));
    else {
      const info = await stat(path.join(directory, name));
      files.push({ name, size: info.size, modifiedAt: info.mtimeMs });
    }
  }
  return files;
}

export async function snapshotBuild(runDir) {
  const source = path.join(desktopDir, "out");
  await stat(path.join(source, "main/index.cjs")).catch(() => {
    throw new Error(
      "No desktop build. When other agents are not building, run pnpm --filter @nestor/desktop build once, then retry.",
    );
  });
  const before = await inventory(source);
  const appDir = path.join(runDir, "app");
  await cp(source, path.join(appDir, "out"), { recursive: true });
  await cp(
    path.join(desktopDir, "package.json"),
    path.join(appDir, "package.json"),
  );
  await symlink(
    path.join(desktopDir, "node_modules"),
    path.join(appDir, "node_modules"),
    "junction",
  );
  const after = await inventory(source);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      "Desktop output changed while copying. Wait for the other build to finish, then retry.",
    );
  const { stdout: revision } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
  });
  const { stdout: changes } = await exec("git", ["status", "--short"], {
    cwd: repoRoot,
  });
  return {
    appDir,
    source,
    copiedAt: new Date().toISOString(),
    revision: revision.trim(),
    changes: changes.trim(),
    files: before,
    note: "Existing build copied without rebuilding. Revision and dirty files describe the checkout at copy time, not proof that output includes them. Dependencies and native sidecars still come from this checkout.",
  };
}

export async function sessionEnvironment(provider, overrides = {}) {
  if (!["deterministic", "configured"].includes(provider))
    throw new Error("provider must be deterministic or configured");
  const loaded = {};
  if (provider === "configured") {
    const { parse } = require("dotenv");
    for (const dir of [repoRoot, desktopDir]) {
      for (const filename of [".env", ".env.local"]) {
        const contents = await readFile(path.join(dir, filename), "utf8").catch(
          (error) => {
            if (error.code !== "ENOENT") throw error;
            return "";
          },
        );
        // Match the desktop's first-defined-value precedence.
        for (const [key, value] of Object.entries(parse(contents)))
          loaded[key] ??= value;
      }
    }
  }
  const env = { ...loaded, ...process.env, ...overrides };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.NODE_OPTIONS;
  // Test hooks retain the legacy external host unless QA explicitly selects one.
  env.NESTOR_BROWSER_HOST ||= "embedded";
  // Test APIs otherwise force deterministic providers despite valid credentials.
  // The selected mode wins over ambient flags from another QA session.
  env.NESTOR_TEST_API_USE_LIVE_AI = provider === "configured" ? "1" : "0";
  env.NESTOR_INTERVIEW_TEST_USE_LIVE_AI = provider === "configured" ? "1" : "0";
  if (provider === "deterministic") {
    for (const key of Object.keys(env)) {
      if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) env[key] = "";
    }
    for (const key of [
      "NESTOR_AI_API_KEY",
      "NESTOR_AI_VISION_API_KEY",
      "NESTOR_INTERVIEW_AI_API_KEY",
      "NESTOR_INTERVIEW_VISION_API_KEY",
    ])
      env[key] = "";
  }
  return env;
}

export function redact(text, env = {}) {
  let result = String(text);
  for (const [key, value] of Object.entries(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value?.length > 3)
      result = result.split(value).join("[redacted]");
  }
  return result.replace(/(Bearer\s+)\S+/gi, "$1[redacted]");
}

export async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");
  if (process.platform === "win32") {
    // An exact owned root PID and its descendants, never a process-name sweep.
    await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]).catch(
      (error) => {
        if (isAlive(child.pid)) throw error;
      },
    );
  } else child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function startFixtureSites(runDir) {
  const log = path.join(runDir, "fixture-submissions.jsonl");
  const child = spawn(
    process.execPath,
    [path.join(desktopDir, "test-fixtures/job-sites/serve.mjs")],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: log,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.resume();
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Fixture startup timed out")),
        10000,
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off("error", failed);
        child.off("exit", exited);
        child.stderr.off("data", received);
        if (error) reject(error);
        else resolve(value);
      };
      const failed = (error) => finish(error);
      const exited = (code) =>
        finish(new Error(`Fixture exited (${code}): ${output}`));
      const received = (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) finish(null, match[0]);
      };
      child.once("error", failed);
      child.once("exit", exited);
      child.stderr.on("data", received);
    });
    child.stderr.resume();
    return { url, log, pid: child.pid, close: () => stopChild(child) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export async function newRunDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "nestor-agent-qa-"));
}

export function journal(runDir, env) {
  let pending = Promise.resolve();
  return {
    record(type, detail) {
      const line = JSON.stringify(
        { at: new Date().toISOString(), type, detail },
        (_key, value) =>
          typeof value === "string" ? redact(value, env) : value,
      );
      pending = pending.then(() =>
        appendFile(path.join(runDir, "events.jsonl"), `${line}\n`),
      );
      // Keep event listeners from creating unhandled rejections; flush still reports failure.
      pending.catch(() => {});
    },
    flush: () => pending,
  };
}
