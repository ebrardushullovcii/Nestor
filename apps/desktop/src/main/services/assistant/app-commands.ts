import {
  JOB_COMMANDS,
  RESUME_COMMANDS,
  TRACKER_COMMANDS,
  TRACKER_STATUS_LABEL,
  type JobCommandOutputs,
  type ResumeCommandOutputs,
  type TrackerCommandOutputs,
  type TrackerChange,
  type SiteChange,
} from "@nestor/contracts";
import {
  assistantCommandTools,
  type AssistantToolContext,
} from "@nestor/job-finder";

import { runJobCommand } from "../job-commands";
import { runResumeCommand } from "../../routes/resumes";
import { runTrackerCommand } from "../../routes/tracker";
import { assistantApplicationCommands } from "./application-commands";

async function trackerChange<T extends TrackerChange>(
  value: T,
  summary: string,
  { session }: AssistantToolContext,
) {
  if (!value.undoId) return { summary, data: value };
  const { part } = await session.recordChange({
    target: "app_command",
    targetId: String(value.undoId),
    summary,
    undoCommand: {
      name: "undo_tracker_change",
      input: { undoId: value.undoId },
      expectedCount: value.undoCount,
    },
    entries: [
      {
        path: ["tracker"],
        kind: "set",
        before: "Previous value",
        after: summary,
        index: null,
        label: "Application tracking",
      },
    ],
  });
  return { summary, data: value, parts: [part] };
}

async function siteChange<T extends SiteChange>(
  value: T,
  summary: string,
  { session }: AssistantToolContext,
) {
  if (!value.undoId) return { summary, data: value };
  const { part } = await session.recordChange({
    target: "app_command",
    targetId: String(value.undoId),
    summary,
    undoCommand: {
      name: "undo_site_change",
      input: { undoId: value.undoId },
      expectedCount: value.undoCount,
    },
    entries: [
      {
        path: ["sites"],
        kind: "set",
        before: "Previous sites",
        after: summary,
        index: null,
        label: "Job sites",
      },
    ],
  });
  return { summary, data: value, parts: [part] };
}

/** Add each screen's command catalog here as its store lands. */
export function assistantAppCommands() {
  return [
    ...assistantApplicationCommands(),
    ...assistantCommandTools<typeof TRACKER_COMMANDS, TrackerCommandOutputs>(
      TRACKER_COMMANDS,
      runTrackerCommand,
      {
        group: "tracking",
        results: {
          list_applications: (page) => ({
            summary: `${page.rows.length} applications on this page; ${page.total}${page.totalCapped ? "+" : ""} match.`,
            data: page,
          }),
          get_application: (value) => ({
            summary: value
              ? `${value.job.title} at ${value.job.company}: ${TRACKER_STATUS_LABEL[value.row.status]}.`
              : "That application was not found.",
            data: value,
          }),
          set_status: (value, input, context) =>
            trackerChange(
              value,
              `Moved ${value.changed} ${value.changed === 1 ? "application" : "applications"} to ${TRACKER_STATUS_LABEL[input.status]}.`,
              context,
            ),
          add_event: (value, input, context) =>
            trackerChange(
              value,
              `Added ${input.kind}: ${value.title}.`,
              context,
            ),
          update_event: (value, _input, context) =>
            trackerChange(
              value,
              `Updated ${value.kind}: ${value.title}.`,
              context,
            ),
          delete_event: (value, _input, context) =>
            trackerChange(
              value,
              value.deleted
                ? "Deleted the tracker entry."
                : "That tracker entry was not deleted.",
              context,
            ),
          set_tags: (value, _input, context) =>
            trackerChange(
              value,
              `Changed ${value.changed} application tags.`,
              context,
            ),
          save_view: (value, _input, context) =>
            trackerChange(
              value,
              `Saved the Applications view ${value.name}.`,
              context,
            ),
          delete_view: (value, _input, context) =>
            trackerChange(
              value,
              value.deleted
                ? "Deleted the saved Applications view."
                : "That view was not deleted.",
              context,
            ),
          undo_tracker_change: (value) => ({
            summary: `${value.changed ? "Undid the tracker change." : "Nothing changed."}${value.skipped ? " Later edits were kept." : ""}`,
            data: value,
          }),
        },
      },
    ),
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
          list_sites: (page) => ({
            summary: `${page.total} job sites match; ${page.enabledTotal} turned on in total.`,
            data: {
              ...page,
              rows: page.rows.map(
                ({ id, label, url, enabled, health, lastSearchedAt }) => ({
                  id,
                  label,
                  url,
                  enabled,
                  health,
                  lastSearchedAt,
                }),
              ),
            },
          }),
          add_sites: (value, _input, context) =>
            siteChange(
              value,
              `Added ${value.added} ${value.added === 1 ? "job site" : "job sites"}; ${value.duplicates} ${value.duplicates === 1 ? "duplicate" : "duplicates"}.${value.invalid.length ? ` ${value.invalid.length} invalid entries were left out.` : ""}`,
              context,
            ),
          update_site: (value, _input, context) =>
            value
              ? siteChange(
                  value,
                  value.undoId
                    ? `Updated ${value.label}.`
                    : `${value.label} already matches the requested values.`,
                  context,
                )
              : { summary: "That job site no longer exists.", data: null },
          remove_site: (value, _input, context) =>
            siteChange(
              value,
              value.removed
                ? "Removed the site. Saved jobs remain."
                : "That site was not removed.",
              context,
            ),
          set_sites_enabled: (value, input, context) =>
            siteChange(
              value,
              `Turned ${input.enabled ? "on" : "off"} ${value.changed} job sites.`,
              context,
            ),
          undo_site_change: (value) => ({
            summary: `Restored ${value.changed} job sites.${value.skipped ? ` ${value.skipped} later changes were kept.` : ""}`,
            data: value,
          }),

          list_jobs: async (page, _input, { session }) => {
            await session.createResultSet({
              kind: "jobs",
              label: "Jobs",
              itemIds: page.rows.map((row) => String(row.id)),
              source: "tool_query",
            });
            return {
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
            };
          },
          get_job: async (job, _input, { session }) => {
            if (job)
              await session.createResultSet({
                kind: "jobs",
                label: job.title,
                itemIds: [String(job.id)],
                source: "tool_query",
              });
            return {
              summary: job
                ? `${job.title} at ${job.company}.`
                : "That job was not found.",
              data: job,
            };
          },
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
          list_shortlisted: async (page, _input, { session }) => {
            await session.createResultSet({
              kind: "jobs",
              label: "Shortlisted",
              itemIds: page.rows.map((row) => String(row.id)),
              source: "tool_query",
            });
            return {
              summary: `${page.rows.length} shortlisted jobs on this page; ${page.total}${page.totalCapped ? "+" : ""} match.`,
              data: {
                ...page,
                rows: page.rows.map(
                  ({ id, stage, title, company, resume }) => ({
                    id,
                    stage,
                    title,
                    company,
                    resume,
                  }),
                ),
              },
            };
          },
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
