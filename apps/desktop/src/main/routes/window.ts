import { BrowserWindow, type IpcMain } from 'electron'
import {
  DesktopWindowCloseGuardStateSchema,
  DesktopWindowCloseResolutionSchema,
} from '@nestor/contracts'
import { getWindowControlsState } from '../setup/window-shell'
import { getMainWindowCloseGuard } from '../setup/main-window-close-guard'

export function registerWindowRouteHandlers(ipcMain: IpcMain) {
  ipcMain.handle('window:get-controls-state', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)

    if (!targetWindow) {
      throw new Error('Unable to resolve the desktop window for controls state.')
    }

    return getWindowControlsState(targetWindow)
  })

  ipcMain.handle('window:minimize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)

    if (!targetWindow) {
      throw new Error('Unable to resolve the desktop window for minimize action.')
    }

    targetWindow.minimize()

    return getWindowControlsState(targetWindow)
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)

    if (!targetWindow) {
      throw new Error('Unable to resolve the desktop window for maximize action.')
    }

    if (process.platform === 'darwin') {
      targetWindow.setFullScreen(!targetWindow.isFullScreen())
    } else if (targetWindow.isMaximized()) {
      targetWindow.unmaximize()
    } else {
      targetWindow.maximize()
    }

    return getWindowControlsState(targetWindow)
  })

  ipcMain.handle('window:close', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)

    if (!targetWindow) {
      throw new Error('Unable to resolve the desktop window for close action.')
    }

    targetWindow.close()

    return { ok: true as const }
  })

  // Renderer-owned dirty-state mirror for app-owned close protection. Only
  // the guarded main window may write it; schema validation fails closed.
  ipcMain.handle('window:set-close-guard-state', (event, input) => {
    const closeGuard = getMainWindowCloseGuard()

    if (!closeGuard.isOwnedBy(event.sender.id)) {
      throw new Error(
        'Only the guarded main window may report close-guard protection state.',
      )
    }

    const guardState = DesktopWindowCloseGuardStateSchema.parse(input)
    closeGuard.setRendererGuardBlocked(guardState.blocked)

    return { ok: true as const }
  })

  ipcMain.handle('window:resolve-close-request', (event, input) => {
    const closeGuard = getMainWindowCloseGuard()

    if (!closeGuard.isOwnedBy(event.sender.id)) {
      throw new Error(
        'Only the guarded main window may resolve a close request.',
      )
    }

    const resolution = DesktopWindowCloseResolutionSchema.parse(input)
    const delivered = closeGuard.deliverResolution(resolution)

    // An explicit user-approved close always proceeds, even when a racing
    // save already cleared the cached protection (deliverResolution false).
    if (resolution.decision === 'proceed') {
      const targetWindow = BrowserWindow.fromWebContents(event.sender)

      if (!targetWindow) {
        throw new Error(
          'Unable to resolve the desktop window for the confirmed close.',
        )
      }

      targetWindow.close()
    } else if (!delivered) {
      throw new Error('No matching close request was pending for this window.')
    }

    return { ok: true as const }
  })
}
