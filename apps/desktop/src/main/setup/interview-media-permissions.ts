import { desktopCapturer, session, type WebContents } from 'electron'

function isTrustedInterviewMediaUrl(value: string) {
  if (value.startsWith('file://')) {
    return true
  }

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!rendererUrl) {
    return false
  }

  try {
    return new URL(value).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}

function isTrustedWebContents(webContents: WebContents | null) {
  if (!webContents || webContents.isDestroyed()) {
    return false
  }

  return isTrustedInterviewMediaUrl(webContents.getURL())
}

function isTrustedOrigin(origin: string) {
  if (origin === 'file://') {
    return true
  }

  return isTrustedInterviewMediaUrl(origin)
}

export function configureInterviewMediaPermissions() {
  const defaultSession = session.defaultSession

  defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) => {
      if (permission !== 'media') {
        return false
      }

      return (
        isTrustedWebContents(webContents) || isTrustedOrigin(requestingOrigin)
      )
    },
  )

  defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(
        (permission === 'media' || permission === 'display-capture') &&
          isTrustedWebContents(webContents),
      )
    },
  )

  defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isTrustedOrigin(request.securityOrigin)) {
      callback({})
      return
    }

    void (async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        })
        const screenSource = sources[0]

        callback({
          ...(request.videoRequested && screenSource
            ? { video: { id: screenSource.id, name: screenSource.name } }
            : {}),
          ...(request.audioRequested && process.platform === 'win32'
            ? { audio: 'loopback' as const }
            : {}),
        })
      } catch {
        callback({})
      }
    })()
  })
}
