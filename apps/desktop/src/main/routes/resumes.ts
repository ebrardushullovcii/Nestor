import {
  RESUMES_EXPORT_PDF_CHANNEL,
  RESUMES_PREVIEW_CHANNEL,
  RESUMES_RUN_CHANNEL,
  ResumePdfExportInputSchema,
  ResumePreviewInputSchema,
  type ResumeCommandName,
  type ResumePdfExportResult,
  type ResumePreviewResult,
} from "@nestor/contracts";
import {
  createResumeCommandRunner,
  type RunResumeCommand,
} from "@nestor/job-finder/resumes";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { getResumeService } from "../services/resumes";
import {
  buildResumeExportDefaultPath,
  chooseResumeExportPath,
} from "./resume-export-path";

/**
 * The resume service starts with the workspace's AI client and renderer;
 * loaded lazily so registering these routes at startup stays cheap.
 */
async function resumeService() {
  const { getJobFinderWorkspaceService } =
    await import("../services/job-finder");
  await getJobFinderWorkspaceService();
  return getResumeService();
}

let runner: RunResumeCommand | null = null;

/** The same commands the Shortlisted screen uses; the Assistant calls this. */
export function runResumeCommand<K extends ResumeCommandName>(
  name: K,
  input: unknown,
) {
  runner ??= createResumeCommandRunner(resumeService);
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
    return runResumeCommand(String(name) as ResumeCommandName, input);
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
      const { jobId } = ResumePdfExportInputSchema.parse(payload);
      const service = await resumeService();
      const { job, resume } = service.get(jobId);
      const level = resume?.level ?? "tailored";
      const target = await chooseResumeExportPath(
        event.sender,
        buildResumeExportDefaultPath(
          level === "original" ? "Resume" : "Tailored Resume",
          job.title,
          job.company,
        ),
      );
      if (!target) return { outputPath: null };
      return { outputPath: await service.exportPdf(jobId, target) };
    },
  );
}
