import {
  ResumeDocumentBundleSchema,
  type ResumeDocumentBlock,
  type ResumeDocumentBundle,
  type ResumeDocumentFileKind,
  type ResumeDocumentParserKind,
  type ResumeDocumentQualitySignal,
  type ResumeDocumentRouteDecision,
} from "@nestor/contracts";

type BuildBundleFromPagesInput = {
  bundleId: string;
  runId: string;
  sourceResumeId: string;
  sourceFileKind: ResumeDocumentFileKind;
  primaryParserKind: ResumeDocumentParserKind;
  parserKinds: ResumeDocumentParserKind[];
  warnings?: string[];
  pages: ResumeDocumentBundle["pages"];
  blocks: ResumeDocumentBundle["blocks"];
  route?: ResumeDocumentRouteDecision | null;
  parserManifest?: ResumeDocumentBundle["parserManifest"];
  quality?: ResumeDocumentQualitySignal;
  qualityWarnings?: string[];
};

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

export function normalizeExtractedText(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex -- PDF extraction may emit null bytes
    .replace(/\u0000/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized || null;
}

export function normalizeInlineText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyBlockKind(text: string): ResumeDocumentBlock["kind"] {
  const normalized = normalizeInlineText(text);

  if (!normalized) {
    return "unknown";
  }

  if (/@|linkedin\.com|github\.com|https?:\/\//i.test(normalized)) {
    return "contact";
  }

  if (
    /\b(?:\d{2}\/\d{4}|\d{4})\s*[–—-]\s*(?:current|present|\d{2}\/\d{4}|\d{4})\b/i.test(
      normalized,
    )
  ) {
    return "experience_header";
  }

  if (/^(?:[-*•●])/u.test(normalized)) {
    return "list_item";
  }

  if (
    (normalized === normalized.toUpperCase() && normalized.length <= 64) ||
    /^[A-Z][A-Z\s&/.'()-]{5,}$/.test(normalized)
  ) {
    return "heading";
  }

  return "paragraph";
}

export function classifySectionHint(
  text: string,
): ResumeDocumentBlock["sectionHint"] {
  const normalized = normalizeInlineText(text).toLowerCase();

  if (!normalized) {
    return "other";
  }

  if (
    /^(about|about me|profile|summary|professional summary)$/.test(normalized)
  )
    return "summary";
  if (/^(experience|work experience|employment)$/.test(normalized))
    return "experience";
  if (/^(education|education and training)$/.test(normalized))
    return "education";
  if (/^(certifications?|licenses?)$/.test(normalized)) return "certifications";
  if (
    /^(skills|technical skills|core skills|key skills|frameworks|tools|programming languages)$/.test(
      normalized,
    )
  )
    return "skills";
  if (/^(projects|portfolio)$/.test(normalized)) return "projects";
  if (/^(language skills|languages)$/.test(normalized)) return "languages";
  if (
    /@|linkedin\.com|github\.com|https?:\/\/|phone|email|address/i.test(
      normalized,
    )
  )
    return "contact";
  if (
    /\b(?:engineer|developer|manager|designer|analyst|consultant|architect|officer)\b/i.test(
      normalized,
    ) &&
    /\b(?:\d{2}\/\d{4}|\d{4})\s*[–—-]\s*(?:current|present|\d{2}\/\d{4}|\d{4})\b/i.test(
      normalized,
    )
  )
    return "experience";
  if (
    /\b(university|college|school|bachelor|master|phd|degree)\b/i.test(
      normalized,
    )
  )
    return "education";
  if (
    /\b(react|typescript|javascript|node|aws|azure|docker|kubernetes|sql|python|c#|\.net)\b/i.test(
      normalized,
    )
  )
    return "skills";
  if (normalized.length >= 64) return "summary";
  if (normalized.length <= 80 && /^[a-z][a-z\s.'()-]+$/i.test(normalized))
    return "identity";
  return "other";
}

export function buildDocumentQualitySignal(input: {
  fullText: string | null;
  pages: ResumeDocumentBundle["pages"];
  blocks: ResumeDocumentBundle["blocks"];
  readingOrderConfidence?: number | null;
  nativeTextCoverage?: number | null;
  ocrConfidence?: number | null;
  columnLikelihood?: number | null;
  imageCoverageRatio?: number | null;
  invalidUnicodeRatio?: number | null;
}): ResumeDocumentQualitySignal {
  const fullText = input.fullText ?? "";
  const tokenCount = fullText.split(/\s+/).filter(Boolean).length;
  const lineCount = fullText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  const blockCount = input.blocks.length;
  const pageCount = Math.max(1, input.pages.length);
  const textDensity = clampProbability(fullText.length / (pageCount * 1600));
  const readingOrderConfidence = clampProbability(
    input.readingOrderConfidence ?? 0.9,
  );
  const nativeTextCoverage =
    input.nativeTextCoverage == null
      ? 1
      : clampProbability(input.nativeTextCoverage);
  const ocrConfidence =
    input.ocrConfidence == null ? null : clampProbability(input.ocrConfidence);
  const columnLikelihood =
    input.columnLikelihood == null
      ? null
      : clampProbability(input.columnLikelihood);
  const imageCoverageRatio =
    input.imageCoverageRatio == null
      ? 0
      : clampProbability(input.imageCoverageRatio);
  const invalidUnicodeRatio =
    input.invalidUnicodeRatio == null
      ? 0
      : clampProbability(input.invalidUnicodeRatio);

  const score = clampProbability(
    readingOrderConfidence * 0.38 +
      nativeTextCoverage * 0.24 +
      textDensity * 0.18 +
      (ocrConfidence ?? 0.8) * 0.08 +
      (1 - imageCoverageRatio) * 0.06 +
      (1 - invalidUnicodeRatio) * 0.06,
  );

  return {
    score,
    textDensity,
    tokenCount,
    lineCount,
    blockCount,
    columnLikelihood,
    readingOrderConfidence,
    nativeTextCoverage,
    ocrConfidence,
    imageCoverageRatio,
    invalidUnicodeRatio,
  };
}

export function createLineBlocks(input: {
  pageNumber: number;
  lines: Array<{
    text: string;
    bbox?: ResumeDocumentBlock["bbox"];
    readingOrder?: number;
    confidence?: number | null;
    readingOrderConfidence?: number | null;
  }>;
  parserKind: ResumeDocumentParserKind;
  blockIdPrefix: string;
}): ResumeDocumentBlock[] {
  const blocks: ResumeDocumentBlock[] = [];

  input.lines.forEach((line, index) => {
    const text = normalizeInlineText(line.text);
    if (!text) {
      return;
    }

    blocks.push({
      id: `${input.blockIdPrefix}_${index + 1}`,
      pageNumber: input.pageNumber,
      readingOrder: line.readingOrder ?? index,
      text,
      kind: classifyBlockKind(text),
      sectionHint: classifySectionHint(text),
      bbox: line.bbox ?? null,
      sourceParserKinds: [input.parserKind],
      sourceConfidence: line.confidence ?? null,
      lineIds: [`${input.blockIdPrefix}_line_${index + 1}`],
      parserLineage: [input.parserKind],
      readingOrderConfidence: line.readingOrderConfidence ?? null,
      textSpan: null,
    });
  });

  return blocks;
}

export function buildBundleFromPages(
  input: BuildBundleFromPagesInput,
): ResumeDocumentBundle {
  const normalizedPages = input.pages.map((page) => ({
    ...page,
    text: page.text ? normalizeExtractedText(page.text) : null,
    charCount: page.charCount ?? page.text?.length ?? 0,
  }));
  const normalizedBlocks = input.blocks.map((block, index) => ({
    ...block,
    readingOrder: Number.isFinite(block.readingOrder)
      ? block.readingOrder
      : index,
    text: normalizeInlineText(block.text),
    kind: block.kind ?? classifyBlockKind(block.text),
    sectionHint: block.sectionHint ?? classifySectionHint(block.text),
    sourceParserKinds:
      block.sourceParserKinds.length > 0
        ? block.sourceParserKinds
        : [input.primaryParserKind],
  }));
  const fullText = normalizeExtractedText(
    normalizedPages
      .map((page) => page.text ?? "")
      .filter(Boolean)
      .join("\n\n"),
  );
  const quality =
    input.quality ??
    buildDocumentQualitySignal({
      fullText,
      pages: normalizedPages,
      blocks: normalizedBlocks,
      readingOrderConfidence:
        normalizedBlocks.length > 0
          ? normalizedBlocks.reduce(
              (sum, block) => sum + (block.readingOrderConfidence ?? 0.86),
              0,
            ) / normalizedBlocks.length
          : 0.86,
    });

  return ResumeDocumentBundleSchema.parse({
    id: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: input.sourceFileKind,
    primaryParserKind: input.primaryParserKind,
    parserKinds: Array.from(
      new Set([input.primaryParserKind, ...input.parserKinds]),
    ),
    createdAt: new Date().toISOString(),
    languageHints: [],
    warnings: input.warnings ?? [],
    pages: normalizedPages,
    blocks: normalizedBlocks,
    fullText,
    parserManifest: input.parserManifest,
    route: input.route ?? null,
    quality,
    qualityWarnings: input.qualityWarnings ?? [],
  });
}

export function buildBundleFromText(input: {
  bundleId: string;
  runId: string;
  sourceResumeId: string;
  sourceFileKind: ResumeDocumentFileKind;
  parserKind: ResumeDocumentParserKind;
  text: string | null;
  warnings?: string[];
  routeKind?: ResumeDocumentRouteDecision["routeKind"];
}): ResumeDocumentBundle {
  const fullText = normalizeExtractedText(input.text ?? "");
  const lines = (fullText ?? "")
    .split(/\r?\n/)
    .map((entry) => normalizeInlineText(entry))
    .filter(Boolean);
  const blocks = createLineBlocks({
    pageNumber: 1,
    lines: lines.map((text, index) => ({
      text,
      readingOrder: index,
      confidence: 0.98,
    })),
    parserKind: input.parserKind,
    blockIdPrefix: "page_1_block",
  });
  const routeKind =
    input.routeKind ??
    (input.sourceFileKind === "docx" ? "docx_native" : "plain_text_native");

  return buildBundleFromPages({
    bundleId: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: input.sourceFileKind,
    primaryParserKind: input.parserKind,
    parserKinds: [input.parserKind],
    warnings: input.warnings ?? [],
    pages: [
      {
        pageNumber: 1,
        text: fullText,
        charCount: fullText?.length ?? 0,
        parserKinds: [input.parserKind],
        usedOcr: false,
        routeKind,
      },
    ],
    blocks,
    route: {
      routeKind,
      triageReasons: ["text_input_available"],
      preferredExecutors: [input.parserKind],
      usedExecutors: [input.parserKind],
    },
    parserManifest: {
      workerKind: "embedded_node",
      workerVersion: process.versions.node,
      manifestVersion: "019-local-v1",
      runtimeLabel: "node-main-process",
      availableCapabilities: ["text_ingest"],
      executorVersions: {
        [input.parserKind]: process.versions.node,
      },
    },
  });
}
