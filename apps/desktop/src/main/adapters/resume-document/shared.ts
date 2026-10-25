import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  ResumeParserWorkerResponseSchema,
  type ResumeDocumentBundle,
  type ResumeDocumentFileKind,
  type ResumeDocumentParserKind,
  type ResumeParserWorkerResponse,
} from "@nestor/contracts";
import {
  buildBundleFromPages,
  buildDocumentQualitySignal,
  normalizeExtractedText,
} from "../resume-document-utils";
import type { ExtractResumeDocumentInput, MatrixTuple } from "./types";

const require = createRequire(import.meta.url);

function getMatrixNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toMatrixTuple(value: unknown): MatrixTuple {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const numbers = Array.from(value as ArrayLike<unknown>);

    if (numbers.length >= 16) {
      return [
        getMatrixNumber(numbers[0], 1),
        getMatrixNumber(numbers[1], 0),
        getMatrixNumber(numbers[4], 0),
        getMatrixNumber(numbers[5], 1),
        getMatrixNumber(numbers[12], 0),
        getMatrixNumber(numbers[13], 0),
      ];
    }

    if (numbers.length >= 6) {
      return [
        getMatrixNumber(numbers[0], 1),
        getMatrixNumber(numbers[1], 0),
        getMatrixNumber(numbers[2], 0),
        getMatrixNumber(numbers[3], 1),
        getMatrixNumber(numbers[4], 0),
        getMatrixNumber(numbers[5], 0),
      ];
    }
  }

  if (value && typeof value === "object") {
    const matrix = value as {
      a?: unknown;
      b?: unknown;
      c?: unknown;
      d?: unknown;
      e?: unknown;
      f?: unknown;
      m11?: unknown;
      m12?: unknown;
      m21?: unknown;
      m22?: unknown;
      m41?: unknown;
      m42?: unknown;
    };

    return [
      getMatrixNumber(matrix.a ?? matrix.m11, 1),
      getMatrixNumber(matrix.b ?? matrix.m12, 0),
      getMatrixNumber(matrix.c ?? matrix.m21, 0),
      getMatrixNumber(matrix.d ?? matrix.m22, 1),
      getMatrixNumber(matrix.e ?? matrix.m41, 0),
      getMatrixNumber(matrix.f ?? matrix.m42, 0),
    ];
  }

  return [1, 0, 0, 1, 0, 0];
}

class PdfJsDomMatrixPolyfill {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor(value?: unknown) {
    [this.a, this.b, this.c, this.d, this.e, this.f] = toMatrixTuple(value);
  }

  get m11(): number {
    return this.a;
  }

  set m11(value: number) {
    this.a = value;
  }

  get m12(): number {
    return this.b;
  }

  set m12(value: number) {
    this.b = value;
  }

  get m21(): number {
    return this.c;
  }

  set m21(value: number) {
    this.c = value;
  }

  get m22(): number {
    return this.d;
  }

  set m22(value: number) {
    this.d = value;
  }

  get m41(): number {
    return this.e;
  }

  set m41(value: number) {
    this.e = value;
  }

  get m42(): number {
    return this.f;
  }

  set m42(value: number) {
    this.f = value;
  }

  get is2D(): boolean {
    return true;
  }

  get isIdentity(): boolean {
    return (
      this.a === 1 &&
      this.b === 0 &&
      this.c === 0 &&
      this.d === 1 &&
      this.e === 0 &&
      this.f === 0
    );
  }

  multiplySelf(other: unknown): PdfJsDomMatrixPolyfill {
    const [a2, b2, c2, d2, e2, f2] = toMatrixTuple(other);
    const { a, b, c, d, e, f } = this;

    this.a = a * a2 + c * b2;
    this.b = b * a2 + d * b2;
    this.c = a * c2 + c * d2;
    this.d = b * c2 + d * d2;
    this.e = a * e2 + c * f2 + e;
    this.f = b * e2 + d * f2 + f;

    return this;
  }

  preMultiplySelf(other: unknown): PdfJsDomMatrixPolyfill {
    const [a2, b2, c2, d2, e2, f2] = toMatrixTuple(other);
    const { a, b, c, d, e, f } = this;

    this.a = a2 * a + c2 * b;
    this.b = b2 * a + d2 * b;
    this.c = a2 * c + c2 * d;
    this.d = b2 * c + d2 * d;
    this.e = a2 * e + c2 * f + e2;
    this.f = b2 * e + d2 * f + f2;

    return this;
  }

  translate(tx = 0, ty = 0): PdfJsDomMatrixPolyfill {
    return this.clone().translateSelf(tx, ty);
  }

  translateSelf(tx = 0, ty = 0): PdfJsDomMatrixPolyfill {
    return this.multiplySelf([1, 0, 0, 1, tx, ty]);
  }

  scale(
    scaleX = 1,
    scaleY = scaleX,
    scaleZ = 1,
    originX = 0,
    originY = 0,
    originZ = 0,
  ): PdfJsDomMatrixPolyfill {
    return this.clone().scaleSelf(
      scaleX,
      scaleY,
      scaleZ,
      originX,
      originY,
      originZ,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- _scaleZ and _originZ are for API compatibility
  scaleSelf(
    scaleX = 1,
    scaleY = scaleX,
    _scaleZ = 1,
    originX = 0,
    originY = 0,
    _originZ = 0,
  ): PdfJsDomMatrixPolyfill {
    if (originX !== 0 || originY !== 0) {
      this.translateSelf(originX, originY);
    }

    this.multiplySelf([scaleX, 0, 0, scaleY, 0, 0]);

    if (originX !== 0 || originY !== 0) {
      this.translateSelf(-originX, -originY);
    }

    return this;
  }

  invertSelf(): PdfJsDomMatrixPolyfill {
    const determinant = this.a * this.d - this.b * this.c;

    if (!Number.isFinite(determinant) || determinant === 0) {
      this.a = Number.NaN;
      this.b = Number.NaN;
      this.c = Number.NaN;
      this.d = Number.NaN;
      this.e = Number.NaN;
      this.f = Number.NaN;
      return this;
    }

    const { a, b, c, d, e, f } = this;

    this.a = d / determinant;
    this.b = -b / determinant;
    this.c = -c / determinant;
    this.d = a / determinant;
    this.e = (c * f - d * e) / determinant;
    this.f = (b * e - a * f) / determinant;

    return this;
  }

  clone(): PdfJsDomMatrixPolyfill {
    return new PdfJsDomMatrixPolyfill([
      this.a,
      this.b,
      this.c,
      this.d,
      this.e,
      this.f,
    ]);
  }
}

export function ensurePdfJsRuntimePolyfills(): void {
  const scope = globalThis as Record<string, unknown>;

  if (typeof scope.DOMMatrix === "undefined") {
    scope.DOMMatrix = PdfJsDomMatrixPolyfill;
  }
}

export function configurePdfJsWorker(pdfjs: {
  GlobalWorkerOptions: {
    workerSrc: string;
  };
}): void {
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
}

export function countTokens(text: string | null): number {
  return (text ?? "").split(/\s+/).filter(Boolean).length;
}

export function uniqueWarnings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function estimateInvalidUnicodeRatio(text: string | null): number {
  if (!text) {
    return 0;
  }

  let suspiciousCount = 0;

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);

    if (
      codeUnit === 0xfffd ||
      (codeUnit >= 0x0000 && codeUnit <= 0x0008) ||
      codeUnit === 0x000b ||
      codeUnit === 0x000c ||
      (codeUnit >= 0x000e && codeUnit <= 0x001f)
    ) {
      suspiciousCount += 1;
    }
  }

  return suspiciousCount / Math.max(text.length, 1);
}

export function createEmbeddedParserManifest(input: {
  executorVersions: Partial<Record<ResumeDocumentParserKind, string>>;
  runtimeLabel: string;
  availableCapabilities: string[];
}): NonNullable<ResumeParserWorkerResponse["parserManifest"]> {
  const executorVersions = Object.fromEntries(
    Object.entries(input.executorVersions).filter(
      ([, version]) => typeof version === "string" && version.trim().length > 0,
    ),
  ) as Record<string, string>;

  return {
    workerKind: "embedded_node",
    workerVersion: process.versions.node,
    manifestVersion: "019-local-v1",
    runtimeLabel: input.runtimeLabel,
    availableCapabilities: input.availableCapabilities,
    executorVersions,
  };
}

export function bundleToWorkerResponse(
  requestId: string,
  bundle: ResumeDocumentBundle,
): ResumeParserWorkerResponse {
  const pages = bundle.pages.map((page) => {
    const pageBlocks = bundle.blocks.filter(
      (block) => block.pageNumber === page.pageNumber,
    );
    const quality =
      page.quality ??
      buildDocumentQualitySignal({
        fullText: page.text,
        pages: [page],
        blocks: pageBlocks,
        readingOrderConfidence:
          pageBlocks.length > 0
            ? pageBlocks.reduce(
                (sum, block) => sum + (block.readingOrderConfidence ?? 0.86),
                0,
              ) / pageBlocks.length
            : 0.86,
        nativeTextCoverage: page.text ? 1 : 0,
        ocrConfidence: page.usedOcr ? 0.72 : null,
        imageCoverageRatio: page.text ? 0.08 : 0.72,
        invalidUnicodeRatio: estimateInvalidUnicodeRatio(page.text),
      });

    return {
      pageNumber: page.pageNumber,
      text: page.text ?? "",
      charCount: page.charCount ?? page.text?.length ?? 0,
      tokenCount: countTokens(page.text),
      quality,
      qualityWarnings: page.qualityWarnings ?? [],
      usedOcr: page.usedOcr,
      width: page.width ?? null,
      height: page.height ?? null,
    };
  });

  return ResumeParserWorkerResponseSchema.parse({
    requestId,
    ok: true,
    primaryParserKind: bundle.primaryParserKind,
    parserKinds: bundle.parserKinds,
    route: bundle.route ?? null,
    parserManifest: bundle.parserManifest,
    quality: bundle.quality,
    qualityWarnings: bundle.qualityWarnings ?? [],
    warnings: bundle.warnings,
    pages,
    blocks: bundle.blocks,
    fullText: bundle.fullText,
    errorMessage: null,
  });
}

export function createFailureResponse(input: {
  requestId: string;
  primaryParserKind?: ResumeDocumentParserKind | null;
  parserKinds?: ResumeDocumentParserKind[];
  warnings?: string[];
  errorMessage: string;
}): ResumeParserWorkerResponse {
  return ResumeParserWorkerResponseSchema.parse({
    requestId: input.requestId,
    ok: false,
    primaryParserKind: input.primaryParserKind ?? null,
    parserKinds: input.parserKinds ?? [],
    route: null,
    parserManifest: createEmbeddedParserManifest({
      executorVersions: {},
      runtimeLabel: "node-main-process",
      availableCapabilities: [],
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
    qualityWarnings: [],
    warnings: input.warnings ?? [],
    pages: [],
    blocks: [],
    fullText: null,
    errorMessage: input.errorMessage,
  });
}

export function workerResponseToBundle(
  fileKind: ResumeDocumentFileKind,
  input: ExtractResumeDocumentInput,
  response: ResumeParserWorkerResponse,
): ResumeDocumentBundle {
  const primaryParserKind =
    response.primaryParserKind ?? "local_sidecar_fallback";

  return buildBundleFromPages({
    bundleId: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: fileKind,
    primaryParserKind,
    parserKinds:
      response.parserKinds.length > 0
        ? response.parserKinds
        : [primaryParserKind],
    warnings: response.warnings,
    pages: response.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: normalizeExtractedText(page.text),
      charCount: page.charCount,
      parserKinds:
        response.parserKinds.length > 0
          ? response.parserKinds
          : [primaryParserKind],
      usedOcr: page.usedOcr,
      width: page.width,
      height: page.height,
      routeKind: response.route?.routeKind ?? null,
      quality: page.quality,
      qualityWarnings: page.qualityWarnings,
    })),
    blocks: response.blocks,
    route: response.route,
    parserManifest: response.parserManifest,
    quality: response.quality,
    qualityWarnings: response.qualityWarnings,
  });
}

export function buildPdfQualityWarnings(input: {
  pages: ResumeDocumentBundle["pages"];
  quality: ResumeDocumentBundle["quality"];
}): string[] {
  const warnings: string[] = [];

  for (const page of input.pages) {
    if ((page.quality?.nativeTextCoverage ?? 1) < 0.35) {
      warnings.push(
        `Page ${page.pageNumber} has low native text coverage and may need OCR in a later parser worker.`,
      );
    }

    if ((page.quality?.readingOrderConfidence ?? 1) < 0.6) {
      warnings.push(
        `Page ${page.pageNumber} has uncertain reading order and should stay reviewable.`,
      );
    }

    if ((page.quality?.invalidUnicodeRatio ?? 0) > 0.08) {
      warnings.push(
        `Page ${page.pageNumber} contains suspicious text noise from native PDF extraction.`,
      );
    }
  }

  if ((input.quality?.score ?? 1) < 0.58) {
    warnings.push(
      "The embedded PDF parser reported low overall quality, so imported suggestions should stay evidence-backed and reviewable.",
    );
  }

  return warnings;
}
