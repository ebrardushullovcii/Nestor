import {
  APPLICATION_COMMANDS,
  ApplyJobsInputSchema,
  ApplicationTargetSchema,
  DEFAULT_APPLICATION_APPLY_MODE,
  type ApplicationCommandOutputs,
  type ApplicationAutomationMode,
  type ApplyJobsResult,
} from "@nestor/contracts";
import {
  assistantCommandTools,
  decideUnderGrants,
  AssistantToolError,
  type AssistantToolContext,
} from "@nestor/job-finder";
import { runApplicationCommand } from "../application-commands";
import { getApplicationStore } from "../job-finder/application-store";
import { startJobFinderRuntime } from "../job-finder/runtime";

async function savedMode() {
  const { repository } = await startJobFinderRuntime();
  if ((await repository.getActivityControl()).paused)
    throw new AssistantToolError(
      "refused",
      "The person paused background work. Resume it before applying or sending.",
    );
  return (
    (await repository.getSettings()).applicationAutomationMode ??
    DEFAULT_APPLICATION_APPLY_MODE
  );
}

export function assistantApplicationCommands() {
  return assistantCommandTools<
    typeof APPLICATION_COMMANDS,
    ApplicationCommandOutputs
  >(APPLICATION_COMMANDS, runApplicationCommand, {
    group: "applications",
    results: {
      open_application: (opened) => ({
        summary: opened
          ? "Opened the exact filled application in the app browser."
          : "That application form is no longer available.",
        data: { opened },
      }),
      stop_application: (stopped) => ({
        summary: stopped
          ? "Stopped the application and closed its tab. Nothing already sent was undone."
          : "The application had already moved on; nothing was stopped.",
        data: { stopped },
      }),
      get_application_details: (value) => ({
        summary: value
          ? `${value.application.title}: ${value.application.state}.`
          : "That application no longer exists.",
        data: value,
      }),
    },
  }).map((tool) => {
    if (tool.name === "apply_to_jobs")
      return {
        ...tool,
        async execute(input: unknown, { session }: AssistantToolContext) {
          const { selection } = ApplyJobsInputSchema.parse(input);
          const ids = getApplicationStore().selectedJobIds(selection);
          const decisions = decideUnderGrants({
            grants: await session.grants.list(),
            jobIds: ids.map(String),
            action: "prepare",
            savedMode: await savedMode(),
          });
          const groups = new Map<ApplicationAutomationMode, number[]>();
          const refused = decisions.filter((d) => !d.allowed);
          for (const d of decisions)
            if (d.allowed && d.mode) {
              const group = groups.get(d.mode) ?? [];
              group.push(Number(d.jobId));
              groups.set(d.mode, group);
            }
          if (!groups.size && ids.length)
            throw new AssistantToolError("refused", refused[0]!.reason!);
          const result: ApplyJobsResult = {
            queued: 0,
            unchanged: 0,
            notApproved: 0,
          };
          for (const [mode, jobIds] of groups) {
            for (let offset = 0; offset < jobIds.length; offset += 5000) {
              session.assertCurrent();
              const next = await runApplicationCommand(
                "apply_to_jobs",
                { selection: { ids: jobIds.slice(offset, offset + 5000) } },
                { conversationId: session.conversationId, mode },
              );
              result.queued += next.queued;
              result.unchanged += next.unchanged;
              result.notApproved += next.notApproved;
            }
          }
          return {
            summary: `Queued ${result.queued} applications; ${result.unchanged} already queued, prepared or sent; ${result.notApproved} need an approved resume.${refused.length ? ` ${refused.length} outside the recorded instruction were left out.` : ""} Apply runs in the background.`,
            data: { ...result, refused: refused.length },
          };
        },
      };
    if (tool.name === "send_application")
      return {
        ...tool,
        async execute(input: unknown, context: AssistantToolContext) {
          const { session } = context;
          const target = ApplicationTargetSchema.parse(input);
          const row = getApplicationStore().getApplication(target.id);
          if (!row)
            throw new AssistantToolError(
              "not_found",
              "That application no longer exists.",
            );
          const currentMode = await savedMode();
          const [decision] = decideUnderGrants({
            grants: await session.grants.list(),
            jobIds: [String(row.jobId)],
            action: "send",
            savedMode:
              row.mode === "autonomous_submit" &&
              currentMode === "autonomous_submit"
                ? "autonomous_submit"
                : "confirm_before_submit",
          });
          if (!decision?.allowed)
            throw new AssistantToolError(
              "refused",
              decision?.reason ?? "Record a send instruction first.",
            );
          session.assertCurrent();
          await session.releaseBrowserLease?.();
          const sent = await runApplicationCommand("send_application", target);
          const details = await runApplicationCommand(
            "get_application_details",
            target,
          );
          return {
            summary: sent
              ? "The site confirmed the application was sent."
              : details?.application.state === "submitted"
                ? "The site already confirmed this application. It was not sent again."
                : details?.application.state === "uncertain"
                  ? "Sending was not confirmed. Check the application details before doing anything else."
                  : details?.application.error
                    ? `Not sent: ${details.application.error}`
                    : "The application was not sent. Check its current work state before trying again.",
            data: details,
          };
        },
      };
    return tool;
  });
}
