import {
  RESUMES_EXPORT_PDF_CHANNEL,
  RESUMES_PREVIEW_CHANNEL,
  RESUMES_RUN_CHANNEL,
  type ResumeCommandInput,
  type ResumeCommandName,
  type ResumeCommandOutput,
  type ResumeDraft,
  type ResumePdfExportResult,
  type ResumePreviewResult,
} from "@nestor/contracts";

/** The renderer's bridge to Shortlisted: the resume commands, preview and PDF. */
export interface DesktopResumesBridge {
  run<K extends ResumeCommandName>(
    name: K,
    input: ResumeCommandInput<K>,
  ): Promise<ResumeCommandOutput<K>>;
  preview(jobId: number, draft: ResumeDraft): Promise<ResumePreviewResult>;
  /** Opens the save dialog and writes the PDF there. */
  exportPdf(jobId: number): Promise<ResumePdfExportResult>;
}

export function createResumesBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): DesktopResumesBridge {
  return {
    run: (name, input) =>
      ipc.invoke(RESUMES_RUN_CHANNEL, { name, input }) as Promise<
        ResumeCommandOutput<typeof name>
      >,
    preview: (jobId, draft) =>
      ipc.invoke(RESUMES_PREVIEW_CHANNEL, {
        jobId,
        draft,
      }) as Promise<ResumePreviewResult>,
    exportPdf: (jobId) =>
      ipc.invoke(RESUMES_EXPORT_PDF_CHANNEL, {
        jobId,
      }) as Promise<ResumePdfExportResult>,
  };
}
