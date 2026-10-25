import { z } from "zod";

import { JobIdSchema, JobListQuerySchema, type JobDetail } from "./jobs";
import type { ResumeTemplateId } from "./base";
import { ResumeDraftSchema } from "./resume";
import {
  ResumeLevelSchema,
  type ShortlistedRow,
  type StoredResume,
} from "./resumes";

/**
 * Every Shortlisted command. The screen calls them over the preload bridge
 * and the side-chat Assistant calls the same ones as tools, so the
 * descriptions are written for both.
 */
export const RESUME_COMMANDS = {
  list_shortlisted: {
    description:
      "One page of shortlisted jobs with each one's resume: stage shortlisted lists the jobs being written or waiting for approval, stage resume lists the approved ones Apply can take. Each row's resume has its level, state (queued, writing, ready, failed) and approvedAt.",
    input: JobListQuerySchema,
  },
  get_resume: {
    description:
      "One shortlisted job and its resume: the listing and the resume draft, its level and state, and whether a level change can be undone.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  save_resume: {
    description:
      "Saves an edited resume draft. Pass the updatedAt you read; a newer save wins. An approved resume needs approving again.",
    input: z
      .object({
        jobId: JobIdSchema,
        draft: ResumeDraftSchema,
        expectedUpdatedAt: z.string(),
      })
      .strict(),
  },
  set_resume_level: {
    description:
      "Writes a job's resume again at another level: original (the imported file as it is), light, tailored or aggressive. undo_resume_level puts the previous resume back.",
    input: z.object({ jobId: JobIdSchema, level: ResumeLevelSchema }).strict(),
  },
  undo_resume_level: {
    description:
      "Puts back the resume, level and approval a level change replaced.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  rewrite_resume: {
    description:
      "Writes a job's resume again at its own level, for one that failed or that the person wants written again.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
  approve_resume: {
    description:
      "Approves a written resume. The job moves to the resume stage, where Apply can take it at once.",
    input: z.object({ jobId: JobIdSchema }).strict(),
  },
} as const;

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
  save_resume: StoredResume;
  set_resume_level: StoredResume;
  undo_resume_level: StoredResume;
  rewrite_resume: StoredResume | null;
  approve_resume: StoredResume;
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
