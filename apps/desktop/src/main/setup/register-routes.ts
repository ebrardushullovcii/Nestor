import type { IpcMain } from 'electron'
import { registerApplicationDocumentRouteHandlers } from '../routes/application-documents'
import { registerCandidateAssetRouteHandlers } from '../routes/candidate-assets'
import { registerLiveAssistantRouteHandlers } from '../routes/live-assistant'
import { registerJobFinderRouteHandlers } from '../routes/job-finder'

export function registerDeferredDesktopRoutes(ipcMain: IpcMain) {
  registerCandidateAssetRouteHandlers(ipcMain)
  registerApplicationDocumentRouteHandlers(ipcMain)
  registerJobFinderRouteHandlers(ipcMain)
  registerLiveAssistantRouteHandlers(ipcMain)
}
