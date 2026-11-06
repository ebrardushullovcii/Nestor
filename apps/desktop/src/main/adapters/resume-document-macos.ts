import { reportSelfLimitHit } from "@nestor/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ResumeDocumentBundleSchema,
  type ResumeDocumentBundle,
} from "@nestor/contracts";

const execFileAsync = promisify(execFile);
const MAX_MACOS_PROCESS_OUTPUT_BYTES = 10 * 1024 * 1024;

function getSwiftExecutable(): {
  executable: string;
  leadingArgs: string[];
} {
  const configuredSwiftPath = process.env.NESTOR_SWIFT_PATH?.trim();
  const candidates = [
    ...(configuredSwiftPath
      ? [{ executable: configuredSwiftPath, leadingArgs: [] as string[] }]
      : []),
    { executable: "/usr/bin/swift", leadingArgs: [] as string[] },
    { executable: "/usr/bin/xcrun", leadingArgs: ["swift"] },
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate.executable)) {
      return candidate;
    }
  }

  throw new Error(
    "Swift runtime not found. Install Xcode Command Line Tools or set NESTOR_SWIFT_PATH to a local Swift executable.",
  );
}

function getSwiftParserScriptPath(): string {
  const builtCandidate = fileURLToPath(
    new URL("./scripts/parse_resume.swift", import.meta.url),
  );
  const repoCandidateA = path.join(
    process.cwd(),
    "src/main/adapters/scripts/parse_resume.swift",
  );
  const repoCandidateB = path.join(
    process.cwd(),
    "../src/main/adapters/scripts/parse_resume.swift",
  );

  const candidates = [builtCandidate, repoCandidateA, repoCandidateB];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Swift parser script not found. Tried: ${candidates.join(", ")}`,
  );
}

export async function extractDocxTextWithTextutil(
  filePath: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "/usr/bin/textutil",
    ["-convert", "txt", "-stdout", filePath],
    { maxBuffer: MAX_MACOS_PROCESS_OUTPUT_BYTES },
  ).catch((error: unknown) => {
    reportMacParserBufferLimit(error);
    throw error;
  });

  const normalized = stdout
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized || null;
}

export async function extractPdfDocumentBundleWithMacOs(
  filePath: string,
  input: {
    bundleId: string;
    runId: string;
    sourceResumeId: string;
  },
): Promise<ResumeDocumentBundle> {
  const swiftExecutable = getSwiftExecutable();
  const { stdout } = await execFileAsync(
    swiftExecutable.executable,
    [
      ...swiftExecutable.leadingArgs,
      getSwiftParserScriptPath(),
      filePath,
      input.bundleId,
      input.runId,
      input.sourceResumeId,
    ],
    { maxBuffer: MAX_MACOS_PROCESS_OUTPUT_BYTES },
  ).catch((error: unknown) => {
    reportMacParserBufferLimit(error);
    throw error;
  });

  return ResumeDocumentBundleSchema.parse(JSON.parse(stdout) as unknown);
}

function reportMacParserBufferLimit(error: unknown): void {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  )
    reportSelfLimitHit({
      limit: "mac_resume_parser_buffer",
      kind: "input",
      value: MAX_MACOS_PROCESS_OUTPUT_BYTES,
      where: "desktop/resume-document-macos",
    });
}
