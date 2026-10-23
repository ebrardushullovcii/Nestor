import { BrowserWindow, Menu, type IpcMain } from "electron";
import {
  DesktopContextMenuInputSchema,
  DesktopContextMenuResultSchema,
  type DesktopContextMenuResult,
  DesktopWindowCloseGuardStateSchema,
  DesktopWindowCloseResolutionSchema,
} from "@nestor/contracts";
import { getWindowControlsState } from "../setup/window-shell";
import { getMainWindowCloseGuard } from "../setup/main-window-close-guard";

export function registerWindowRouteHandlers(ipcMain: IpcMain) {
  // A row's right-click menu, shown as the system's own menu at the pointer.
  ipcMain.handle("window:show-context-menu", (event, payload: unknown) => {
    const { items } = DesktopContextMenuInputSchema.parse(payload);
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (!targetWindow) {
      throw new Error(
        "Unable to resolve the desktop window for a context menu.",
      );
    }

    return new Promise<DesktopContextMenuResult>((resolve) => {
      let chosen: string | null = null;
      const menu = Menu.buildFromTemplate(
        items.map((item) =>
          "type" in item
            ? { type: "separator" as const }
            : {
                label: item.label,
                enabled: item.enabled ?? true,
                click: () => {
                  chosen = item.id;
                },
              },
        ),
      );
      menu.popup({
        window: targetWindow,
        // The click runs before the menu closes.
        callback: () =>
          resolve(DesktopContextMenuResultSchema.parse({ id: chosen })),
      });
    });
  });

  ipcMain.handle("window:get-controls-state", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (!targetWindow) {
      throw new Error(
        "Unable to resolve the desktop window for controls state.",
      );
    }

    return getWindowControlsState(targetWindow);
  });

  ipcMain.handle("window:minimize", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (!targetWindow) {
      throw new Error(
        "Unable to resolve the desktop window for minimize action.",
      );
    }

    targetWindow.minimize();

    return getWindowControlsState(targetWindow);
  });

  ipcMain.handle("window:toggle-maximize", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (!targetWindow) {
      throw new Error(
        "Unable to resolve the desktop window for maximize action.",
      );
    }

    if (process.platform === "darwin") {
      targetWindow.setFullScreen(!targetWindow.isFullScreen());
    } else if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
    } else {
      targetWindow.maximize();
    }

    return getWindowControlsState(targetWindow);
  });

  ipcMain.handle("window:close", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (!targetWindow) {
      throw new Error("Unable to resolve the desktop window for close action.");
    }

    targetWindow.close();

    return { ok: true as const };
  });

  // Renderer-owned dirty-state mirror for app-owned close protection. Only
  // the guarded main window may write it; schema validation fails closed.
  ipcMain.handle("window:set-close-guard-state", (event, input) => {
    const closeGuard = getMainWindowCloseGuard();

    if (!closeGuard.isOwnedBy(event.sender.id)) {
      throw new Error(
        "Only the guarded main window may report close-guard protection state.",
      );
    }

    const guardState = DesktopWindowCloseGuardStateSchema.parse(input);
    closeGuard.setRendererGuardBlocked(guardState.blocked);

    return { ok: true as const };
  });

  ipcMain.handle("window:resolve-close-request", (event, input) => {
    const closeGuard = getMainWindowCloseGuard();

    if (!closeGuard.isOwnedBy(event.sender.id)) {
      throw new Error(
        "Only the guarded main window may resolve a close request.",
      );
    }

    const resolution = DesktopWindowCloseResolutionSchema.parse(input);
    const delivered = closeGuard.deliverResolution(resolution);

    // An explicit user-approved close always proceeds, even when a racing
    // save already cleared the cached protection (deliverResolution false).
    if (resolution.decision === "proceed") {
      const targetWindow = BrowserWindow.fromWebContents(event.sender);

      if (!targetWindow) {
        throw new Error(
          "Unable to resolve the desktop window for the confirmed close.",
        );
      }

      targetWindow.close();
    } else if (!delivered) {
      throw new Error("No matching close request was pending for this window.");
    }

    return { ok: true as const };
  });
}
