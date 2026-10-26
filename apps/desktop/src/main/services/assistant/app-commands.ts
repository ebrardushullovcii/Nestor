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
  guardResumeEditor,
  resumeCommandReceipts,
  resumeResultData,
  needsYouCommandTools,
  type AssistantToolContext,
} from "@nestor/job-finder";

import { runNeedsYouCommand } from "../../routes/needs-you";
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
  const resumeReceipts = resumeCommandReceipts(runResumeCommand);
  return [
    ...assistantApplicationCommands(),
    ...needsYouCommandTools(runNeedsYouCommand),
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
        before: {
          save_resume: resumeReceipts.before,
          edit_resume: resumeReceipts.before,
          approve_resume: resumeReceipts.before,
          set_resume_level: (input, context) =>
            guardResumeEditor(input.jobId, context),
          rewrite_resume: (input, context) =>
            guardResumeEditor(input.jobId, context),
          undo_resume_level: (input, context) =>
            guardResumeEditor(input.jobId, context),
          undo_resume_change: (input, context) =>
            guardResumeEditor(input.jobId, context),
        },
        replaces: {
          get_resume: ["read_resume"],
          save_resume: ["edit_resume", "revise_resume", "set_resume_template"],
          rewrite_resume: ["generate_resumes"],
          approve_resume: ["action_approve_resumes"],
        },
        results: {
          export_resume_pdf: async (value, input) => {
            if (!value.outputPath)
              return {
                summary: "PDF export cancelled. No file was written.",
                data: value,
              };
            const { job } = await runResumeCommand("get_resume", {
              jobId: input.jobId,
            });
            return {
              summary: `Exported the saved resume PDF for ${job.title} at ${job.company} to ${value.outputPath}.`,
              data: value,
            };
          },
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
          get_resume: (value) => ({
            summary: `${value.job.title} at ${value.job.company}: ${value.resume?.state ?? "no resume yet"}. Edit with edit_resume; resume.updatedAt is the required revision.`,
            data: {
              job: {
                id: value.job.id,
                title: value.job.title,
                company: value.job.company,
                stage: value.job.stage,
              },
              resume: value.resume ? resumeResultData(value.resume) : null,
              templates: value.templates,
            },
          }),
          undo_resume_change: (value) => ({
            summary: "Undid the resume change.",
            data: resumeResultData(value),
          }),
          save_resume: (value, input, context) =>
            resumeReceipts.result(value, input, context, "edit"),
          edit_resume: (value, input, context) =>
            resumeReceipts.result(value, input, context, "edit"),
          approve_resume: (value, input, context) =>
            resumeReceipts.result(value, input, context, "approve"),
          async rewrite_resume(value, input, { session }) {
            const summary = "Writing this resume again.";
            if (!value?.levelChangeId) return { summary, data: value };
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
                  path: ["draft"],
                  kind: "set",
                  index: null,
                  label: "Resume rewrite",
                  before: "Previous saved resume and approval",
                  after: "Writing a replacement resume",
                },
              ],
            });
            return { summary, data: value, parts: [part] };
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
