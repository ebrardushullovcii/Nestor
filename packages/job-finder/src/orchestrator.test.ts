import { describe, expect, test } from 'vitest'
import { runSequentialArtifactOrchestrator } from './orchestrator'

describe('runSequentialArtifactOrchestrator', () => {
  test('runs phases sequentially and stops when a phase requests it', async () => {
    const trace: string[] = []
    const phases = ['phase_a', 'phase_b', 'phase_c'] as const

    const artifacts = await runSequentialArtifactOrchestrator<(typeof phases)[number], string>({
      phases,
      beforePhase: (phase) => {
        trace.push(`before:${phase}`)
      },
      executePhase: (phase) => {
        trace.push(`execute:${phase}`)

        return Promise.resolve({
          artifact: `artifact:${phase}`,
          stop: phase === 'phase_b'
        })
      },
      afterPhase: (phase, _index, artifact) => {
        trace.push(['after', phase, artifact ?? 'none'].join(':'))
      }
    })

    expect(artifacts).toEqual(['artifact:phase_a', 'artifact:phase_b'])
    expect(trace).toEqual([
      'before:phase_a',
      'execute:phase_a',
      'after:phase_a:artifact:phase_a',
      'before:phase_b',
      'execute:phase_b',
      'after:phase_b:artifact:phase_b'
    ])
  })

  test('completes all phases and collects every artifact when stop is never requested', async () => {
    const trace: string[] = []
    const phases = ['phase_a', 'phase_b', 'phase_c'] as const

    const artifacts = await runSequentialArtifactOrchestrator<(typeof phases)[number], string>({
      phases,
      beforePhase: (phase) => {
        trace.push(`before:${phase}`)
      },
      executePhase: (phase) => {
        trace.push(`execute:${phase}`)
        return Promise.resolve({ artifact: `artifact:${phase}` })
      },
      afterPhase: (phase, _index, artifact) => {
        trace.push(['after', phase, artifact ?? 'none'].join(':'))
      }
    })

    expect(artifacts).toEqual(['artifact:phase_a', 'artifact:phase_b', 'artifact:phase_c'])
    expect(trace).toEqual([
      'before:phase_a',
      'execute:phase_a',
      'after:phase_a:artifact:phase_a',
      'before:phase_b',
      'execute:phase_b',
      'after:phase_b:artifact:phase_b',
      'before:phase_c',
      'execute:phase_c',
      'after:phase_c:artifact:phase_c'
    ])
  })

  test('handles empty phases and skips null or undefined artifacts', async () => {
    // empty phases should return empty and not invoke hooks
    const emptyBefore: string[] = []
    const emptyAfter: string[] = []
    const emptyResult = await runSequentialArtifactOrchestrator<string, string>({
      phases: [],
      beforePhase: (phase) => {
        emptyBefore.push(phase)
      },
      executePhase: () => Promise.resolve({ artifact: 'should-not-run' }),
      afterPhase: (phase) => {
        emptyAfter.push(phase)
      }
    })
    expect(emptyResult).toEqual([])
    expect(emptyBefore).toEqual([])
    expect(emptyAfter).toEqual([])

    // null / undefined artifacts should not be collected but afterPhase still receives null
    const phases = ['phase_a', 'phase_b', 'phase_c', 'phase_d'] as const
    const afterArtifacts: Array<string | null> = []
    const afterSeenArtifacts: Array<readonly string[]> = []

    const artifacts = await runSequentialArtifactOrchestrator<(typeof phases)[number], string>({
      phases,
      executePhase: (phase) => {
        if (phase === 'phase_a') return Promise.resolve({ artifact: 'artifact:a' })
        if (phase === 'phase_b') return Promise.resolve({ artifact: null })
        if (phase === 'phase_c') return Promise.resolve({ artifact: undefined })
        return Promise.resolve({})
      },
      afterPhase: (_phase, _index, artifact, allArtifacts) => {
        afterArtifacts.push(artifact)
        afterSeenArtifacts.push([...allArtifacts])
      }
    })

    expect(artifacts).toEqual(['artifact:a'])
    expect(afterArtifacts).toEqual(['artifact:a', null, null, null])
    // accumulated artifacts should remain ['artifact:a'] after nullish phases (no new pushes)
    expect(afterSeenArtifacts).toEqual([
      ['artifact:a'],
      ['artifact:a'],
      ['artifact:a'],
      ['artifact:a']
    ])
  })

  test('propagates correct index and accumulated artifacts to hooks and propagates errors', async () => {
    const phases = ['phase_a', 'phase_b', 'phase_c'] as const
    const beforeCalls: Array<{ phase: string; index: number; artifacts: string[] }> = []
    const executeCalls: Array<{ phase: string; index: number; artifacts: string[] }> = []
    const afterCalls: Array<{ phase: string; index: number; artifact: string | null; artifacts: string[] }> = []

    const artifacts = await runSequentialArtifactOrchestrator<(typeof phases)[number], string>({
      phases,
      beforePhase: (phase, index, arts) => {
        beforeCalls.push({ phase, index, artifacts: [...arts] })
      },
      executePhase: (phase, index, arts) => {
        executeCalls.push({ phase, index, artifacts: [...arts] })
        return Promise.resolve({ artifact: `artifact:${phase}` })
      },
      afterPhase: (phase, index, artifact, arts) => {
        afterCalls.push({ phase, index, artifact, artifacts: [...arts] })
      }
    })

    expect(artifacts).toEqual(['artifact:phase_a', 'artifact:phase_b', 'artifact:phase_c'])

    expect(beforeCalls).toEqual([
      { phase: 'phase_a', index: 0, artifacts: [] },
      { phase: 'phase_b', index: 1, artifacts: ['artifact:phase_a'] },
      { phase: 'phase_c', index: 2, artifacts: ['artifact:phase_a', 'artifact:phase_b'] }
    ])

    expect(executeCalls).toEqual([
      { phase: 'phase_a', index: 0, artifacts: [] },
      { phase: 'phase_b', index: 1, artifacts: ['artifact:phase_a'] },
      { phase: 'phase_c', index: 2, artifacts: ['artifact:phase_a', 'artifact:phase_b'] }
    ])

    expect(afterCalls).toEqual([
      { phase: 'phase_a', index: 0, artifact: 'artifact:phase_a', artifacts: ['artifact:phase_a'] },
      { phase: 'phase_b', index: 1, artifact: 'artifact:phase_b', artifacts: ['artifact:phase_a', 'artifact:phase_b'] },
      { phase: 'phase_c', index: 2, artifact: 'artifact:phase_c', artifacts: ['artifact:phase_a', 'artifact:phase_b', 'artifact:phase_c'] }
    ])

    // error propagation: rejection in executePhase should bubble and stop orchestration
    await expect(
      runSequentialArtifactOrchestrator<string, string>({
        phases: ['ok', 'fail', 'skipped'],
        executePhase: (phase) => {
          if (phase === 'fail') return Promise.reject(new Error('boom'))
          return Promise.resolve({ artifact: `artifact:${phase}` })
        }
      })
    ).rejects.toThrow('boom')

    // error in beforePhase should also propagate
    await expect(
      runSequentialArtifactOrchestrator<string, string>({
        phases: ['phase_a'],
        beforePhase: () => {
          throw new Error('before-fail')
        },
        executePhase: () => Promise.resolve({ artifact: 'x' })
      })
    ).rejects.toThrow('before-fail')
  })
})
