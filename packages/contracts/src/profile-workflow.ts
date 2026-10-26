import { z } from "zod";
import type { ProfileSetupState } from "./profile-setup";
import { ProfileSetupStateSchema } from "./profile-setup";
import type {
  ResumeImportFieldCandidateSummary,
  ResumeImportProgressEvent,
  ResumeImportRun,
} from "./resume-import";
import type {
  SourceDebugProgressEvent,
  SourceInstructionArtifact,
} from "./source-debug";
import {
  JobFinderProfileSetupReviewActionInputSchema,
  JobFinderResumeTimelineRepairActionInputSchema,
  JobFinderSaveSourceInstructionInputSchema,
} from "./workspace";

/**
 * Guided setup, resume import and site checks for Profile and setup, without
 * the old whole-workspace load. Every command answers with the small state
 * these screens show, read from the job store.
 */
export const PROFILE_WORKFLOW_CHANNEL = "profile-workflow:run";
export const PROFILE_WORKFLOW_IMPORT_CHANNEL = "profile-workflow:import-resume";
export const PROFILE_WORKFLOW_CHECK_SITE_CHANNEL =
  "profile-workflow:check-site";

export const ProfileWorkflowCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read") }).strict(),
  z.object({ type: z.literal("analyze_resume") }).strict(),
  z
    .object({
      type: z.literal("apply_review_action"),
      input: JobFinderProfileSetupReviewActionInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("apply_timeline_repair"),
      input: JobFinderResumeTimelineRepairActionInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("save_setup_state"),
      state: ProfileSetupStateSchema,
    })
    .strict(),
  z.object({ type: z.literal("list_site_instructions") }).strict(),
  z
    .object({
      type: z.literal("save_site_instructions"),
      input: JobFinderSaveSourceInstructionInputSchema,
    })
    .strict(),
]);
export type ProfileWorkflowCommand = z.input<
  typeof ProfileWorkflowCommandSchema
>;

export const ProfileWorkflowCheckSiteInputSchema = z
  .object({
    targetId: z.string().trim().min(1).max(200),
    requestId: z.string().trim().min(1).max(200),
  })
  .strict();

export interface ProfileWorkflowState {
  profileSetupState: ProfileSetupState;
  latestResumeImportRun: ResumeImportRun | null;
  latestResumeImportReviewCandidates: ResumeImportFieldCandidateSummary[];
  resumeImportActive: boolean;
}

export interface ProfileWorkflowResult {
  state: ProfileWorkflowState;
  /** What happened, in a sentence for the screen; null when nothing to say. */
  message: string | null;
  /** Only for `list_site_instructions` and the site-instruction commands. */
  siteInstructions?: readonly SourceInstructionArtifact[];
}

/** The renderer's bridge for Profile and guided setup. */
export interface DesktopProfileWorkflowBridge {
  run(command: ProfileWorkflowCommand): Promise<ProfileWorkflowResult>;
  /** Opens the file picker, or imports the saved working copy again. */
  importResume(
    onProgress: (event: ResumeImportProgressEvent) => void,
    options?: { retryInterrupted?: boolean },
  ): Promise<ProfileWorkflowResult>;
  /** Stops a picker, or with `stopProcessing` an import already reading. */
  cancelImportResume(stopProcessing?: boolean): void;
  checkSite(
    targetId: string,
    onProgress: (event: SourceDebugProgressEvent) => void,
  ): Promise<ProfileWorkflowResult>;
}
