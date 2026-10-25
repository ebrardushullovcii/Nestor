import {
  ResumeImportVisionArtifactSchema,
  type ResumeDocumentFileKind,
  type ResumeImportArtifactRetention,
  type ResumeImportVisionArtifact,
} from "@nestor/contracts";
import { runResumeVisionImageSidecar } from "./resume-document-sidecar";
import { detectResumeDocumentFileKind } from "./resume-document/worker";

function parseRetentionMode(
  env: NodeJS.ProcessEnv,
): ResumeImportArtifactRetention {
  const raw = env.NESTOR_RESUME_VISION_RETAIN_ARTIFACTS?.trim().toLowerCase();

  if (
    raw === "debug" ||
    raw === "debug_retained" ||
    raw === "1" ||
    raw === "true"
  ) {
    return "debug_retained";
  }

  if (raw === "benchmark" || raw === "benchmark_retained") {
    return "benchmark_retained";
  }

  return "temporary";
}

function parseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(
    env.NESTOR_RESUME_VISION_IMAGE_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 600_000;
}

export async function generateResumeVisionImages(input: {
  filePath: string;
  runId: string;
  sourceResumeId: string;
  artifactId?: string;
  fileKind?: ResumeDocumentFileKind;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  artifact: ResumeImportVisionArtifact;
  warnings: string[];
}> {
  const env = input.env ?? process.env;
  const fileKind =
    input.fileKind ?? detectResumeDocumentFileKind(input.filePath);
  const artifactId = input.artifactId ?? `resume_vision_artifact_${Date.now()}`;
  const retention = parseRetentionMode(env);
  const response = await runResumeVisionImageSidecar({
    filePath: input.filePath,
    fileKind,
    artifactId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    retention,
    timeoutMs: parseTimeoutMs(env),
  });
  const baseWarnings =
    response.warnings.length > 0
      ? response.warnings
      : response.artifact.warnings;
  const mergedWarnings = response.errorMessage
    ? [...baseWarnings, response.errorMessage]
    : baseWarnings;
  const artifact = ResumeImportVisionArtifactSchema.parse({
    ...response.artifact,
    id: artifactId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: fileKind,
    retained: retention,
    pages: response.artifact.pages.map((page) => ({
      ...page,
      sourceResumeId: input.sourceResumeId,
      sourceFileKind: fileKind,
      retained: retention,
      dataUrl: retention === "temporary" ? page.dataUrl : null,
      storagePath: retention === "temporary" ? null : page.storagePath,
    })),
    warnings: mergedWarnings,
  });

  return {
    artifact,
    warnings: mergedWarnings,
  };
}
