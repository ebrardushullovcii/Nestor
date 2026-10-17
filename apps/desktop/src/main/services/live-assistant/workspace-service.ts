import { createLiveAssistantProvidersFromEnvironment } from '@nestor/ai-providers'
import { createFileLiveAssistantRepository } from '@nestor/db'
import { createLiveAssistantService } from '@nestor/live-assistant'
import { createStaticProtectedOverlaySurfaceAdapter } from '@nestor/os-integration'
import { createElectronDesktopAudioCaptureAdapter } from './electron-audio-capture-adapter'
import { createElectronDesktopScreenshotCaptureAdapter } from './electron-screenshot-adapter'
import {
  getLiveAssistantTemporaryScreenshotDirectory,
  getLiveAssistantWorkspaceFilePath,
} from './paths'
import { areAdvancedInterviewSurfacesEnabled } from '../../setup/interview-surface-mode'

let liveAssistantServicePromise:
  | Promise<ReturnType<typeof createLiveAssistantService>>
  | undefined

export function getLiveAssistantService() {
  liveAssistantServicePromise ??= Promise.resolve(
    (() => {
      const interviewProviders = createLiveAssistantProvidersFromEnvironment()

      return createLiveAssistantService({
        advancedSurfacesEnabled: areAdvancedInterviewSurfacesEnabled(),
        repository: createFileLiveAssistantRepository({
          filePath: getLiveAssistantWorkspaceFilePath(),
        }),
        audioCaptureAdapter: createElectronDesktopAudioCaptureAdapter({
          platform: process.platform,
        }),
        screenshotCaptureAdapter: createElectronDesktopScreenshotCaptureAdapter({
          directory: getLiveAssistantTemporaryScreenshotDirectory(),
        }),
        protectedSurfaceAdapter: createStaticProtectedOverlaySurfaceAdapter({
          platform: process.platform,
        }),
        cueCardProvider: interviewProviders.cueCardProvider,
        screenshotVisionProvider: interviewProviders.screenshotVisionProvider,
        transcriptionProvider: interviewProviders.transcriptionProvider,
        summaryProvider: interviewProviders.summaryProvider,
      })
    })(),
  )

  return liveAssistantServicePromise
}

export async function shutdownLiveAssistantService() {
  const servicePromise = liveAssistantServicePromise
  liveAssistantServicePromise = undefined

  if (!servicePromise) {
    return
  }

  const service = await servicePromise
  await service.close()
}
