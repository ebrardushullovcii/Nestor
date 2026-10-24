import { app, Notification, type BrowserWindow } from "electron";
import { resolveBrandIconPaths } from "./brand-icons";
import {
  createFinishedWorkNotifier,
  type FinishedWorkNotifier,
} from "./finished-work-notices";

/** Asks the window to open a Job Finder screen (preload: onOpenRoute). */
export const JOB_FINDER_OPEN_ROUTE_CHANNEL = "job-finder:open-route";

/** The installer's id; Windows shows a notification under it. */
const WINDOWS_APP_USER_MODEL_ID = "com.nestor.desktop";

let mainWindow: BrowserWindow | null = null;
let notifier: FinishedWorkNotifier | null = null;

export function getRegisteredMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Called once the main window exists; notices and the taskbar use it. */
export function registerFinishedWorkWindow(window: BrowserWindow): void {
  mainWindow = window;
  if (process.platform === "win32") {
    // A development run has no Start menu shortcut under the installer's id,
    // so it shows notifications under the executable instead.
    app.setAppUserModelId(
      app.isPackaged ? WINDOWS_APP_USER_MODEL_ID : process.execPath,
    );
  }
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
}

export function getFinishedWorkNotifier(): FinishedWorkNotifier {
  notifier ??= createFinishedWorkNotifier({
    getWindow: () => {
      const window = mainWindow;
      if (!window) return null;
      return {
        isDestroyed: () => window.isDestroyed(),
        isFocused: () => window.isFocused(),
        isMinimized: () => window.isMinimized(),
        restore: () => window.restore(),
        focus: () => window.focus(),
        setProgressBar: (progress, options) =>
          window.setProgressBar(progress, options),
        openRoute: (route) => {
          if (!window.webContents.isDestroyed())
            window.webContents.send(JOB_FINDER_OPEN_ROUTE_CHANNEL, route);
        },
      };
    },
    showNotification: (notice, onClick) => {
      if (!Notification.isSupported()) return;
      const icon =
        process.platform === "darwin"
          ? undefined
          : resolveBrandIconPaths(app.getAppPath())?.appIcon;
      const notification = new Notification({
        title: notice.title,
        body: notice.body,
        silent: true,
        ...(icon ? { icon } : {}),
      });
      notification.on("click", onClick);
      notification.show();
    },
  });
  return notifier;
}
