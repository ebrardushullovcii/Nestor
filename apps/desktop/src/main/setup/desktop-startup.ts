import { app } from "electron";
import { loadDesktopEnvironment } from "./env";
import { migrateLegacyDesktopUserData } from "./legacy-user-data-migration";
import {
  configureDesktopUserDataDirectory,
  getDesktopStartupDiagnosticsPath,
} from "./user-data-directory";

loadDesktopEnvironment();
const configuredDirectory = configureDesktopUserDataDirectory(app);
try {
  // Preserve the existing order: resolve/migrate userData before taking its lock.
  migrateLegacyDesktopUserData(app, { configuredDirectory });
} catch (error) {
  console.warn("Could not move the pre-rename user data directory.", error);
}
export const hasSingleInstanceLock = app.requestSingleInstanceLock();
export const startupDiagnosticsPath = getDesktopStartupDiagnosticsPath();
