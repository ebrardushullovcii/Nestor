import {
  TRACKER_COMMANDS,
  type TrackerCommandName,
  type TrackerCommandOutputs,
  type TrackerCommandParsedInput,
} from "@nestor/contracts";
import { createTrackerStore, type JobStore } from "@nestor/db/job-store";

type Handlers = {
  [K in TrackerCommandName]: (
    input: TrackerCommandParsedInput<K>,
  ) => TrackerCommandOutputs[K];
};

export type RunTrackerCommand = <K extends TrackerCommandName>(
  name: K,
  input: unknown,
) => Promise<TrackerCommandOutputs[K]>;

/**
 * Runs one Applications command after checking its input; the screen and the
 * Assistant both call this.
 */
export function createTrackerCommandRunner(store: JobStore): RunTrackerCommand {
  const tracker = createTrackerStore(store);
  const handlers: Handlers = {
    list_applications: (input) => tracker.list(input),
    get_application: ({ jobId }) => {
      const job = store.getJob(jobId);
      const row = tracker.getRow(jobId);
      return job && row ? { job, row, events: tracker.events(jobId) } : null;
    },
    set_status: ({ ids, status }) => tracker.setStatus(ids, status),
    undo_status: ({ undoId }) => tracker.undoStatus(undoId),
    add_event: (input) => tracker.addEvent(input),
    update_event: (input) => tracker.updateEvent(input),
    delete_event: ({ id }) => tracker.deleteEvent(id),
    set_tags: ({ ids, add, remove }) => tracker.setTags(ids, add, remove),
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
