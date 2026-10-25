import {
  RESUME_COMMANDS,
  type ResumeCommandName,
  type ResumeCommandOutputs,
} from "@nestor/contracts";
import type { z } from "zod";

import type { ResumeService } from "./resume-service";

type Handlers = {
  [K in ResumeCommandName]: (
    input: z.output<(typeof RESUME_COMMANDS)[K]["input"]>,
  ) => ResumeCommandOutputs[K] | Promise<ResumeCommandOutputs[K]>;
};

export type RunResumeCommand = <K extends ResumeCommandName>(
  name: K,
  input: unknown,
) => Promise<ResumeCommandOutputs[K]>;

/**
 * Runs one Shortlisted command after checking its input; the screen and the
 * Assistant both call this.
 */
export function createResumeCommandRunner(
  service: () => Promise<ResumeService>,
): RunResumeCommand {
  const handlers = (resumes: ResumeService): Handlers => ({
    list_shortlisted: (input) => resumes.list(input),
    get_resume: ({ jobId }) => resumes.get(jobId),
    save_resume: ({ jobId, draft, expectedUpdatedAt }) =>
      resumes.saveDraft(jobId, draft, expectedUpdatedAt),
    set_resume_level: ({ jobId, level }) => resumes.setLevel(jobId, level),
    undo_resume_level: ({ jobId }) => resumes.undoLevel(jobId),
    rewrite_resume: ({ jobId }) => resumes.rewrite(jobId),
    approve_resume: ({ jobId }) => resumes.approve(jobId),
  });

  return async (name, input) => {
    if (!Object.hasOwn(RESUME_COMMANDS, name)) {
      throw new Error(`There is no resume command named ${String(name)}.`);
    }
    const parsed: unknown = RESUME_COMMANDS[name].input.parse(input ?? {});
    const handler = handlers(await service())[name] as (
      value: unknown,
    ) => unknown;
    return (await handler(parsed)) as ResumeCommandOutputs[typeof name];
  };
}
