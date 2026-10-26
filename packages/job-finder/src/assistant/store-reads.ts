import type {
  JOB_COMMANDS,
  RESUME_COMMANDS,
  APPLICATION_COMMANDS,
  NEEDS_YOU_COMMANDS,
  TRACKER_COMMANDS,
  CandidateProfile,
  JobSearchPreferences,
  JobFinderSettings,
  ProfileSetupState,
  JobFinderActivityControl,
  ResumeImportRun,
  ResumeTemplateDefinition,
  JobCommandOutputs,
  ResumeCommandOutputs,
  ApplicationCommandOutputs,
  NeedsYouCommandOutputs,
  TrackerCommandOutputs,
} from "@nestor/contracts";
import type { z } from "zod";

type Commands = typeof JOB_COMMANDS &
  typeof RESUME_COMMANDS &
  typeof APPLICATION_COMMANDS &
  typeof NEEDS_YOU_COMMANDS &
  typeof TRACKER_COMMANDS;
export type AssistantReadCommand = {
  [K in keyof Commands]: Commands[K]["effect"] extends "read" ? K : never;
}[keyof Commands];
type Outputs = JobCommandOutputs &
  ResumeCommandOutputs &
  ApplicationCommandOutputs &
  NeedsYouCommandOutputs &
  TrackerCommandOutputs;
export type AssistantReadInput<K extends AssistantReadCommand> = z.input<
  Commands[K]["input"]
>;
export type AssistantReadOutput<K extends AssistantReadCommand> = Outputs[K];
export type RunAssistantReadCommand = <K extends AssistantReadCommand>(
  name: K,
  input: AssistantReadInput<K>,
) => Promise<AssistantReadOutput<K>>;

/** Person-sized singleton rows; never contains job, application or site lists. */
export interface AssistantPersonalState {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  settings: JobFinderSettings;
  profileSetupState: ProfileSetupState;
  activityControl: JobFinderActivityControl;
  latestResumeImportRun: ResumeImportRun | null;
  resumeImportActive: boolean;
  availableResumeTemplates: readonly ResumeTemplateDefinition[];
  generatedAt: string;
  enabledSiteCount: number;
}
