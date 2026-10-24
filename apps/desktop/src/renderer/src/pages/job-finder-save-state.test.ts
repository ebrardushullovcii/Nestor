import { describe, expect, it, vi } from 'vitest'
import {
  createJobFinderSaveCoordinator,
  createSaveDedupeKey,
  getJobFinderSaveStateFromReceipt,
  loadJobFinderSaveReceipt,
  persistJobFinderSaveReceipt,
  type JobFinderSaveState
} from './job-finder-save-state'

function assertFailedBlockedState(
  state: JobFinderSaveState | undefined,
): asserts state is JobFinderSaveState & {
  state: 'failed'
  canRetry: false
  retryBlockedReason: string
} {
  if (state?.state !== 'failed') {
    throw new Error('Expected failed state')
  }
  if (state.canRetry !== false) {
    throw new Error('Expected blocked retry state')
  }
  if (typeof state.retryBlockedReason !== 'string') {
    throw new Error('Expected retryBlockedReason')
  }
}

describe('Job Finder save coordinator', () => {
  it('carries a request undo onto its saved state only', async () => {
    const states: JobFinderSaveState[] = []
    const undo = vi.fn()
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })
    await coordinator.run({
      dedupeKey: 'settings:a',
      execute: () => Promise.resolve(true),
      failedMessage: () => 'Not saved.',
      label: 'AI behavior',
      savedMessage: 'AI behavior saved.',
      surface: 'settings',
      undo
    })

    expect(states.map((state) => state.state)).toEqual(['saving', 'saved'])
    expect(states[0] && 'undo' in states[0]).toBe(false)
    const saved = states[1]
    expect(saved?.state === 'saved' ? saved.undo : null).toBe(undo)
  })

  it('deduplicates rapid identical saves and versions meaningful changes', async () => {
    const states: JobFinderSaveState[] = []
    let resolveFirst: (value: string) => void = () => undefined
    const executeFirst = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve
        })
    )
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })
    const firstRequest = {
      dedupeKey: createSaveDedupeKey('settings', { mode: 'original' }),
      execute: executeFirst,
      failedMessage: () => 'Settings were not saved.',
      label: 'Settings',
      savedMessage: 'Settings saved.',
      surface: 'settings' as const
    }

    const first = coordinator.run(firstRequest)
    const duplicate = coordinator.run(firstRequest)

    expect(first).toBe(duplicate)
    expect(executeFirst).toHaveBeenCalledTimes(1)
    resolveFirst('saved')
    await first

    await coordinator.run({
      ...firstRequest,
      dedupeKey: createSaveDedupeKey('settings', { mode: 'tailored' }),
      execute: vi.fn(() => Promise.resolve('saved again'))
    })

    expect(states.map((state) => state.version)).toEqual([1, 1, 2, 2])
    expect(states.filter((state) => state.state !== 'idle').map((state) => state.attempt)).toEqual([1, 1, 1, 1])
    expect(states.at(-1)).toMatchObject({ state: 'saved', version: 2 })
  })

  it('keeps a failed save visible and retries the exact request', async () => {
    const states: JobFinderSaveState[] = []
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('saved')
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })

    await coordinator.run({
      dedupeKey: createSaveDedupeKey('profile', { name: 'Casey' }),
      execute,
      failedMessage: () => 'Profile was not saved. Check your connection and retry.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })

    expect(states.at(-1)).toMatchObject({ state: 'failed', canRetry: true, version: 1 })

    await coordinator.retry()

    expect(execute).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toMatchObject({ state: 'saved', canRetry: false, version: 1, attempt: 2 })
  })

  it('dismisses only saved feedback without resetting dedupe/version state', async () => {
    const states: JobFinderSaveState[] = []
    const receipts: unknown[] = []
    const coordinator = createJobFinderSaveCoordinator({
      onReceiptChange: (receipt) => receipts.push(receipt),
      onStateChange: (state) => states.push(state)
    })
    const request = {
      dedupeKey: createSaveDedupeKey('settings', { mode: 'original' }),
      execute: vi.fn(() => Promise.resolve('saved')),
      failedMessage: () => 'Settings were not saved.',
      label: 'Settings',
      savedMessage: 'Settings saved.',
      surface: 'settings' as const
    }

    await coordinator.run(request)
    expect(states.at(-1)).toMatchObject({ state: 'saved', version: 1 })
    coordinator.dismissSaved()
    expect(states.at(-1)).toEqual({ state: 'idle', version: 0 })
    expect(receipts.at(-1)).toBeNull()

    await coordinator.run(request)
    expect(states.at(-1)).toMatchObject({ state: 'saved', version: 1, attempt: 2 })
  })

  it('does not let a stale dismissal hide newer background save work', async () => {
    const states: JobFinderSaveState[] = []
    let finishBackgroundSave: () => void = () => undefined
    const coordinator = createJobFinderSaveCoordinator({
      onStateChange: (state) => states.push(state)
    })

    await coordinator.run({
      dedupeKey: 'settings:first',
      execute: () => Promise.resolve(),
      failedMessage: () => 'Settings were not saved.',
      label: 'Settings',
      savedMessage: 'Settings saved.',
      surface: 'settings'
    })
    const backgroundSave = coordinator.run({
      dedupeKey: 'profile:background',
      execute: () =>
        new Promise<void>((resolve) => {
          finishBackgroundSave = resolve
        }),
      failedMessage: () => 'Profile was not saved.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })

    coordinator.dismissSaved()
    expect(states.at(-1)).toMatchObject({ state: 'saving', label: 'Profile' })
    finishBackgroundSave()
    await backgroundSave
    expect(states.at(-1)).toMatchObject({ state: 'saved', label: 'Profile' })
  })

  it('does not let an older save completion obscure a newer save state', async () => {
    const states: JobFinderSaveState[] = []
    let resolveOlder: () => void = () => undefined
    let resolveNewer: () => void = () => undefined
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })

    const older = coordinator.run({
      dedupeKey: 'profile:older',
      execute: () =>
        new Promise<void>((resolve) => {
          resolveOlder = resolve
        }),
      failedMessage: () => 'Older failed.',
      label: 'Profile',
      savedMessage: 'Older saved.',
      surface: 'profile'
    })
    const newer = coordinator.run({
      dedupeKey: 'profile:newer',
      execute: () =>
        new Promise<void>((resolve) => {
          resolveNewer = resolve
        }),
      failedMessage: () => 'Newer failed.',
      label: 'Profile',
      savedMessage: 'Newer saved.',
      surface: 'profile'
    })

    resolveNewer()
    await newer
    resolveOlder()
    await older

    expect(states.at(-1)).toMatchObject({ state: 'saved', version: 2, message: 'Newer saved.' })
  })

  it('does not let an older failing completion obscure a newer successful status', async () => {
    const states: JobFinderSaveState[] = []
    let rejectOlder: (error: unknown) => void = () => undefined
    let resolveNewer: () => void = () => undefined
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })

    const older = coordinator.run({
      dedupeKey: 'profile:older-fail',
      execute: () =>
        new Promise<void>((_resolve, reject) => {
          rejectOlder = reject
        }),
      failedMessage: () => 'Older failed.',
      label: 'Profile',
      savedMessage: 'Older saved.',
      surface: 'profile'
    })
    const newer = coordinator.run({
      dedupeKey: 'settings:newer-save',
      execute: () =>
        new Promise<void>((resolve) => {
          resolveNewer = resolve
        }),
      failedMessage: () => 'Settings were not saved.',
      label: 'Settings',
      savedMessage: 'Newer saved.',
      surface: 'settings'
    })

    resolveNewer()
    const newerResult = await newer
    rejectOlder(new Error('offline'))
    const olderResult = await older

    // The newer save keeps both the visible save state and its truth: the
    // older operation's late failure is reported to its caller as failed but
    // marked superseded so it can never overwrite newer status anywhere.
    expect(states.at(-1)).toMatchObject({ state: 'saved', message: 'Newer saved.' })
    expect(olderResult.status).toBe('failed')
    expect(olderResult.superseded).toBe(true)
    expect(newerResult.status).toBe('saved')
    expect(newerResult.superseded).toBe(false)
  })

  it('retires exact-request retry when the surface is revised after a failure', async () => {
    const states: JobFinderSaveState[] = []
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline'))
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })

    await coordinator.run({
      dedupeKey: createSaveDedupeKey('profile', { name: 'Casey' }),
      execute,
      failedMessage: () => 'Profile was not saved. Check your connection and retry.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })
    expect(states.at(-1)).toMatchObject({ state: 'failed', canRetry: true })

    // The user edits the form after the failure: the captured request now
    // holds stale data, so Retry must disappear with explicit guidance and
    // refuse to resubmit the old payload.
    coordinator.markSurfaceRevised('profile')

    const blockedState = states.at(-1)
    expect(blockedState).toMatchObject({ state: 'failed', canRetry: false })
    assertFailedBlockedState(blockedState)
    expect(blockedState.retryBlockedReason).toContain('Use Save on the form')
    await expect(coordinator.retry()).resolves.toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('retires exact-request retry when the surface is revised while its save runs', async () => {
    const states: JobFinderSaveState[] = []
    let rejectSave: (error: unknown) => void = () => undefined
    const execute = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectSave = reject
        })
    )
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })
    const pending = coordinator.run({
      dedupeKey: createSaveDedupeKey('resume', { text: 'draft' }),
      execute,
      failedMessage: () => 'Resume draft was not saved.',
      label: 'Resume draft',
      savedMessage: 'Draft saved.',
      surface: 'resume'
    })

    coordinator.markSurfaceRevised('resume')
    rejectSave(new Error('offline'))
    await pending

    expect(states.at(-1)).toMatchObject({ state: 'failed', canRetry: false })
    await expect(coordinator.retry()).resolves.toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps exact-request retry working when revisions touch only other surfaces', async () => {
    const states: JobFinderSaveState[] = []
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('saved')
    const coordinator = createJobFinderSaveCoordinator({ onStateChange: (state) => states.push(state) })

    await coordinator.run({
      dedupeKey: createSaveDedupeKey('profile', { name: 'Casey' }),
      execute,
      failedMessage: () => 'Profile was not saved.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })

    // Unrelated settings drafts changed; the untouched profile payload stays
    // exactly what the user asked to save, so Retry remains available.
    coordinator.markSurfaceRevised('settings')

    expect(states.at(-1)).toMatchObject({ state: 'failed', canRetry: true })
    await coordinator.retry()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toMatchObject({ state: 'saved', attempt: 2 })
  })

  it('keeps same-key dedupe across clearReceipt while an operation stays in flight', async () => {
    const receipts: unknown[] = []
    const states: JobFinderSaveState[] = []
    let resolveSave: () => void = () => undefined
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    const coordinator = createJobFinderSaveCoordinator({
      onReceiptChange: (receipt) => receipts.push(receipt),
      onStateChange: (state) => states.push(state)
    })
    const first = coordinator.run({
      dedupeKey: 'profile:pending-reset',
      execute,
      failedMessage: () => 'Profile was not saved.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })

    coordinator.clearReceipt()

    // clearReceipt must not open the door to a duplicate same-key execution:
    // the second run joins the still-executing original instead of starting
    // a parallel save of the same payload.
    const second = coordinator.run({
      dedupeKey: 'profile:pending-reset',
      execute,
      failedMessage: () => 'Profile was not saved.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })
    expect(second).toBe(first)

    resolveSave()
    const result = await second
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'saved', result: undefined, superseded: true })
    expect(receipts).toEqual([null])
    expect(states.at(-1)).toEqual({ state: 'idle', version: 0 })

    // The settled operation released its slot, so a later save executes for real.
    await coordinator.run({
      dedupeKey: 'profile:pending-reset',
      execute: vi.fn(() => Promise.resolve(undefined)),
      failedMessage: () => 'Profile was not saved.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })
    expect(states.at(-1)).toMatchObject({ state: 'saved', version: 1 })
  })

  it('restores a privacy-safe receipt across restarts and keeps meaningful versions stable', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value)
    }
    const firstStates: JobFinderSaveState[] = []
    const dedupeKey = createSaveDedupeKey('answers', { answer: 'private response' })
    const firstCoordinator = createJobFinderSaveCoordinator({
      onReceiptChange: (receipt) => persistJobFinderSaveReceipt(storage, receipt),
      onStateChange: (state) => firstStates.push(state)
    })

    await firstCoordinator.run({
      dedupeKey,
      execute: () => Promise.resolve('saved'),
      failedMessage: () => 'Answers were not saved.',
      label: 'Saved answers',
      savedMessage: 'Answers saved.',
      surface: 'answers'
    })

    const storedValue = [...values.values()][0]
    expect(storedValue).not.toContain('private response')
    const receipt = loadJobFinderSaveReceipt(storage)
    expect(receipt).toMatchObject({ dedupeKey, surface: 'answers', version: 1 })
    expect(getJobFinderSaveStateFromReceipt(receipt)).toMatchObject({
      state: 'saved',
      message: 'Answers saved.',
      version: 1
    })

    const restartedStates: JobFinderSaveState[] = []
    const restartedCoordinator = createJobFinderSaveCoordinator({
      initialReceipt: receipt,
      onReceiptChange: (nextReceipt) => persistJobFinderSaveReceipt(storage, nextReceipt),
      onStateChange: (state) => restartedStates.push(state)
    })
    await restartedCoordinator.run({
      dedupeKey,
      execute: () => Promise.resolve('saved again'),
      failedMessage: () => 'Answers were not saved.',
      label: 'Saved answers',
      savedMessage: 'Answers saved.',
      surface: 'answers'
    })

    expect(restartedStates.at(-1)).toMatchObject({ state: 'saved', version: 1, attempt: 1 })

    restartedCoordinator.clearReceipt()
    expect(loadJobFinderSaveReceipt(storage)).toBeNull()
    expect(restartedStates.at(-1)).toEqual({ state: 'idle', version: 0 })
  })

  it('ignores corrupt receipts and unavailable storage', () => {
    const corruptStorage = {
      getItem: () => '{invalid',
      removeItem: () => undefined,
      setItem: () => undefined
    }
    const unavailableStorage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {
        throw new Error('storage unavailable')
      }
    }

    expect(loadJobFinderSaveReceipt(corruptStorage)).toBeNull()
    expect(loadJobFinderSaveReceipt(unavailableStorage)).toBeNull()
    expect(() => persistJobFinderSaveReceipt(unavailableStorage, null)).not.toThrow()
  })
  it('does not restore a receipt when a cleared pending save completes later', async () => {
    const receipts: unknown[] = []
    const states: JobFinderSaveState[] = []
    let resolveSave: () => void = () => undefined
    const coordinator = createJobFinderSaveCoordinator({
      onReceiptChange: (receipt) => receipts.push(receipt),
      onStateChange: (state) => states.push(state)
    })
    const pendingSave = coordinator.run({
      dedupeKey: 'profile:pending-reset',
      execute: () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
      failedMessage: () => 'Profile was not saved.',
      label: 'Profile',
      savedMessage: 'Profile saved.',
      surface: 'profile'
    })

    coordinator.clearReceipt()
    resolveSave()
    await pendingSave

    expect(receipts).toEqual([null])
    expect(states.at(-1)).toEqual({ state: 'idle', version: 0 })
  })
})
