import type { z } from "zod";
import type { AppCommandDefinition } from "./app-commands";
import {
  ApplyJobsInputSchema,
  ApplicationListQuerySchema,
  ApplicationTargetSchema,
  ApplicationsForJobsInputSchema,
  type ApplyJobsResult,
  type ApplicationListPage,
  type ApplicationRow,
  type ApplicationDetails,
} from "./applications";

/** Apply's work records are separate from the Applications tracker. */
export const APPLICATION_COMMANDS = {
  apply_to_jobs: {
    effect: "external",
    description:
      "Queues approved resumes for Apply, one job, selected/page ids, or all matching an Approved (stage=resume) filter except exclusions. Returns immediately; queued, filled and sent differ. Record the person's instruction first. Fill in for me leaves Send to the person; Send for me permits sending, with the same send guards as the screen. Existing queued, prepared or sent work is never duplicated or upgraded.",
    input: ApplyJobsInputSchema,
  },
  list_application_work: {
    effect: "read",
    description:
      "One page of Apply work: queued, running, needs_you, ready (filled; not sent), submitted, stopped or failed. Use list_applications for tracker statuses. Pass nextCursor back as cursor.",
    input: ApplicationListQuerySchema,
  },
  applications_for_jobs: {
    effect: "read",
    description:
      "The Apply work records for these numeric job ids. Their id is an application work id, used by get_application_details, open_application, stop_application and send_application.",
    input: ApplicationsForJobsInputSchema,
  },
  get_application_details: {
    effect: "read",
    description:
      "One Apply work id: progress, blocker, what was filled in or sent, attached resume and the site's actual submission receipt. A tracker status is not proof of sending.",
    input: ApplicationTargetSchema,
  },
  open_application: {
    effect: "local_write",
    description:
      "Opens the exact retained form for a ready or needs_you application work id in the app browser. Does not send. Returns false if the form is unavailable.",
    input: ApplicationTargetSchema,
  },
  stop_application: {
    effect: "local_write",
    description:
      "Stops one queued, running, ready or needs_you application work id and closes its tab. Sent applications remain sent. Retry a stopped job with Apply; stop cannot unsend.",
    input: ApplicationTargetSchema,
  },
  send_application: {
    effect: "external",
    description:
      "Sends one already-filled, ready application work id through the app's send guards. Record the person's explicit send instruction first; never change settings to authorize it. True means the site confirmed submission. False requires checking get_application_details; never blindly retry an uncertain send.",
    input: ApplicationTargetSchema,
  },
} as const satisfies Record<string, AppCommandDefinition>;

export type ApplicationCommandName = keyof typeof APPLICATION_COMMANDS;
export type ApplicationCommandInput<K extends ApplicationCommandName> = z.input<
  (typeof APPLICATION_COMMANDS)[K]["input"]
>;
export interface ApplicationCommandOutputs {
  apply_to_jobs: ApplyJobsResult;
  list_application_work: ApplicationListPage;
  applications_for_jobs: ApplicationRow[];
  get_application_details: ApplicationDetails | null;
  open_application: boolean;
  stop_application: boolean;
  send_application: boolean;
}
