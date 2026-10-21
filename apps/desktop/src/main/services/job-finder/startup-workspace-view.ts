import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { deserialize, serialize } from "node:v8";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { readCleanCloseFingerprint } from "@nestor/db";
import {
  getJobFinderUserDataDirectory,
  getJobFinderWorkspaceFilePath,
} from "./paths";

/**
 * What the window showed when the app last closed cleanly: the opening
 * bootstrap and the full workspace view, saved at quit. On the next start the
 * window gets them at once instead of waiting seconds for every job to load;
 * the real workspace replaces them a moment later through the ordinary delta
 * sync. They are used only when the database is byte-for-byte the file that
 * clean close left and the main-process build is the one that wrote them, so
 * the view cannot describe different data. Each saved view is used once.
 */
export type StartupWorkspaceView = {
  bootstrap: JobFinderRendererWorkspaceSnapshot;
  snapshot: JobFinderRendererWorkspaceSnapshot;
};

/**
 * The two views are serialized separately, so the small bootstrap is read
 * without decoding the full view (about 30 MB with a large search history).
 */
type StoredStartupWorkspaceView = {
  format: number;
  build: { stamp: string; contents: string };
  database: string;
  bootstrap: Uint8Array;
  snapshot: Uint8Array;
};

const FORMAT = 3;

function viewPath(): string {
  return path.join(
    getJobFinderUserDataDirectory(),
    "job-finder-startup-view.bin",
  );
}

function bundleFiles(): string[] {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".cjs") || name.endsWith(".js"))
    .sort()
    .map((name) => path.join(directory, name));
}

/** The main-process build by its files' names, sizes and times: instant. */
function buildStamp(): string {
  const hash = createHash("sha1");
  for (const file of bundleFiles()) {
    const { size, mtimeMs } = statSync(file);
    hash.update(`${path.basename(file)}:${size}:${mtimeMs}\n`);
  }
  return hash.digest("hex");
}

/**
 * The build by its files' contents. `pnpm desktop:dev` rewrites unchanged
 * files on every start, so their times change while the build does not.
 * Opening the bundle costs about 0.3 s on Windows, so only then.
 */
function buildContents(): string {
  const hash = createHash("sha1");
  for (const file of bundleFiles()) {
    hash.update(`${path.basename(file)}\n`);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

let buildDigest: Promise<string | null> | null = null;

/**
 * The build by its files' contents, read off the main thread. Null when the
 * bundle cannot be found (tests run from sources).
 */
export function mainBuildDigest(): Promise<string | null> {
  buildDigest ??= (async () => {
    try {
      const files = bundleFiles();
      if (files.length === 0) return null;
      const hash = createHash("sha1");
      for (const file of files) {
        hash.update(`${path.basename(file)}\n`);
        hash.update(await readFile(file));
      }
      return hash.digest("hex");
    } catch {
      return null;
    }
  })();
  return buildDigest;
}

let startupDatabase: string | null = null;
let loaded:
  | { bootstrap: Uint8Array | null; snapshot: Uint8Array | null }
  | null
  | undefined;
let bootstrapTaken = false;
let snapshotTaken = false;

/**
 * Notes, before anything opens the workspace database, whether it is still
 * the file a clean close left. Opening it changes that.
 */
export function captureStartupWorkspaceView(): void {
  try {
    startupDatabase = readCleanCloseFingerprint(
      getJobFinderWorkspaceFilePath(),
    );
  } catch {
    startupDatabase = null;
  }
  if (!startupDatabase) discardStartupWorkspaceView();
}

/** Whether this start may open on a saved view (checked again when read). */
export function hasStartupWorkspaceView(): boolean {
  return startupDatabase !== null && existsSync(viewPath());
}

function loadStartupWorkspaceView() {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (!startupDatabase) return null;
  try {
    const stored = deserialize(
      readFileSync(viewPath()),
    ) as StoredStartupWorkspaceView;
    if (
      stored.format === FORMAT &&
      stored.database === startupDatabase &&
      (stored.build.stamp === buildStamp() ||
        stored.build.contents === buildContents())
    ) {
      loaded = { bootstrap: stored.bootstrap, snapshot: stored.snapshot };
    }
  } catch {
    loaded = null;
  }
  discardStartupWorkspaceView();
  return loaded;
}

function decode(bytes: Uint8Array | null | undefined) {
  if (!bytes) return null;
  try {
    return deserialize(bytes) as JobFinderRendererWorkspaceSnapshot;
  } catch {
    return null;
  }
}

/** The saved opening bootstrap, once. */
export function takeStartupBootstrap(): JobFinderRendererWorkspaceSnapshot | null {
  if (bootstrapTaken) return null;
  bootstrapTaken = true;
  const view = loadStartupWorkspaceView();
  const bootstrap = decode(view?.bootstrap);
  if (view) view.bootstrap = null;
  return bootstrap;
}

/** The saved full view, once, for the window's first full sync. */
export function takeStartupSnapshot(): JobFinderRendererWorkspaceSnapshot | null {
  if (snapshotTaken) return null;
  snapshotTaken = true;
  const snapshot = decode(loadStartupWorkspaceView()?.snapshot);
  loaded = null;
  return snapshot;
}

export function discardStartupWorkspaceView(): void {
  rmSync(viewPath(), { force: true });
}

/**
 * Saves the view after the workspace database closed cleanly. Without a clean
 * close there is nothing it could safely describe, so any old view goes.
 */
export function writeStartupWorkspaceView(
  view: StartupWorkspaceView | null,
): void {
  try {
    const database = readCleanCloseFingerprint(getJobFinderWorkspaceFilePath());
    if (!view || !database) {
      discardStartupWorkspaceView();
      return;
    }
    const stored: StoredStartupWorkspaceView = {
      format: FORMAT,
      build: { stamp: buildStamp(), contents: buildContents() },
      database,
      bootstrap: serialize(view.bootstrap),
      snapshot: serialize(view.snapshot),
    };
    const file = viewPath();
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, serialize(stored));
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    console.warn("[Job Finder] Could not save the startup view.", error);
    try {
      discardStartupWorkspaceView();
    } catch {
      // The next start checks the view's database fingerprint anyway.
    }
  }
}
