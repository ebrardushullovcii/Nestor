import { getJobStore } from "../services/job-store";
import { listLocalResumeTemplates } from "../../shared/job-finder-resume-renderer";
import {
  RESUMES_EXPORT_PDF_CHANNEL,
  RESUMES_PREVIEW_CHANNEL,
  RESUMES_RUN_CHANNEL,
  ResumePreviewInputSchema,
  type ResumeCommandName,
  type ResumePdfExportResult,
  type ResumePreviewResult,
} from "@nestor/contracts";
import type { RunResumeCommand } from "@nestor/job-finder/resumes";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import {
  buildResumeExportDefaultPath,
  chooseResumeExportPath,
} from "./resume-export-path";

/**
 * The resume service starts with the Job Finder runtime (AI client and
 * renderer); it and the resume code load on first use, so registering these
 * routes at startup stays cheap.
 */
async function resumeService() {
  const { startJobFinderRuntime } = await import("../services/job-finder");
  await startJobFinderRuntime();
  const { getResumeService } = await import("../services/resumes");
  return getResumeService();
}

let runner: RunResumeCommand | null = null;

async function exportResumePdf(
  service: Awaited<ReturnType<typeof resumeService>>,
  jobId: number,
  sender: WebContents | null = null,
): Promise<ResumePdfExportResult> {
  const { job, resume } = service.get(jobId);
  const target = await chooseResumeExportPath(
    sender,
    buildResumeExportDefaultPath(
      resume?.level === "original"
        ? "Resume"
        : `${resume?.level === "light" ? "Light" : resume?.level === "aggressive" ? "Aggressive" : "Tailored"} Resume`,
      job.title,
      job.company,
    ),
  );
  if (!target) return { outputPath: null };
  return { outputPath: await service.exportPdf(jobId, target) };
}

async function createRunner(sender: WebContents | null = null) {
  const { createResumeCommandRunner, createResumeCommandReads } =
    await import("@nestor/job-finder/resumes");
  return createResumeCommandRunner(
    resumeService,
    () =>
      Promise.resolve(
        createResumeCommandReads(getJobStore(), listLocalResumeTemplates),
      ),
    (service, jobId) => exportResumePdf(service, jobId, sender),
  );
}

/** The same commands the Shortlisted screen uses; the Assistant calls this. */
export async function runResumeCommand<K extends ResumeCommandName>(
  name: K,
  input: unknown,
  sender: WebContents | null = null,
) {
  // Bind the initiating window per export; concurrent windows must not share a sender.
  if (sender && name === "export_resume_pdf")
    return (await createRunner(sender))(name, input);
  runner ??= await createRunner();
  return runner(name, input);
}

function fromMainFrame(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame;
}

export function registerResumeRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(RESUMES_RUN_CHANNEL, (event, request: unknown) => {
    if (!fromMainFrame(event)) throw new Error("Not allowed.");
    const { name, input } = (request ?? {}) as {
      name?: unknown;
      input?: unknown;
    };
    return runResumeCommand(
      String(name) as ResumeCommandName,
      input,
      event.sender,
    );
  });

  // The live preview renders every few keystrokes; a newer render for the
  // same window replaces the one still running.
  const previews = new Map<number, AbortController>();
  ipcMain.handle(
    RESUMES_PREVIEW_CHANNEL,
    async (event, payload: unknown): Promise<ResumePreviewResult> => {
      if (!fromMainFrame(event)) throw new Error("Not allowed.");
      const { jobId, draft } = ResumePreviewInputSchema.parse(payload);
      previews.get(event.sender.id)?.abort();
      const controller = new AbortController();
      previews.set(event.sender.id, controller);
      try {
        const service = await resumeService();
        const preview = await service.preview(jobId, draft, controller.signal);
        return { html: preview.html, pageCount: preview.pageCount ?? null };
      } finally {
        if (previews.get(event.sender.id) === controller) {
          previews.delete(event.sender.id);
        }
      }
    },
  );

  ipcMain.handle(
    RESUMES_EXPORT_PDF_CHANNEL,
    async (event, payload: unknown): Promise<ResumePdfExportResult> => {
      if (!fromMainFrame(event)) throw new Error("Not allowed.");
      return runResumeCommand("export_resume_pdf", payload, event.sender);
    },
  );
}
