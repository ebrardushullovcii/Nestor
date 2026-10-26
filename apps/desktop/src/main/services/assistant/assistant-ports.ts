import { savePageJobs } from "@nestor/job-finder/job-commands";
import { createResumeStore } from "@nestor/db/job-store";
import { getJobStore } from "../job-store";
import {
  readAssistantPersonalState,
  runAssistantReadCommand,
} from "./store-reads";
import {
  CandidateAssetSchema,
  type CandidateAsset,
  type CandidateProfile,
  type ShortlistedPage,
} from "@nestor/contracts";
import {
  savedResumeDigestMatches,
  type AssistantHostPorts,
} from "@nestor/job-finder";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractResumeDocument } from "../../adapters/resume-document";
import { getApplicationStore } from "../job-finder/application-store";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { loadEmbeddedBrowser } from "../browser/load-embedded-browser";
import { getCandidateAssetLibrary } from "../job-finder/candidate-asset-library-instance";
import {
  importResumeFromSourcePath,
  isDesktopResumeImportActive,
} from "../job-finder/import-resume";
import { getJobFinderUserDataDirectory } from "../job-finder/paths";
import { isDesktopTestApiEnabled } from "../job-finder/test-api";
import { notifyJobFinderChange } from "../job-finder/changes";
import { getProfileService } from "../job-finder/runtime";
import { createAssistantBrowserPort } from "./assistant-browser-port";
import { waitForAssistantResumeImport } from "./resume-import-completion";
import { assistantAppCommands } from "./app-commands";

/**
 * The assistant's host ports, implemented with the exact functions the IPC
 * routes use, so a request in the sidebar and a button press take one path:
 * the same resume approval, the same task-scoped sending authority, the same
 * batch start, the same serialized send.
 */

async function readProfile(): Promise<CandidateProfile> {
  return (await readAssistantPersonalState()).profile;
}

async function withTempCopy<T>(
  asset: CandidateAsset,
  bytes: Uint8Array,
  use: (filePath: string) => Promise<T>,
): Promise<T> {
  const directory = path.join(
    getJobFinderUserDataDirectory(),
    "tmp",
    "assistant",
  );
  await mkdir(directory, { recursive: true });
  const filePath = path.join(
    directory,
    `${Date.now()}_${path.basename(asset.originalName)}`,
  );
  await writeFile(filePath, bytes, { mode: 0o600 });
  try {
    return await use(filePath);
  } finally {
    await rm(filePath, { force: true });
  }
}

/** The imported resume, as the assistant's file list shows it. */
const ORIGINAL_RESUME_DOCUMENT_ID = "original_resume";
/** One approved, job-specific resume PDF per job: `approved_resume_<jobId>`. */
const APPROVED_RESUME_DOCUMENT_PREFIX = "approved_resume_";

function resumeMime(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".md") return "text/markdown";
  if (extension === ".html" || extension === ".htm") return "text/html";
  return "text/plain";
}

interface ResumeDocument {
  asset: CandidateAsset;
  filePath: string;
}

/** Every approved job, a page at a time. */
async function approvedJobIds(): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | null = null;
  do {
    const page: ShortlistedPage = await runAssistantReadCommand(
      "list_shortlisted",
      {
        stage: "resume",
        limit: 200,
        ...(cursor ? { cursor } : {}),
      },
    );
    ids.push(...page.rows.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/**
 * The resumes an application can send, as documents the assistant can list
 * and upload: the imported Original, and each job's approved resume. They
 * live in the profile and the resume workspace, not the file library, so the
 * assistant used to see only the extra files and could not attach either.
 */
async function listResumeDocuments(
  documentId?: string,
): Promise<ResumeDocument[]> {
  const documents: ResumeDocument[] = [];
  const base = (await readProfile()).baseResume;
  if (
    (!documentId || documentId === ORIGINAL_RESUME_DOCUMENT_ID) &&
    base.storagePath &&
    base.sha256
  ) {
    const metadata = await stat(base.storagePath).catch(() => null);
    if (metadata?.isFile() && metadata.size > 0) {
      documents.push({
        filePath: base.storagePath,
        asset: CandidateAssetSchema.parse({
          id: ORIGINAL_RESUME_DOCUMENT_ID,
          kind: "resume",
          originalName: base.fileName.slice(0, 255),
          mime: resumeMime(base.fileName),
          byteSize: metadata.size,
          sha256: base.sha256,
          createdAt: base.uploadedAt,
          sensitivity: "sensitive",
          consentScope: "job_application_attachment",
          retention: "until_deleted",
        }),
      });
    }
  }
  const jobId = documentId?.startsWith(APPROVED_RESUME_DOCUMENT_PREFIX)
    ? Number(documentId.slice(APPROVED_RESUME_DOCUMENT_PREFIX.length))
    : null;
  const ids = jobId ? [jobId] : documentId ? [] : await approvedJobIds();
  for (const id of ids) {
    const { job, resume } = await runAssistantReadCommand("get_resume", {
      jobId: id,
    });
    if (!resume?.approvedAt || !resume.pdfPath || resume.state !== "ready")
      continue;
    const filePath = resume.pdfPath;
    const metadata = await stat(filePath).catch(() => null);
    if (!metadata?.isFile() || !metadata.size) continue;
    // Approved before hashes were kept: the file is hashed the first time
    // it is needed, and later uploads must match that.
    let sha256 = resume.pdfSha256;
    if (!sha256) {
      sha256 = createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex");
      createResumeStore(getJobStore()).rememberPdfHash(id, sha256);
    }
    documents.push({
      filePath,
      asset: CandidateAssetSchema.parse({
        id: `${APPROVED_RESUME_DOCUMENT_PREFIX}${id}`,
        kind: "resume",
        originalName: path.basename(filePath).slice(0, 255),
        mime: resumeMime(filePath),
        byteSize: metadata.size,
        sha256,
        createdAt: resume.approvedAt,
        sensitivity: "sensitive",
        consentScope: "job_application_attachment",
        retention: "until_deleted",
        forJob: {
          jobId: String(id),
          title: job.title.slice(0, 300),
          company: job.company.slice(0, 300),
        },
      }),
    });
  }
  return documents;
}

async function findResumeDocument(
  documentId: string,
): Promise<ResumeDocument | null> {
  if (
    documentId !== ORIGINAL_RESUME_DOCUMENT_ID &&
    !documentId.startsWith(APPROVED_RESUME_DOCUMENT_PREFIX)
  ) {
    return null;
  }
  return (
    (await listResumeDocuments(documentId)).find(
      (document) => document.asset.id === documentId,
    ) ?? null
  );
}

export function createAssistantHostPorts(input: {
  browserHost: "embedded" | "external";
}): AssistantHostPorts {
  const library = getCandidateAssetLibrary();
  const ports: AssistantHostPorts = {
    commands: assistantAppCommands(),
    readPersonalState: readAssistantPersonalState,
    readCommand: runAssistantReadCommand,
    savePageJobs: (input) =>
      Promise.resolve(savePageJobs(getJobStore(), input)),
    async executeAction(actionId, input) {
      const { executeDesktopJobFinderAction } =
        await import("./desktop-actions");
      return executeDesktopJobFinderAction(actionId, input);
    },
    isResumeImportActive: isDesktopResumeImportActive,
    async prepareAppNavigation() {
      if (input.browserHost === "embedded") {
        await (await loadEmbeddedBrowser()).command({ type: "minimize" });
      }
    },
    resolveApprovedJobs: (selection) =>
      Promise.resolve(getApplicationStore().selectedJobIds(selection)),
    async checkSource(targetId, options) {
      const service = await getProfileService();
      await service.runSourceDebug(targetId, options?.signal, () =>
        notifyJobFinderChange(),
      );
      notifyJobFinderChange();
    },
    async listDocuments() {
      const resumes = await listResumeDocuments();
      return [
        ...resumes.map((document) => document.asset),
        ...(await library.list({ includeDeleted: false })).assets,
      ];
    },
    async readDocumentText(documentId) {
      if (documentId === ORIGINAL_RESUME_DOCUMENT_ID) {
        return (await readProfile()).baseResume.textContent ?? null;
      }
      const resumeDocument = await findResumeDocument(documentId);
      if (resumeDocument) {
        const extracted = await extractResumeDocument(resumeDocument.filePath, {
          bundleId: `assistant_read_${Date.now()}`,
          runId: `assistant_read_${Date.now()}`,
          sourceResumeId: documentId,
        });
        return extracted.textContent;
      }
      const resolved = await library.resolveForApplication(documentId);
      const bytes = await resolved.loadVerifiedBytes();
      if (resolved.asset.mime.startsWith("text/")) {
        return new TextDecoder().decode(bytes);
      }
      return withTempCopy(resolved.asset, bytes, async (filePath) => {
        const extracted = await extractResumeDocument(filePath, {
          bundleId: `assistant_read_${Date.now()}`,
          runId: `assistant_read_${Date.now()}`,
          sourceResumeId: documentId,
        });
        return extracted.textContent;
      });
    },
    async loadDocumentFile(documentId) {
      const resumeDocument = await findResumeDocument(documentId);
      if (resumeDocument) {
        const bytes = await readFile(resumeDocument.filePath);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (!savedResumeDigestMatches(resumeDocument.asset.sha256, sha256)) {
          throw new Error(
            "That resume changed on disk since it was saved. Import or approve it again.",
          );
        }
        return {
          name: resumeDocument.asset.originalName,
          mimeType: resumeDocument.asset.mime,
          bytes: Uint8Array.from(bytes),
        };
      }
      const resolved = await library.resolveForApplication(documentId);
      return {
        name: resolved.asset.originalName,
        mimeType: resolved.asset.mime,
        bytes: await resolved.loadVerifiedBytes(),
      };
    },
    async importResumeDocument(documentId, options) {
      options?.signal?.throwIfAborted();
      const service = await getProfileService();
      const resolved = await library.resolveForApplication(documentId);
      const bytes = await resolved.loadVerifiedBytes();
      options?.signal?.throwIfAborted();
      const imported = await withTempCopy(resolved.asset, bytes, (filePath) =>
        importResumeFromSourcePath(filePath, {
          fileName: resolved.asset.originalName,
          useVision: !isDesktopTestApiEnabled(),
        }),
      );
      try {
        await waitForAssistantResumeImport(service, imported, {
          ...options,
          readProfile,
        });
      } finally {
        notifyJobFinderChange();
      }
    },
    publishWorkspaceUpdate: () => notifyJobFinderChange(),
  };
  if (input.browserHost === "embedded") {
    ports.browser = createAssistantBrowserPort(
      getEmbeddedBrowser(),
      async (id) => runAssistantReadCommand("get_application_details", { id }),
      (url) => getApplicationStore().holdsFormAt(url),
    );
  }
  return ports;
}
