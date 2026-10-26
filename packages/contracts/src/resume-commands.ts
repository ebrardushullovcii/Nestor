import { z } from "zod";
import type { AppCommandDefinition } from "./app-commands";

import { JobIdSchema, JobListQuerySchema, type JobDetail } from "./jobs";
import type { ResumeTemplateId } from "./base";
import {
  ResumeDraftSchema,
  ResumeDraftIdentitySchema,
  ResumeDraftSectionSchema,
  ResumeDraftEntrySchema,
  ResumeDraftBulletSchema,
} from "./resume";
import {
  ResumeLevelSchema,
  type ShortlistedRow,
  type StoredResume,
} from "./resumes";

const ResumeBulletEditSchema = z
  .object({
    id: z.string().min(1),
    fields: ResumeDraftBulletSchema.pick({
      text: true,
      included: true,
      locked: true,
    })
      .partial()
      .strict(),
  })
  .strict();
export const EditResumeInputSchema = z
  .object({
    jobId: JobIdSchema,
    expectedUpdatedAt: z.string(),
    identity: ResumeDraftIdentitySchema.partial().strict().optional(),
    layout: ResumeDraftSchema.pick({
      templateId: true,
      targetPageCount: true,
      language: true,
    })
      .partial()
      .strict()
      .optional(),
    sections: z
      .array(
        z
          .object({
            id: z.string().min(1),
            fields: ResumeDraftSectionSchema.pick({
              label: true,
              text: true,
              included: true,
              locked: true,
            })
              .partial()
              .strict()
              .optional(),
            bullets: z.array(ResumeBulletEditSchema).max(100).optional(),
            entries: z
              .array(
                z
                  .object({
                    id: z.string().min(1),
                    fields: ResumeDraftEntrySchema.innerType()
                      .pick({
                        title: true,
                        subtitle: true,
                        location: true,
                        startDate: true,
                        endDate: true,
                        summary: true,
                        included: true,
                        locked: true,
                      })
                      .partial()
                      .strict()
                      .optional(),
                    bullets: z
                      .array(ResumeBulletEditSchema)
                      .max(100)
                      .optional(),
                  })
                  .strict(),
              )
              .max(100)
              .optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export type EditResumeInput = z.infer<typeof EditResumeInputSchema>;

/**
 * Every Shortlisted command. The screen calls them over the preload bridge
 * and the side-chat Assistant calls the same ones as tools, so the
 * descriptions are written for both.
 */
export const RESUME_COMMANDS = {
  list_shortlisted: {
    effect: "read",
    description:
      "One page of shortlisted jobs with each one's resume: stage shortlisted lists the jobs being written or waiting for approval, stage resume lists the approved ones Apply can take. Each row's resume has its level, state (queued, writing, ready, failed) and approvedAt.",
    input: JobListQuerySchema,
  },
  get_resume: {
    effect: "read",
    description:
      "One shortlisted job and its resume: the listing and the resume draft, its level and state, and whether a level change can be undone.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  save_resume: {
    effect: "local_write",
    description:
      "Saves a complete replacement draft. For changing text or fields use edit_resume, which keeps all untouched content. Pass the resume's updatedAt; never guess it. Missing content is rejected unless allowRemoval is true for an explicitly requested removal or full replacement. An approved resume needs approving again.",
    input: z
      .object({
        jobId: JobIdSchema,
        draft: ResumeDraftSchema,
        expectedUpdatedAt: z.string(),
        allowRemoval: z.boolean().optional(),
      })
      .strict(),
  },
  edit_resume: {
    effect: "local_write",
    description:
      "Edits only named saved resume fields, sections, entries or bullets and keeps everything else. Read get_resume first and pass resume.updatedAt exactly; never guess a revision. Sections, entries and bullets use their saved IDs. Approval comes off until approved again. Returns a per-change Undo.",
    input: EditResumeInputSchema,
  },
  set_resume_level: {
    effect: "local_write",
    description:
      "Writes a job's resume again at another level: original (the imported file as it is), light, tailored or aggressive. undo_resume_level puts the previous resume back.",
    input: z.object({ jobId: JobIdSchema, level: ResumeLevelSchema }).strict(),
  },
  undo_resume_level: {
    effect: "local_write",
    description:
      "Puts back the resume, level and approval a level change replaced.",
    input: z
      .object({
        jobId: JobIdSchema,
        changeId: z.string().min(1).max(100).optional(),
      })
      .strict(),
  },
  rewrite_resume: {
    effect: "local_write",
    description:
      "Writes a job's resume again at its own level, for one that failed or that the person wants written again.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  approve_resume: {
    effect: "local_write",
    description:
      "Approves a written resume. The job moves to the resume stage, where Apply can take it at once.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  export_resume_pdf: {
    effect: "local_write",
    description:
      "Exports the job's saved resume as a PDF using the app's Save dialog. The person chooses the file location; cancellation writes nothing. Does not save unsaved typing, approve the resume or apply to the job.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  undo_resume_change: {
    effect: "local_write",
    description:
      "Undoes one saved resume edit or approval by its changeId, including its previous approval and PDF. Later edits or job moves are preserved; a conflict leaves everything unchanged.",
    input: z
      .object({ jobId: JobIdSchema, changeId: z.string().min(1).max(100) })
      .strict(),
  },
} as const satisfies Record<string, AppCommandDefinition>;

export type ResumeCommandName = keyof typeof RESUME_COMMANDS;

export type ResumeCommandInput<K extends ResumeCommandName> = z.input<
  (typeof RESUME_COMMANDS)[K]["input"]
>;

export interface ShortlistedPage {
  rows: ShortlistedRow[];
  nextCursor: string | null;
  total: number;
  totalCapped: boolean;
  counts: Record<
    "found" | "hidden" | "shortlisted" | "resume" | "applied",
    number
  >;
}

export interface ResumeCommandOutputs {
  list_shortlisted: ShortlistedPage;
  get_resume: {
    job: JobDetail;
    resume: StoredResume | null;
    /** The templates a resume can use, by id and name. */
    templates: { id: ResumeTemplateId; label: string }[];
  };
  save_resume: ResumeChangeResult;
  edit_resume: ResumeChangeResult;
  set_resume_level: StoredResume;
  undo_resume_level: StoredResume;
  rewrite_resume: StoredResume | null;
  approve_resume: ResumeChangeResult;
  export_resume_pdf: ResumePdfExportResult;
  undo_resume_change: StoredResume;
}

export interface ResumeChangeResult extends StoredResume {
  /** A durable inverse for this exact edit or approval; null for a no-op. */
  undoId: string | null;
}

export type ResumeCommandOutput<K extends ResumeCommandName> =
  ResumeCommandOutputs[K];

export const ResumePreviewInputSchema = z
  .object({ jobId: JobIdSchema, draft: ResumeDraftSchema })
  .strict();
export const ResumePdfExportInputSchema = z
  .object({ jobId: JobIdSchema })
  .strict();

export const RESUMES_RUN_CHANNEL = "resumes:run";
export const RESUMES_PREVIEW_CHANNEL = "resumes:preview";
export const RESUMES_EXPORT_PDF_CHANNEL = "resumes:export-pdf";

/** The live preview's render of a draft that may not be saved yet. */
export interface ResumePreviewResult {
  html: string;
  pageCount: number | null;
}

/** What Download PDF did: the file it wrote, or null when cancelled. */
export interface ResumePdfExportResult {
  outputPath: string | null;
}
