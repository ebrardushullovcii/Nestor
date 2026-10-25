import { z } from "zod";

import { ApplicationWorkStateSchema } from "./applications";
import { JobIdSchema, type JobDetail } from "./jobs";

/**
 * Where an application stands. `applying` covers everything before it is
 * sent (Apply's own work state says which step); the rest is the hiring
 * side, set by the person or, for `applied`, by the send itself.
 */
export const trackerStatusValues = [
  "applying",
  "applied",
  "replied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "no_reply",
] as const;
export const TrackerStatusSchema = z.enum(trackerStatusValues);
export type TrackerStatus = z.infer<typeof TrackerStatusSchema>;

/** Statuses that end an application; the board keeps them in one column. */
export const CLOSED_TRACKER_STATUSES: readonly TrackerStatus[] = [
  "rejected",
  "withdrawn",
  "no_reply",
];

export type TrackerStatusCounts = Record<TrackerStatus, number>;

export const TRACKER_STATUS_LABEL: Record<TrackerStatus, string> = {
  applying: "Applying",
  applied: "Applied",
  replied: "Heard back",
  assessment: "Assessment",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  no_reply: "No reply",
};

/** `recent`: last status change first. `applied`: newest sent first. `next`: soonest interview or reminder first. */
export const trackerSortValues = ["recent", "applied", "next"] as const;
export const TrackerSortSchema = z.enum(trackerSortValues);
export type TrackerSort = z.infer<typeof TrackerSortSchema>;

/** Which applications a list or board column shows; every field is indexed. */
export const TrackerFilterSchema = z
  .object({
    /** Any of these; empty means all. */
    statuses: z.array(TrackerStatusSchema).max(9).default([]),
    tag: z.string().max(60).nullable().default(null),
    /** Words in the title, company or location. */
    text: z.string().max(200).default(""),
    /** Only applications with a reminder or interview due by now. */
    due: z.boolean().default(false),
    /** Only `applied` ones with no news for this many days. */
    quietForDays: z.number().int().min(1).max(365).nullable().default(null),
  })
  .strict();
export type TrackerFilter = z.infer<typeof TrackerFilterSchema>;
export type TrackerFilterInput = z.input<typeof TrackerFilterSchema>;

export const TrackerListQuerySchema = TrackerFilterSchema.extend({
  sort: TrackerSortSchema.default("recent"),
  cursor: z.string().max(400).nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type TrackerListQueryInput = z.input<typeof TrackerListQuerySchema>;

export const TrackerRowSchema = z.object({
  id: JobIdSchema,
  title: z.string(),
  company: z.string(),
  location: z.string(),
  status: TrackerStatusSchema,
  statusAt: z.string(),
  /** Apply's step while `applying`; null once sent or when added by hand. */
  work: ApplicationWorkStateSchema.nullable(),
  workError: z.string().nullable(),
  appliedAt: z.string().nullable(),
  /** The next interview or reminder still open, if any. */
  nextAt: z.string().nullable(),
  nextTitle: z.string().nullable(),
  tags: z.array(z.string()),
});
export type TrackerRow = z.infer<typeof TrackerRowSchema>;

export interface TrackerPage {
  rows: TrackerRow[];
  nextCursor: string | null;
  /** Rows matching the filter, counted up to 1000. */
  total: number;
  totalCapped: boolean;
  counts: TrackerStatusCounts;
}

export const trackerEventKindValues = [
  "status",
  "reply",
  "interview",
  "reminder",
  "note",
] as const;
export const TrackerEventKindSchema = z.enum(trackerEventKindValues);
export type TrackerEventKind = z.infer<typeof TrackerEventKindSchema>;

/** One thing that happened, or is due, on an application. */
export const TrackerEventSchema = z.object({
  id: z.number().int().positive(),
  kind: TrackerEventKindSchema,
  at: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  /** Interviews and reminders: when. */
  dueAt: z.string().nullable(),
  /** Interviews and reminders: when it was done or dropped. */
  doneAt: z.string().nullable(),
  /** Interviews: where, or the meeting link. */
  place: z.string().nullable(),
});
export type TrackerEvent = z.infer<typeof TrackerEventSchema>;

export interface TrackedApplication {
  job: JobDetail;
  row: TrackerRow;
  /** Newest first. */
  events: TrackerEvent[];
}

const IdsSchema = z.array(JobIdSchema).min(1).max(1000);

export const AddTrackerEventInputSchema = z
  .object({
    jobId: JobIdSchema,
    kind: z.enum(["reply", "interview", "reminder", "note"]),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(5000).nullable().default(null),
    dueAt: z.string().datetime({ offset: true }).nullable().default(null),
    place: z.string().max(500).nullable().default(null),
  })
  .strict();
export type AddTrackerEventInput = z.input<typeof AddTrackerEventInputSchema>;

export const UpdateTrackerEventInputSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(5000).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    place: z.string().max(500).nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();
export type UpdateTrackerEventInput = z.input<
  typeof UpdateTrackerEventInputSchema
>;

export const TrackerViewSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(60),
  filter: TrackerFilterSchema,
  sort: TrackerSortSchema,
});
export type TrackerView = z.infer<typeof TrackerViewSchema>;

/** The tracker's commands; the screen and the Assistant both call these. */
export const TRACKER_COMMANDS = {
  list_applications: {
    description:
      "One page of applications with their status (applying, applied, replied, assessment, interview, offer, rejected, withdrawn, no_reply), Apply's step while applying, tags and the next interview or reminder. Filter by statuses, tag, text, due follow-ups or applications quiet for some days.",
    input: TrackerListQuerySchema,
  },
  get_application: {
    description:
      "One application in full: the listing, its status and its history of replies, interviews, reminders, notes and status changes.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  set_status: {
    description:
      "Moves applications to a status after they were sent: replied, assessment, interview, offer, rejected, withdrawn, no_reply or back to applied. Returns an undoId for undo_status.",
    input: z
      .object({
        ids: IdsSchema,
        status: TrackerStatusSchema.exclude(["applying"]),
      })
      .strict(),
  },
  undo_status: {
    description: "Puts back the statuses one set_status changed.",
    input: z.object({ undoId: z.number().int().positive() }).strict(),
  },
  add_event: {
    description:
      "Logs a reply, schedules an interview, sets a reminder or adds a note on one application.",
    input: AddTrackerEventInputSchema,
  },
  update_event: {
    description:
      "Edits a reply, interview, reminder or note, or marks an interview or reminder done (done: true) or open again.",
    input: UpdateTrackerEventInputSchema,
  },
  delete_event: {
    description: "Deletes a reply, interview, reminder or note.",
    input: z.object({ id: z.number().int().positive() }).strict(),
  },
  set_tags: {
    description: "Adds and removes tags on applications.",
    input: z
      .object({
        ids: IdsSchema,
        add: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
        remove: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      })
      .strict(),
  },
  list_tags: {
    description: "Every tag in use, with how many applications carry it.",
    input: z.object({}).strict(),
  },
  list_views: {
    description: "The saved views: a named filter and sort.",
    input: z.object({}).strict(),
  },
  save_view: {
    description:
      "Saves a filter and sort under a name; the same name replaces it.",
    input: z
      .object({
        name: z.string().trim().min(1).max(60),
        filter: TrackerFilterSchema,
        sort: TrackerSortSchema.default("recent"),
      })
      .strict(),
  },
  delete_view: {
    description: "Deletes a saved view.",
    input: z.object({ id: z.number().int().positive() }).strict(),
  },
} as const;

export type TrackerCommandName = keyof typeof TRACKER_COMMANDS;
export type TrackerCommandInput<K extends TrackerCommandName> = z.input<
  (typeof TRACKER_COMMANDS)[K]["input"]
>;
/** A command's input after parsing, defaults filled in. */
export type TrackerCommandParsedInput<K extends TrackerCommandName> = z.output<
  (typeof TRACKER_COMMANDS)[K]["input"]
>;

export interface TrackerCommandOutputs {
  list_applications: TrackerPage;
  get_application: TrackedApplication | null;
  set_status: { changed: number; undoId: number | null };
  undo_status: { changed: number };
  add_event: TrackerEvent;
  update_event: TrackerEvent;
  delete_event: { deleted: boolean };
  set_tags: { changed: number };
  list_tags: { tags: { tag: string; count: number }[] };
  list_views: { views: TrackerView[] };
  save_view: TrackerView;
  delete_view: { deleted: boolean };
}
export type TrackerCommandOutput<K extends TrackerCommandName> =
  TrackerCommandOutputs[K];

export const TRACKER_RUN_CHANNEL = "tracker:run";
export const TRACKER_EXPORT_CHANNEL = "tracker:export";
export const TrackerExportInputSchema = TrackerFilterSchema.extend({
  sort: TrackerSortSchema.default("recent"),
}).strict();
export type TrackerExportInput = z.input<typeof TrackerExportInputSchema>;
/** What Export did: the file it wrote and how many rows, or null when cancelled. */
export interface TrackerExportResult {
  outputPath: string | null;
  rows: number;
}
