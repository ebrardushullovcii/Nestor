import { getJobStore } from "../job-store";
import {
  JOB_COMMANDS,
  RESUME_COMMANDS,
  APPLICATION_COMMANDS,
  NEEDS_YOU_COMMANDS,
  TRACKER_COMMANDS,
  type JobCommandName,
  type ResumeCommandName,
  type ApplicationCommandName,
  type NeedsYouCommandName,
  type TrackerCommandName,
} from "@nestor/contracts";
import type {
  AssistantHostPorts,
  AssistantReadCommand,
  AssistantReadInput,
  AssistantReadOutput,
} from "@nestor/job-finder";
import { runJobCommand } from "../job-commands";
import { runResumeCommand } from "../../routes/resumes";
import { runApplicationCommand } from "../application-commands";
import { runNeedsYouCommand } from "../../routes/needs-you";
import { runTrackerCommand } from "../../routes/tracker";
import { readPersonalWorkspaceState } from "@nestor/db";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { isDesktopResumeImportActive } from "../job-finder/import-resume";
import { listLocalResumeTemplates } from "../../../shared/job-finder-resume-renderer";

const catalog = {
  ...JOB_COMMANDS,
  ...RESUME_COMMANDS,
  ...APPLICATION_COMMANDS,
  ...NEEDS_YOU_COMMANDS,
  ...TRACKER_COMMANDS,
};
export async function runAssistantReadCommand<K extends AssistantReadCommand>(
  name: K,
  input: AssistantReadInput<K>,
): Promise<AssistantReadOutput<K>> {
  if (!Object.hasOwn(catalog, name) || catalog[name].effect !== "read")
    throw new Error("Not a read command.");
  const value = Object.hasOwn(JOB_COMMANDS, name)
    ? await runJobCommand(name as JobCommandName, input)
    : Object.hasOwn(RESUME_COMMANDS, name)
      ? await runResumeCommand(name as ResumeCommandName, input)
      : Object.hasOwn(APPLICATION_COMMANDS, name)
        ? await runApplicationCommand(name as ApplicationCommandName, input)
        : Object.hasOwn(NEEDS_YOU_COMMANDS, name)
          ? await runNeedsYouCommand(name as NeedsYouCommandName, input)
          : await runTrackerCommand(name as TrackerCommandName, input);
  return value as AssistantReadOutput<K>;
}

export const readAssistantPersonalState: AssistantHostPorts["readPersonalState"] =
  async () => {
    const personal = readPersonalWorkspaceState(
      createEmptyJobFinderRepositoryState(),
      getJobStore(),
    );
    const sites = await runJobCommand("list_sites", {
      filter: "enabled",
      limit: 1,
    });
    return {
      ...personal,
      enabledSiteCount: sites.enabledTotal,
      availableResumeTemplates: listLocalResumeTemplates(),
      resumeImportActive: isDesktopResumeImportActive(),
      generatedAt: new Date().toISOString(),
    };
  };
