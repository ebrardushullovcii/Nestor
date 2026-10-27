import type { IpcMain } from "electron";
import { availableParallelism, totalmem } from "node:os";
import { DesktopPlatformPingSchema } from "@nestor/contracts";

export function registerSystemRouteHandlers(ipcMain: IpcMain) {
  ipcMain.handle("system:ping", () => {
    return DesktopPlatformPingSchema.parse({
      ok: true as const,
      platform: process.platform,
      memoryGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
      cores: availableParallelism(),
    });
  });
}
