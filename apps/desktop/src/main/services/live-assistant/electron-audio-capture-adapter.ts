import { desktopCapturer, systemPreferences } from 'electron'
import type {
  DesktopAudioCaptureAdapter,
  DesktopAudioCaptureCapability,
  DesktopCaptureCapabilityState,
} from '@nestor/os-integration'

function microphoneStatusFromMediaAccess(
  mediaAccessStatus: ReturnType<typeof systemPreferences.getMediaAccessStatus>,
): DesktopCaptureCapabilityState {
  switch (mediaAccessStatus) {
    case 'granted':
      return 'available'
    case 'denied':
    case 'restricted':
      return 'permission_denied'
    case 'not-determined':
      return 'unknown'
    case 'unknown':
      return 'unknown'
  }
}

function meetingAudioDetail(platform: NodeJS.Platform, sourceCount: number) {
  if (sourceCount === 0) {
    return 'Electron desktopCapturer did not return screen sources for meeting/system audio capture.'
  }

  if (platform === 'win32') {
    return 'Electron desktopCapturer can enumerate screen sources; Windows meeting/system audio still needs a user-approved loopback or Chromium audio stream before live STT.'
  }

  if (platform === 'darwin') {
    return 'Electron desktopCapturer can enumerate screen sources; macOS meeting/system audio still depends on ScreenCaptureKit or an approved audio device path.'
  }

  if (platform === 'linux') {
    return 'Electron desktopCapturer can enumerate screen sources; Linux meeting/system audio still depends on PipeWire/PulseAudio monitor-source availability.'
  }

  return 'Electron desktopCapturer can enumerate screen sources; meeting/system audio stream verification is platform-specific.'
}

export function createElectronDesktopAudioCaptureAdapter(input: {
  platform: NodeJS.Platform
}): DesktopAudioCaptureAdapter {
  return {
    async checkAudioCapture(): Promise<readonly DesktopAudioCaptureCapability[]> {
      const microphoneAccessStatus = systemPreferences.getMediaAccessStatus('microphone')
      const microphoneStatus = microphoneStatusFromMediaAccess(microphoneAccessStatus)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      })
      const meetingStatus: DesktopCaptureCapabilityState =
        sources.length > 0 ? 'degraded' : 'unavailable'

      return [
        {
          source: 'microphone',
          status: microphoneStatus,
          label: 'Microphone permission',
          detail: `Electron systemPreferences reports microphone access as ${microphoneAccessStatus}.`,
        },
        {
          source: 'meeting-audio',
          status: meetingStatus,
          label: 'Meeting/system audio source',
          detail: meetingAudioDetail(input.platform, sources.length),
        },
      ]
    },
  }
}
