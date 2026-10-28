import { createResumeStore, type JobStore } from "@nestor/db/job-store";
import {
  RESUME_COMMANDS,
  JOB_COMMANDS,
  JobListQuerySchema,
  isResumeTemplateApplyEligible,
  type ResumeTemplateDefinition,
  type JobListQueryInput,
  type ShortlistedPage,
  type ResumeCommandName,
  type ResumeCommandOutputs,
  type ResumePdfExportResult,
  type AssistantJobListPage,
  type JobListPage,
  type JobStageCounts,
  JobFilterSchema,
  type JobFilterInput,
} from "@nestor/contracts";
import type { z } from "zod";

import type { ResumeService } from "./resume-service";
interface ResumeCommandReads {
  list(query: JobListQueryInput): ShortlistedPage;
  get(jobId: number): ResumeCommandOutputs["get_resume"];
}

/** Chat uses screen names; the preload commands retain exact stored stages. */
export const ASSISTANT_JOB_COMMANDS = {
  ...JOB_COMMANDS,
  list_jobs: {
    ...JOB_COMMANDS.list_jobs,
    description:
      "One page of jobs with resumeStatus and current counts. stage shortlisted lists all Shortlisted jobs, including writing, to-review and approved resumes. stage resume lists only approved jobs. Other stages: found (Find jobs), hidden, applied. Filters and nextCursor paginate the combined list.",
  },
  count_jobs: {
    ...JOB_COMMANDS.count_jobs,
    description:
      "Exact matching count. stage shortlisted includes approved jobs on Shortlisted; stage resume counts only approved jobs. Move selections still use exact stored stages.",
  },
  stage_counts: {
    ...JOB_COMMANDS.stage_counts,
    description:
      "Current screen counts: shortlisted includes writing, to-review and approved jobs; approvedResumes is its approved subset.",
  },
};

export const ASSISTANT_RESUME_COMMANDS = {
  ...RESUME_COMMANDS,
  list_shortlisted: {
    ...RESUME_COMMANDS.list_shortlisted,
    description:
      ASSISTANT_JOB_COMMANDS.list_jobs.description +
      " Use get_resume for the full draft, level and edit revision.",
  },
};

/** Shortlisted includes both the review and approved tabs; approval is a subset. */
export function assistantJobCounts({
  resume: approvedResumes,
  ...counts
}: JobStageCounts) {
  return {
    ...counts,
    shortlisted: counts.shortlisted + approvedResumes,
    approvedResumes,
  };
}

export function readAssistantJobs(
  store: JobStore,
  input: JobListQueryInput,
): JobListPage {
  const query = JobListQuerySchema.parse(input);
  return store.listJobs(query, query.stage === "shortlisted" ? ["resume"] : []);
}

export function countAssistantJobs(
  store: JobStore,
  input: JobFilterInput,
): number {
  const filter = JobFilterSchema.parse(input);
  return store.countJobs(
    filter,
    filter.stage === "shortlisted" ? ["resume"] : [],
  );
}

/** The same indexed status lookup as Shortlisted, bounded to this chat page. */
export function assistantJobListPage(
  store: JobStore,
  page: JobListPage,
): AssistantJobListPage {
  const statuses = createResumeStore(store).statuses(
    page.rows.map((row) => row.id),
  );
  return {
    ...page,
    counts: assistantJobCounts(page.counts),
    rows: page.rows.map(({ id, stage, title, company, location, fitScore }) => {
      const resume = statuses.get(id);
      return {
        id,
        stage,
        title,
        company,
        location,
        fitScore,
        resumeStatus: resume?.approvedAt
          ? "approved"
          : resume?.state === "ready"
            ? "to_review"
            : resume?.state === "queued" || resume?.state === "writing"
              ? "writing"
              : "none",
        resumeError: resume?.error?.slice(0, 300) ?? null,
      };
    }),
  };
}

type Handlers = {
  [K in ResumeCommandName]: (
    input: z.output<(typeof RESUME_COMMANDS)[K]["input"]>,
  ) => ResumeCommandOutputs[K] | Promise<ResumeCommandOutputs[K]>;
};

export type RunResumeCommand = <K extends ResumeCommandName>(
  name: K,
  input: unknown,
) => Promise<ResumeCommandOutputs[K]>;

/**
 * Runs one Shortlisted command after checking its input; the screen and the
 * Assistant both call this.
 */
export function createResumeCommandRunner(
  service: () => Promise<ResumeService>,
  read: () => Promise<ResumeCommandReads> = service,
  exportPdf?: (
    resumes: ResumeService,
    jobId: number,
  ) => Promise<ResumePdfExportResult>,
): RunResumeCommand {
  const handlers: Handlers = {
    list_shortlisted: async (input) => (await read()).list(input),
    get_resume: async ({ jobId }) => (await read()).get(jobId),
    save_resume: async ({ jobId, draft, expectedUpdatedAt, allowRemoval }) =>
      (await service()).saveDraft(
        jobId,
        draft,
        expectedUpdatedAt,
        allowRemoval,
      ),
    edit_resume: async (input) => (await service()).edit(input),
    set_resume_level: async ({ jobId, level }) =>
      (await service()).setLevel(jobId, level),
    undo_resume_level: async ({ jobId, changeId }) =>
      (await service()).undoLevel(jobId, changeId),
    rewrite_resume: async ({ jobId }) => (await service()).rewrite(jobId),
    approve_resume: async ({ jobId }) => (await service()).approve(jobId),
    export_resume_pdf: async ({ jobId }) => {
      if (!exportPdf)
        throw new Error("PDF export needs the app's file chooser.");
      return exportPdf(await service(), jobId);
    },
    undo_resume_change: async ({ jobId, changeId }) =>
      (await service()).undoChange(jobId, changeId),
  };

  return async (name, input) => {
    if (!Object.hasOwn(RESUME_COMMANDS, name)) {
      throw new Error(`There is no resume command named ${String(name)}.`);
    }
    const parsed: unknown = RESUME_COMMANDS[name].input.parse(input ?? {});
    const handler = handlers[name] as (value: unknown) => unknown;
    return (await handler(parsed)) as ResumeCommandOutputs[typeof name];
  };
}

/** Store-only reads shared by the screen, chat and the running resume service. */
export function createResumeCommandReads(
  store: JobStore,
  templates: () => readonly ResumeTemplateDefinition[],
): ResumeCommandReads {
  const resumes = createResumeStore(store);
  return {
    list(query) {
      const page = store.listJobs(JobListQuerySchema.parse(query));
      const ids = page.rows.map((row) => row.id);
      const statuses = resumes.statuses(ids);
      const applications = resumes.openApplications(ids);
      return {
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          resume: statuses.get(row.id) ?? null,
          application: applications.get(row.id) ?? null,
        })),
      };
    },
    get(jobId) {
      const job = store.getJob(jobId);
      if (!job) throw new Error("That job no longer exists.");
      return {
        job,
        resume: resumes.get(jobId),
        templates: templates()
          .filter(isResumeTemplateApplyEligible)
          .map(({ id, label }) => ({ id, label })),
      };
    },
  };
}
