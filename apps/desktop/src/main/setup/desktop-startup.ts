import { app } from "electron";
import { loadDesktopEnvironment } from "./env";
import { migrateLegacyDesktopUserData } from "./legacy-user-data-migration";
import {
  configureDesktopUserDataDirectory,
  getDesktopStartupDiagnosticsPath,
} from "./user-data-directory";

loadDesktopEnvironment();
// Chromium applies this to persistent sessions, including the embedded browser.
app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024));
const configuredDirectory = configureDesktopUserDataDirectory(app);
try {
  // Preserve the existing order: resolve/migrate userData before taking its lock.
  migrateLegacyDesktopUserData(app, { configuredDirectory });
} catch (error) {
  console.warn("Could not move the pre-rename user data directory.", error);
}
export const hasSingleInstanceLock = app.requestSingleInstanceLock();
export const startupDiagnosticsPath = getDesktopStartupDiagnosticsPath();
