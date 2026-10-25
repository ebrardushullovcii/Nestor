import {
  TRACKER_EXPORT_CHANNEL,
  TRACKER_RUN_CHANNEL,
  type TrackerCommandInput,
  type TrackerCommandName,
  type TrackerCommandOutput,
  type TrackerExportInput,
  type TrackerExportResult,
} from "@nestor/contracts";

/** The renderer's bridge to Applications: its commands and the CSV export. */
export interface DesktopTrackerBridge {
  run<K extends TrackerCommandName>(
    name: K,
    input: TrackerCommandInput<K>,
  ): Promise<TrackerCommandOutput<K>>;
  /** Opens the save dialog and writes the filtered applications as CSV. */
  exportCsv(input: TrackerExportInput): Promise<TrackerExportResult>;
}

export function createTrackerBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): DesktopTrackerBridge {
  return {
    run: (name, input) =>
      ipc.invoke(TRACKER_RUN_CHANNEL, { name, input }) as Promise<
        TrackerCommandOutput<typeof name>
      >,
    exportCsv: (input) =>
      ipc.invoke(TRACKER_EXPORT_CHANNEL, input) as Promise<TrackerExportResult>,
  };
}
