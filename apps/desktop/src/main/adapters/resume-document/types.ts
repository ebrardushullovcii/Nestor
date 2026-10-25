import type { ResumeDocumentBlock, ResumeDocumentBundle } from '@nestor/contracts'

export type ExtractResumeDocumentInput = {
  bundleId: string
  runId: string
  sourceResumeId: string
}

export type ExtractResumeDocumentResult = {
  bundle: ResumeDocumentBundle
  textContent: string | null
  warnings: string[]
}

export type MatrixTuple = [number, number, number, number, number, number]

export type PdfTextItem = {
  str: string
  dir: string
  width: number
  height: number
  transform: number[]
  fontName: string
  hasEOL: boolean
}

export type PdfTextLineEntry = {
  text: string
  bbox: ResumeDocumentBlock['bbox']
  confidence: number | null
  readingOrderConfidence: number | null
}
