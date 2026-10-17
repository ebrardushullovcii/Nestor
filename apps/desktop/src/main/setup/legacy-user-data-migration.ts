import type { App } from "electron";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

/**
 * Nestor was called Nordri (ADR 0052) and before that UnEmployed, and Live
 * Assistant was called Interview Helper (ADR 0040). Electron derives the
 * default userData directory from the app name, so a rename alone would open an
 * empty workspace. This moves the newest old directory and the old entry names
 * once, before anything opens them. It never merges into a directory that
 * already holds data.
 */
const LEGACY_APP_NAMES: Readonly<Record<string, readonly string[]>> = {
  // Development builds take their name from apps/desktop/package.json.
  "@nestor/desktop": ["@nordri/desktop", "@unemployed/desktop"],
  // Packaged builds take it from electron-builder's productName.
  Nestor: ["Nordri", "UnEmployed"],
};

// Earlier names first: an entry moves only while its new name is still free.
const LEGACY_ENTRY_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["interview-helper-workspace.json", "live-assistant-workspace.json"],
  ["interview-helper-screenshots", "live-assistant-screenshots"],
  // The embedded browser's sign-ins live in its persistent partition.
  [path.join("Partitions", "nordri-browser"), path.join("Partitions", "nestor-browser")],
  [path.join("Partitions", "unemployed-browser"), path.join("Partitions", "nestor-browser")],
];

export type LegacyUserDataMigrationResult = {
  movedDirectory: { from: string; to: string } | null;
  renamedEntries: string[];
  skippedReason: "target-has-data" | null;
};

function isEmptyDirectory(directory: string): boolean {
  return statSync(directory).isDirectory() && readdirSync(directory).length === 0;
}

export function migrateLegacyDesktopUserData(
  app: Pick<App, "getName" | "getPath">,
  options: { configuredDirectory: string | null },
): LegacyUserDataMigrationResult {
  const result: LegacyUserDataMigrationResult = {
    movedDirectory: null,
    renamedEntries: [],
    skippedReason: null,
  };
  const target = app.getPath("userData");
  // Any overridden directory (NESTOR_USER_DATA_DIR, a --user-data-dir switch)
  // is an isolated session for tests or QA. It must never adopt the person's
  // real workspace, so only the name-derived default location migrates.
  const appData = app.getPath("appData");
  const usesDefaultLocation =
    !options.configuredDirectory &&
    path.resolve(target) === path.resolve(appData, app.getName());
  const legacy = (LEGACY_APP_NAMES[app.getName()] ?? [])
    .map((name) => path.join(appData, name))
    .find((directory) => directory !== target && existsSync(directory));
  if (usesDefaultLocation && legacy) {
    if (!existsSync(target) || isEmptyDirectory(target)) {
      if (existsSync(target)) rmdirSync(target);
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(legacy, target);
      result.movedDirectory = { from: legacy, to: target };
      // Drop the now-empty old scope folder (e.g. "@nordri") in development.
      const legacyParent = path.dirname(legacy);
      if (legacyParent !== appData && isEmptyDirectory(legacyParent)) {
        rmdirSync(legacyParent);
      }
    } else {
      result.skippedReason = "target-has-data";
    }
  }

  if (existsSync(target)) {
    for (const [legacyEntry, entry] of LEGACY_ENTRY_NAMES) {
      const from = path.join(target, legacyEntry);
      const to = path.join(target, entry);
      if (existsSync(from) && !existsSync(to)) {
        renameSync(from, to);
        result.renamedEntries.push(entry);
      }
    }
  }

  return result;
}
