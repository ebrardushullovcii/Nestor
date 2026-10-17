import type { App } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function getConfiguredDesktopUserDataDirectory(
  configuredDirectory = process.env.NESTOR_USER_DATA_DIR,
): string | null {
  const requestedDirectory = configuredDirectory?.trim();
  return requestedDirectory ? path.resolve(requestedDirectory) : null;
}

export function resolveDesktopUserDataDirectory(
  app: Pick<App, "getPath">,
  configuredDirectory = process.env.NESTOR_USER_DATA_DIR,
): string {
  return (
    getConfiguredDesktopUserDataDirectory(configuredDirectory) ??
    app.getPath("userData")
  );
}

export function getDesktopStartupDiagnosticsPath(
  configuredDirectory = process.env.NESTOR_USER_DATA_DIR,
): string | null {
  const resolvedDirectory =
    getConfiguredDesktopUserDataDirectory(configuredDirectory);

  return resolvedDirectory
    ? path.join(resolvedDirectory, "startup-diagnostics.log")
    : null;
}

export function configureDesktopUserDataDirectory(
  app: Pick<App, "setPath">,
  configuredDirectory = process.env.NESTOR_USER_DATA_DIR,
): string | null {
  const resolvedDirectory =
    getConfiguredDesktopUserDataDirectory(configuredDirectory);
  if (!resolvedDirectory) {
    return null;
  }

  mkdirSync(resolvedDirectory, { recursive: true });
  app.setPath("userData", resolvedDirectory);
  return resolvedDirectory;
}
