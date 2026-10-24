import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
 * clean close left and the view format is compatible. Each saved view is used
 * once; a new main build revalidates the rows independently in the background.
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
  database: string;
  bootstrap: Uint8Array;
  snapshot: Uint8Array;
};

// Bump when the renderer's saved-view contract changes incompatibly. Main's
// validation digest is intentionally independent from this display format.
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
let savedViewAccepted = false;
let snapshotSent = false;
let windowHydrated = false;
let hydrationReady: Promise<void> | null = null;
let resolveHydration: (() => void) | null = null;
let hydrationFallback: ReturnType<typeof setTimeout> | null = null;

/** Background reads must not compete with the first full window transfer. */
export function waitForStartupWorkspaceHydration(): Promise<void> {
  if (windowHydrated) return Promise.resolve();
  hydrationReady ??= new Promise<void>((resolve) => {
    resolveHydration = resolve;
    // A closed or failed renderer must not strand background work forever.
    hydrationFallback = setTimeout(releaseStartupWorkspaceHydration, 15_000);
    hydrationFallback.unref?.();
  });
  return hydrationReady;
}

export function releaseStartupWorkspaceHydration(): void {
  windowHydrated = true;
  if (hydrationFallback) clearTimeout(hydrationFallback);
  hydrationFallback = null;
  resolveHydration?.();
  resolveHydration = null;
}

export function noteStartupWorkspaceSnapshotSent(): void {
  snapshotSent = true;
}

/** The renderer already sends this acknowledgement after applying each view. */
export function noteStartupWorkspaceRevisionHeld(): void {
  if (snapshotSent) releaseStartupWorkspaceHydration();
}

/** A valid saved view needs no canonical service before its first transfer. */
export function waitForSavedStartupWorkspace(): Promise<void> | null {
  loadStartupWorkspaceView();
  return savedViewAccepted ? waitForStartupWorkspaceHydration() : null;
}

/**
 * Notes, before anything opens the workspace database, whether it is still
 * the file a clean close left. Opening it changes that.
 */
export function captureStartupWorkspaceView(): void {
  if (process.env.NESTOR_QUERY_LISTS === "1") {
    discardStartupWorkspaceView();
    return;
  }
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
  if (process.env.NESTOR_QUERY_LISTS === "1") return false;
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
    if (stored.format === FORMAT && stored.database === startupDatabase) {
      savedViewAccepted = true;
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
  if (savedViewAccepted && !bootstrap) {
    savedViewAccepted = false;
    loaded = null;
    releaseStartupWorkspaceHydration();
  }
  return bootstrap;
}

/** The saved full view, once, for the window's first full sync. */
export function takeStartupSnapshot(): JobFinderRendererWorkspaceSnapshot | null {
  if (snapshotTaken) return null;
  snapshotTaken = true;
  const snapshot = decode(loadStartupWorkspaceView()?.snapshot);
  loaded = null;
  if (savedViewAccepted && !snapshot) {
    savedViewAccepted = false;
    releaseStartupWorkspaceHydration();
  }
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
  if (process.env.NESTOR_QUERY_LISTS === "1") {
    discardStartupWorkspaceView();
    return;
  }
  try {
    const database = readCleanCloseFingerprint(getJobFinderWorkspaceFilePath());
    if (!view || !database) {
      discardStartupWorkspaceView();
      return;
    }
    const stored: StoredStartupWorkspaceView = {
      format: FORMAT,
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
