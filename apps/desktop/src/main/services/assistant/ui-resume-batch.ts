import type {
  AssistantResumeBatchState,
  ResumeBatchProviderBlock,
} from "@nestor/contracts";

/** The UI publishes its queue and checks this stop flag before each dispatch. */
let batch: AssistantResumeBatchState | null = null;
const invalidatedBatchIds = new Set<string>();

export function isUiResumeBatchInvalidated(id: string): boolean {
  return invalidatedBatchIds.has(id);
}

/** Workspace replacement revokes the old queue, including late cleanup callbacks. */
export function invalidateUiResumeBatch(): void {
  if (batch) invalidatedBatchIds.add(batch.id);
  batch = null;
}

export function syncUiResumeBatch(
  state: AssistantResumeBatchState,
): AssistantResumeBatchState {
  if (isUiResumeBatchInvalidated(state.id))
    throw new Error("This resume batch belongs to a previous workspace.");
  if (
    batch &&
    !batch.done &&
    batch.running !== false &&
    batch.id !== state.id
  ) {
    throw new Error("A resume batch is already running.");
  }
  batch = structuredClone({
    ...state,
    stopRequested:
      state.stopRequested || (batch?.id === state.id && batch.stopRequested),
    ...(batch?.id === state.id && batch.providerBlock
      ? { providerBlock: batch.providerBlock }
      : {}),
  });
  return structuredClone(batch);
}

export function readUiResumeBatch(): AssistantResumeBatchState | null {
  return batch && !batch.done && batch.running !== false
    ? structuredClone(batch)
    : null;
}

export function stopUiResumeBatch(): AssistantResumeBatchState | null {
  if (batch && !batch.done) batch.stopRequested = true;
  return readUiResumeBatch();
}

/** A rejection belongs only to its queue; a late old writer cannot stop a new one. */
export function blockUiResumeBatch(
  id: string,
  block: ResumeBatchProviderBlock,
): void {
  if (!batch || batch.id !== id || batch.done) return;
  batch.stopRequested = true;
  batch.providerBlock ??= structuredClone(block);
}

export function clearUiResumeBatch(): void {
  batch = null;
}
