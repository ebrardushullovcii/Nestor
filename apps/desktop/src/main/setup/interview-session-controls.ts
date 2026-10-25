import { app, Menu, Tray, dialog, globalShortcut, nativeImage } from 'electron'
import type { InterviewHotkeyAction } from '@nestor/contracts'
import { getLiveAssistantService } from '../services/live-assistant'
import { resolveBrandIconPaths } from './brand-icons'
import { syncInterviewOverlayWindows } from './interview-overlay-windows'

const hotkeyBindings: ReadonlyArray<{
  readonly accelerator: string
  readonly action: InterviewHotkeyAction
}> = [
  { accelerator: 'Alt+H', action: 'panic_hide' },
  { accelerator: 'Alt+Q', action: 'force_cue' },
  { accelerator: 'Alt+S', action: 'capture_screenshot' },
  { accelerator: 'Alt+T', action: 'toggle_transcript_overlay' },
  { accelerator: 'Alt+A', action: 'toggle_answer_overlay' },
  { accelerator: 'Alt+L', action: 'toggle_listening' },
  { accelerator: 'Alt+I', action: 'toggle_overlay_interaction_mode' },
]

let interviewTray: Tray | null = null

async function performInterviewAction(action: InterviewHotkeyAction) {
  const service = await getLiveAssistantService()
  const workspace = await service.performAction({ action })
  syncInterviewOverlayWindows(workspace)
}

async function endSessionWithConfirmation() {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['End session', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'End Live Assistant session?',
    message: 'End the active Live Assistant session?',
    detail: 'Audio and screenshot capture actions stop, overlays close, and the session moves to post-session review.',
  })

  if (result.response === 0) {
    await performInterviewAction('end_session')
  }
}

function createTrayImage() {
  const icons = resolveBrandIconPaths(app.getAppPath())
  if (!icons) return nativeImage.createEmpty()
  const isMac = process.platform === 'darwin'
  const image = nativeImage.createFromPath(
    isMac ? icons.trayTemplate : icons.trayWhite,
  )
  if (isMac) {
    image.setTemplateImage(true)
  }
  return image
}

function buildInterviewTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Pause/resume listening',
      click: () => {
        void performInterviewAction('toggle_listening')
      },
    },
    {
      label: 'Force cue',
      click: () => {
        void performInterviewAction('force_cue')
      },
    },
    {
      label: 'Capture screenshot',
      click: () => {
        void performInterviewAction('capture_screenshot')
      },
    },
    { type: 'separator' },
    {
      label: 'Show/hide answer overlay',
      click: () => {
        void performInterviewAction('toggle_answer_overlay')
      },
    },
    {
      label: 'Show/hide transcript overlay',
      click: () => {
        void performInterviewAction('toggle_transcript_overlay')
      },
    },
    {
      label: 'Panic hide',
      click: () => {
        void performInterviewAction('panic_hide')
      },
    },
    { type: 'separator' },
    {
      label: 'End session...',
      click: () => {
        void endSessionWithConfirmation()
      },
    },
  ])
}

export function initializeInterviewSessionControls() {
  for (const binding of hotkeyBindings) {
    const registered = globalShortcut.register(binding.accelerator, () => {
      void performInterviewAction(binding.action)
    })

    if (!registered) {
      console.warn(`[LiveAssistant] Failed to register global hotkey ${binding.accelerator}.`)
    }
  }

  interviewTray = new Tray(createTrayImage())
  interviewTray.setToolTip('Live Assistant')
  interviewTray.setContextMenu(buildInterviewTrayMenu())
}

export function disposeInterviewSessionControls() {
  globalShortcut.unregisterAll()

  if (interviewTray) {
    interviewTray.destroy()
    interviewTray = null
  }
}
