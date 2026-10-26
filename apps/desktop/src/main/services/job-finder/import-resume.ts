import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  canRetrySavedResumeImport,
  type CandidateProfile,
  type ResumeImportProgressEvent,
  type ResumeImportRun,
  type ResumeSourceDocument,
} from "@nestor/contracts";
import {
  detectResumeDocumentFileKind,
  extractResumeDocument,
  getPdfPageCount,
} from "../../adapters/resume-document";
import { generateResumeVisionImages } from "../../adapters/resume-vision-images";
import { startJobFinderRuntime } from "./runtime";
import { getJobFinderDocumentsDirectory } from "./paths";

export interface ImportResumeFromSourcePathOptions {
  onProgress?: (event: ResumeImportProgressEvent) => void;
  useVision?: boolean;
  signal?: AbortSignal;
  /**
   * The name the person knows the file by. Set when importing the private
   * working copy again, whose own name carries a timestamp prefix.
   */
  fileName?: string;
}

/**
 * Where an import keeps its private working copy: the documents directory,
 * named `<timestamp>_<file name>` with the same timestamp as the resume id
 * `resume_<timestamp>`. Null when the id does not follow that shape.
 */
export function resolveResumeWorkingCopyPath(input: {
  documentsDirectory: string;
  sourceResumeId: string;
  fileName: string;
}): string | null {
  const timestamp = /^resume_(\d+)$/.exec(input.sourceResumeId)?.[1];
  const fileName = path.basename(input.fileName.trim());
  if (!timestamp || !fileName) {
    return null;
  }
  return path.join(input.documentsDirectory, `${timestamp}_${fileName}`);
}

/** The profile an import left, with the run that wrote it. */
export interface ImportedResume {
  profile: CandidateProfile;
  latestResumeImportRun: ResumeImportRun | null;
}

export class ResumeImportRetryUnavailableError extends Error {}

export class ResumeImportUnreadableFileError extends Error {}

/**
 * A damaged or truncated PDF must never replace a working resume: it would be
 * attached to applications as-is. A scanned PDF with no text is still a valid
 * file and passes; only a file that does not open as a PDF with pages fails.
 */
export async function assertResumeFileOpens(
  filePath: string,
  fileName: string,
): Promise<void> {
  if (detectResumeDocumentFileKind(filePath) !== "pdf") {
    return;
  }
  const pageCount = await getPdfPageCount(filePath).catch(() => 0);
  if (pageCount < 1) {
    throw new ResumeImportUnreadableFileError(
      `${fileName} could not be opened as a PDF; it looks damaged or incomplete. Your current resume is unchanged. Save or export it again, or import a DOCX or text copy.`,
    );
  }
}

/**
 * Imports again the file an import was reading when the app closed. The
 * working copy saved at the start of that import is read in place of a file
 * picker, so starting over is one press instead of finding the file again.
 */
export async function retryInterruptedResumeImport(
  latestRun: ResumeImportRun | null,
  options: Omit<ImportResumeFromSourcePathOptions, "fileName"> = {},
): Promise<ImportedResume> {
  if (!latestRun || !canRetrySavedResumeImport(latestRun)) {
    throw new ResumeImportRetryUnavailableError(
      "There is no failed import to try again. Choose your resume file to import it.",
    );
  }
  const workingCopy = resolveResumeWorkingCopyPath({
    documentsDirectory: getJobFinderDocumentsDirectory(),
    sourceResumeId: latestRun.sourceResumeId,
    fileName: latestRun.sourceResumeFileName,
  });
  const exists = workingCopy
    ? await access(workingCopy).then(
        () => true,
        () => false,
      )
    : false;
  if (!workingCopy || !exists) {
    throw new ResumeImportRetryUnavailableError(
      `The saved copy of ${latestRun.sourceResumeFileName} is no longer on this device. Choose the file again to import it.`,
    );
  }
  return importResumeFromSourcePath(workingCopy, {
    ...options,
    fileName: latestRun.sourceResumeFileName,
  });
}

let activeDesktopImports = 0;

export function isDesktopResumeImportActive(): boolean {
  return activeDesktopImports > 0;
}

export async function importResumeFromSourcePath(
  sourcePath: string,
  options: ImportResumeFromSourcePathOptions = {},
): Promise<ImportedResume> {
  activeDesktopImports += 1;
  try {
    return await importResumeFile(sourcePath, options);
  } finally {
    activeDesktopImports -= 1;
  }
}

async function importResumeFile(
  sourcePath: string,
  options: ImportResumeFromSourcePathOptions,
): Promise<ImportedResume> {
  const targetDirectory = getJobFinderDocumentsDirectory();
  const { profileService, repository } = await startJobFinderRuntime();
  const readImported = async (): Promise<ImportedResume> => ({
    profile: await repository.getProfile(),
    latestResumeImportRun: await repository.getLatestResumeImportRun(),
  });
  const useVision = options.useVision ?? true;
  // The four stages are the ones the contract names, in the order they run, so
  // the renderer can show "step 2 of 4" instead of one label that sits frozen
  // for the ~30s the model stages take. Expectations are stated per stage
  // rather than only after 45s, which a 36s import never reached.
  const stageOrder: readonly ResumeImportProgressEvent["stage"][] = [
    "saving_file",
    "reading_document",
    "building_profile",
    "saving_results",
  ];
  const stageExpectations: Record<
    ResumeImportProgressEvent["stage"],
    { max: number; min: number }
  > = {
    saving_file: { max: 2, min: 0 },
    reading_document: { max: 5, min: 0 },
    building_profile: { max: 60, min: 15 },
    saving_results: { max: 3, min: 0 },
  };
  const reportProgress = (
    stage: ResumeImportProgressEvent["stage"],
    message: string,
  ) =>
    options.onProgress?.({
      stage,
      message,
      occurredAt: new Date().toISOString(),
      completed: stageOrder.indexOf(stage),
      total: stageOrder.length,
      expectedSecondsMin: stageExpectations[stage].min,
      expectedSecondsMax: stageExpectations[stage].max,
    });

  reportProgress(
    "saving_file",
    "Saving a private working copy on this device.",
  );
  await mkdir(targetDirectory, { recursive: true });

  const timestamp = Date.now();
  const uploadedAt = new Date(timestamp).toISOString();
  const fileName = path.basename(
    options.fileName?.trim() || path.basename(sourcePath),
  );
  const resumeId = `resume_${timestamp}`;
  const targetPath = path.join(targetDirectory, `${timestamp}_${fileName}`);
  const seedRunId = `resume_import_seed_${timestamp}`;
  const sourceFileKind = detectResumeDocumentFileKind(targetPath);
  const shouldGenerateVision =
    useVision &&
    sourceFileKind !== "plain_text" &&
    sourceFileKind !== "markdown";

  await assertResumeFileOpens(sourcePath, fileName);
  await copyFile(sourcePath, targetPath);
  const sourceSha256 = createHash("sha256")
    .update(await readFile(targetPath))
    .digest("hex");
  reportProgress(
    "reading_document",
    "Reading resume text, sections, and page layout.",
  );
  const extractionInput = {
    bundleId: `resume_bundle_${timestamp}`,
    runId: seedRunId,
    sourceResumeId: resumeId,
  };
  const generatedVisionArtifactPromise = shouldGenerateVision
    ? generateResumeVisionImages({
        filePath: targetPath,
        fileKind: sourceFileKind,
        runId: seedRunId,
        sourceResumeId: resumeId,
        artifactId: `resume_vision_artifact_${timestamp}`,
      }).catch((error) => ({
        artifact: null,
        warnings: [
          error instanceof Error
            ? `Local resume image generation failed: ${error.message}`
            : "Local resume image generation failed before the vision branch could start.",
        ],
      }))
    : Promise.resolve({ artifact: null, warnings: [] });

  const [extractedResume, generatedVisionArtifact] = await Promise.all([
    extractResumeDocument(targetPath, extractionInput),
    generatedVisionArtifactPromise,
  ]);
  const visionWarnings = generatedVisionArtifact.warnings;
  const extractionStatus = extractedResume.textContent
    ? "not_started"
    : "needs_text";
  const baseResume: ResumeSourceDocument = {
    id: resumeId,
    fileName,
    uploadedAt,
    storagePath: targetPath,
    sha256: sourceSha256,
    textContent: extractedResume.textContent,
    textUpdatedAt: extractedResume.textContent ? uploadedAt : null,
    extractionStatus,
    lastAnalyzedAt: null,
    analysisProviderKind: null,
    analysisProviderLabel: null,
    analysisWarnings:
      extractedResume.warnings.length > 0 || visionWarnings.length > 0
        ? [...extractedResume.warnings, ...visionWarnings]
        : extractedResume.textContent
          ? []
          : [
              "Paste plain-text resume content below if you want the agent to extract profile details from this file.",
            ],
  };

  const hasReadableResumeContent = Boolean(
    extractedResume.textContent ||
    generatedVisionArtifact.artifact?.pages.length,
  );
  // Always announce this stage. It is the single longest phase of the import,
  // and skipping it for an unreadable file left the previous stage's label
  // frozen on screen for the whole wait.
  reportProgress(
    "building_profile",
    hasReadableResumeContent
      ? "Reading your resume and filling in your profile. Anything that would replace details you already saved waits for your review."
      : "Checking what can be recovered from this file.",
  );
  const snapshot = await profileService
    .runResumeImport({
      baseResume,
      ...(options.signal ? { signal: options.signal } : {}),
      documentBundle: extractedResume.bundle,
      importWarnings: [...extractedResume.warnings, ...visionWarnings],
      ...(generatedVisionArtifact.artifact
        ? { visionArtifact: generatedVisionArtifact.artifact }
        : {}),
    })
    .then(readImported)
    .catch(async (error: unknown) => {
      const saved = await readImported();
      if (
        saved.profile.baseResume.id === resumeId &&
        saved.latestResumeImportRun?.sourceResumeId === resumeId &&
        saved.latestResumeImportRun.status === "failed"
      ) {
        return saved;
      }
      throw error;
    });

  reportProgress(
    "saving_results",
    snapshot.latestResumeImportRun?.status === "failed"
      ? "Your file is saved. You can try again or continue manually."
      : hasReadableResumeContent
        ? "Saving the imported resume and review items."
        : "Saving the import issue and recovery guidance.",
  );
  return snapshot;
}
