import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { openJobStore } from "@nestor/db/job-store";
import { RESUMES_EXPORT_PDF_CHANNEL } from "@nestor/contracts";

const { get, exportPdf, choose, start } = vi.hoisted(() => ({
  start: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => ({
    job: { title: "Designer", company: "Example" },
    resume: { level: "light" },
  })),
  exportPdf: vi.fn((_id: number, target: string) => Promise.resolve(target)),
  choose: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../services/job-finder", () => ({
  startJobFinderRuntime: start,
}));
vi.mock("../services/job-store", () => ({ getJobStore: () => jobs }));
vi.mock("../services/resumes", () => ({
  getResumeService: () => ({ get, exportPdf }),
}));
vi.mock("./resume-export-path", () => ({
  chooseResumeExportPath: choose,
  buildResumeExportDefaultPath: () => "/documents/resume.pdf",
}));

import { registerResumeRoutes, runResumeCommand } from "./resumes";
const jobs = openJobStore(":memory:");
afterAll(() => jobs.close());

beforeEach(() => {
  vi.clearAllMocks();
  choose.mockResolvedValue("/chosen/resume.pdf");
});

it("keeps store reads independent of the AI runtime after adding export", async () => {
  await expect(runResumeCommand("get_resume", { jobId: 99 })).rejects.toThrow(
    "no longer exists",
  );
  expect(start).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("exports the saved resume through the same command from chat and Download PDF", async () => {
  expect(await runResumeCommand("export_resume_pdf", { jobId: 12 })).toEqual({
    outputPath: "/chosen/resume.pdf",
  });
  expect(exportPdf).toHaveBeenCalledWith(12, "/chosen/resume.pdf");

  const handle = vi.fn<IpcMain["handle"]>();
  registerResumeRoutes({ handle } as Pick<IpcMain, "handle"> as IpcMain);
  const download = handle.mock.calls.find(
    ([channel]) => channel === RESUMES_EXPORT_PDF_CHANNEL,
  )![1];
  const frame = {};
  const event = {
    senderFrame: frame,
    sender: { mainFrame: frame },
  } as IpcMainInvokeEvent;
  expect(await download(event, { jobId: 12 })).toEqual({
    outputPath: "/chosen/resume.pdf",
  });
  expect(exportPdf).toHaveBeenCalledTimes(2);
});

it("leaves the resume and file alone when the person cancels", async () => {
  choose.mockResolvedValue(null);
  expect(await runResumeCommand("export_resume_pdf", { jobId: 12 })).toEqual({
    outputPath: null,
  });
  expect(exportPdf).not.toHaveBeenCalled();
});

it("rejects a model-supplied destination before opening a dialog", async () => {
  await expect(
    runResumeCommand("export_resume_pdf", {
      jobId: 12,
      outputPath: "/unapproved/path.pdf",
    }),
  ).rejects.toThrow();
  expect(choose).not.toHaveBeenCalled();
  expect(exportPdf).not.toHaveBeenCalled();
});

it("reports a failed export instead of claiming a file was saved", async () => {
  exportPdf.mockRejectedValueOnce(new Error("Disk full"));
  await expect(
    runResumeCommand("export_resume_pdf", { jobId: 12 }),
  ).rejects.toThrow("Disk full");
});
