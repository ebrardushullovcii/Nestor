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
 * Where an export writes. A person picks the file in the save dialog; a
 * test-API run, which cannot answer a native dialog, saves under the app's own
 * data folder so the export still writes a real file.
 */
export async function chooseSavePath(
  sender: WebContents | null,
  defaultPath: string,
  kind: { name: string; extension: string; title: string },
): Promise<string | null> {
  if (isDesktopTestApiEnabled()) {
    const directory = path.join(app.getPath("userData"), "exports");
    await mkdir(directory, { recursive: true });
    return path.join(directory, path.basename(defaultPath));
  }
  const options: SaveDialogOptions = {
    defaultPath,
    filters: [{ name: kind.name, extensions: [kind.extension] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
    title: kind.title,
  };
  const browserWindow = sender ? BrowserWindow.fromWebContents(sender) : null;
  const result = browserWindow
    ? await dialog.showSaveDialog(browserWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  const suffix = `.${kind.extension}`;
  return result.filePath.toLowerCase().endsWith(suffix)
    ? result.filePath
    : `${result.filePath}${suffix}`;
}

/** Download PDF: the resume, named after the job. */
export function chooseResumeExportPath(
  sender: WebContents | null,
  defaultPath: string,
): Promise<string | null> {
  // Not "tailored": the same dialog opens for a document nothing could be
  // tailored for.
  return chooseSavePath(sender, defaultPath, {
    name: "PDF",
    extension: "pdf",
    title: "Export resume PDF",
  });
}
