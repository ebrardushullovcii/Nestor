import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { describe, expect, test, vi } from "vitest";

import { createLocalJobFinderDocumentManager } from "./job-finder-document-manager";

vi.mock("electron", () => ({ BrowserWindow: vi.fn() }));

describe("application document DOCX rendering", () => {
  test("writes a valid Word package containing the generated text", async () => {
    const outputDirectory = await mkdtemp(
      path.join(tmpdir(), "nestor-letter-docx-"),
    );
    const manager = createLocalJobFinderDocumentManager({ outputDirectory });
    const result = await manager.renderLetterArtifact!({
      text: "Dear hiring team,\n\nI build safe & useful workflow tools.",
      job: {
        id: "job_docx",
        title: "Platform Engineer",
        company: "Northwind Tools",
      } as never,
      profile: { fullName: "Alex Vanguard" } as never,
      settings: {} as never,
      fileType: "docx",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileName).toMatch(/\.docx$/u);
    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const bytes = await readFile(result.storagePath);
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]);
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("Dear hiring team");
    expect(documentXml).toContain("safe &amp; useful workflow tools");
  });
});
