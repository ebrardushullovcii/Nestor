import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createResumeParserWorkerRequest,
  extractResumeDocument,
  shouldFallbackToEmbeddedDocxResponse,
} from "./resume-document";
import { buildBundleFromText } from "./resume-document-utils";

const tempDirectories: string[] = [];

async function createTempResumeFile(fileName: string, contents: string) {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-parser-"),
  );
  tempDirectories.push(tempDirectory);
  const filePath = path.join(tempDirectory, fileName);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

async function mockEmbeddedPdfExtraction() {
  const pdfModule = await import("./resume-document/pdf");
  const extractBundle = (
    _filePath: string,
    input: { bundleId: string; runId: string; sourceResumeId: string },
  ) =>
    Promise.resolve(
      buildBundleFromText({
        ...input,
        sourceFileKind: "pdf",
        parserKind: "pdfjs_text",
        text: "Jamie Rivers\njamie@example.com\nBerlin, Germany",
        routeKind: "native_first",
      }),
    );

  const macOsSpy = vi
    .spyOn(pdfModule, "extractMacOsPdfDocumentBundle")
    .mockImplementation(extractBundle);
  const pdfJsSpy = vi
    .spyOn(pdfModule, "extractPdfDocumentBundleWithPdfJs")
    .mockImplementation(extractBundle);

  return { macOsSpy, pdfJsSpy };
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.NESTOR_RESUME_PARSER_SIDECAR;
  delete process.env.NESTOR_RESUME_PARSER_SIDECAR_BINARY_PATH;
  delete process.env.NESTOR_RESUME_PARSER_SIDECAR_PATH;

  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resume document parser worker orchestration", () => {
  test("creates preferred executors for PDF parsing", async () => {
    const pdfPath = await createTempResumeFile("sample.pdf", "not-a-real-pdf");
    const request = createResumeParserWorkerRequest(pdfPath);

    expect(request.fileKind).toBe("pdf");
    expect(request.preferredExecutors).toContain("local_pdf_layout");
  });

  test("falls back to the embedded parser when the python sidecar is disabled", async () => {
    process.env.NESTOR_RESUME_PARSER_SIDECAR = "0";
    const resumePath = await createTempResumeFile(
      "resume.txt",
      ["Jamie Rivers", "Staff Frontend Engineer", "Berlin, Germany"].join("\n"),
    );

    const extracted = await extractResumeDocument(resumePath, {
      bundleId: "bundle_test",
      runId: "run_test",
      sourceResumeId: "resume_test",
    });

    expect(extracted.bundle.parserManifest?.workerKind).toBe("embedded_node");
    expect(extracted.bundle.primaryParserKind).toBe("plain_text");
    expect(extracted.textContent).toContain("Jamie Rivers");
  });

  test("uses the python sidecar for docx requests when available", async () => {
    const sidecarModule = await import("./resume-document-sidecar");
    const sidecarSpy = vi
      .spyOn(sidecarModule, "runResumeParserSidecar")
      .mockResolvedValue({
        requestId: "request_docx_test",
        ok: true,
        primaryParserKind: "local_docx",
        parserKinds: ["local_docx"],
        route: {
          routeKind: "docx_native",
          triageReasons: ["mock_sidecar"],
          preferredExecutors: ["local_docx"],
          usedExecutors: ["local_docx"],
        },
        parserManifest: {
          workerKind: "python_sidecar",
          workerVersion: "3.13.0",
          manifestVersion: "019-python-sidecar-v1",
          runtimeLabel: "python 3.13",
          availableCapabilities: ["docx_attempt"],
          executorVersions: {
            local_docx: "fixture",
          },
        },
        quality: {
          score: 0.91,
          textDensity: 0.8,
          tokenCount: 6,
          lineCount: 3,
          blockCount: 3,
          columnLikelihood: 0.08,
          readingOrderConfidence: 0.95,
          nativeTextCoverage: 1,
          ocrConfidence: null,
          imageCoverageRatio: 0,
          invalidUnicodeRatio: 0,
        },
        qualityWarnings: [],
        warnings: [],
        pages: [
          {
            pageNumber: 1,
            text: "Jamie Rivers\nStaff Frontend Engineer\nBerlin, Germany",
            charCount: 50,
            tokenCount: 6,
            quality: {
              score: 0.91,
              textDensity: 0.8,
              tokenCount: 6,
              lineCount: 3,
              blockCount: 3,
              columnLikelihood: 0.08,
              readingOrderConfidence: 0.95,
              nativeTextCoverage: 1,
              ocrConfidence: null,
              imageCoverageRatio: 0,
              invalidUnicodeRatio: 0,
            },
            qualityWarnings: [],
            usedOcr: false,
            width: null,
            height: null,
          },
        ],
        blocks: [
          {
            id: "page_1_block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Jamie Rivers",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["local_docx"],
            sourceConfidence: 0.9,
            lineIds: ["page_1_line_1"],
            parserLineage: ["local_docx"],
            readingOrderConfidence: 0.95,
            textSpan: null,
          },
        ],
        fullText: "Jamie Rivers\nStaff Frontend Engineer\nBerlin, Germany",
        errorMessage: null,
      });

    const docxPath = await createTempResumeFile(
      "resume.docx",
      "fake-docx-content",
    );
    const extracted = await extractResumeDocument(docxPath, {
      bundleId: "bundle_docx",
      runId: "run_docx",
      sourceResumeId: "resume_docx",
    });

    expect(sidecarSpy).toHaveBeenCalledTimes(1);
    expect(extracted.bundle.parserManifest?.workerKind).toBe("python_sidecar");
    expect(extracted.bundle.primaryParserKind).toBe("local_docx");
    expect(extracted.textContent).toContain("Jamie Rivers");
  }, 15000);

  test("falls back to embedded DOCX parsing when the sidecar response looks partial", () => {
    expect(
      shouldFallbackToEmbeddedDocxResponse({
        sidecarResponse: {
          requestId: "request_docx_partial",
          ok: true,
          primaryParserKind: "local_docx",
          parserKinds: ["local_docx"],
          route: {
            routeKind: "docx_native",
            triageReasons: ["docx_sidecar_attempt"],
            preferredExecutors: ["local_docx", "mammoth"],
            usedExecutors: ["local_docx"],
          },
          parserManifest: {
            workerKind: "python_sidecar",
            workerVersion: "3.13.0",
            manifestVersion: "019-python-sidecar-v1",
            runtimeLabel: "python 3.13",
            availableCapabilities: ["docx_attempt"],
            executorVersions: { local_docx: "fixture" },
          },
          quality: {
            score: 0.72,
            textDensity: 0.18,
            tokenCount: 12,
            lineCount: 3,
            blockCount: 3,
            columnLikelihood: 0.08,
            readingOrderConfidence: 0.9,
            nativeTextCoverage: 1,
            ocrConfidence: null,
            imageCoverageRatio: 0,
            invalidUnicodeRatio: 0,
          },
          qualityWarnings: [],
          warnings: [],
          pages: [],
          blocks: [
            {
              id: "page_1_block_1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Jamie Rivers",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["local_docx"],
              sourceConfidence: 0.9,
              lineIds: ["page_1_line_1"],
              parserLineage: ["local_docx"],
              readingOrderConfidence: 0.95,
              textSpan: null,
            },
          ],
          fullText: "Jamie Rivers\nSenior Engineer",
          errorMessage: null,
        },
        embeddedResponse: {
          requestId: "request_docx_partial",
          ok: true,
          primaryParserKind: "mammoth",
          parserKinds: ["mammoth"],
          route: {
            routeKind: "docx_native",
            triageReasons: ["embedded_docx"],
            preferredExecutors: ["local_docx", "mammoth"],
            usedExecutors: ["mammoth"],
          },
          parserManifest: {
            workerKind: "embedded_node",
            workerVersion: process.versions.node,
            manifestVersion: "019-embedded-node-v1",
            runtimeLabel: "node-main-process",
            availableCapabilities: ["docx_native"],
            executorVersions: { mammoth: "fixture" },
          },
          quality: {
            score: 0.94,
            textDensity: 0.6,
            tokenCount: 124,
            lineCount: 26,
            blockCount: 26,
            columnLikelihood: 0.08,
            readingOrderConfidence: 0.95,
            nativeTextCoverage: 1,
            ocrConfidence: null,
            imageCoverageRatio: 0,
            invalidUnicodeRatio: 0,
          },
          qualityWarnings: [],
          warnings: [],
          pages: [],
          blocks: [],
          fullText: [
            "Jamie Rivers",
            "Senior Engineer",
            "Berlin, Germany",
            "Experience",
            "Built internal workflow platforms for distributed teams and led multi-quarter migrations.",
            "Directed frontend platform modernization across multiple product lines and improved release reliability.",
            "Created shared design-system primitives, accessibility standards, and test harnesses for core workflows.",
            "Partnered with recruiting and hiring teams to turn process pain points into measurable product improvements.",
            "Led cross-functional delivery reviews, roadmap planning, and post-launch regression triage for enterprise surfaces.",
            "Skills",
            "TypeScript React Playwright Architecture Leadership",
            "Projects",
            "Workflow Copilot, Discovery Platform, Resume Import Reliability, Shared Profile Editing",
          ].join("\n"),
          errorMessage: null,
        },
      }),
    ).toBe(true);
  });

  test("uses the bundled sidecar binary even when the python script path is unavailable", async () => {
    const sidecarModule = await import("./resume-document-sidecar");
    const sidecarSpy = vi
      .spyOn(sidecarModule, "runResumeParserSidecar")
      .mockResolvedValue({
        requestId: "request_binary_pdf_test",
        ok: true,
        primaryParserKind: "local_pdf_layout",
        parserKinds: ["local_pdf_layout"],
        route: {
          routeKind: "native_first",
          triageReasons: ["mock_binary_sidecar"],
          preferredExecutors: ["local_pdf_layout"],
          usedExecutors: ["local_pdf_layout"],
        },
        parserManifest: {
          workerKind: "python_sidecar",
          workerVersion: "bundled",
          manifestVersion: "019-python-sidecar-v1",
          runtimeLabel: "bundled binary",
          availableCapabilities: ["pdf_layout"],
          executorVersions: { local_pdf_layout: "fixture" },
        },
        quality: {
          score: 0.9,
          textDensity: 0.8,
          tokenCount: 4,
          lineCount: 2,
          blockCount: 2,
          columnLikelihood: 0.1,
          readingOrderConfidence: 0.95,
          nativeTextCoverage: 1,
          ocrConfidence: null,
          imageCoverageRatio: 0,
          invalidUnicodeRatio: 0,
        },
        qualityWarnings: [],
        warnings: [],
        pages: [
          {
            pageNumber: 1,
            text: "Jamie Rivers\nBerlin, Germany",
            charCount: 28,
            tokenCount: 4,
            quality: {
              score: 0.9,
              textDensity: 0.8,
              tokenCount: 4,
              lineCount: 2,
              blockCount: 2,
              columnLikelihood: 0.1,
              readingOrderConfidence: 0.95,
              nativeTextCoverage: 1,
              ocrConfidence: null,
              imageCoverageRatio: 0,
              invalidUnicodeRatio: 0,
            },
            qualityWarnings: [],
            usedOcr: false,
            width: null,
            height: null,
          },
        ],
        blocks: [],
        fullText: "Jamie Rivers\nBerlin, Germany",
        errorMessage: null,
      });

    process.env.NESTOR_RESUME_PARSER_SIDECAR_BINARY_PATH = path.join(
      os.tmpdir(),
      "resume_parser_sidecar.exe",
    );
    process.env.NESTOR_RESUME_PARSER_SIDECAR_PATH = path.join(
      os.tmpdir(),
      "missing_resume_parser_sidecar.py",
    );
    await writeFile(
      process.env.NESTOR_RESUME_PARSER_SIDECAR_BINARY_PATH,
      "binary",
      "utf8",
    );

    const pdfPath = await createTempResumeFile(
      "bundled-binary.pdf",
      "fake-pdf-content",
    );
    const extracted = await extractResumeDocument(pdfPath, {
      bundleId: "bundle_binary_pdf",
      runId: "run_binary_pdf",
      sourceResumeId: "resume_binary_pdf",
    });

    expect(sidecarSpy).toHaveBeenCalledTimes(1);
    expect(extracted.bundle.primaryParserKind).toBe("local_pdf_layout");
    expect(extracted.textContent).toContain("Jamie Rivers");
  });

  test("merges sidecar failure warnings into embedded fallback results", async () => {
    const embeddedParser = await mockEmbeddedPdfExtraction();
    const sidecarModule = await import("./resume-document-sidecar");
    vi.spyOn(sidecarModule, "runResumeParserSidecar").mockResolvedValue({
      requestId: "request_pdf_test",
      ok: false,
      primaryParserKind: null,
      parserKinds: [],
      route: null,
      parserManifest: {
        workerKind: "python_sidecar",
        workerVersion: "3.13.0",
        manifestVersion: "019-python-sidecar-v1",
        runtimeLabel: "python 3.13",
        availableCapabilities: [],
        executorVersions: {},
      },
      quality: {
        score: 0,
        textDensity: null,
        tokenCount: 0,
        lineCount: 0,
        blockCount: 0,
        columnLikelihood: null,
        readingOrderConfidence: null,
        nativeTextCoverage: null,
        ocrConfidence: null,
        imageCoverageRatio: null,
        invalidUnicodeRatio: null,
      },
      qualityWarnings: [],
      warnings: ["Python sidecar could not start."],
      pages: [],
      blocks: [],
      fullText: null,
      errorMessage: "Python sidecar unavailable",
    });

    const pdfPath = await createTempResumeFile(
      "resume.pdf",
      ["Jamie Rivers", "jamie@example.com", "Berlin, Germany"].join("\n"),
    );
    const extracted = await extractResumeDocument(pdfPath, {
      bundleId: "bundle_pdf",
      runId: "run_pdf",
      sourceResumeId: "resume_pdf",
    });

    expect(extracted.bundle.parserManifest?.workerKind).toBe("embedded_node");
    expect(extracted.textContent).toContain("Jamie Rivers");
    expect(
      embeddedParser.macOsSpy.mock.calls.length +
        embeddedParser.pdfJsSpy.mock.calls.length,
    ).toBe(1);
    expect(extracted.bundle.warnings).toEqual(
      expect.arrayContaining([
        "Python sidecar could not start.",
        "Python resume parser sidecar fallback: Python sidecar unavailable",
      ]),
    );
  });

  test("falls back when sidecar collapses multiple pages into one page number", async () => {
    const embeddedParser = await mockEmbeddedPdfExtraction();
    const sidecarModule = await import("./resume-document-sidecar");
    vi.spyOn(sidecarModule, "runResumeParserSidecar").mockResolvedValue({
      requestId: "request_pdf_multipage_test",
      ok: true,
      primaryParserKind: "local_pdf_layout",
      parserKinds: ["local_pdf_layout"],
      route: {
        routeKind: "native_first",
        triageReasons: ["python_sidecar_pdf_attempt"],
        preferredExecutors: ["local_pdf_layout"],
        usedExecutors: ["local_pdf_layout"],
      },
      parserManifest: {
        workerKind: "python_sidecar",
        workerVersion: "3.13.0",
        manifestVersion: "019-python-sidecar-v1",
        runtimeLabel: "python 3.13",
        availableCapabilities: ["pdf_layout"],
        executorVersions: {
          local_pdf_layout: "fixture",
        },
      },
      quality: {
        score: 0.8,
        textDensity: 0.7,
        tokenCount: 12,
        lineCount: 6,
        blockCount: 6,
        columnLikelihood: 0.1,
        readingOrderConfidence: 0.9,
        nativeTextCoverage: 1,
        ocrConfidence: null,
        imageCoverageRatio: 0,
        invalidUnicodeRatio: 0,
      },
      qualityWarnings: [],
      warnings: [],
      pages: [
        {
          pageNumber: 1,
          text: "Page one",
          charCount: 8,
          tokenCount: 2,
          quality: {
            score: 0.8,
            textDensity: 0.7,
            tokenCount: 2,
            lineCount: 1,
            blockCount: 1,
            columnLikelihood: 0.1,
            readingOrderConfidence: 0.9,
            nativeTextCoverage: 1,
            ocrConfidence: null,
            imageCoverageRatio: 0,
            invalidUnicodeRatio: 0,
          },
          qualityWarnings: [],
          usedOcr: false,
          width: null,
          height: null,
        },
        {
          pageNumber: 1,
          text: "Page two",
          charCount: 8,
          tokenCount: 2,
          quality: {
            score: 0.8,
            textDensity: 0.7,
            tokenCount: 2,
            lineCount: 1,
            blockCount: 1,
            columnLikelihood: 0.1,
            readingOrderConfidence: 0.9,
            nativeTextCoverage: 1,
            ocrConfidence: null,
            imageCoverageRatio: 0,
            invalidUnicodeRatio: 0,
          },
          qualityWarnings: [],
          usedOcr: false,
          width: null,
          height: null,
        },
      ],
      blocks: [
        {
          id: "page_1_block_1",
          pageNumber: 1,
          readingOrder: 0,
          text: "Page one",
          kind: "paragraph",
          sectionHint: "other",
          bbox: null,
          sourceParserKinds: ["local_pdf_layout"],
          sourceConfidence: 0.9,
          lineIds: ["page_1_line_1"],
          parserLineage: ["local_pdf_layout"],
          readingOrderConfidence: 0.95,
          textSpan: null,
        },
        {
          id: "page_1_block_2",
          pageNumber: 1,
          readingOrder: 1,
          text: "Page two",
          kind: "paragraph",
          sectionHint: "other",
          bbox: null,
          sourceParserKinds: ["local_pdf_layout"],
          sourceConfidence: 0.9,
          lineIds: ["page_1_line_2"],
          parserLineage: ["local_pdf_layout"],
          readingOrderConfidence: 0.95,
          textSpan: null,
        },
      ],
      fullText: "Page one\n\nPage two",
      errorMessage: null,
    });

    const pdfPath = await createTempResumeFile(
      "multi-page.pdf",
      ["Jamie Rivers", "jamie@example.com", "Berlin, Germany"].join("\n"),
    );
    const extracted = await extractResumeDocument(pdfPath, {
      bundleId: "bundle_pdf_multipage",
      runId: "run_pdf_multipage",
      sourceResumeId: "resume_pdf_multipage",
    });

    expect(extracted.bundle.parserManifest?.workerKind).toBe("embedded_node");
    expect(extracted.textContent).toContain("Jamie Rivers");
    expect(
      embeddedParser.macOsSpy.mock.calls.length +
        embeddedParser.pdfJsSpy.mock.calls.length,
    ).toBe(1);
    expect(extracted.bundle.warnings).toEqual(
      expect.arrayContaining([
        "Python resume parser sidecar returned no usable parse, so the desktop importer used the embedded parser.",
      ]),
    );
  });
});
