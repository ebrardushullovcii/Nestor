import {
  JOB_COMMANDS,
  RESUME_COMMANDS,
  type JobCommandOutputs,
  type ResumeCommandOutputs,
} from "@nestor/contracts";
import { assistantCommandTools } from "@nestor/job-finder";

import { runJobCommand } from "../job-commands";
import { runResumeCommand } from "../../routes/resumes";

/** Add each screen's command catalog here as its store lands. */
export function assistantAppCommands() {
  return [
    ...assistantCommandTools<typeof JOB_COMMANDS, JobCommandOutputs>(
      JOB_COMMANDS,
      runJobCommand,
      {
        group: "jobs",
        writes: ["move_jobs", "undo_move"],
        results: {
          list_jobs: (page) => ({
            summary: `${page.rows.length} jobs on this page; ${page.total}${page.totalCapped ? "+" : ""} match.`,
            data: page,
          }),
          get_job: (job) => ({
            summary: job
              ? `${job.title} at ${job.company}.`
              : "That job was not found.",
            data: job,
          }),
          async move_jobs(result, input, { session }) {
            const summary = `Moved ${result.moved} jobs to ${input.to}.`;
            if (!result.moveId || !result.moved)
              return { summary, data: result };
            const { part } = await session.recordChange({
              target: "app_command",
              targetId: String(result.moveId),
              summary,
              entries: [
                {
                  path: ["undo_move"],
                  kind: "set",
                  before: result.moved,
                  after: { moveId: result.moveId },
                  index: null,
                  label: "Job stage",
                },
              ],
            });
            return { summary, data: result, parts: [part], canFinish: true };
          },
          undo_move: (result) => ({
            summary: `Moved ${result.moved} jobs back. Later changes were kept.`,
            data: result,
          }),
        },
      },
    ),
    ...assistantCommandTools<typeof RESUME_COMMANDS, ResumeCommandOutputs>(
      RESUME_COMMANDS,
      runResumeCommand,
      {
        group: "resume",
        writes: [
          "save_resume",
          "set_resume_level",
          "undo_resume_level",
          "rewrite_resume",
          "approve_resume",
        ],
        results: {
          async set_resume_level(value, input, { session }) {
            const label = `${value.level[0]!.toUpperCase()}${value.level.slice(1)}`;
            const summary = `Writing this resume at ${label}.`;
            if (!value.levelChangeId) return { summary, data: value };
            const { part } = await session.recordChange({
              target: "app_command",
              targetId: String(input.jobId),
              summary,
              entries: [
                {
                  path: ["undo_resume_level"],
                  kind: "set",
                  before: value.previousLevel,
                  after: { jobId: input.jobId, changeId: value.levelChangeId },
                  label: "Resume level",
                  index: null,
                },
              ],
            });
            return { summary, data: value, parts: [part] };
          },
        },
      },
    ),
  ];
}
