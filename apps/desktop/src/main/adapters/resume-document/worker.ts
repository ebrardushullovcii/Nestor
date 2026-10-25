import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ResumeParserWorkerRequestSchema,
  ResumeParserWorkerResponseSchema,
  type ResumeDocumentBlock,
  type ResumeDocumentFileKind,
  type ResumeDocumentParserKind,
  type ResumeParserWorkerRequest,
  type ResumeParserWorkerResponse,
} from "@nestor/contracts";
import { extractDocxTextWithTextutil } from "../resume-document-macos";
import {
  buildBundleFromText,
  buildDocumentQualitySignal,
  normalizeExtractedText,
} from "../resume-document-utils";
import { runResumeParserSidecar } from "../resume-document-sidecar";
import {
  extractMacOsPdfDocumentBundle,
  extractPdfDocumentBundleWithPdfJs,
} from "./pdf";
import {
  bundleToWorkerResponse,
  createEmbeddedParserManifest,
  createFailureResponse,
  uniqueWarnings,
} from "./shared";
import type { ExtractResumeDocumentInput } from "./types";

export function detectResumeDocumentFileKind(
  filePath: string,
): ResumeDocumentFileKind {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".txt") {
    return "plain_text";
  }

  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }

  if (extension === ".docx") {
    return "docx";
  }

  if (extension === ".pdf") {
    return "pdf";
  }

  return "unknown";
}

export function defaultPreferredRoute(
  fileKind: ResumeDocumentFileKind,
): ResumeParserWorkerRequest["preferredRoute"] {
  switch (fileKind) {
    case "plain_text":
    case "markdown":
      return "plain_text_native";
    case "docx":
      return "docx_native";
    case "pdf":
      return "native_first";
    default:
      return "unsupported_fallback";
  }
}

function preferredExecutorsForFileKind(
  fileKind: ResumeDocumentFileKind,
): ResumeDocumentParserKind[] {
  switch (fileKind) {
    case "plain_text":
    case "markdown":
      return ["plain_text"];
    case "docx":
      return process.platform === "darwin"
        ? ["local_docx", "textutil_docx", "mammoth"]
        : ["local_docx", "mammoth"];
    case "pdf":
      return process.platform === "darwin"
        ? [
            "local_pdf_layout",
            "macos_pdfkit_text",
            "macos_vision_ocr",
            "pdfjs_text",
          ]
        : ["local_pdf_layout", "local_pdf_text_probe", "pdfjs_text"];
    default:
      return ["local_sidecar_fallback"];
  }
}

export function createResumeParserWorkerRequest(
  filePath: string,
): ResumeParserWorkerRequest {
  const fileKind = detectResumeDocumentFileKind(filePath);

  return ResumeParserWorkerRequestSchema.parse({
    requestId: `resume_parser_request_${Date.now()}`,
    filePath,
    fileKind,
    preferredRoute: defaultPreferredRoute(fileKind),
    preferredExecutors: preferredExecutorsForFileKind(fileKind),
  });
}

function shouldAttemptSidecar(fileKind: ResumeDocumentFileKind): boolean {
  if (process.env.NESTOR_RESUME_PARSER_SIDECAR === "0") {
    return false;
  }

  return fileKind === "pdf" || fileKind === "docx";
}

function shouldFallbackFromSidecarResponse(
  response: ResumeParserWorkerResponse,
): boolean {
  if (!response.ok || !response.primaryParserKind) {
    return true;
  }

  if (response.primaryParserKind === "local_sidecar_fallback") {
    return true;
  }

  const uniquePageNumbers = new Set(
    response.pages.map((page) => page.pageNumber),
  );
  if (response.pages.length > 1 && uniquePageNumbers.size <= 1) {
    return true;
  }

  return response.blocks.length === 0 && !response.fullText;
}

function countWordLikeTokens(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function normalizeComparableDocxLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@+./]+/g, " ")
    .trim();
}

function isDocxContactLine(value: string): boolean {
  return (
    /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(value) ||
    /\b(?:https?:\/\/|www\.|linkedin\.com\/|github\.com\/)/i.test(value) ||
    /(?:^|\s)\+?\d[\d\s().-]{7,}\d(?:\s|$)/.test(value)
  );
}

function collectSidecarDocxIdentityLines(input: {
  sidecarText: string | null | undefined;
  embeddedText: string | null | undefined;
}): string[] {
  const sidecarLines = (input.sidecarText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  const firstContactIndex = sidecarLines.findIndex(isDocxContactLine);
  const lastContactIndex = sidecarLines.reduce(
    (lastIndex, line, index) => (isDocxContactLine(line) ? index : lastIndex),
    -1,
  );

  const identityWindow = sidecarLines.slice(0, lastContactIndex + 1);
  const containsBodySectionHeading = identityWindow.some((line) =>
    /^(?:professional\s+)?(?:experience|employment|work history|education|skills|projects|certifications?|achievements?)$/i.test(
      line,
    ),
  );

  if (
    firstContactIndex < 0 ||
    firstContactIndex > 7 ||
    containsBodySectionHeading
  ) {
    return [];
  }

  const embeddedLines = new Set(
    (input.embeddedText ?? "")
      .split(/\r?\n/)
      .map(normalizeComparableDocxLine)
      .filter(Boolean),
  );

  return identityWindow.filter(
    (line) => !embeddedLines.has(normalizeComparableDocxLine(line)),
  );
}

export function mergeDocxFallbackIdentityEvidence(input: {
  sidecarResponse: ResumeParserWorkerResponse;
  embeddedResponse: ResumeParserWorkerResponse;
}): ResumeParserWorkerResponse {
  const identityLines = collectSidecarDocxIdentityLines({
    sidecarText: input.sidecarResponse.fullText,
    embeddedText: input.embeddedResponse.fullText,
  });

  if (identityLines.length === 0) {
    return input.embeddedResponse;
  }

  const firstPage = input.embeddedResponse.pages[0];
  const firstPageNumber = firstPage?.pageNumber ?? 1;
  const mergedFirstPageText = [
    identityLines.join("\n"),
    firstPage?.text ?? input.embeddedResponse.fullText ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const parserKinds = Array.from(
    new Set([
      ...input.embeddedResponse.parserKinds,
      ...input.sidecarResponse.parserKinds,
    ]),
  );
  const sidecarBlocksByText = new Map(
    input.sidecarResponse.blocks.map((block) => [
      normalizeComparableDocxLine(block.text),
      block,
    ]),
  );
  const identityBlocks: ResumeDocumentBlock[] = identityLines.map(
    (text, index) => {
      const sourceBlock = sidecarBlocksByText.get(
        normalizeComparableDocxLine(text),
      );
      return {
        id: `docx_identity_merge_${index + 1}`,
        pageNumber: firstPageNumber,
        readingOrder: index,
        text,
        kind:
          sourceBlock?.kind ??
          (isDocxContactLine(text) ? "contact" : "heading"),
        sectionHint:
          sourceBlock?.sectionHint ??
          (isDocxContactLine(text) ? "contact" : "identity"),
        bbox: sourceBlock?.bbox ?? null,
        sourceParserKinds:
          sourceBlock?.sourceParserKinds ?? input.sidecarResponse.parserKinds,
        sourceConfidence: sourceBlock?.sourceConfidence ?? 0.9,
        lineIds: sourceBlock?.lineIds ?? [
          `docx_identity_merge_line_${index + 1}`,
        ],
        parserLineage:
          sourceBlock?.parserLineage ?? input.sidecarResponse.parserKinds,
        readingOrderConfidence: sourceBlock?.readingOrderConfidence ?? 0.9,
        textSpan: null,
      };
    },
  );
  const shiftedBlocks = input.embeddedResponse.blocks.map((block) => ({
    ...block,
    readingOrder: block.readingOrder + identityBlocks.length,
  }));
  const blocks = [...identityBlocks, ...shiftedBlocks];
  const pages = firstPage
    ? input.embeddedResponse.pages.map((page, index) =>
        index === 0
          ? {
              ...page,
              text: mergedFirstPageText,
              charCount: mergedFirstPageText.length,
            }
          : page,
      )
    : [
        {
          pageNumber: firstPageNumber,
          text: mergedFirstPageText,
          charCount: mergedFirstPageText.length,
          tokenCount: countWordLikeTokens(mergedFirstPageText),
          quality: buildDocumentQualitySignal({
            fullText: mergedFirstPageText,
            pages: [],
            blocks: identityBlocks,
          }),
          qualityWarnings: [],
          usedOcr: false,
          width: null,
          height: null,
        },
      ];
  const fullText = pages
    .map((page) => page.text)
    .filter(Boolean)
    .join("\n\n");
  const qualityPages = pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: page.text,
    charCount: page.charCount,
    parserKinds,
    usedOcr: page.usedOcr,
    width: page.width,
    height: page.height,
    routeKind: "docx_native" as const,
    quality: page.quality,
    qualityWarnings: page.qualityWarnings,
  }));
  const route = input.embeddedResponse.route
    ? {
        ...input.embeddedResponse.route,
        triageReasons: uniqueWarnings([
          ...input.embeddedResponse.route.triageReasons,
          "docx_identity_evidence_merged",
        ]),
        usedExecutors: Array.from(
          new Set([
            ...input.embeddedResponse.route.usedExecutors,
            ...(input.sidecarResponse.route?.usedExecutors ?? []),
          ]),
        ),
      }
    : input.embeddedResponse.route;

  return ResumeParserWorkerResponseSchema.parse({
    ...input.embeddedResponse,
    parserKinds,
    route,
    pages,
    blocks,
    fullText,
    quality: buildDocumentQualitySignal({
      fullText,
      pages: qualityPages,
      blocks,
      readingOrderConfidence:
        input.embeddedResponse.quality.readingOrderConfidence,
      nativeTextCoverage: input.embeddedResponse.quality.nativeTextCoverage,
      imageCoverageRatio: input.embeddedResponse.quality.imageCoverageRatio,
      invalidUnicodeRatio: input.embeddedResponse.quality.invalidUnicodeRatio,
    }),
  });
}

export function shouldFallbackToEmbeddedDocxResponse(input: {
  sidecarResponse: ResumeParserWorkerResponse;
  embeddedResponse: ResumeParserWorkerResponse;
}): boolean {
  const { embeddedResponse, sidecarResponse } = input;

  if (
    !sidecarResponse.ok ||
    sidecarResponse.primaryParserKind !== "local_docx"
  ) {
    return false;
  }

  if (
    !embeddedResponse.ok ||
    !embeddedResponse.primaryParserKind ||
    !embeddedResponse.fullText
  ) {
    return false;
  }

  const sidecarTextLength = sidecarResponse.fullText?.trim().length ?? 0;
  const embeddedTextLength = embeddedResponse.fullText.trim().length;
  const sidecarTokenCount = countWordLikeTokens(sidecarResponse.fullText);
  const embeddedTokenCount = countWordLikeTokens(embeddedResponse.fullText);

  if (sidecarTextLength === 0) {
    return true;
  }

  const lengthGap = embeddedTextLength - sidecarTextLength;
  const tokenGap = embeddedTokenCount - sidecarTokenCount;

  return (
    embeddedTextLength >= 200 &&
    embeddedTokenCount >= 40 &&
    lengthGap >= 120 &&
    tokenGap >= 20 &&
    embeddedTextLength >= Math.ceil(sidecarTextLength * 1.5)
  );
}

function mergeSidecarFallbackWarnings(
  sidecarResponse: ResumeParserWorkerResponse,
  embeddedResponse: ResumeParserWorkerResponse,
  fallbackMessage?: string,
): ResumeParserWorkerResponse {
  const sidecarWarnings = [...sidecarResponse.warnings];

  if (fallbackMessage) {
    sidecarWarnings.push(fallbackMessage);
  } else if (sidecarResponse.errorMessage) {
    sidecarWarnings.push(
      `Python resume parser sidecar fallback: ${sidecarResponse.errorMessage}`,
    );
  } else {
    sidecarWarnings.push(
      "Python resume parser sidecar returned no usable parse, so the desktop importer used the embedded parser.",
    );
  }

  const route = embeddedResponse.route
    ? {
        ...embeddedResponse.route,
        triageReasons: uniqueWarnings([
          ...embeddedResponse.route.triageReasons,
          "python_sidecar_fallback",
        ]),
      }
    : embeddedResponse.route;

  return ResumeParserWorkerResponseSchema.parse({
    ...embeddedResponse,
    route,
    warnings: uniqueWarnings([
      ...sidecarWarnings,
      ...embeddedResponse.warnings,
    ]),
  });
}

async function executePlainTextParser(
  filePath: string,
  input: ExtractResumeDocumentInput,
  request: ResumeParserWorkerRequest,
): Promise<ResumeParserWorkerResponse> {
  const text = normalizeExtractedText(await readFile(filePath, "utf8"));
  const bundle = buildBundleFromText({
    bundleId: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: request.fileKind,
    parserKind: "plain_text",
    text,
    routeKind: "plain_text_native",
  });

  return bundleToWorkerResponse(request.requestId, bundle);
}

async function extractDocxText(filePath: string): Promise<string | null> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeExtractedText(result.value);
}

async function executeDocxParser(
  filePath: string,
  input: ExtractResumeDocumentInput,
  request: ResumeParserWorkerRequest,
): Promise<ResumeParserWorkerResponse> {
  let parserKind: ResumeDocumentParserKind = "mammoth";
  let text: string | null = null;

  if (process.platform === "darwin") {
    try {
      text = await extractDocxTextWithTextutil(filePath);
      parserKind = "textutil_docx";
    } catch {
      text = await extractDocxText(filePath);
      parserKind = "mammoth";
    }
  } else {
    text = await extractDocxText(filePath);
    parserKind = "mammoth";
  }

  const bundle = buildBundleFromText({
    bundleId: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: "docx",
    parserKind,
    text,
    routeKind: "docx_native",
  });

  return bundleToWorkerResponse(request.requestId, bundle);
}

async function executePdfParser(
  filePath: string,
  input: ExtractResumeDocumentInput,
  request: ResumeParserWorkerRequest,
): Promise<ResumeParserWorkerResponse> {
  const bundle =
    process.platform === "darwin"
      ? await extractMacOsPdfDocumentBundle(filePath, input, request)
      : await extractPdfDocumentBundleWithPdfJs(filePath, input, request);

  return bundleToWorkerResponse(request.requestId, bundle);
}

async function executeEmbeddedParserWorker(
  request: ResumeParserWorkerRequest,
  input: ExtractResumeDocumentInput,
): Promise<ResumeParserWorkerResponse> {
  try {
    switch (request.fileKind) {
      case "plain_text":
      case "markdown":
        return await executePlainTextParser(request.filePath, input, request);
      case "docx":
        return await executeDocxParser(request.filePath, input, request);
      case "pdf":
        return await executePdfParser(request.filePath, input, request);
      default:
        return ResumeParserWorkerResponseSchema.parse({
          requestId: request.requestId,
          ok: true,
          primaryParserKind: "local_sidecar_fallback",
          parserKinds: ["local_sidecar_fallback"],
          route: {
            routeKind: "unsupported_fallback",
            triageReasons: ["unsupported_file_kind"],
            preferredExecutors: request.preferredExecutors,
            usedExecutors: ["local_sidecar_fallback"],
          },
          parserManifest: createEmbeddedParserManifest({
            executorVersions: {
              local_sidecar_fallback: process.versions.node,
            },
            runtimeLabel: "node-main-process",
            availableCapabilities: ["unsupported_fallback"],
          }),
          quality: buildDocumentQualitySignal({
            fullText: null,
            pages: [],
            blocks: [],
            readingOrderConfidence: 0,
            nativeTextCoverage: 0,
            imageCoverageRatio: 1,
            invalidUnicodeRatio: 0,
          }),
          qualityWarnings: ["unsupported_file_kind"],
          warnings: [
            "This file type is stored locally, but automatic text extraction is not available yet.",
          ],
          pages: [],
          blocks: [],
          fullText: null,
          errorMessage: null,
        });
    }
  } catch (error) {
    return createFailureResponse({
      requestId: request.requestId,
      warnings: [
        "Resume extraction fell back before a canonical bundle could be produced.",
      ],
      errorMessage:
        error instanceof Error
          ? error.message
          : "Resume extraction failed before the embedded parser worker could respond.",
    });
  }
}

export async function executeResumeParserWorker(
  request: ResumeParserWorkerRequest,
  input: ExtractResumeDocumentInput,
): Promise<ResumeParserWorkerResponse> {
  if (!shouldAttemptSidecar(request.fileKind)) {
    return executeEmbeddedParserWorker(request, input);
  }

  const sidecarResponse = await runResumeParserSidecar(request);

  if (
    !shouldFallbackFromSidecarResponse(sidecarResponse) &&
    request.fileKind === "docx"
  ) {
    const embeddedDocxResponse = await executeEmbeddedParserWorker(
      request,
      input,
    );

    if (
      shouldFallbackToEmbeddedDocxResponse({
        sidecarResponse,
        embeddedResponse: embeddedDocxResponse,
      })
    ) {
      console.warn(
        `[ResumeImport] Sidecar DOCX parse looked incomplete, so the embedded parser was preferred: sidecarTokens=${countWordLikeTokens(sidecarResponse.fullText)} embeddedTokens=${countWordLikeTokens(embeddedDocxResponse.fullText)}`,
      );
      return mergeSidecarFallbackWarnings(
        sidecarResponse,
        mergeDocxFallbackIdentityEvidence({
          sidecarResponse,
          embeddedResponse: embeddedDocxResponse,
        }),
        "Python resume parser sidecar returned a partial DOCX parse, so the desktop importer used the embedded parser.",
      );
    }
  }

  if (!shouldFallbackFromSidecarResponse(sidecarResponse)) {
    console.log(
      `[ResumeImport] Sidecar parser succeeded for ${request.fileKind}: primary=${sidecarResponse.primaryParserKind ?? "unknown"} parsers=${sidecarResponse.parserKinds.join(",") || "none"}`,
    );
    return sidecarResponse;
  }

  console.warn(
    `[ResumeImport] Sidecar parser fell back for ${request.fileKind}: primary=${sidecarResponse.primaryParserKind ?? "none"} error=${sidecarResponse.errorMessage ?? "no usable parse"} warnings=${sidecarResponse.warnings.join(" | ") || "none"}`,
  );

  const embeddedResponse = await executeEmbeddedParserWorker(request, input);
  console.log(
    `[ResumeImport] Embedded parser used for ${request.fileKind}: primary=${embeddedResponse.primaryParserKind ?? "unknown"} parsers=${embeddedResponse.parserKinds.join(",") || "none"}`,
  );
  return mergeSidecarFallbackWarnings(sidecarResponse, embeddedResponse);
}
