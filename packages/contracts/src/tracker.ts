import { z } from "zod";

import type { AppCommandDefinition } from "./app-commands";

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

/** Navigation applies this state to the same list the person uses. */
export const AssistantTrackerViewSchema = TrackerFilterSchema.partial()
  .extend({
    sort: TrackerSortSchema.optional(),
    layout: z.enum(["list", "board"]).optional(),
    density: z.enum(["compact", "comfortable"]).optional(),
    columns: z
      .array(z.enum(["status", "since", "applied", "next", "tags"]))
      .min(1)
      .max(5)
      .refine(
        (columns) => new Set(columns).size === columns.length,
        "Columns must be unique.",
      )
      .optional(),
    selectedIds: z.array(JobIdSchema).max(50).optional(),
    all: z.boolean().optional(),
  })
  .strict();
export type AssistantTrackerView = z.infer<typeof AssistantTrackerViewSchema>;

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

export const TrackerSelectionSchema = z.union([
  z.object({ ids: IdsSchema }).strict(),
  z
    .object({
      filter: TrackerFilterSchema,
      except: z.array(JobIdSchema).max(1000).default([]),
    })
    .strict(),
]);
export type TrackerSelectionInput = z.input<typeof TrackerSelectionSchema>;

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

export const TrackerExportInputSchema = TrackerFilterSchema.extend({
  sort: TrackerSortSchema.default("recent"),
}).strict();
export type TrackerExportInput = z.input<typeof TrackerExportInputSchema>;

/** The tracker's commands; the screen and the Assistant both call these. */
export const TRACKER_COMMANDS = {
  export_applications: {
    effect: "local_write",
    description:
      "Exports the Applications matching this filter and sort as CSV. The person chooses the file. Report only the outputPath returned; null means cancelled.",
    input: TrackerExportInputSchema,
  },
  list_tracker_agenda: {
    effect: "read",
    description:
      "Open interviews and reminders due by the next days, earliest first, including overdue entries. Each entry has its jobId and an ISO date with timezone; display dates in the person's timezone.",
    input: z
      .object({
        days: z.number().int().min(1).max(60).default(14),
        limit: z.number().int().min(1).max(100).default(40),
      })
      .strict(),
  },
  list_applications: {
    effect: "read",
    description:
      "One page of applications with their status (applying, applied, replied, assessment, interview, offer, rejected, withdrawn, no_reply), Apply's step while applying, tags and the next interview or reminder. Filter by statuses, tag, text, due follow-ups or applications quiet for some days.",
    input: TrackerListQuerySchema,
  },
  get_application: {
    effect: "read",
    description:
      "One application in full: the listing, its status and its history of replies, interviews, reminders, notes and status changes.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  set_status: {
    effect: "local_write",
    description:
      "Moves applications by IDs or the whole filtered selection (except some) to a status after they were sent: replied, assessment, interview, offer, rejected, withdrawn, no_reply or back to applied. Returns an undoId for undo_tracker_change.",
    input: z
      .object({
        selection: TrackerSelectionSchema,
        status: TrackerStatusSchema.exclude(["applying"]),
      })
      .strict(),
  },
  undo_tracker_change: {
    effect: "local_write",
    description:
      "Undoes one tracker change by undoId, preserving any later edits. Returns changed and skipped counts.",
    input: z.object({ undoId: z.number().int().positive() }).strict(),
  },
  add_event: {
    effect: "local_write",
    description:
      "Logs a reply, schedules an interview, sets a reminder or adds a note on one application.",
    input: AddTrackerEventInputSchema,
  },
  update_event: {
    effect: "local_write",
    description:
      "Edits a reply, interview, reminder or note, or marks an interview or reminder done (done: true) or open again.",
    input: UpdateTrackerEventInputSchema,
  },
  delete_event: {
    effect: "local_write",
    description: "Deletes a reply, interview, reminder or note.",
    input: z.object({ id: z.number().int().positive() }).strict(),
  },
  set_tags: {
    effect: "local_write",
    description:
      "Adds and removes tags on applications by IDs or the whole filtered selection (except some).",
    input: z
      .object({
        selection: TrackerSelectionSchema,
        add: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
        remove: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      })
      .strict(),
  },
  list_tags: {
    effect: "read",
    description: "Every tag in use, with how many applications carry it.",
    input: z.object({}).strict(),
  },
  list_views: {
    effect: "read",
    description: "The saved views: a named filter and sort.",
    input: z.object({}).strict(),
  },
  save_view: {
    effect: "local_write",
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
    effect: "local_write",
    description: "Deletes a saved view.",
    input: z.object({ id: z.number().int().positive() }).strict(),
  },
} as const satisfies Record<string, AppCommandDefinition>;

export type TrackerCommandName = keyof typeof TRACKER_COMMANDS;
export type TrackerCommandInput<K extends TrackerCommandName> = z.input<
  (typeof TRACKER_COMMANDS)[K]["input"]
>;
/** A command's input after parsing, defaults filled in. */
export type TrackerCommandParsedInput<K extends TrackerCommandName> = z.output<
  (typeof TRACKER_COMMANDS)[K]["input"]
>;

export interface TrackerChange {
  undoId: number | null;
  undoCount: number;
}

export interface TrackerCommandOutputs {
  export_applications: TrackerExportResult;
  list_tracker_agenda: { jobId: number; job: string; event: TrackerEvent }[];
  list_applications: TrackerPage;
  get_application: TrackedApplication | null;
  set_status: { changed: number } & TrackerChange;
  undo_tracker_change: { changed: number; skipped: number };
  add_event: TrackerEvent & TrackerChange;
  update_event: TrackerEvent & TrackerChange;
  delete_event: { deleted: boolean } & TrackerChange;
  set_tags: { changed: number } & TrackerChange;
  list_tags: { tags: { tag: string; count: number }[] };
  list_views: { views: TrackerView[] };
  save_view: TrackerView & TrackerChange;
  delete_view: { deleted: boolean } & TrackerChange;
}
export type TrackerCommandOutput<K extends TrackerCommandName> =
  TrackerCommandOutputs[K];

export { TRACKER_EXPORT_CHANNEL, TRACKER_RUN_CHANNEL } from "./ipc-channels";
/** What Export did: the file it wrote and how many rows, or null when cancelled. */
export interface TrackerExportResult {
  outputPath: string | null;
  rows: number;
}
