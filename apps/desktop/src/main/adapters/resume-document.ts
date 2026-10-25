import { buildBundleFromText } from './resume-document-utils'
import { workerResponseToBundle } from './resume-document/shared'
import type {
  ExtractResumeDocumentInput,
  ExtractResumeDocumentResult,
} from './resume-document/types'
import {
  createResumeParserWorkerRequest,
  defaultPreferredRoute,
  executeResumeParserWorker,
} from './resume-document/worker'
export { getPdfPageCount } from './resume-document/pdf'
export {
  createResumeParserWorkerRequest,
  detectResumeDocumentFileKind,
  mergeDocxFallbackIdentityEvidence,
  shouldFallbackToEmbeddedDocxResponse,
} from './resume-document/worker'

export async function extractResumeDocument(
  filePath: string,
  input: ExtractResumeDocumentInput,
): Promise<ExtractResumeDocumentResult> {
  const request = createResumeParserWorkerRequest(filePath)
  const response = await executeResumeParserWorker(request, input)

  if (!response.ok || !response.primaryParserKind) {
    const bundle = buildBundleFromText({
      bundleId: input.bundleId,
      runId: input.runId,
      sourceResumeId: input.sourceResumeId,
      sourceFileKind: request.fileKind,
      parserKind: 'local_sidecar_fallback',
      text: null,
      warnings: [
        ...response.warnings,
        response.errorMessage ?? 'Resume extraction failed before automatic text extraction could complete.',
      ],
      routeKind: defaultPreferredRoute(request.fileKind) ?? 'unsupported_fallback',
    })

    return {
      bundle,
      textContent: bundle.fullText,
      warnings: bundle.warnings,
    }
  }

  const bundle = workerResponseToBundle(request.fileKind, input, response)

  return {
    bundle,
    textContent: bundle.fullText,
    warnings: bundle.warnings,
  }
}

export async function extractResumeText(filePath: string): Promise<{
  textContent: string | null
  warnings: string[]
}> {
  const extracted = await extractResumeDocument(filePath, {
    bundleId: `bundle_${Date.now()}`,
    runId: `run_${Date.now()}`,
    sourceResumeId: `resume_${Date.now()}`,
  })

  return {
    textContent: extracted.textContent,
    warnings: extracted.warnings,
  }
}
