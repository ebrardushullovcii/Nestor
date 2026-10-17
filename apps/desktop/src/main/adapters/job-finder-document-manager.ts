import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow } from "electron";
import { createConcurrencyLimiter } from "@nestor/core";
import type { JobFinderDocumentManager } from "@nestor/job-finder";
import JSZip from "jszip";
import { getApplicationDocumentLibrary } from "../services/job-finder/application-document-library-instance";

import { getPdfPageCount } from "./resume-document";
import {
  listLocalResumeTemplates,
  renderResumeTemplateHtml,
  sanitizeSegment,
} from "../../shared/job-finder-resume-renderer";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * A letter on a page: the text, in paragraphs, with ordinary margins.
 *
 * Deliberately plain. A letter that looks like a letter is what an employer
 * expects; anything more decorative reads as generated.
 */
function renderLetterHtml(text: string, authorName: string): string {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/gu, "<br />")}</p>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(authorName)} — cover letter</title>
    <style>
      @page { size: Letter; margin: 22mm 20mm; }
      body {
        font-family: Georgia, "Times New Roman", serif;
        font-size: 11.5pt;
        line-height: 1.55;
        color: #111;
        margin: 0;
      }
      p { margin: 0 0 12pt; }
    </style>
  </head>
  <body>
${paragraphs}
  </body>
</html>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

async function renderLetterDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const runs = paragraph
        .split(/\n/u)
        .map(
          (line, index) =>
            `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`,
        )
        .join("");
      return `<w:p><w:pPr><w:spacing w:after="200" w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="23"/></w:rPr>${runs}</w:r></w:p>`;
    })
    .join("");

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")?.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134"/></w:sectPr></w:body>
</w:document>`,
  );
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

interface CreateLocalJobFinderDocumentManagerOptions {
  outputDirectory: string;
  previewTestMode?: "ok" | "fail_once";
}

function throwIfPreviewAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw new DOMException("Resume preview was superseded.", "AbortError");
}

const pdfRendering = createConcurrencyLimiter(2);

async function renderPdfFromHtml(
  html: string,
  htmlPath: string,
  targetPath: string,
  signal?: AbortSignal,
  onQueueWait?: (milliseconds: number) => void,
): Promise<void> {
  throwIfPreviewAborted(signal);
  const queuedAt = performance.now();
  await pdfRendering.run(async () => {
    onQueueWait?.(performance.now() - queuedAt);
    throwIfPreviewAborted(signal);
    await mkdir(path.dirname(htmlPath), { recursive: true });
    throwIfPreviewAborted(signal);
    const exportWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // A hidden print window that never finishes must fail loudly, not leave
    // "Exporting PDF" on screen for good.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () =>
          reject(
            new Error(
              "The PDF did not finish rendering within 2 minutes. Try approving again.",
            ),
          ),
        120_000,
      ).unref?.();
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          new DOMException("Resume preview was superseded.", "AbortError"),
        );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Cancellation can arrive while the HTML file write is still pending.
    void aborted.catch(() => {});
    const waitFor = <T>(operation: Promise<T>) =>
      Promise.race([operation, deadline, aborted]);
    try {
      await writeFile(htmlPath, html, "utf8");
      throwIfPreviewAborted(signal);
      await waitFor(exportWindow.loadFile(htmlPath));
      await waitFor(
        exportWindow.webContents.executeJavaScript(
          "new Promise((resolve) => { if (document.fonts?.ready) { document.fonts.ready.finally(resolve); } else { resolve(); } })",
          true,
        ),
      );

      const pdfBuffer = await waitFor(
        exportWindow.webContents.printToPDF({
          margins: {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
          },
          printBackground: true,
          pageSize: "Letter",
          preferCSSPageSize: true,
        }),
      );

      throwIfPreviewAborted(signal);
      await writeFile(targetPath, pdfBuffer);
    } finally {
      clearTimeout(deadlineTimer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (!exportWindow.isDestroyed()) {
        exportWindow.destroy();
      }
    }
  });
}

/** Best-effort measurements never hold the live preview for a slow print. */
function createPreviewPageCounter() {
  const counts = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  return async (html: string, signal?: AbortSignal): Promise<number | null> => {
    throwIfPreviewAborted(signal);
    const hash = createHash("sha256").update(html).digest("hex");
    const cached = counts.get(hash);
    if (cached !== undefined) return cached;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let onMeasurementAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onMeasurementAbort = () =>
        reject(
          new DOMException("Page count measurement stopped.", "AbortError"),
        );
      controller.signal.addEventListener("abort", onMeasurementAbort, {
        once: true,
      });
    });
    // Includes time in the queue and PDF parsing; a slow measurement leaves
    // the count unknown instead of delaying the HTML by seconds.
    const timer = setTimeout(() => controller.abort(), 750);
    const measurement = queue.then(async () => {
      throwIfPreviewAborted(controller.signal);
      // A preceding preview may have measured the same HTML while we waited.
      const queuedCount = counts.get(hash);
      if (queuedCount !== undefined) return queuedCount;
      const directory = path.join(
        tmpdir(),
        `nestor-preview-pages-${randomUUID()}`,
      );
      try {
        throwIfPreviewAborted(controller.signal);
        const pdfPath = path.join(directory, "resume.pdf");
        await renderPdfFromHtml(
          html,
          path.join(directory, "resume.html"),
          pdfPath,
          controller.signal,
        );
        const pageCount = await getPdfPageCount(pdfPath);
        throwIfPreviewAborted(controller.signal);
        counts.set(hash, pageCount);
        // Bound the in-memory cache while someone edits many drafts.
        if (counts.size > 64) counts.delete(counts.keys().next().value!);
        return pageCount;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    // Keep all preview windows serial, including cleanup after cancellation.
    queue = measurement.catch(() => {});
    try {
      return await Promise.race([measurement, aborted]);
    } catch {
      throwIfPreviewAborted(signal);
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (onMeasurementAbort)
        controller.signal.removeEventListener("abort", onMeasurementAbort);
    }
  };
}

/** "Jane Doe" + "resume" -> "jane-doe-resume"; never a storage id. */
function employerFacingFileBaseName(
  fullName: string | null | undefined,
  documentKind: "resume" | "cover-letter",
): string {
  const name = sanitizeSegment(fullName ?? "");
  return name ? `${name}-${documentKind}` : documentKind;
}

export function createLocalJobFinderDocumentManager(
  options: CreateLocalJobFinderDocumentManagerOptions,
): JobFinderDocumentManager {
  let shouldFailNextPreview = options.previewTestMode === "fail_once";
  const countPreviewPages = createPreviewPageCounter();

  return {
    listResumeTemplates() {
      return listLocalResumeTemplates();
    },
    async renderResumePreview(input, signal) {
      throwIfPreviewAborted(signal);
      if (shouldFailNextPreview) {
        shouldFailNextPreview = false;
        throw new Error("Preview rendering failed in desktop test mode.");
      }

      const html = renderResumeTemplateHtml(input, { mode: "preview" });
      let pageCount: number | null = null;
      try {
        pageCount = await countPreviewPages(
          renderResumeTemplateHtml(input),
          signal,
        );
      } catch {
        throwIfPreviewAborted(signal);
      }
      throwIfPreviewAborted(signal);

      return { html, warnings: [], pageCount };
    },
    /**
     * Renders the letter through the same window-and-print path the resume
     * export uses, so a letter and the resume beside it are produced the same
     * way and land in the same place.
     *
     * PDF uses the same print path as resume export. DOCX is a real Office
     * Open XML package, not renamed PDF bytes.
     */
    getApprovedApplicationLetter: (jobId, applicationRecordId) =>
      getApplicationDocumentLibrary().getLatestApprovedCoverLetter(
        jobId,
        applicationRecordId,
      ),
    async saveApprovedApplicationLetter(input) {
      // The person's own words: proposed, marked as theirs, then approved.
      const library = getApplicationDocumentLibrary();
      const proposed = await library.propose({
        kind: "cover_letter",
        grounding: {
          profile: input.profile,
          job: input.job,
          applicationRecord: input.applicationRecord,
          question: input.question,
        },
        writtenContent: input.text,
      });
      const theirs = await library.edit(
        proposed.id,
        proposed.revision,
        input.text,
      );
      await library.approve(theirs.id, theirs.revision);
    },
    async renderLetterArtifact(input) {
      // Each document gets its own folder so the file itself can carry the
      // name an employer sees ("jane-doe-cover-letter.pdf") with no storage
      // ids, while two letters for the same person never collide.
      const documentDirectory = path.join(
        options.outputDirectory,
        `${Date.now()}_${randomUUID()}`,
      );
      const baseName = employerFacingFileBaseName(
        input.profile.fullName,
        "cover-letter",
      );
      if (input.fileType === "txt") {
        await mkdir(documentDirectory, { recursive: true });
        const txtPath = path.join(documentDirectory, `${baseName}.txt`);
        await writeFile(txtPath, `${input.text.trim()}\n`, "utf8");
        const sha256 = createHash("sha256")
          .update(await readFile(txtPath))
          .digest("hex");
        return {
          ok: true,
          fileName: path.basename(txtPath),
          mimeType: "text/plain",
          storagePath: txtPath,
          sha256,
        };
      }
      if (input.fileType === "docx") {
        await mkdir(documentDirectory, { recursive: true });
        const docxPath = path.join(documentDirectory, `${baseName}.docx`);
        await writeFile(docxPath, await renderLetterDocx(input.text));
        const sha256 = createHash("sha256")
          .update(await readFile(docxPath))
          .digest("hex");
        return {
          ok: true,
          fileName: path.basename(docxPath),
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          storagePath: docxPath,
          sha256,
        };
      }
      const htmlPath = path.join(documentDirectory, `${baseName}.html`);
      const pdfPath = path.join(documentDirectory, `${baseName}.pdf`);

      await renderPdfFromHtml(
        renderLetterHtml(input.text, input.profile.fullName ?? ""),
        htmlPath,
        pdfPath,
      );
      const sha256 = createHash("sha256")
        .update(await readFile(pdfPath))
        .digest("hex");

      return {
        ok: true,
        fileName: path.basename(pdfPath),
        mimeType: "application/pdf",
        storagePath: pdfPath,
        sha256,
      };
    },
    async renderResumeArtifact(input) {
      // Parallel drafts for the same employer can render in the same
      // millisecond, so uniqueness lives in the folder name and the file keeps
      // the name an employer sees ("jane-doe-resume.pdf").
      const artifactDirectory = path.join(
        options.outputDirectory,
        `${Date.now()}_${randomUUID()}`,
      );
      const artifactBaseName = employerFacingFileBaseName(
        input.profile.fullName,
        "resume",
      );
      const htmlFileName = `${artifactBaseName}.html`;
      const htmlPath = path.join(artifactDirectory, htmlFileName);
      const html = renderResumeTemplateHtml(input);

      const requestedFormat =
        input.settings.resumeFormat === "html" ? "html" : "pdf";

      if (requestedFormat === "html") {
        await mkdir(artifactDirectory, { recursive: true });
        const targetPath = input.targetPath ?? htmlPath;
        const fileName = path.basename(targetPath);
        await writeFile(targetPath, html, "utf8");
        const sha256 = createHash("sha256")
          .update(await readFile(targetPath))
          .digest("hex");

        return {
          fileName,
          storagePath: targetPath,
          sha256,
          format: "html",
          intermediateFileName: fileName,
          intermediateStoragePath: targetPath,
          pageCount: null,
          warnings: [],
        };
      }

      const pdfFileName = `${artifactBaseName}.pdf`;
      const pdfPath =
        input.targetPath ?? path.join(artifactDirectory, pdfFileName);
      const outputFileName = path.basename(pdfPath);
      await renderPdfFromHtml(
        html,
        htmlPath,
        pdfPath,
        input.signal,
        input.onQueueWait,
      );
      const pageCount = await getPdfPageCount(pdfPath);
      const sha256 = createHash("sha256")
        .update(await readFile(pdfPath))
        .digest("hex");

      return {
        fileName: outputFileName,
        storagePath: pdfPath,
        sha256,
        format: "pdf",
        intermediateFileName: htmlFileName,
        intermediateStoragePath: htmlPath,
        pageCount,
        warnings: [],
      };
    },
  };
}
