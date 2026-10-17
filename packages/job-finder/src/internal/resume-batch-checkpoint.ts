import type { JobFinderIntelligenceState } from "@nordri/contracts";
import type { ResumeBatchCheckpoint } from "@nordri/contracts";

/** Keep independently running queues durable, and expose one recovery control. */
export function mergeResumeBatchCheckpoints(
  existing: readonly ResumeBatchCheckpoint[],
  incoming: ResumeBatchCheckpoint,
) {
  const checkpoints = [
    ...existing.flatMap((batch) => {
      if (batch.done || batch.id === incoming.id) return [];
      if (!incoming.resumedBatchIds?.includes(batch.id)) return [batch];
      const remaining = batch.jobIds.filter(
        (id) =>
          !incoming.jobIds.includes(id) && !batch.completedJobIds.includes(id),
      );
      return remaining.length
        ? [
            {
              ...batch,
              jobIds: remaining,
              activeJobIds: [],
              completedJobIds: [],
              running: false,
              ...(batch.requests
                ? {
                    requests: batch.requests.filter((request) =>
                      remaining.includes(request.jobId),
                    ),
                  }
                : {}),
            },
          ]
        : [];
    }),
    structuredClone(incoming),
  ];
  const unfinished = checkpoints.filter((batch) => !batch.done);
  if (unfinished.length <= 1) {
    return { checkpoints, checkpoint: unfinished[0] ?? incoming };
  }
  const pending = new Set(
    unfinished.flatMap((batch) =>
      batch.jobIds.filter((id) => !batch.completedJobIds.includes(id)),
    ),
  );
  return {
    checkpoints,
    checkpoint: {
      id: unfinished[0]!.id,
      jobIds: [...new Set(unfinished.flatMap((batch) => batch.jobIds))],
      activeJobIds: [
        ...new Set(unfinished.flatMap((batch) => batch.activeJobIds)),
      ],
      completedJobIds: [
        ...new Set(unfinished.flatMap((batch) => batch.completedJobIds)),
      ].filter((id) => !pending.has(id)),
      requests: unfinished.flatMap((batch) => batch.requests ?? []),
      durationsMs: unfinished.flatMap((batch) => batch.durationsMs ?? []),
      done: false,
      running: unfinished.some((batch) => batch.running),
      stopRequested: unfinished.every((batch) => batch.stopRequested),
      ...(unfinished.find((batch) => batch.providerBlock)?.providerBlock
        ? {
            providerBlock: unfinished.find((batch) => batch.providerBlock)!
              .providerBlock,
          }
        : {}),
    } satisfies ResumeBatchCheckpoint,
  };
}

const liveBatches = new WeakMap<object, Set<string>>();
export function clearResumeBatchLiveness(repository: object): void {
  liveBatches.delete(repository);
}
export function markResumeBatchRunning(
  repository: object,
  batch: ResumeBatchCheckpoint,
): void {
  const ids = liveBatches.get(repository) ?? new Set<string>();
  for (const id of batch.resumedBatchIds ?? []) ids.delete(id);
  if (batch.running) ids.add(batch.id);
  else ids.delete(batch.id);
  liveBatches.set(repository, ids);
}

export function withResumeBatchLiveness(
  repository: object,
  state: JobFinderIntelligenceState,
): JobFinderIntelligenceState {
  if (state.resumeBatchCheckpoint?.running === undefined) return state;
  const ids = liveBatches.get(repository);
  const checkpoints = state.resumeBatchCheckpoints ?? [
    state.resumeBatchCheckpoint,
  ];
  return {
    ...state,
    ...(state.resumeBatchCheckpoints
      ? {
          resumeBatchCheckpoints: state.resumeBatchCheckpoints.map((batch) => ({
            ...batch,
            running: !batch.done && !!ids?.has(batch.id),
          })),
        }
      : {}),
    resumeBatchCheckpoint: {
      ...state.resumeBatchCheckpoint,
      running: checkpoints.some((batch) => !batch.done && ids?.has(batch.id)),
    },
  };
}
