import { existsSync } from "node:fs";
import path from "node:path";

export const DESKTOP_BUILD_ARGS = Object.freeze([
  "--filter",
  "@nestor/desktop",
  "build",
]);

/**
 * Resolve the package-manager executable without asking Corepack to fetch or
 * verify a new release. When this script is run from an npm/pnpm lifecycle,
 * npm_execpath points at the already-selected cached pnpm JavaScript entry
 * point; running it through the current Node executable avoids the broken
 * pnpm.cmd/Corepack shim path on Windows. The PATH executable remains an
 * explicit fallback for direct invocation.
 */
export function resolveBuildInvocation({
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  repositoryRoot = process.cwd(),
  fileExists = existsSync,
} = {}) {
  const rawExecPath = String(environment.npm_execpath ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1");
  if (rawExecPath) {
    const candidate = path.isAbsolute(rawExecPath)
      ? rawExecPath
      : path.resolve(repositoryRoot, rawExecPath);
    const normalizedCandidate = candidate.replaceAll("\\", "/").toLowerCase();
    const looksLikePnpm =
      /(?:^|\/)pnpm(?:[./]|$)/.test(normalizedCandidate) ||
      normalizedCandidate.includes("/pnpm/");
    const isJavaScriptEntryPoint = /\.(?:c|m)?js$/i.test(candidate);
    if (looksLikePnpm && isJavaScriptEntryPoint && fileExists(candidate)) {
      return {
        command: nodeExecutable,
        args: [candidate, ...DESKTOP_BUILD_ARGS],
        source: "npm_execpath",
        executable: candidate,
      };
    }
  }
  const command = platform === "win32" ? "pnpm.cmd" : "pnpm";
  return {
    command,
    args: [...DESKTOP_BUILD_ARGS],
    source: "path-fallback",
    executable: command,
  };
}
