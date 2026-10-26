import { app } from "electron";
import { loadDesktopEnvironment } from "./env";
import {
  configureDesktopUserDataDirectory,
  getDesktopStartupDiagnosticsPath,
} from "./user-data-directory";

loadDesktopEnvironment();
// Chromium applies this to persistent sessions, including the embedded browser.
app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024));
// userData is settled before its lock is taken.
configureDesktopUserDataDirectory(app);
export const hasSingleInstanceLock = app.requestSingleInstanceLock();
export const startupDiagnosticsPath = getDesktopStartupDiagnosticsPath();
