import type { IpcMain } from 'electron'
import { DesktopPlatformPingSchema } from '@nestor/contracts'

export function registerSystemRouteHandlers(ipcMain: IpcMain) {
  ipcMain.handle('system:ping', () => {
    return DesktopPlatformPingSchema.parse({
      ok: true as const,
      platform: process.platform
    })
  })
}
