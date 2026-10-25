import { z } from "zod";

import { ApplicationAutomationModeSchema } from "./application-authority";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";

/** Largest selection one Apply press can queue. */
export const APPLY_QUEUE_MAX_JOBS = 2_000;

/**
 * One Apply press over many jobs (Apply to selected, this page, or all ready).
 * The queue starts runs of at most ten back to back, waits out the daily
 * limit until local midnight, and is saved so it carries on after a restart.
 *
 * - `running`: a run is under way or the next one is about to start.
 * - `waiting_for_tomorrow`: today's limit is used; it continues at `resumesAt`.
 * - `paused`: the person paused it, or a run could not start (`pausedReason`).
 * - `stopped` / `done`: finished; kept so the screens can say what happened.
 */
export const ApplyQueueStateSchema = z.enum([
  "running",
  "waiting_for_tomorrow",
  "paused",
  "stopped",
  "done",
]);
export type ApplyQueueState = z.infer<typeof ApplyQueueStateSchema>;

export const ApplyQueueSkippedJobSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    reason: z.string().trim().max(500),
  })
  .strict();
export type ApplyQueueSkippedJob = z.infer<typeof ApplyQueueSkippedJobSchema>;

export const ApplyQueueSchema = z
  .object({
    id: NonEmptyStringSchema,
    /**
     * The mode the press was made in. A run never uses a mode that allows
     * more than this one or more than the one saved in Settings now.
     */
    mode: ApplicationAutomationModeSchema,
    state: ApplyQueueStateSchema,
    jobIds: z.array(NonEmptyStringSchema).max(APPLY_QUEUE_MAX_JOBS),
    /** Chat-owned choices retain their identity even if the chat is deleted. */
    assistantScopes: z
      .array(
        z
          .object({
            conversationId: NonEmptyStringSchema,
            jobIds: z.array(NonEmptyStringSchema).max(APPLY_QUEUE_MAX_JOBS),
          })
          .strict(),
      )
      .optional(),
    /** Jobs handed to a run. A job is never handed to a second run. */
    startedJobIds: z.array(NonEmptyStringSchema).max(APPLY_QUEUE_MAX_JOBS),
    skipped: z.array(ApplyQueueSkippedJobSchema).max(APPLY_QUEUE_MAX_JOBS),
    activeRunId: NonEmptyStringSchema.nullable(),
    pausedReason: z.string().trim().max(1_000).nullable(),
    resumesAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type ApplyQueue = z.infer<typeof ApplyQueueSchema>;

export const JobFinderStartApplyQueueInputSchema = z
  .object({
    jobIds: z.array(NonEmptyStringSchema).min(1).max(APPLY_QUEUE_MAX_JOBS),
    applicationAutomationMode: ApplicationAutomationModeSchema.optional(),
  })
  .strict();
export type JobFinderStartApplyQueueInput = z.infer<
  typeof JobFinderStartApplyQueueInputSchema
>;

export const JobFinderApplyQueueControlInputSchema = z
  .object({
    action: z.enum(["pause", "continue", "stop", "dismiss"]),
    queueId: NonEmptyStringSchema.optional(),
  })
  .strict();
export type JobFinderApplyQueueControlInput = z.infer<
  typeof JobFinderApplyQueueControlInputSchema
>;

/** Jobs the person takes out of the queue before a run takes them. */
export const JobFinderRemoveFromApplyQueueInputSchema = z
  .object({
    jobIds: z.array(NonEmptyStringSchema).min(1).max(APPLY_QUEUE_MAX_JOBS),
  })
  .strict();
export type JobFinderRemoveFromApplyQueueInput = z.infer<
  typeof JobFinderRemoveFromApplyQueueInputSchema
>;

/**
 * The person's press of "Approve N resumes": each named job's current resume
 * is approved as written, as the single Approve does. A resume with a line
 * still to decide is left for the person.
 */
export const JobFinderApproveResumesInputSchema = z
  .object({
    jobIds: z.array(NonEmptyStringSchema).min(1).max(APPLY_QUEUE_MAX_JOBS),
  })
  .strict();
export type JobFinderApproveResumesInput = z.infer<
  typeof JobFinderApproveResumesInputSchema
>;

/** Jobs of the queue no run has taken yet, in the order they were chosen. */
export function listApplyQueueRemainingJobIds(queue: ApplyQueue): string[] {
  const taken = new Set([
    ...queue.startedJobIds,
    ...queue.skipped.map((entry) => entry.jobId),
  ]);
  return queue.jobIds.filter((jobId) => !taken.has(jobId));
}
