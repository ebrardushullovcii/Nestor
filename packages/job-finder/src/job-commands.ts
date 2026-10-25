import {
  JOB_COMMANDS,
  type JobCommandName,
  type JobCommandOutputs,
} from "@nestor/contracts";
import type { JobStore } from "@nestor/db/job-store";
import type { z } from "zod";

type Handlers = {
  [K in JobCommandName]: (
    input: z.output<(typeof JOB_COMMANDS)[K]["input"]>,
  ) => JobCommandOutputs[K] | Promise<JobCommandOutputs[K]>;
};

export type RunJobCommand = <K extends JobCommandName>(
  name: K,
  input: unknown,
) => Promise<JobCommandOutputs[K]>;

export class UnknownJobCommandError extends Error {
  constructor(name: string) {
    super(`There is no job command named ${name}.`);
  }
}

/**
 * Runs one job command after checking its input. The preload bridge and the
 * Assistant both call this, so a person and the chat can do the same things.
 */
export function createJobCommandRunner(deps: {
  store: JobStore;
}): RunJobCommand {
  const { store } = deps;
  const handlers: Handlers = {
    list_jobs: (input) => store.listJobs(input),
    get_job: ({ id }) => store.getJob(id),
    stage_counts: () => store.stageCounts(),
    move_jobs: (input) => store.moveJobs(input),
    undo_move: ({ moveId }) => store.undoMove(moveId),
  };

  return async (name, input) => {
    if (!Object.hasOwn(JOB_COMMANDS, name)) {
      throw new UnknownJobCommandError(String(name));
    }
    const parsed: unknown = JOB_COMMANDS[name].input.parse(input ?? {});
    const handler = handlers[name] as (value: unknown) => unknown;
    return (await handler(parsed)) as JobCommandOutputs[typeof name];
  };
}
