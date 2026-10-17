import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { CookiesSetDetails } from "electron";
import type {
  DesktopBrowserImportBrowser,
  DesktopBrowserImportInput,
  DesktopBrowserImportResult,
  DesktopBrowserImportSource,
  DesktopBrowserImportSources,
} from "@nestor/contracts";
import type { EmbeddedBrowser } from "./embedded-browser";

/**
 * Brings sign-ins over from a browser profile already on this device, the
 * way browsers import from each other. The user picks the browser and
 * profile; cookie values are read, decrypted and written only in main, and
 * never logged or sent to the renderer. Passwords, bookmarks, history and
 * partitioned cookies are not imported (ADR 0017).
 */
const execFileAsync = promisify(execFile);

interface BrowserFamily {
  browser: DesktopBrowserImportBrowser;
  label: string;
  /** Chromium user-data roots or the Firefox root, relative per platform. */
  roots: Partial<Record<NodeJS.Platform, string[]>>;
  /** macOS Keychain service holding the Chromium safe-storage password. */
  keychainService?: string;
}

const CHROMIUM_FAMILIES: readonly BrowserFamily[] = [
  {
    browser: "chrome",
    label: "Google Chrome",
    keychainService: "Chrome Safe Storage",
    roots: {
      darwin: ["Library/Application Support/Google/Chrome"],
      win32: ["Google/Chrome/User Data"],
      linux: [".config/google-chrome"],
    },
  },
  {
    browser: "arc",
    label: "Arc",
    keychainService: "Arc Safe Storage",
    roots: { darwin: ["Library/Application Support/Arc/User Data"] },
  },
  {
    browser: "brave",
    label: "Brave",
    keychainService: "Brave Safe Storage",
    roots: {
      darwin: ["Library/Application Support/BraveSoftware/Brave-Browser"],
      win32: ["BraveSoftware/Brave-Browser/User Data"],
      linux: [".config/BraveSoftware/Brave-Browser"],
    },
  },
  {
    browser: "edge",
    label: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    roots: {
      darwin: ["Library/Application Support/Microsoft Edge"],
      win32: ["Microsoft/Edge/User Data"],
      linux: [".config/microsoft-edge"],
    },
  },
  {
    browser: "chromium",
    label: "Chromium",
    keychainService: "Chromium Safe Storage",
    roots: {
      darwin: ["Library/Application Support/Chromium"],
      win32: ["Chromium/User Data"],
      linux: [".config/chromium"],
    },
  },
];

const FIREFOX_FAMILY: BrowserFamily = {
  browser: "firefox",
  label: "Firefox",
  roots: {
    darwin: ["Library/Application Support/Firefox"],
    win32: ["Mozilla/Firefox"],
    linux: [".mozilla/firefox"],
  },
};

export interface ImportEnvironment {
  platform: NodeJS.Platform;
  home: string;
  localAppData?: string | undefined;
  appData?: string | undefined;
}

function defaultImportEnvironment(): ImportEnvironment {
  return {
    platform: process.platform,
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    appData: process.env.APPDATA,
  };
}

interface Profile {
  directory: string;
  label: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function familyRoots(family: BrowserFamily, env: ImportEnvironment): string[] {
  const base =
    env.platform === "win32"
      ? family.browser === "firefox"
        ? env.appData
        : env.localAppData
      : env.home;
  if (!base) return [];
  return (family.roots[env.platform] ?? []).map((root) =>
    path.join(base, root),
  );
}

function chromiumSupport(env: ImportEnvironment): {
  supported: boolean;
  note: string | null;
} {
  if (env.platform === "darwin")
    return {
      supported: true,
      note: "macOS asks once for Keychain access to read the saved sign-ins.",
    };
  if (env.platform === "linux") return { supported: true, note: null };
  return {
    supported: false,
    note: "This browser protects its sign-ins on Windows so other apps cannot read them. Sign in here directly instead.",
  };
}

async function chromiumCookiesPath(
  profileDirectory: string,
): Promise<string | null> {
  for (const candidate of ["Network/Cookies", "Cookies"]) {
    const full = path.join(profileDirectory, candidate);
    if (await exists(full)) return full;
  }
  return null;
}

async function chromiumProfiles(root: string): Promise<Profile[]> {
  const names = new Map<string, string>();
  try {
    const localState = JSON.parse(
      await readFile(path.join(root, "Local State"), "utf8"),
    ) as { profile?: { info_cache?: Record<string, { name?: unknown }> } };
    for (const [directory, info] of Object.entries(
      localState.profile?.info_cache ?? {},
    ))
      names.set(
        directory,
        typeof info?.name === "string" && info.name.trim()
          ? info.name.trim()
          : directory,
      );
  } catch {
    /* Without Local State the folder names stand in for profile names. */
  }
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const profiles: Profile[] = [];
  for (const entry of entries) {
    if (
      entry !== "Default" &&
      !/^Profile \d+$/.test(entry) &&
      !names.has(entry)
    )
      continue;
    const directory = path.join(root, entry);
    if (!(await chromiumCookiesPath(directory))) continue;
    profiles.push({ directory, label: names.get(entry) ?? entry });
  }
  return profiles;
}

async function firefoxProfiles(root: string): Promise<Profile[]> {
  const profiles: Profile[] = [];
  try {
    const ini = await readFile(path.join(root, "profiles.ini"), "utf8");
    let name = "";
    let relative = true;
    let target = "";
    const flush = async () => {
      if (!target) return;
      const directory = relative ? path.join(root, target) : target;
      if (await exists(path.join(directory, "cookies.sqlite")))
        profiles.push({ directory, label: name || path.basename(directory) });
    };
    for (const line of ini.split(/\r?\n/)) {
      if (line.startsWith("[")) {
        await flush();
        name = "";
        relative = true;
        target = "";
      } else if (line.startsWith("Name=")) name = line.slice(5).trim();
      else if (line.startsWith("IsRelative="))
        relative = line.slice(11).trim() !== "0";
      else if (line.startsWith("Path=")) target = line.slice(5).trim();
    }
    await flush();
  } catch {
    /* No profiles.ini: scan the Profiles folder instead. */
  }
  if (profiles.length) return profiles;
  try {
    for (const entry of await readdir(path.join(root, "Profiles"))) {
      const directory = path.join(root, "Profiles", entry);
      if (await exists(path.join(directory, "cookies.sqlite")))
        profiles.push({ directory, label: entry.replace(/^[^.]+\./, "") });
    }
  } catch {
    /* No Firefox profiles. */
  }
  return profiles;
}

interface ResolvedSource extends DesktopBrowserImportSource {
  cookiesPath: string;
  family: BrowserFamily;
}

const encodeId = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");

async function resolveSources(
  env: ImportEnvironment,
): Promise<ResolvedSource[]> {
  const sources: ResolvedSource[] = [];
  for (const family of CHROMIUM_FAMILIES) {
    const support = chromiumSupport(env);
    for (const root of familyRoots(family, env)) {
      for (const profile of await chromiumProfiles(root)) {
        const cookiesPath = await chromiumCookiesPath(profile.directory);
        if (!cookiesPath) continue;
        sources.push({
          id: encodeId(`${family.browser}:${profile.directory}`),
          browser: family.browser,
          browserLabel: family.label,
          profileLabel: profile.label,
          supported: support.supported,
          note: support.note,
          cookiesPath,
          family,
        });
      }
    }
  }
  for (const root of familyRoots(FIREFOX_FAMILY, env)) {
    for (const profile of await firefoxProfiles(root)) {
      sources.push({
        id: encodeId(`firefox:${profile.directory}`),
        browser: "firefox",
        browserLabel: FIREFOX_FAMILY.label,
        profileLabel: profile.label,
        supported: true,
        note: null,
        cookiesPath: path.join(profile.directory, "cookies.sqlite"),
        family: FIREFOX_FAMILY,
      });
    }
  }
  return sources;
}

export async function listBrowserImportSources(
  env: ImportEnvironment = defaultImportEnvironment(),
): Promise<DesktopBrowserImportSources> {
  const sources = (await resolveSources(env)).map(
    ({ cookiesPath, family, ...source }) => {
      void cookiesPath;
      void family;
      return source;
    },
  );
  return {
    sources,
    note: sources.length
      ? null
      : "No browser profiles with saved sign-ins were found on this device.",
  };
}

/** Chromium stores expiry as microseconds since 1601-01-01. */
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const CHROMIUM_SALT = "saltysalt";
const CHROMIUM_IV = Buffer.alloc(16, 0x20);

export function deriveChromiumKey(
  password: string,
  iterations: number,
): Buffer {
  return pbkdf2Sync(password, CHROMIUM_SALT, iterations, 16, "sha1");
}

async function chromiumKey(
  family: BrowserFamily,
  env: ImportEnvironment,
): Promise<Buffer> {
  if (env.platform === "linux") return deriveChromiumKey("peanuts", 1);
  if (env.platform !== "darwin" || !family.keychainService)
    throw new Error("unsupported");
  // The Keychain prompt is the user's consent; the password never leaves main.
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", family.keychainService],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const password = stdout.replace(/\r?\n$/, "");
  if (!password) throw new Error("keychain");
  return deriveChromiumKey(password, 1003);
}

/**
 * Decrypts one Chromium cookie value. Schema 24 and later prefix the plain
 * value with a SHA-256 of the host key; that prefix is verified and removed.
 */
export function decryptChromiumCookieValue(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string,
  schemaVersion: number,
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  const prefix = buffer.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return null;
  if (prefix === "v11" && process.platform === "linux") return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
    plain = Buffer.concat([
      decipher.update(buffer.subarray(3)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
  if (schemaVersion >= 24) {
    if (plain.length < 32) return null;
    const digest = createHash("sha256").update(hostKey, "utf8").digest();
    if (!digest.equals(plain.subarray(0, 32))) return null;
    plain = plain.subarray(32);
  }
  return plain.toString("utf8");
}

interface ChromiumCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  has_expires: number;
  top_frame_site_key?: string | null;
}

/**
 * Chromium and Firefox both store 2 = Strict, 1 = Lax and 0 = None. Chromium
 * refuses SameSite=None on an insecure cookie, so that case is left unset.
 */
function sameSiteFor(
  value: number,
  secure: boolean,
): NonNullable<CookiesSetDetails["sameSite"]> {
  if (value === 2) return "strict";
  if (value === 1) return "lax";
  if (value === 0 && secure) return "no_restriction";
  return "unspecified";
}

function cookieUrl(hostKey: string, cookiePath: string, secure: boolean) {
  const hostname = hostKey.replace(/^\./, "");
  if (
    !/^[a-zA-Z0-9.-]+$/.test(hostname) ||
    hostname.includes("..") ||
    hostname.endsWith(".")
  )
    return null;
  const url = new URL(
    `${secure ? "https" : "http"}://${hostname}${cookiePath}`,
  );
  return url.hostname === hostname.toLowerCase() ? url.href : null;
}

export function chromiumCookieToDetails(
  row: ChromiumCookieRow,
  value: string,
  now = Date.now() / 1000,
): CookiesSetDetails | null {
  if (row.top_frame_site_key) return null;
  const secure = row.is_secure === 1;
  const url = cookieUrl(row.host_key, row.path || "/", secure);
  if (!url) return null;
  const expires =
    row.has_expires === 1 && row.expires_utc > 0
      ? row.expires_utc / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS
      : null;
  if (expires !== null && expires <= now) return null;
  return {
    url,
    name: row.name,
    value,
    path: row.path || "/",
    ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
    secure,
    httpOnly: row.is_httponly === 1,
    ...(expires !== null ? { expirationDate: expires } : {}),
    sameSite: sameSiteFor(row.samesite, secure),
  };
}

interface FirefoxCookieRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number;
  originAttributes?: string | null;
}

export function firefoxCookieToDetails(
  row: FirefoxCookieRow,
  now = Date.now() / 1000,
): CookiesSetDetails | null {
  if (row.originAttributes && row.originAttributes.includes("partitionKey"))
    return null;
  const secure = row.isSecure === 1;
  const url = cookieUrl(row.host, row.path || "/", secure);
  if (!url) return null;
  if (row.expiry > 0 && row.expiry <= now) return null;
  return {
    url,
    name: row.name,
    value: row.value,
    path: row.path || "/",
    ...(row.host.startsWith(".") ? { domain: row.host } : {}),
    secure,
    httpOnly: row.isHttpOnly === 1,
    ...(row.expiry > 0 ? { expirationDate: row.expiry } : {}),
    sameSite: sameSiteFor(row.sameSite, secure),
  };
}

async function snapshotDatabase(source: string): Promise<{
  path: string;
  dispose: () => Promise<void>;
}> {
  // The browser may hold the live file open; a private copy is read instead.
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-import-"));
  const target = path.join(directory, "cookies.sqlite");
  await copyFile(source, target);
  for (const suffix of ["-wal", "-journal"]) {
    try {
      await copyFile(`${source}${suffix}`, `${target}${suffix}`);
    } catch {
      /* No write-ahead log to carry over. */
    }
  }
  return {
    path: target,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

/** BigInt columns become numbers; precision loss only affects far-future expiry. */
function numericRow(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row))
    output[key] = typeof value === "bigint" ? Number(value) : value;
  return output;
}

export function readChromiumCookies(
  file: string,
  key: Buffer,
): CookiesSetDetails[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = db
      .prepare("SELECT value FROM meta WHERE key = 'version'")
      .get() as { value?: unknown } | undefined;
    const schemaVersion = Number(meta?.value ?? 0);
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]
      ).map((column) => column.name),
    );
    const partitionColumn = columns.has("top_frame_site_key")
      ? "top_frame_site_key"
      : "NULL AS top_frame_site_key";
    // Chromium expiry stamps exceed 2^53, so integers are read as BigInt.
    const statement = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires, ${partitionColumn} FROM cookies`,
    );
    statement.setReadBigInts(true);
    const rows = statement
      .all()
      .map(numericRow) as unknown as ChromiumCookieRow[];
    const cookies: CookiesSetDetails[] = [];
    for (const row of rows) {
      const value =
        row.encrypted_value && row.encrypted_value.length > 0
          ? decryptChromiumCookieValue(
              row.encrypted_value,
              key,
              row.host_key,
              schemaVersion,
            )
          : row.value;
      if (value === null) continue;
      const details = chromiumCookieToDetails(row, value);
      if (details) cookies.push(details);
    }
    return cookies;
  } finally {
    db.close();
  }
}

export function readFirefoxCookies(file: string): CookiesSetDetails[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const statement = db.prepare(
      "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies",
    );
    statement.setReadBigInts(true);
    const rows = statement
      .all()
      .map(numericRow) as unknown as FirefoxCookieRow[];
    return rows.flatMap((row) => firefoxCookieToDetails(row) ?? []);
  } finally {
    db.close();
  }
}

/**
 * Reads the chosen profile's cookies and writes them into the embedded
 * browser session. Cookie values never leave main and are never logged.
 */
export async function importSignInsFromBrowser(
  host: EmbeddedBrowser,
  input: DesktopBrowserImportInput,
  env: ImportEnvironment = defaultImportEnvironment(),
): Promise<DesktopBrowserImportResult> {
  const result = (
    status: DesktopBrowserImportResult["status"],
    message: string,
    cookieCount = 0,
    siteCount = 0,
  ): DesktopBrowserImportResult => ({
    status,
    message,
    cookieCount,
    siteCount,
  });
  const source = (await resolveSources(env)).find(
    (candidate) => candidate.id === input.sourceId,
  );
  if (!source)
    return result(
      "failed",
      "That browser profile is no longer available. Pick another one.",
    );
  if (!source.supported)
    return result(
      "unsupported",
      source.note ??
        "Sign-ins from this browser cannot be read on this device.",
    );
  await host.takeControl();
  let cookies: CookiesSetDetails[];
  const snapshot = await snapshotDatabase(source.cookiesPath).catch(() => null);
  if (!snapshot)
    return result(
      "failed",
      `${source.browserLabel} did not let its saved sign-ins be read. Close it and try again.`,
    );
  try {
    if (source.family.browser === "firefox")
      cookies = readFirefoxCookies(snapshot.path);
    else {
      let key: Buffer;
      try {
        key = await chromiumKey(source.family, env);
      } catch {
        return result(
          "cancelled",
          `Keychain access was not granted, so nothing was imported from ${source.browserLabel}.`,
        );
      }
      cookies = readChromiumCookies(snapshot.path, key);
    }
  } catch {
    return result(
      "failed",
      `The saved sign-ins in ${source.browserLabel} could not be read. Close it and try again.`,
    );
  } finally {
    await snapshot.dispose().catch(() => undefined);
  }
  if (!cookies.length)
    return result(
      "unsupported",
      `${source.browserLabel} has no current sign-ins to bring over.`,
    );
  let imported = 0;
  const sites = new Set<string>();
  const cookieStore = host.getSession().cookies;
  for (const cookie of cookies) {
    try {
      await cookieStore.set(cookie);
      imported++;
      sites.add(new URL(cookie.url).hostname.replace(/^www\./, ""));
    } catch {
      /* Do not log cookie material, including values embedded in exceptions. */
    }
  }
  await cookieStore.flushStore();
  return result(
    imported ? "imported" : "failed",
    imported
      ? `Brought over sign-ins for ${sites.size} ${sites.size === 1 ? "site" : "sites"} from ${source.browserLabel}. Some sites may still ask you to sign in again.`
      : `Nothing could be imported from ${source.browserLabel}.`,
    imported,
    sites.size,
  );
}
