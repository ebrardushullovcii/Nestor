import { readFile } from 'node:fs/promises'
import { type ResumeDocumentBundle } from '@nestor/contracts'
import { extractPdfDocumentBundleWithMacOs } from '../resume-document-macos'
import {
  buildBundleFromPages,
  buildDocumentQualitySignal,
  createLineBlocks,
  normalizeExtractedText,
} from '../resume-document-utils'
import {
  buildPdfQualityWarnings,
  configurePdfJsWorker,
  createEmbeddedParserManifest,
  ensurePdfJsRuntimePolyfills,
  estimateInvalidUnicodeRatio,
} from './shared'
import type {
  ExtractResumeDocumentInput,
  PdfTextItem,
  PdfTextLineEntry,
} from './types'
import type { ResumeParserWorkerRequest } from '@nestor/contracts'

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return (
    item !== null &&
    typeof item === 'object' &&
    'str' in item &&
    typeof (item as Record<string, unknown>).str === 'string' &&
    'transform' in item &&
    Array.isArray((item as Record<string, unknown>).transform)
  )
}

function joinPdfLineText(items: readonly PdfTextItem[]): string {
  let text = ''
  let previousRight: number | null = null

  for (const item of items) {
    const itemText = item.str
    const x = item.transform[4] ?? 0
    const width = Math.max(0, item.width ?? 0)
    const height = Math.abs(item.height ?? 0) || 10
    const gap = previousRight == null ? 0 : x - previousRight
    const startsWithPunctuation = /^[,.;:!?)}\]]/.test(itemText)

    if (text.length > 0 && gap > Math.max(2, height * 0.18) && !startsWithPunctuation && !text.endsWith(' ')) {
      text += ' '
    }

    text += itemText
    previousRight = x + width
  }

  return text.replace(/\s+/g, ' ').trim()
}

function groupTextItemsIntoLines(items: PdfTextItem[], pageHeight: number): PdfTextLineEntry[] {
  const groups: Array<{ y: number; items: PdfTextItem[] }> = []
  const yTolerance = 4

  for (const item of items) {
    const itemY = item.transform[5]
    if (typeof itemY !== 'number') {
      continue
    }

    const group = groups.find((entry) => Math.abs(entry.y - itemY) <= yTolerance)

    if (group) {
      group.items.push(item)
      continue
    }

    groups.push({ y: itemY, items: [item] })
  }

  const lines: PdfTextLineEntry[] = []

  groups
    .sort((left, right) => right.y - left.y)
    .forEach((group) => {
      const lineItems = [...group.items].sort((left, right) => (left.transform[4] ?? 0) - (right.transform[4] ?? 0))
      const text = joinPdfLineText(lineItems)

      if (!text) {
        return
      }

      let left = Number.POSITIVE_INFINITY
      let top = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      let bottom = Number.NEGATIVE_INFINITY

      for (const item of lineItems) {
        const x = item.transform[4] ?? 0
        const y = item.transform[5] ?? 0
        const width = Math.max(0, item.width ?? 0)
        const height = Math.abs(item.height ?? 0) || 10
        const itemTop = Math.max(0, pageHeight - y - height)
        const itemBottom = itemTop + height

        left = Math.min(left, x)
        top = Math.min(top, itemTop)
        right = Math.max(right, x + width)
        bottom = Math.max(bottom, itemBottom)
      }

      lines.push({
        text,
        bbox:
          Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom)
            ? {
                left,
                top,
                width: Math.max(0, right - left),
                height: Math.max(0, bottom - top),
              }
            : null,
        confidence: 0.72,
        readingOrderConfidence: lineItems.length > 1 ? 0.88 : 0.8,
      })
    })

  return lines
}

export async function extractPdfDocumentBundleWithPdfJs(
  filePath: string,
  input: ExtractResumeDocumentInput,
  request: ResumeParserWorkerRequest,
): Promise<ResumeDocumentBundle> {
  ensurePdfJsRuntimePolyfills()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  configurePdfJsWorker(pdfjs)
  const rawBytes = await readFile(filePath)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(rawBytes),
    useWorkerFetch: false,
    isEvalSupported: false,
  })
  const document = await loadingTask.promise
  const pages: ResumeDocumentBundle['pages'] = []
  const blocks: ResumeDocumentBundle['blocks'] = []

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent()
      const textItems = textContent.items.filter(isPdfTextItem)
      const lineEntries = groupTextItemsIntoLines(textItems, viewport.height)
      const pageBlocks = createLineBlocks({
        pageNumber,
        lines: lineEntries.map((line, index) => ({
          text: line.text,
          bbox: line.bbox,
          readingOrder: index,
          confidence: line.confidence,
          readingOrderConfidence: line.readingOrderConfidence,
        })),
        parserKind: 'pdfjs_text',
        blockIdPrefix: `page_${pageNumber}_block`,
      })
      const pageText = normalizeExtractedText(pageBlocks.map((block) => block.text).join('\n'))
      const pageQuality = buildDocumentQualitySignal({
        fullText: pageText,
        pages: [
          {
            pageNumber,
            text: pageText,
            charCount: pageText?.length ?? 0,
            parserKinds: ['pdfjs_text'],
            usedOcr: false,
            width: viewport.width,
            height: viewport.height,
            routeKind: 'native_first',
          },
        ],
        blocks: pageBlocks,
        readingOrderConfidence:
          pageBlocks.length > 0
            ? pageBlocks.reduce((sum, block) => sum + (block.readingOrderConfidence ?? 0.86), 0) / pageBlocks.length
            : 0.42,
        nativeTextCoverage: pageText ? 1 : 0,
        imageCoverageRatio: pageText ? 0.08 : 0.72,
        invalidUnicodeRatio: estimateInvalidUnicodeRatio(pageText),
      })
      const qualityWarnings: string[] = []

      if ((pageQuality.nativeTextCoverage ?? 1) < 0.35) {
        qualityWarnings.push('low_native_text_coverage')
      }

      if ((pageQuality.readingOrderConfidence ?? 1) < 0.6) {
        qualityWarnings.push('reading_order_uncertain')
      }

      pages.push({
        pageNumber,
        text: pageText,
        charCount: pageText?.length ?? 0,
        parserKinds: ['pdfjs_text'],
        usedOcr: false,
        width: viewport.width,
        height: viewport.height,
        routeKind: 'native_first',
        quality: pageQuality,
        qualityWarnings,
      })
      blocks.push(...pageBlocks)
    }
  } finally {
    await document.destroy()
  }

  const quality = buildDocumentQualitySignal({
    fullText: normalizeExtractedText(pages.map((page) => page.text ?? '').filter(Boolean).join('\n\n')),
    pages,
    blocks,
    readingOrderConfidence:
      blocks.length > 0
        ? blocks.reduce((sum, block) => sum + (block.readingOrderConfidence ?? 0.86), 0) / blocks.length
        : 0.42,
    nativeTextCoverage:
      pages.length > 0 ? pages.filter((page) => (page.text?.length ?? 0) > 0).length / pages.length : 0,
    imageCoverageRatio:
      pages.length > 0 ? pages.filter((page) => !page.text).length / pages.length : 1,
    invalidUnicodeRatio: estimateInvalidUnicodeRatio(
      normalizeExtractedText(pages.map((page) => page.text ?? '').join('\n\n')),
    ),
  })
  const qualityWarnings = buildPdfQualityWarnings({ pages, quality })

  return buildBundleFromPages({
    bundleId: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: 'pdf',
    primaryParserKind: 'pdfjs_text',
    parserKinds: ['pdfjs_text'],
    warnings: qualityWarnings,
    pages,
    blocks,
    route: {
      routeKind: request.preferredRoute ?? 'native_first',
      triageReasons: ['embedded_pdfjs_layout_grouping', 'native_text_layer_available'],
      preferredExecutors: request.preferredExecutors,
      usedExecutors: ['pdfjs_text'],
    },
    parserManifest: createEmbeddedParserManifest({
      executorVersions: {
        pdfjs_text: process.versions.node,
      },
      runtimeLabel: 'node-pdfjs-parser',
      availableCapabilities: ['pdf_text_probe', 'layout_line_grouping'],
    }),
    quality,
    qualityWarnings,
  })
}

export async function extractMacOsPdfDocumentBundle(
  filePath: string,
  input: ExtractResumeDocumentInput,
  request: ResumeParserWorkerRequest,
): Promise<ResumeDocumentBundle> {
  let macOsBundle: ResumeDocumentBundle

  try {
    macOsBundle = await extractPdfDocumentBundleWithMacOs(filePath, input)
  } catch (error) {
    console.warn(
      `[ResumeImport] macOS native PDF parser unavailable, so the embedded PDF.js parser was used: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    return extractPdfDocumentBundleWithPdfJs(filePath, input, request)
  }

  const pages = macOsBundle.pages.map((page) => ({
    ...page,
    routeKind: request.preferredRoute ?? 'native_first',
    quality:
      page.quality ??
      buildDocumentQualitySignal({
        fullText: page.text,
        pages: [page],
        blocks: macOsBundle.blocks.filter((block) => block.pageNumber === page.pageNumber),
        readingOrderConfidence:
          macOsBundle.blocks
            .filter((block) => block.pageNumber === page.pageNumber)
            .reduce((sum, block, index, collection) => {
              if (collection.length === 0) {
                return 0.9
              }

              return sum + (block.readingOrderConfidence ?? 0.9)
            }, 0) /
          Math.max(1, macOsBundle.blocks.filter((block) => block.pageNumber === page.pageNumber).length),
        nativeTextCoverage: page.usedOcr ? 0.32 : 1,
        ocrConfidence: page.usedOcr ? 0.74 : null,
        imageCoverageRatio: page.usedOcr ? 0.82 : 0.08,
        invalidUnicodeRatio: estimateInvalidUnicodeRatio(page.text),
      }),
  }))
  const blocks = macOsBundle.blocks.map((block) => ({
    ...block,
    parserLineage: block.parserLineage ?? block.sourceParserKinds,
    readingOrderConfidence: block.readingOrderConfidence ?? (block.bbox ? 0.92 : 0.82),
    lineIds: block.lineIds ?? [block.id.replace('_block_', '_line_')],
    textSpan: block.textSpan ?? null,
  }))
  const quality =
    macOsBundle.quality ??
    buildDocumentQualitySignal({
      fullText: macOsBundle.fullText,
      pages,
      blocks,
      readingOrderConfidence:
        blocks.length > 0
          ? blocks.reduce((sum, block) => sum + (block.readingOrderConfidence ?? 0.88), 0) / blocks.length
          : 0.88,
      nativeTextCoverage:
        pages.length > 0 ? pages.filter((page) => !page.usedOcr).length / pages.length : 0,
      ocrConfidence: pages.some((page) => page.usedOcr) ? 0.74 : null,
      imageCoverageRatio:
        pages.length > 0 ? pages.filter((page) => page.usedOcr).length / pages.length : 0,
      invalidUnicodeRatio: estimateInvalidUnicodeRatio(macOsBundle.fullText),
    })
  const warnings = [...macOsBundle.warnings, ...buildPdfQualityWarnings({ pages, quality })]

  return buildBundleFromPages({
    bundleId: input.bundleId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: 'pdf',
    primaryParserKind: macOsBundle.primaryParserKind,
    parserKinds: macOsBundle.parserKinds,
    warnings,
    pages,
    blocks,
    route: {
      routeKind: request.preferredRoute ?? 'native_first',
      triageReasons: pages.some((page) => page.usedOcr)
        ? ['macos_native_pdf_text', 'page_level_ocr_fallback']
        : ['macos_native_pdf_text'],
      preferredExecutors: request.preferredExecutors,
      usedExecutors: macOsBundle.parserKinds,
    },
    parserManifest: createEmbeddedParserManifest({
      executorVersions: {
        macos_pdfkit_text: process.versions.node,
        macos_vision_ocr: process.versions.node,
      },
      runtimeLabel: 'macos-swift-pdf-parser',
      availableCapabilities: ['pdf_native_text', 'page_level_ocr_fallback'],
    }),
    quality,
    qualityWarnings: buildPdfQualityWarnings({ pages, quality }),
  })
}

export async function getPdfPageCount(filePath: string): Promise<number> {
  ensurePdfJsRuntimePolyfills()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  configurePdfJsWorker(pdfjs)
  const rawBytes = await readFile(filePath)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(rawBytes),
    useWorkerFetch: false,
    isEvalSupported: false,
  })
  const document = await loadingTask.promise

  try {
    return document.numPages
  } finally {
    await document.destroy()
  }
}
