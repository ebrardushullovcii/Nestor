import {
  SourceDebugRunRecordSchema,
  JobFinderDiscoveryStateSchema,
  type SourceDebugRunRecord,
  type JobFinderDiscoveryState,
} from "@nestor/contracts";

export function normalizeLegacySourceDebugRunRecord(
  value: unknown,
): SourceDebugRunRecord {
  const parsedValue =
    value && typeof value === "object"
      ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
      : value;

  if (
    parsedValue &&
    typeof parsedValue === "object" &&
    "state" in parsedValue &&
    "activePhase" in parsedValue
  ) {
    const state = parsedValue.state;
    const isTerminalState =
      state === "completed" ||
      state === "cancelled" ||
      state === "failed" ||
      state === "interrupted";

    if (isTerminalState) {
      parsedValue.activePhase = null;
    }
  }

  return SourceDebugRunRecordSchema.parse(parsedValue);
}

export function normalizeLegacyDiscoveryState(
  value: unknown,
): JobFinderDiscoveryState {
  const parsedValue =
    value && typeof value === "object"
      ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const activeSourceDebugRun =
    parsedValue.activeSourceDebugRun == null
      ? null
      : normalizeLegacySourceDebugRunRecord(parsedValue.activeSourceDebugRun);
  const recentSourceDebugRuns = Array.isArray(parsedValue.recentSourceDebugRuns)
    ? parsedValue.recentSourceDebugRuns.flatMap((run) => {
        try {
          return [normalizeLegacySourceDebugRunRecord(run)];
        } catch {
          return [];
        }
      })
    : [];

  return JobFinderDiscoveryStateSchema.parse({
    ...parsedValue,
    activeSourceDebugRun,
    recentSourceDebugRuns,
  });
}
