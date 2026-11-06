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

test("renders the approved resume's identity, sections and entries as a Word resume", async () => {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "nestor-resume-docx-"),
  );
  const manager = createLocalJobFinderDocumentManager({ outputDirectory });
  const result = await manager.renderResumeDocxArtifact!({
    profile: { fullName: "Jamie Synthetic" } as never,
    renderDocument: {
      fullName: "Jamie Synthetic",
      headline: "Engineer",
      location: "Berlin",
      contactItems: [{ field: "email", text: "jamie@example.test" }],
      sections: [
        {
          id: "experience",
          kind: "experience",
          label: "Experience",
          text: "Approved words & facts",
          bullets: [],
          entries: [
            {
              id: "role",
              title: "Engineer",
              subtitle: "Synthetic Tools",
              location: "Remote",
              dateRange: "2020–2026",
              startDate: null,
              endDate: null,
              isCurrent: true,
              heading: null,
              summary: "Built interfaces",
              bullets: [{ id: "one", text: "Kept the approved claim." }],
            },
          ],
        },
      ],
    },
  });
  expect(result).toMatchObject({
    ok: true,
    fileName: "jamie-synthetic-resume.docx",
  });
  if (!result.ok) return;
  const bytes = await readFile(result.storagePath);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  for (const part of [
    "Jamie Synthetic",
    "jamie@example.test",
    "Approved words &amp; facts",
    "Synthetic Tools",
    "2020–2026",
    "Kept the approved claim.",
  ])
    expect(xml).toContain(part);
});

test("Word copies of the same approved text keep identical bytes across attempts", async () => {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "nestor-stable-docx-"),
  );
  const manager = createLocalJobFinderDocumentManager({ outputDirectory });
  const input = {
    profile: { fullName: "Jamie Synthetic" } as never,
    renderDocument: {
      fullName: "Jamie Synthetic",
      headline: null,
      location: null,
      contactItems: [],
      sections: [],
    },
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    const first = await manager.renderResumeDocxArtifact!(input);
    vi.setSystemTime(new Date("2026-11-06T01:00:00Z"));
    const second = await manager.renderResumeDocxArtifact!(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.sha256).toBe(first.sha256);
    expect(await readFile(second.storagePath)).toEqual(
      await readFile(first.storagePath),
    );
  } finally {
    vi.useRealTimers();
  }
});
