export type JobFinderSaveSurface = 'profile' | 'settings' | 'answers'

export type JobFinderSaveState =
  | { state: 'idle'; version: 0 }
  | {
      state: 'saving' | 'saved' | 'failed'
      version: number
      attempt: number
      surface: JobFinderSaveSurface
      label: string
      message: string
      canRetry: boolean
      savedAt?: string
      /**
       * Present only on a failed state whose exact-request retry was retired
       * because the protected surface changed after the failure. Explains why
       * the Retry action is gone and points at the surface Save action.
       */
      retryBlockedReason?: string
      /** Offered beside a saved confirmation; puts the earlier values back. */
      undo?: () => void
    }

export const initialJobFinderSaveState: JobFinderSaveState = {
  state: 'idle',
  version: 0
}

const SAVE_RECEIPT_STORAGE_KEY = 'nestor.job-finder.save-receipt.v1'

/**
 * Shown in place of the Retry action when the protected surface changed after
 * the save failed: an exact-request retry would resubmit the pre-edit payload
 * and a later refresh could then overwrite the user's newer content. The
 * guidance names the safe alternative instead of leaving a silent gap.
 */
export const JOB_FINDER_STALE_RETRY_GUIDANCE =
  'This form changed after the save failed, so Retry was removed to keep it from saving your older edits. Use Save on the form to submit your current changes.'

export type JobFinderSaveReceipt = {
  schemaVersion: 1
  dedupeKey: string
  label: string
  message: string
  savedAt: string
  surface: JobFinderSaveSurface
  version: number
}

type SaveReceiptStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

function isSaveSurface(value: unknown): value is JobFinderSaveSurface {
  return value === 'profile' || value === 'settings' || value === 'answers'
}

export function loadJobFinderSaveReceipt(storage: SaveReceiptStorage): JobFinderSaveReceipt | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SAVE_RECEIPT_STORAGE_KEY) ?? 'null')
    if (!value || typeof value !== 'object') {
      return null
    }

    const receipt = value as Record<string, unknown>
    if (
      receipt.schemaVersion !== 1 ||
      typeof receipt.dedupeKey !== 'string' ||
      typeof receipt.label !== 'string' ||
      typeof receipt.message !== 'string' ||
      typeof receipt.savedAt !== 'string' ||
      !isSaveSurface(receipt.surface) ||
      typeof receipt.version !== 'number' ||
      !Number.isInteger(receipt.version) ||
      receipt.version < 1
    ) {
      return null
    }

    return receipt as JobFinderSaveReceipt
  } catch {
    return null
  }
}

export function persistJobFinderSaveReceipt(storage: SaveReceiptStorage, receipt: JobFinderSaveReceipt | null): void {
  try {
    if (receipt) {
      storage.setItem(SAVE_RECEIPT_STORAGE_KEY, JSON.stringify(receipt))
    } else {
      storage.removeItem(SAVE_RECEIPT_STORAGE_KEY)
    }
  } catch {
    // Saving workspace data succeeded even when renderer receipt storage is unavailable.
  }
}

export function getJobFinderSaveStateFromReceipt(receipt: JobFinderSaveReceipt | null): JobFinderSaveState {
  return receipt
    ? {
        state: 'saved',
        version: receipt.version,
        attempt: 1,
        surface: receipt.surface,
        label: receipt.label,
        message: receipt.message,
        canRetry: false,
        savedAt: receipt.savedAt
      }
    : initialJobFinderSaveState
}
export type JobFinderSaveOperationFence = { isCurrent: () => boolean }

export type JobFinderSaveRequest<TResult> = {
  dedupeKey: string
  execute: (fence?: JobFinderSaveOperationFence) => Promise<TResult>
  failedMessage: (error: unknown) => string
  label: string
  savedMessage: string
  surface: JobFinderSaveSurface
  /** Shown as Undo on the saved confirmation. */
  undo?: () => void
}

export type JobFinderSaveResult<TResult> =
  | { status: 'saved'; result: TResult; superseded: boolean }
  | { status: 'failed'; error: unknown; superseded: boolean }

export type JobFinderSaveCoordinator = {
  clearReceipt: () => void
  dismissSaved: () => void
  /**
   * Record that the user revised a protected surface's draft. Any exact-request
   * retry captured for that surface becomes stale: it would resubmit the
   * pre-edit payload, so it is retired and the failed state swaps its Retry
   * action for explicit guidance to save from the form instead.
   */
  markSurfaceRevised: (surface: JobFinderSaveSurface) => void
  retry: () => Promise<JobFinderSaveResult<unknown> | null>
  run: <TResult>(request: JobFinderSaveRequest<TResult>) => Promise<JobFinderSaveResult<TResult>>
}

function hashSavePayload(value: string): string {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(36)
}

export function createSaveDedupeKey(surface: JobFinderSaveSurface, payload: unknown): string {
  return `${surface}:${hashSavePayload(JSON.stringify(payload) ?? String(payload))}`
}

export function createJobFinderSaveCoordinator(input: {
  initialReceipt?: JobFinderSaveReceipt | null
  onReceiptChange?: (receipt: JobFinderSaveReceipt | null) => void
  onStateChange: (state: JobFinderSaveState) => void
}): JobFinderSaveCoordinator {
  let version = input.initialReceipt?.version ?? 0
  let attempt = 0
  let operationToken = 0
  let latestOperationToken = 0
  let latestDedupeKey: string | null = input.initialReceipt?.dedupeKey ?? null
  // The exact request a Retry would resubmit, tagged with the revision epoch
  // of its surface at run time. A later `markSurfaceRevised` bumps the epoch,
  // so an epoch mismatch proves the draft changed after this request ran and
  // the captured payload must never be silently resubmitted.
  let retryCandidate: {
    request: JobFinderSaveRequest<unknown>
    revision: number
  } | null = null
  let currentState = getJobFinderSaveStateFromReceipt(input.initialReceipt ?? null)
  const inFlight = new Map<string, Promise<JobFinderSaveResult<unknown>>>()
  const surfaceRevisionEpochs = new Map<JobFinderSaveSurface, number>()
  const currentRevision = (surface: JobFinderSaveSurface): number =>
    surfaceRevisionEpochs.get(surface) ?? 0
  const isRetryStale = (): boolean =>
    retryCandidate !== null && retryCandidate.revision !== currentRevision(retryCandidate.request.surface)
  const emitState = (state: JobFinderSaveState) => {
    currentState = state
    input.onStateChange(state)
  }

  const run = <TResult>(request: JobFinderSaveRequest<TResult>): Promise<JobFinderSaveResult<TResult>> => {
    const existing = inFlight.get(request.dedupeKey)
    if (existing) {
      return existing as Promise<JobFinderSaveResult<TResult>>
    }

    if (request.dedupeKey !== latestDedupeKey) {
      version += 1
      attempt = 1
      latestDedupeKey = request.dedupeKey
    } else {
      attempt += 1
    }
    operationToken += 1
    latestOperationToken = operationToken
    const currentOperationToken = operationToken
    const operationVersion = version
    const operationAttempt = attempt
    retryCandidate = {
      request: request as JobFinderSaveRequest<unknown>,
      revision: currentRevision(request.surface)
    }
    emitState({
      state: 'saving',
      version: operationVersion,
      attempt: operationAttempt,
      surface: request.surface,
      label: request.label,
      message: `Saving ${request.label.toLowerCase()}…`,
      canRetry: false
    })

    const operation = request
      .execute({ isCurrent: () => currentOperationToken === latestOperationToken })
      .then((result): JobFinderSaveResult<TResult> => {
        const superseded = currentOperationToken !== latestOperationToken
        if (!superseded) {
          const savedAt = new Date().toISOString()
          retryCandidate = null
          // The persisted baseline moved to this save's content, so revision
          // history for the surface starts fresh from here.
          surfaceRevisionEpochs.delete(request.surface)
          emitState({
            state: 'saved',
            version: operationVersion,
            attempt: operationAttempt,
            surface: request.surface,
            label: request.label,
            message: request.savedMessage,
            canRetry: false,
            savedAt,
            ...(request.undo ? { undo: request.undo } : {})
          })
          input.onReceiptChange?.({
            schemaVersion: 1,
            dedupeKey: request.dedupeKey,
            label: request.label,
            message: request.savedMessage,
            savedAt,
            surface: request.surface,
            version: operationVersion
          })
        }

        return { status: 'saved', result, superseded }
      })
      .catch((error: unknown): JobFinderSaveResult<TResult> => {
        const superseded = currentOperationToken !== latestOperationToken
        if (!superseded) {
          const retryStale = isRetryStale()
          if (retryStale) {
            // Edits landed between run start and this failure; the captured
            // payload no longer matches the draft, so retire it instead of
            // offering a Retry that would save stale data.
            retryCandidate = null
          }
          emitState({
            state: 'failed',
            version: operationVersion,
            attempt: operationAttempt,
            surface: request.surface,
            label: request.label,
            message: request.failedMessage(error),
            canRetry: !retryStale,
            ...(retryStale ? { retryBlockedReason: JOB_FINDER_STALE_RETRY_GUIDANCE } : {})
          })
        }

        return { status: 'failed', error, superseded }
      })
      .finally(() => {
        if (inFlight.get(request.dedupeKey) === operation) {
          inFlight.delete(request.dedupeKey)
        }
      })

    inFlight.set(request.dedupeKey, operation as Promise<JobFinderSaveResult<unknown>>)
    return operation
  }

  return {
    clearReceipt: () => {
      operationToken += 1
      latestOperationToken = operationToken
      version = 0
      attempt = 0
      latestDedupeKey = null
      retryCandidate = null
      surfaceRevisionEpochs.clear()
      // Deliberately keeps `inFlight`: clearing it would let a duplicate
      // same-key operation start while the original still executes, so the
      // map stays authoritative until each operation removes itself on
      // settle. Late state/receipt writes from those operations stay fenced
      // by the bumped operation token above.
      input.onReceiptChange?.(null)
      emitState(initialJobFinderSaveState)
    },
    dismissSaved: () => {
      if (currentState.state !== 'saved') {
        return
      }
      retryCandidate = null
      input.onReceiptChange?.(null)
      emitState(initialJobFinderSaveState)
    },
    markSurfaceRevised: (surface: JobFinderSaveSurface) => {
      surfaceRevisionEpochs.set(surface, currentRevision(surface) + 1)
      if (
        currentState.state === 'failed' &&
        currentState.surface === surface &&
        currentState.canRetry &&
        isRetryStale()
      ) {
        // Swap the live Retry action for explicit guidance so the toast never
        // offers to resubmit a payload older than the user's draft.
        retryCandidate = null
        emitState({ ...currentState, canRetry: false, retryBlockedReason: JOB_FINDER_STALE_RETRY_GUIDANCE })
      }
    },
    retry: () => {
      if (!retryCandidate) {
        return Promise.resolve(null)
      }
      if (isRetryStale()) {
        // Defense in depth: presentation should already show the blocked
        // guidance, but a stale request must also refuse to execute here.
        const revisedSurface = retryCandidate.request.surface
        if (
          currentState.state === 'failed' &&
          currentState.canRetry &&
          currentState.surface === revisedSurface
        ) {
          retryCandidate = null
          emitState({ ...currentState, canRetry: false, retryBlockedReason: JOB_FINDER_STALE_RETRY_GUIDANCE })
        }
        return Promise.resolve(null)
      }
      return run(retryCandidate.request)
    },
    run
  }
}
