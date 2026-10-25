import {
  getAiProviderAccessFailure,
  isAiProviderRateLimited,
  isAiServiceBusy,
} from "@nestor/ai-providers";
import {
  isResumeTemplateApplyEligible,
  JobListQuerySchema,
  type ResumeCommandOutputs,
  type JobDetail,
  type JobListQueryInput,
  type ResumeDraft,
  type ResumeLevel,
  type ShortlistedPage,
} from "@nestor/contracts";
import { createAdaptiveConcurrencyLimiter } from "@nestor/core";
import {
  createResumeStore,
  type JobStore,
  type ResumeStore,
} from "@nestor/db/job-store";

import {
  createDefaultListingHtmlFetcher,
  createModelListingPageReader,
  readListingDetail,
  type ListingHtmlFetcher,
} from "../internal/listing-detail-enrichment";
import { normalizeResumeDraftEntryOrdering } from "../internal/resume-entry-ordering";
import { buildResumeRenderDocument } from "../internal/resume-workspace-helpers";
import type { JobFinderDocumentManager } from "../internal/workspace-service-contracts";
import {
  resolveProfileResumeLevel,
  toResumeJob,
  writeResume,
  type ResumeWriterDeps,
  type ResumeWriterInputs,
} from "./write-resume";

/** Resumes written at once; it drops toward two when the AI says it is busy. */
const MAX_WRITERS = 6;
/** How long a write the AI turned away waits before the queue tries again. */
const BUSY_RETRY_MS = 30_000;
/** Below this the listing is a card, and the resume reads the posting first. */
const THIN_LISTING_CHARS = 400;

export interface ResumeServiceDeps extends ResumeWriterDeps {
  store: JobStore;
  documentManager: ResumeWriterDeps["documentManager"] &
    Pick<JobFinderDocumentManager, "renderResumePreview">;
  /** The person's profile and settings, read fresh for each write. */
  readInputs(): Promise<ResumeWriterInputs>;
  fetchListingHtml?: ListingHtmlFetcher;
}

export type ResumeView = ResumeCommandOutputs["get_resume"];

export type ResumeService = ReturnType<typeof createResumeService>;

/**
 * Writes a resume for every shortlisted job, several at once, and owns the
 * editor's actions on them. Approving one moves its job to the `resume`
 * stage, which is what Apply reads.
 */
export function createResumeService(deps: ResumeServiceDeps) {
  const { store } = deps;
  const resumes: ResumeStore = createResumeStore(store);
  const writers = createAdaptiveConcurrencyLimiter({
    max: MAX_WRITERS,
    min: 2,
  });
  const running = new Map<number, AbortController>();
  const fetchHtml = deps.fetchListingHtml ?? createDefaultListingHtmlFetcher();
  const readPage = createModelListingPageReader(deps.aiClient);
  let stopped = true;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const requireJob = (jobId: number) => {
    const job = store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} is no longer saved.`);
    return job;
  };

  /** A card-only job gets its posting read once, with no fit check. */
  async function withListing(job: JobDetail, signal: AbortSignal) {
    if (job.description.trim().length >= THIN_LISTING_CHARS) return job;
    try {
      const page = await fetchHtml(job.url, { signal });
      if (page.status >= 400) return job;
      const detail =
        (await readListingDetail({
          html: page.html,
          url: page.finalUrl,
          expectedTitle: job.title,
          readPage,
          signal,
        })) ?? null;
      if (!detail || detail.description.length <= job.description.length) {
        return job;
      }
      const facts = {
        ...job.facts,
        keySkills: detail.keySkills ?? job.facts.keySkills,
        responsibilities: detail.responsibilities ?? job.facts.responsibilities,
        minimumQualifications:
          detail.minimumQualifications ?? job.facts.minimumQualifications,
        preferredQualifications:
          detail.preferredQualifications ?? job.facts.preferredQualifications,
      };
      resumes.saveListing(job.id, detail.description, facts);
      return { ...job, description: detail.description, facts };
    } catch (error) {
      if (signal.aborted) throw error;
      return job;
    }
  }

  async function write(jobId: number, controller: AbortController) {
    const release = await writers.acquire();
    const { signal } = controller;
    try {
      if (stopped || signal.aborted) return;
      const inputs = await deps.readInputs();
      const level = resumes.startWriting(
        jobId,
        resolveProfileResumeLevel(inputs),
      );
      if (!level) return;
      try {
        const job =
          level === "original"
            ? requireJob(jobId)
            : await withListing(requireJob(jobId), signal);
        const draft = await writeResume(deps, {
          ...inputs,
          job,
          level,
          signal,
        });
        if (stopped) return;
        resumes.finishWriting(jobId, draft);
        writers.recordSuccess();
      } catch (error) {
        // A write the app's shutdown stopped is picked up at the next start.
        if (stopped) return;
        if (signal.aborted) {
          resumes.requeue(jobId);
        } else if (
          !getAiProviderAccessFailure(error) &&
          (isAiProviderRateLimited(error) || isAiServiceBusy(error))
        ) {
          writers.recordOverload();
          resumes.requeue(jobId);
          retryTimer ??= setTimeout(() => {
            retryTimer = null;
            pump();
          }, BUSY_RETRY_MS);
        } else {
          resumes.failWriting(jobId, describeFailure(error));
        }
      }
    } finally {
      release();
      running.delete(jobId);
      if (!retryTimer) pump();
    }
  }

  function pump() {
    if (stopped) return;
    for (const jobId of resumes.listUnwritten(50)) {
      if (running.has(jobId)) continue;
      const controller = new AbortController();
      running.set(jobId, controller);
      void write(jobId, controller);
    }
  }

  /** A job moved off Shortlisted mid-write stops writing; it resumes if it comes back. */
  function stopWritesThatLeft() {
    if (running.size === 0) return;
    const shortlisted = new Set(
      store
        .sql(
          `SELECT id FROM jobs WHERE stage = 'shortlisted'
         AND id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify([...running.keys()]))
        .map((row) => (row as { id: number }).id),
    );
    for (const [jobId, controller] of running) {
      if (!shortlisted.has(jobId)) controller.abort();
    }
  }

  function setLevel(jobId: number, level: ResumeLevel) {
    const resume = resumes.setLevel(jobId, level);
    pump();
    return resume;
  }

  async function renderPdf(
    jobId: number,
    draft: ResumeDraft,
    targetPath: string | null,
  ) {
    const inputs = await deps.readInputs();
    const artifact = await deps.documentManager.renderResumeArtifact({
      job: toResumeJob(requireJob(jobId)),
      profile: inputs.profile,
      renderDocument: buildResumeRenderDocument(inputs.profile, draft),
      templateId: draft.templateId,
      settings: inputs.settings,
      targetPath,
    });
    if (!artifact.storagePath) throw new Error("The PDF could not be written.");
    return artifact.storagePath;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      resumes.requeue();
      unsubscribe = store.onChange((change) => {
        if (change.cause === "found" || change.cause === "fit") return;
        if (!change.stages.includes("shortlisted")) return;
        stopWritesThatLeft();
        pump();
      });
      pump();
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      for (const controller of running.values()) controller.abort();
    },

    /** Shortlisted (`shortlisted`) or Approved (`resume`) jobs, a page at a time. */
    list(query: JobListQueryInput): ShortlistedPage {
      const page = store.listJobs(JobListQuerySchema.parse(query));
      const statuses = resumes.statuses(page.rows.map((row) => row.id));
      return {
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          resume: statuses.get(row.id) ?? null,
        })),
      };
    },

    get(jobId: number): ResumeView {
      return {
        job: requireJob(jobId),
        resume: resumes.get(jobId),
        templates: deps.documentManager
          .listResumeTemplates()
          .filter(isResumeTemplateApplyEligible)
          .map(({ id, label }) => ({ id, label })),
      };
    },

    saveDraft(jobId: number, draft: ResumeDraft, expectedUpdatedAt: string) {
      // The editor's Reset order asks for date order; saving applies it.
      return resumes.saveDraft(
        jobId,
        normalizeResumeDraftEntryOrdering(draft),
        expectedUpdatedAt,
      );
    },

    setLevel,

    undoLevel(jobId: number) {
      running.get(jobId)?.abort();
      return resumes.undoLevel(jobId);
    },

    /** Writes a failed or finished resume again at its own level. */
    rewrite(jobId: number) {
      const level = resumes.get(jobId)?.level;
      if (!level) {
        pump();
        return null;
      }
      return setLevel(jobId, level);
    },

    async approve(jobId: number) {
      const resume = resumes.get(jobId);
      if (!resume || resume.state !== "ready") {
        throw new Error("This resume is still being written.");
      }
      const pdfPath = resume.draft
        ? await renderPdf(jobId, resume.draft, null)
        : null;
      return resumes.approve(jobId, pdfPath);
    },

    async exportPdf(jobId: number, targetPath: string) {
      const draft = resumes.get(jobId)?.draft;
      if (!draft) throw new Error("This job sends your imported resume file.");
      return renderPdf(jobId, draft, targetPath);
    },

    async preview(jobId: number, draft: ResumeDraft, signal?: AbortSignal) {
      const inputs = await deps.readInputs();
      return deps.documentManager.renderResumePreview(
        {
          job: toResumeJob(requireJob(jobId)),
          profile: inputs.profile,
          renderDocument: buildResumeRenderDocument(inputs.profile, draft),
          templateId: draft.templateId,
          settings: inputs.settings,
        },
        signal,
      );
    },
  };
}

function describeFailure(error: unknown): string {
  const access = getAiProviderAccessFailure(error);
  if (access) return access.message;
  const message = error instanceof Error ? error.message : String(error);
  return `The resume could not be written: ${message}`;
}
