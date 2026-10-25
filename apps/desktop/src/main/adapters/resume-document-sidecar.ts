import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ResumeImportVisionArtifactSchema,
  ResumeParserWorkerResponseSchema,
  type ResumeDocumentFileKind,
  type ResumeImportVisionArtifact,
  type ResumeParserWorkerRequest,
  type ResumeParserWorkerResponse,
} from "@nestor/contracts";

const DEFAULT_PARSER_TIMEOUT_MS = 45_000;
const MAX_SIDECAR_OUTPUT_BYTES = 512_000;
const MAX_VISION_IMAGE_OUTPUT_BYTES = 64_000_000;
const SIDECAR_BINARY_NAME =
  process.platform === "win32"
    ? "resume_parser_sidecar.exe"
    : "resume_parser_sidecar";
const SIDECAR_PLATFORM_DIR = `${process.platform}-${process.arch}`;

type SidecarCommandCandidate = {
  command: string;
  args: string[];
  label: string;
  env?: NodeJS.ProcessEnv;
};

type SidecarBundleManifest = {
  signature?: string;
  bundledRequirements?: string[];
  targets?: Record<
    string,
    {
      ready?: boolean;
      platform?: string;
      arch?: string;
      binaryPath?: string;
      pythonRoot?: string;
      pythonCommand?: string;
    }
  >;
};

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.filter((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    const normalized =
      process.platform === "win32" ? trimmed.toLowerCase() : trimmed;

    if (seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

function getGeneratedSidecarRootCandidates(): string[] {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;

  return uniquePaths(
    [
      path.join(currentDir, "..", "..", "dist", "resume-parser-sidecar"),
      path.join(process.cwd(), "dist", "resume-parser-sidecar"),
      path.join(process.cwd(), "../dist", "resume-parser-sidecar"),
      resourcesPath ? path.join(resourcesPath, "resume-parser-sidecar") : "",
    ].filter(Boolean),
  );
}

function readBundledSidecarManifest(): {
  manifestPath: string;
  manifest: SidecarBundleManifest;
} | null {
  for (const root of getGeneratedSidecarRootCandidates()) {
    const manifestPath = path.join(root, "manifest.json");

    if (!existsSync(manifestPath)) {
      continue;
    }

    try {
      return {
        manifestPath,
        manifest: JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as SidecarBundleManifest,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function logBundledSidecarAvailability() {
  const manifestEntry = readBundledSidecarManifest();

  if (!manifestEntry) {
    console.warn(
      "[ResumeImport] No bundled resume parser sidecar manifest was found. The app may rely on Python fallback paths.",
    );
    return;
  }

  const targetKey = `${process.platform}-${process.arch}`;
  const currentTarget = manifestEntry.manifest.targets?.[targetKey];
  const availableTargets = Object.keys(manifestEntry.manifest.targets ?? {});

  if (currentTarget?.ready) {
    console.log(
      `[ResumeImport] Bundled resume parser sidecar ready for ${targetKey}. Available targets: ${availableTargets.join(", ") || "none"}`,
    );
    return;
  }

  console.warn(
    `[ResumeImport] Bundled resume parser sidecar is missing for ${targetKey}. Available targets: ${availableTargets.join(", ") || "none"}`,
  );
}

const sidecarAvailability = { logged: false };

/** @internal — exported only for test reset */
export function _resetSidecarAvailabilityLogged(): void {
  sidecarAvailability.logged = false;
}

function getBundledSidecarBinaryPath(): string | null {
  const override = process.env.NESTOR_RESUME_PARSER_SIDECAR_BINARY_PATH?.trim();
  const candidates = uniquePaths([
    override ?? "",
    ...getGeneratedSidecarRootCandidates().map((root) =>
      path.join(root, "bin", SIDECAR_PLATFORM_DIR, SIDECAR_BINARY_NAME),
    ),
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPythonPathEntriesForScript(scriptPath: string): string[] {
  const override = process.env.NESTOR_RESUME_PARSER_PYTHONPATH?.trim();
  const scriptDir = path.dirname(scriptPath);

  return uniquePaths(
    [
      override ?? "",
      path.join(scriptDir, "site-packages"),
      path.join(scriptDir, ".python-packages"),
    ].filter((candidate) => Boolean(candidate) && existsSync(candidate)),
  );
}

function buildCandidateEnv(
  extraPythonPaths: readonly string[] = [],
): NodeJS.ProcessEnv | undefined {
  if (extraPythonPaths.length === 0) {
    return undefined;
  }

  const combinedPythonPath = uniquePaths(
    [...extraPythonPaths, process.env.PYTHONPATH ?? ""].filter(Boolean),
  ).join(path.delimiter);

  return {
    ...process.env,
    PYTHONPATH: combinedPythonPath,
  };
}

function buildPythonCommandCandidate(
  command: string,
  scriptPath: string,
): SidecarCommandCandidate {
  const trimmed = command.trim();
  const env = buildCandidateEnv(getPythonPathEntriesForScript(scriptPath));

  if (trimmed.toLowerCase() === "py") {
    const candidate: SidecarCommandCandidate = {
      command: trimmed,
      args: ["-3", scriptPath],
      label: `${trimmed} -3`,
      ...(env ? { env } : {}),
    };

    return candidate;
  }

  const candidate: SidecarCommandCandidate = {
    command: trimmed,
    args: [scriptPath],
    label: trimmed,
    ...(env ? { env } : {}),
  };

  return candidate;
}

function getResumeParserSidecarScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const builtCandidate = path.join(
    currentDir,
    "scripts",
    "resume_parser_sidecar.py",
  );
  const generatedCandidates = getGeneratedSidecarRootCandidates().map((root) =>
    path.join(root, "python", "resume_parser_sidecar.py"),
  );
  const repoCandidateA = path.join(
    process.cwd(),
    "src/main/adapters/scripts/resume_parser_sidecar.py",
  );
  const repoCandidateB = path.join(
    process.cwd(),
    "../src/main/adapters/scripts/resume_parser_sidecar.py",
  );
  const overrideCandidate =
    process.env.NESTOR_RESUME_PARSER_SIDECAR_PATH?.trim();

  const candidates = [
    overrideCandidate,
    ...generatedCandidates,
    builtCandidate,
    repoCandidateA,
    repoCandidateB,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Python resume parser sidecar script not found. Tried: ${candidates.join(", ")}`,
  );
}

function resolveBundledScriptPathFromManifest(): string | null {
  const manifestEntry = readBundledSidecarManifest();
  const currentTarget = manifestEntry?.manifest.targets?.[SIDECAR_PLATFORM_DIR];
  const pythonRoot =
    typeof currentTarget?.pythonRoot === "string"
      ? currentTarget.pythonRoot
      : null;

  if (!manifestEntry || !pythonRoot) {
    return null;
  }

  const manifestRoot = path.dirname(manifestEntry.manifestPath);
  const resolvedPythonRoot = path.isAbsolute(pythonRoot)
    ? pythonRoot
    : path.resolve(manifestRoot, pythonRoot);
  const relativePythonRoot = path.relative(manifestRoot, resolvedPythonRoot);
  if (
    !path.isAbsolute(pythonRoot) &&
    (relativePythonRoot === ".." ||
      relativePythonRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePythonRoot))
  ) {
    return null;
  }
  const candidate = path.join(resolvedPythonRoot, "resume_parser_sidecar.py");
  return existsSync(candidate) ? candidate : null;
}

function getSidecarCommandCandidates(
  scriptPath: string,
): SidecarCommandCandidate[] {
  const override = process.env.NESTOR_RESUME_PARSER_PYTHON?.trim();
  const bundledBinaryPath = getBundledSidecarBinaryPath();
  const candidates: SidecarCommandCandidate[] = [];

  if (bundledBinaryPath) {
    candidates.push({
      command: bundledBinaryPath,
      args: [],
      label: path.basename(bundledBinaryPath),
    });
  }

  if (override) {
    candidates.push(buildPythonCommandCandidate(override, scriptPath));
    return candidates;
  }

  const commands =
    process.platform === "win32"
      ? ["py", "python", "python3"]
      : ["python3", "python", "py"];

  candidates.push(
    ...commands.map((command) =>
      buildPythonCommandCandidate(command, scriptPath),
    ),
  );
  return candidates;
}

function createSidecarFailureResponse(input: {
  request: ResumeParserWorkerRequest;
  message: string;
  warnings?: readonly string[];
}): ResumeParserWorkerResponse {
  return ResumeParserWorkerResponseSchema.parse({
    requestId: input.request.requestId,
    ok: false,
    primaryParserKind: null,
    parserKinds: [],
    route: null,
    parserManifest: {
      workerKind: "python_sidecar",
      workerVersion: null,
      manifestVersion: "019-python-sidecar-v1",
      runtimeLabel: null,
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
    warnings: [...(input.warnings ?? [])],
    pages: [],
    blocks: [],
    fullText: null,
    errorMessage: input.message,
  });
}

function createVisionImageFailureResponse(input: {
  artifactId: string;
  runId: string;
  sourceResumeId: string;
  sourceFileKind: ResumeDocumentFileKind;
  message: string;
  warnings?: readonly string[];
}): {
  ok: false;
  artifact: ResumeImportVisionArtifact;
  warnings: string[];
  errorMessage: string;
} {
  const warnings = [...(input.warnings ?? [])];
  return {
    ok: false,
    artifact: ResumeImportVisionArtifactSchema.parse({
      id: input.artifactId,
      runId: input.runId,
      sourceResumeId: input.sourceResumeId,
      sourceFileKind: input.sourceFileKind,
      createdAt: new Date().toISOString(),
      retained: "temporary",
      pages: [],
      warnings,
    }),
    warnings,
    errorMessage: input.message,
  };
}

function isMissingCommandError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : null;
  return code === "ENOENT";
}

function appendSidecarOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > MAX_SIDECAR_OUTPUT_BYTES
    ? next.slice(next.length - MAX_SIDECAR_OUTPUT_BYTES)
    : next;
}

export function appendBoundedSidecarOutputForTest(
  current: string,
  chunk: Buffer | string,
  maxBytes: number,
): string {
  const next = current + chunk.toString();

  if (next.length > maxBytes) {
    throw new Error(
      `Python resume parser sidecar output exceeded ${maxBytes} bytes.`,
    );
  }

  return next;
}

async function invokeSidecarCandidate<TResult>(input: {
  candidate: SidecarCommandCandidate;
  request: ResumeParserWorkerRequest | Record<string, unknown>;
  timeoutMs: number;
  maxOutputBytes?: number;
  parseOutput: (output: unknown) => TResult;
}): Promise<TResult> {
  return await new Promise<TResult>((resolve, reject) => {
    const child = spawn(input.candidate.command, input.candidate.args, {
      env: input.candidate.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(
          new Error(
            `Python resume parser sidecar timed out after ${input.timeoutMs}ms (${input.candidate.label}).`,
          ),
        );
      });
    }, input.timeoutMs);

    child.once("error", (error) => {
      finish(() => reject(error));
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (input.maxOutputBytes) {
        try {
          stdout = appendBoundedSidecarOutputForTest(
            stdout,
            chunk,
            input.maxOutputBytes,
          );
        } catch (error) {
          child.kill();
          finish(() =>
            reject(
              error instanceof Error
                ? error
                : new Error(
                    "Python resume parser sidecar output exceeded the configured limit.",
                  ),
            ),
          );
        }
        return;
      }

      stdout = appendSidecarOutput(stdout, chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendSidecarOutput(stderr, chunk);
    });

    child.once("close", (code) => {
      finish(() => {
        try {
          if (!stdout.trim()) {
            throw new Error(
              code === 0
                ? `Python resume parser sidecar returned no output (${input.candidate.label}).`
                : `Python resume parser sidecar exited with code ${code ?? "unknown"} (${input.candidate.label}). ${stderr.trim() || "No stderr output."}`,
            );
          }

          const parsed = JSON.parse(stdout) as unknown;
          resolve(input.parseOutput(parsed));
        } catch (error) {
          const details = stderr.trim();
          const message =
            error instanceof Error
              ? error.message
              : "Python resume parser sidecar returned invalid output.";

          reject(new Error(details ? `${message} ${details}` : message));
        }
      });
    });

    child.stdin.write(JSON.stringify(input.request));
    child.stdin.end();
  });
}

export type ResumeVisionImageSidecarResponse = {
  ok: boolean;
  artifact: ResumeImportVisionArtifact;
  warnings: string[];
  errorMessage: string | null;
};

function parseVisionImageSidecarResponse(
  value: unknown,
): ResumeVisionImageSidecarResponse {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ok: record.ok === true,
    artifact: ResumeImportVisionArtifactSchema.parse(record.artifact),
    warnings: Array.isArray(record.warnings)
      ? record.warnings.flatMap((entry) =>
          typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
        )
      : [],
    errorMessage:
      typeof record.errorMessage === "string" && record.errorMessage.trim()
        ? record.errorMessage.trim()
        : null,
  };
}

export async function runResumeParserSidecar(
  request: ResumeParserWorkerRequest,
  timeoutMs = DEFAULT_PARSER_TIMEOUT_MS,
): Promise<ResumeParserWorkerResponse> {
  if (!sidecarAvailability.logged) {
    sidecarAvailability.logged = true;
    logBundledSidecarAvailability();
  }

  const bundledBinaryPath = getBundledSidecarBinaryPath();
  let scriptPath: string | null = null;

  try {
    scriptPath = getResumeParserSidecarScriptPath();
  } catch (error) {
    if (!bundledBinaryPath) {
      return createSidecarFailureResponse({
        request,
        message:
          error instanceof Error
            ? error.message
            : "Python resume parser sidecar script is unavailable.",
        warnings: [
          "Python resume parser sidecar script could not be located, so desktop import will fall back to the embedded parser.",
        ],
      });
    }

    scriptPath = resolveBundledScriptPathFromManifest();
  }

  if (!scriptPath && !bundledBinaryPath) {
    return createSidecarFailureResponse({
      request,
      message: "Python resume parser sidecar script is unavailable.",
      warnings: [
        "Python resume parser sidecar script could not be located, so desktop import will fall back to the embedded parser.",
      ],
    });
  }

  const candidates = scriptPath
    ? getSidecarCommandCandidates(scriptPath)
    : bundledBinaryPath
      ? [
          {
            command: bundledBinaryPath,
            args: [],
            label: path.basename(bundledBinaryPath),
          },
        ]
      : [];
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await invokeSidecarCandidate({
        candidate,
        request,
        timeoutMs,
        parseOutput: (output) => ResumeParserWorkerResponseSchema.parse(output),
      });
    } catch (error) {
      lastError = error;

      if (isMissingCommandError(error)) {
        continue;
      }

      break;
    }
  }

  const fallbackMessage =
    lastError instanceof Error
      ? lastError.message
      : "Python resume parser sidecar could not be started.";

  return createSidecarFailureResponse({
    request,
    message: fallbackMessage,
    warnings: [
      "Python resume parser sidecar could not complete, so desktop import will fall back to the embedded parser.",
    ],
  });
}

export async function runResumeVisionImageSidecar(input: {
  filePath: string;
  fileKind: ResumeDocumentFileKind;
  artifactId: string;
  runId: string;
  sourceResumeId: string;
  retention?: "temporary" | "debug_retained" | "benchmark_retained";
  timeoutMs?: number;
}): Promise<ResumeVisionImageSidecarResponse> {
  if (!sidecarAvailability.logged) {
    sidecarAvailability.logged = true;
    logBundledSidecarAvailability();
  }

  const bundledBinaryPath = getBundledSidecarBinaryPath();
  let scriptPath: string | null = null;

  try {
    scriptPath = getResumeParserSidecarScriptPath();
  } catch (error) {
    if (!bundledBinaryPath) {
      return createVisionImageFailureResponse({
        artifactId: input.artifactId,
        runId: input.runId,
        sourceResumeId: input.sourceResumeId,
        sourceFileKind: input.fileKind,
        message:
          error instanceof Error
            ? error.message
            : "Python resume parser sidecar script is unavailable.",
        warnings: [
          "Local resume vision image generation could not start because the parser sidecar script was unavailable.",
        ],
      });
    }

    scriptPath = resolveBundledScriptPathFromManifest();
  }

  if (!scriptPath && !bundledBinaryPath) {
    return createVisionImageFailureResponse({
      artifactId: input.artifactId,
      runId: input.runId,
      sourceResumeId: input.sourceResumeId,
      sourceFileKind: input.fileKind,
      message: "Python resume parser sidecar script is unavailable.",
      warnings: [
        "Local resume vision image generation could not start because the parser sidecar script was unavailable.",
      ],
    });
  }

  const candidates = scriptPath
    ? getSidecarCommandCandidates(scriptPath)
    : bundledBinaryPath
      ? [
          {
            command: bundledBinaryPath,
            args: [],
            label: path.basename(bundledBinaryPath),
          },
        ]
      : [];
  const request = {
    operation: "render_vision_images",
    requestId: `resume_vision_images_${Date.now()}`,
    filePath: input.filePath,
    fileKind: input.fileKind,
    artifactId: input.artifactId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    retention: input.retention ?? "temporary",
  };
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const response = await invokeSidecarCandidate({
        candidate,
        request,
        timeoutMs: input.timeoutMs ?? DEFAULT_PARSER_TIMEOUT_MS,
        maxOutputBytes: MAX_VISION_IMAGE_OUTPUT_BYTES,
        parseOutput: parseVisionImageSidecarResponse,
      });
      return response;
    } catch (error) {
      lastError = error;

      if (isMissingCommandError(error)) {
        continue;
      }

      break;
    }
  }

  const fallbackMessage =
    lastError instanceof Error
      ? lastError.message
      : "Python resume parser sidecar could not render local resume page images.";

  return createVisionImageFailureResponse({
    artifactId: input.artifactId,
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    sourceFileKind: input.fileKind,
    message: fallbackMessage,
    warnings: [
      "Local resume vision image generation failed; import can continue with text extraction only.",
    ],
  });
}
