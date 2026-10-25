import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type SaveDialogOptions,
  type WebContents,
} from "electron";

import { isDesktopTestApiEnabled } from "../services/job-finder/test-api";

function sanitizeFileNameSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name the app already gives this document, leading its exported file.
 *
 * A resume nothing could be tailored for is called "Your original resume"
 * everywhere else; the exported file used to carry no document name at all
 * while the screen around it still said "Tailored Resume". One label, derived
 * from one state, reaches the shortlisted row, the documents list and the
 * file on disk.
 */
export function buildResumeExportDefaultPath(
  documentLabel: string,
  jobTitle: string,
  company: string,
): string {
  const titleSegment = sanitizeFileNameSegment(jobTitle) || "Resume";
  const companySegment = sanitizeFileNameSegment(company);
  const labelSegment = sanitizeFileNameSegment(documentLabel);
  const fileName = [labelSegment, titleSegment, companySegment]
    .filter((segment) => segment.length > 0)
    .join(" - ");

  return path.join(app.getPath("documents"), `${fileName}.pdf`);
}
/**
 * Where Download PDF writes. A person picks the file in the save dialog; a
 * test-API run, which cannot answer a native dialog, saves under the app's own
 * data folder so the download still writes a real file.
 */
export async function chooseResumeExportPath(
  sender: WebContents,
  defaultPath: string,
): Promise<{ canceled: boolean; filePath?: string }> {
  if (isDesktopTestApiEnabled()) {
    const directory = path.join(app.getPath("userData"), "exports");
    await mkdir(directory, { recursive: true });
    return {
      canceled: false,
      filePath: path.join(directory, path.basename(defaultPath)),
    };
  }
  const options: SaveDialogOptions = {
    defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
    // Not "tailored": the same dialog opens for a document nothing could be
    // tailored for.
    title: "Export resume PDF",
  };
  const browserWindow = BrowserWindow.fromWebContents(sender);
  return browserWindow
    ? dialog.showSaveDialog(browserWindow, options)
    : dialog.showSaveDialog(options);
}
