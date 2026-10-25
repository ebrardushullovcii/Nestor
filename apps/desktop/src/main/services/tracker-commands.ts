import {
  TRACKER_COMMANDS,
  type TrackerCommandName,
  type TrackerExportInput,
  type TrackerExportResult,
  type TrackerCommandOutputs,
  type TrackerCommandParsedInput,
} from "@nestor/contracts";
import { createTrackerStore, type JobStore } from "@nestor/db/job-store";

type Handlers = {
  [K in TrackerCommandName]: (
    input: TrackerCommandParsedInput<K>,
  ) => TrackerCommandOutputs[K] | Promise<TrackerCommandOutputs[K]>;
};

export type RunTrackerCommand = <K extends TrackerCommandName>(
  name: K,
  input: unknown,
) => Promise<TrackerCommandOutputs[K]>;

/**
 * Runs one Applications command after checking its input; the screen and the
 * Assistant both call this.
 */
export function createTrackerCommandRunner(
  store: JobStore,
  exports?: {
    exportApplications: (
      input: TrackerExportInput,
    ) => Promise<TrackerExportResult>;
  },
): RunTrackerCommand {
  const tracker = createTrackerStore(store);
  const handlers: Handlers = {
    export_applications: (input) => {
      if (!exports) throw new Error("Export is unavailable here.");
      return exports.exportApplications(input);
    },
    list_tracker_agenda: ({ days, limit }) => tracker.agenda(days, limit),
    list_applications: (input) => tracker.list(input),
    get_application: ({ jobId }) => {
      const job = store.getJob(jobId);
      const row = tracker.getRow(jobId);
      return job && row ? { job, row, events: tracker.events(jobId) } : null;
    },
    set_status: ({ selection, status }) =>
      tracker.setStatus(tracker.selectedIds(selection), status),
    undo_tracker_change: ({ undoId }) => tracker.undoChange(undoId),
    add_event: (input) => tracker.addEvent(input),
    update_event: (input) => tracker.updateEvent(input),
    delete_event: ({ id }) => tracker.deleteEvent(id),
    set_tags: ({ selection, add, remove }) =>
      tracker.setTags(tracker.selectedIds(selection), add, remove),
    list_tags: () => tracker.tags(),
    list_views: () => tracker.views(),
    save_view: ({ name, filter, sort }) => tracker.saveView(name, filter, sort),
    delete_view: ({ id }) => tracker.deleteView(id),
  };

  return async (name, input) => {
    if (!Object.hasOwn(TRACKER_COMMANDS, name)) {
      throw new Error(
        `There is no Applications command named ${String(name)}.`,
      );
    }
    const parsed: unknown = TRACKER_COMMANDS[name].input.parse(input ?? {});
    const handler = handlers[name] as (value: unknown) => unknown;
    return Promise.resolve(
      handler(parsed) as TrackerCommandOutputs[typeof name],
    );
  };
}
