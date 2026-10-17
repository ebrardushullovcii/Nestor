import { execFile, type ExecFileOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

import { JobPostingSchema, type JobPosting } from "@nestor/contracts";
import type { Page } from "playwright";
import type { AgentDiscoveryOptions } from "./runtime-types";

// These query params vary per warm page instance and do not change the reusable
// page surface we compare against for warm-session reuse.
export const DEFAULT_WARM_REUSE_REMOVABLE_QUERY_PARAMS = [
  "currentJobId",
  "selectedJobId",
  "jobId",
  "trk",
  "trackingId",
];

function execFileAsync(
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options ?? {}, (error, stdout, stderr) => {
      if (error) {
        reject(error instanceof Error ? error : new Error("execFile failed"));
        return;
      }

      resolve({
        stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
        stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
      });
    });
  });
}
const REMOTE_DEBUGGING_PORT_PATTERN =
  /(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?=\s|$)/iu;
const USER_DATA_DIR_PATTERN =
  /(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))(?=\s|$)/iu;

export interface RunningChromeDebugSession {
  debugPort: number;
  userDataDir: string;
}

function normalizeUserDataDir(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\/+$|\s+$/g, "")
    .toLowerCase();
}

function parseProcessListOutput(value: string): string[] {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return [];
  }

  if (trimmedValue.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedValue) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  return trimmedValue
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function listChromeProcessCommandLines(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Select-Object -ExpandProperty CommandLine)",
        ],
        {
          windowsHide: true,
          maxBuffer: 5 * 1024 * 1024,
          timeout: 3_000,
        },
      );

      return parseProcessListOutput(stdout);
    }

    const { stdout } = await execFileAsync("ps", ["-axww", "-o", "command="], {
      maxBuffer: 5 * 1024 * 1024,
    });

    const chromeProcessOutput = stdout
      .split("\n")
      .filter((line) =>
        /(^|\s)(chrome|chromium|google-chrome)(\s|$)/i.test(line),
      )
      .join("\n");

    return parseProcessListOutput(chromeProcessOutput);
  } catch {
    return [];
  }
}

export function parseRunningChromeDebugSession(
  commandLine: string,
): RunningChromeDebugSession | null {
  const debugPortMatch = commandLine.match(REMOTE_DEBUGGING_PORT_PATTERN);
  const userDataDirMatch = commandLine.match(USER_DATA_DIR_PATTERN);
  const debugPort = debugPortMatch?.[1] ? Number(debugPortMatch[1]) : null;
  const userDataDir =
    userDataDirMatch?.[1] ??
    userDataDirMatch?.[2] ??
    userDataDirMatch?.[3] ??
    null;

  if (
    !debugPort ||
    !Number.isInteger(debugPort) ||
    debugPort <= 0 ||
    debugPort > 65535 ||
    !userDataDir ||
    userDataDir.trim().length === 0
  ) {
    return null;
  }

  return {
    debugPort,
    userDataDir: userDataDir.trim(),
  };
}

export function findRunningChromeDebugPortInCommandLines(
  commandLines: readonly string[],
  userDataDir: string,
): number | null {
  const normalizedUserDataDir = normalizeUserDataDir(userDataDir);
  const sessions = uniqueByKey(
    commandLines.flatMap((commandLine) => {
      const session = parseRunningChromeDebugSession(commandLine);
      return session ? [session] : [];
    }),
    (session) =>
      `${normalizeUserDataDir(session.userDataDir)}:${session.debugPort}`,
  );

  const match = sessions.find(
    (session) =>
      normalizeUserDataDir(session.userDataDir) === normalizedUserDataDir,
  );

  return match?.debugPort ?? null;
}

export async function findRunningChromeDebugPortForUserDataDir(
  userDataDir: string,
): Promise<number | null> {
  const commandLines = await listChromeProcessCommandLines();
  return findRunningChromeDebugPortInCommandLines(commandLines, userDataDir);
}

export function uniqueByKey<TValue>(
  values: readonly TValue[],
  getKey: (value: TValue) => string,
): TValue[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const key = getKey(value);

    if (!key || seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [value];
  });
}

export function validateJobPostings(
  values: unknown,
  context: string,
): JobPosting[] {
  if (!Array.isArray(values)) {
    console.warn(
      `[BrowserRuntime] Expected an array of job postings from ${context}, received ${typeof values}.`,
    );
    return [];
  }

  return values.flatMap((value) => {
    const parsed = JobPostingSchema.safeParse(value);

    if (!parsed.success) {
      console.warn(
        `[BrowserRuntime] Skipping invalid job posting from ${context}:`,
        parsed.error.flatten(),
      );
      return [];
    }

    return [parsed.data];
  });
}

export async function bringPageToFrontBestEffort(
  page: Pick<Page, "bringToFront">,
  timeoutMs = 1_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      page.bringToFront().catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readDevToolsActivePort(
  userDataDir: string,
): Promise<number | null> {
  try {
    const fileContents = await readFile(
      join(userDataDir, "DevToolsActivePort"),
      "utf8",
    );
    const firstLine = fileContents.split(/\r?\n/u, 1)[0]?.trim() ?? "";

    if (!/^\d+$/u.test(firstLine)) {
      return null;
    }

    const port = Number(firstLine);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function isHttpUrlLike(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  return /^https?:\/\//iu.test(value.trim());
}

function is404LikeUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value);
    return /(^|\/)(404|not-found)(\/|$)/iu.test(parsedUrl.pathname);
  } catch {
    return false;
  }
}

export function normalizeWarmReuseUrl(
  value: string | null | undefined,
  options?: { removableQueryParams?: readonly string[] },
): string | null {
  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!normalizedValue || !isHttpUrlLike(normalizedValue)) {
    return null;
  }

  try {
    const parsedUrl = new URL(normalizedValue);
    const removableQueryParams =
      options?.removableQueryParams ??
      DEFAULT_WARM_REUSE_REMOVABLE_QUERY_PARAMS;
    for (const key of removableQueryParams) {
      parsedUrl.searchParams.delete(key);
    }
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

export function areStructurallyEquivalentHttpUrls(
  left: string | null | undefined,
  right: string | null | undefined,
  options?: { removableQueryParams?: readonly string[] },
): boolean {
  const normalizedLeft = normalizeWarmReuseUrl(left, options);
  const normalizedRight = normalizeWarmReuseUrl(right, options);

  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function hostMatchesNavigationPolicy(
  pageUrl: string,
  navigationHostnames: readonly string[],
): boolean {
  if (navigationHostnames.length === 0) {
    return true;
  }

  try {
    const parsedPageUrl = new URL(pageUrl);
    const pageHostname = parsedPageUrl.hostname.toLowerCase();

    return navigationHostnames.some((hostname) => {
      const normalizedHostname = hostname.trim().toLowerCase();
      return (
        pageHostname === normalizedHostname ||
        pageHostname.endsWith(`.${normalizedHostname}`)
      );
    });
  } catch {
    return false;
  }
}

export function isWarmPageReusable(input: {
  pageUrl: string;
  options: Pick<
    AgentDiscoveryOptions,
    "startingUrls" | "navigationHostnames" | "relevantUrlSubstrings"
  >;
}): boolean {
  const normalizedPageUrl = normalizeWarmReuseUrl(input.pageUrl);
  if (!normalizedPageUrl || is404LikeUrl(normalizedPageUrl)) {
    return false;
  }

  if (
    !hostMatchesNavigationPolicy(
      normalizedPageUrl,
      input.options.navigationHostnames,
    )
  ) {
    return false;
  }

  if (
    input.options.startingUrls.some(
      (startingUrl) => normalizeWarmReuseUrl(startingUrl) === normalizedPageUrl,
    )
  ) {
    return true;
  }

  const hasConcreteStartingQuery = input.options.startingUrls.some(
    (startingUrl) => {
      const normalizedStartingUrl = normalizeWarmReuseUrl(startingUrl);
      if (!normalizedStartingUrl) {
        return false;
      }

      try {
        return new URL(normalizedStartingUrl).searchParams.size > 0;
      } catch {
        return false;
      }
    },
  );
  if (hasConcreteStartingQuery) {
    return false;
  }

  const relevantUrlSubstrings =
    input.options.relevantUrlSubstrings
      ?.map((substring) => substring.trim().toLowerCase())
      .filter(Boolean) ?? [];

  if (relevantUrlSubstrings.length === 0) {
    return false;
  }

  const normalizedCandidate = normalizedPageUrl.toLowerCase();
  return relevantUrlSubstrings.some((substring) =>
    normalizedCandidate.includes(substring),
  );
}

export function isLikelyStalePage(
  page: Pick<Page, "url" | "isClosed">,
): boolean {
  return page.isClosed() || !isHttpUrlLike(page.url());
}

export function selectLiveHttpPage<
  TPage extends Pick<Page, "url" | "isClosed">,
>(pages: readonly TPage[]): TPage | null {
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const candidate = pages[index];
    if (candidate && !isLikelyStalePage(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function isTcpPortReachable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port,
    });
    const timeoutId = setTimeout(() => settle(false), 1_000);

    const settle = (reachable: boolean) => {
      clearTimeout(timeoutId);
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export function buildChromeExecutableCandidates(
  explicitPath?: string,
): string[] {
  const candidates = explicitPath ? [explicitPath] : [];

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";

    candidates.push(
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    );

    if (process.env.LOCALAPPDATA) {
      candidates.push(
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    );
  }

  return uniqueByKey(
    candidates.map((candidate) => candidate.trim()).filter(Boolean),
    (candidate) => candidate.toLowerCase(),
  );
}

export function buildQuerySummary(
  targetRoles: readonly string[],
  locations: readonly string[],
  siteLabel?: string,
): string {
  const roles = targetRoles.join(", ") || "all roles";
  const preferredLocations = locations.join(", ") || "all locations";
  const target = siteLabel?.trim() || "configured target";
  return `${roles} | ${preferredLocations} | ${target}`;
}
