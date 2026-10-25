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
        replaces: {
          list_jobs: ["query_jobs", "show_jobs", "compare_jobs"],
          move_jobs: [
            "shortlist_jobs",
            "shortlist_result_set",
            "remove_from_shortlist",
            "dismiss_jobs",
            "restore_jobs",
          ],
          start_search: ["search_for_jobs"],
          stop_search: ["cancel_search"],
        },
        results: {
          list_jobs: (page) => ({
            summary: `${page.rows.length} jobs on this page; ${page.total}${page.totalCapped ? "+" : ""} match.`,
            data: {
              ...page,
              rows: page.rows.map(
                ({ id, stage, title, company, location, fitScore }) => ({
                  id,
                  stage,
                  title,
                  company,
                  location,
                  fitScore,
                }),
              ),
            },
          }),
          get_job: (job) => ({
            summary: job
              ? `${job.title} at ${job.company}.`
              : "That job was not found.",
            data: job,
          }),
          async move_jobs(result, input, { session }) {
            const destination = {
              found: "Find jobs",
              hidden: "Hidden",
              shortlisted: "Shortlisted",
            }[input.to];
            const summary = `Moved ${result.moved} ${result.moved === 1 ? "job" : "jobs"} to ${destination}.`;
            if (!result.moveId || !result.moved)
              return { summary, data: result };
            const { part } = await session.recordChange({
              target: "app_command",
              targetId: String(result.moveId),
              summary,
              undoCommand: {
                name: "undo_move",
                input: { moveId: result.moveId },
                expectedCount: result.moved,
              },
              entries: [
                {
                  path: ["stage"],
                  kind: "set",
                  before: "Previous stages",
                  after: destination,
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
        replaces: {
          get_resume: ["read_resume"],
          save_resume: ["edit_resume", "revise_resume", "set_resume_template"],
          rewrite_resume: ["generate_resumes"],
          approve_resume: ["action_approve_resumes"],
        },
        results: {
          list_shortlisted: (page) => ({
            summary: `${page.rows.length} shortlisted jobs on this page; ${page.total}${page.totalCapped ? "+" : ""} match.`,
            data: {
              ...page,
              rows: page.rows.map(({ id, stage, title, company, resume }) => ({
                id,
                stage,
                title,
                company,
                resume,
              })),
            },
          }),
          async set_resume_level(value, input, { session }) {
            const label = `${value.level[0]!.toUpperCase()}${value.level.slice(1)}`;
            const summary = `Writing this resume at ${label}.`;
            if (!value.levelChangeId) return { summary, data: value };
            const { part } = await session.recordChange({
              target: "app_command",
              targetId: String(input.jobId),
              summary,
              undoCommand: {
                name: "undo_resume_level",
                input: { jobId: input.jobId, changeId: value.levelChangeId },
              },
              entries: [
                {
                  path: ["level"],
                  kind: "set",
                  before: value.previousLevel
                    ? `${value.previousLevel[0]!.toUpperCase()}${value.previousLevel.slice(1)}`
                    : null,
                  after: label,
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
