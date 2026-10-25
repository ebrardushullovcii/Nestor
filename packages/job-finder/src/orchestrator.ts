export interface SequentialArtifactPhaseResult<TArtifact> {
  artifact?: TArtifact | null
  stop?: boolean
}

export interface SequentialArtifactOrchestratorHooks<TPhase, TArtifact> {
  phases: readonly TPhase[]
  beforePhase?: (phase: TPhase, index: number, artifacts: readonly TArtifact[]) => Promise<void> | void
  executePhase: (
    phase: TPhase,
    index: number,
    artifacts: readonly TArtifact[]
  ) => Promise<SequentialArtifactPhaseResult<TArtifact>>
  afterPhase?: (
    phase: TPhase,
    index: number,
    artifact: TArtifact | null,
    artifacts: readonly TArtifact[]
  ) => Promise<void> | void
}

export async function runSequentialArtifactOrchestrator<TPhase, TArtifact>(
  hooks: SequentialArtifactOrchestratorHooks<TPhase, TArtifact>
): Promise<readonly TArtifact[]> {
  const artifacts: TArtifact[] = []

  for (const [index, phase] of hooks.phases.entries()) {
    await hooks.beforePhase?.(phase, index, artifacts)
    const result = await hooks.executePhase(phase, index, artifacts)
    const artifact = result.artifact ?? null

    if (artifact !== null) {
      artifacts.push(artifact)
    }

    await hooks.afterPhase?.(phase, index, artifact, artifacts)

    if (result.stop) {
      break
    }
  }

  return artifacts
}
