import {
  CandidateAssetSchema,
  type CandidateAsset,
  type CandidateProfile,
  type DiscoveryActivityEvent,
  type ResumeExportArtifactSummary,
} from "@nestor/contracts";
import {
  resolveApprovedResumeExportForApply,
  savedResumeDigestMatches,
  type AssistantHostPorts,
  type JobFinderWorkspaceService,
} from "@nestor/job-finder";
import { BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractResumeDocument } from "../../adapters/resume-document";
import { getApplicationStore } from "../job-finder/application-store";
import { getApplicationService } from "../applications";
import { getJobStore } from "../job-store";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { getCandidateAssetLibrary } from "../job-finder/candidate-asset-library-instance";
import { getJobFinderRepositoryForWorkspaceService } from "../job-finder/create-workspace-service";
import {
  importResumeFromSourcePath,
  isDesktopResumeImportActive,
} from "../job-finder/import-resume";
import { getJobFinderUserDataDirectory } from "../job-finder/paths";
import { isDesktopTestApiEnabled } from "../job-finder/test-api";
import { getJobFinderWorkspaceService } from "../job-finder/workspace-service";
import {
  createSearchProgressPublisher,
  publishJobFinderWorkspaceUpdate,
} from "../job-finder/workspace-updates";
import { createAssistantBrowserPort } from "./assistant-browser-port";
import { waitForAssistantResumeImport } from "./resume-import-completion";
import { assistantAppCommands } from "./app-commands";
import { readUiResumeBatch, stopUiResumeBatch } from "./ui-resume-batch";

/**
 * The assistant's host ports, implemented with the exact functions the IPC
 * routes use, so a request in the sidebar and a button press take one path:
 * the same resume approval, the same task-scoped sending authority, the same
 * batch start, the same serialized send.
 */

const SEARCH_START_TIMEOUT_MS = 20_000;

async function readWorkspaceProjection(service: JobFinderWorkspaceService) {
  if (!service.getWorkspaceProjection) {
    throw new Error("The assistant workspace view is unavailable.");
  }
  return service.getWorkspaceProjection();
}

async function readProfile(
  service: JobFinderWorkspaceService,
): Promise<CandidateProfile> {
  const repository = getJobFinderRepositoryForWorkspaceService(service);
  return repository
    ? repository.getProfile()
    : (await readWorkspaceProjection(service)).profile;
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
  return "text/plain";
}

interface ResumeDocument {
  asset: CandidateAsset;
  filePath: string;
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
  const service = await getJobFinderWorkspaceService();
  const snapshot =
    documentId === ORIGINAL_RESUME_DOCUMENT_ID
      ? null
      : await readWorkspaceProjection(service);
  const documents: ResumeDocument[] = [];
  const base =
    snapshot?.profile.baseResume ?? (await readProfile(service)).baseResume;
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
  if (!snapshot) return documents;
  const draftsByJob = new Map(
    snapshot.resumeDrafts.map((draft) => [draft.jobId, draft]),
  );
  const exportsByJob = new Map<string, ResumeExportArtifactSummary[]>();
  for (const artifact of snapshot.resumeExportArtifacts) {
    const exports = exportsByJob.get(artifact.jobId) ?? [];
    exports.push(artifact);
    exportsByJob.set(artifact.jobId, exports);
  }
  for (const item of snapshot.reviewQueue) {
    if (
      documentId &&
      documentId !== `${APPROVED_RESUME_DOCUMENT_PREFIX}${item.jobId}`
    )
      continue;
    if (item.resumeReview.status !== "approved") continue;
    const draft = draftsByJob.get(item.jobId);
    if (!draft?.approvedAt) continue;
    const approvedExport = resolveApprovedResumeExportForApply({
      draft,
      exports: exportsByJob.get(item.jobId) ?? [],
    });
    if (!approvedExport?.sha256) continue;
    const filePath = approvedExport.filePath;
    const metadata = await stat(filePath).catch(() => null);
    if (!metadata?.isFile() || metadata.size === 0) continue;
    documents.push({
      filePath,
      asset: CandidateAssetSchema.parse({
        id: `${APPROVED_RESUME_DOCUMENT_PREFIX}${item.jobId}`,
        kind: "resume",
        originalName: path.basename(filePath).slice(0, 255),
        mime: resumeMime(filePath),
        byteSize: metadata.size,
        sha256: approvedExport.sha256,
        createdAt: draft.approvedAt,
        sensitivity: "sensitive",
        consentScope: "job_application_attachment",
        retention: "until_deleted",
        forJob: {
          jobId: item.jobId,
          title: item.title.slice(0, 300),
          company: item.company.slice(0, 300),
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
    async readJobDetail(jobId, planId) {
      const { readJobFinderJobDetail } =
        await import("../job-finder/read-job-detail");
      const service = await getJobFinderWorkspaceService();
      const repository = getJobFinderRepositoryForWorkspaceService(service);
      const activePlan =
        planId ??
        (await repository?.getCampaignState())?.activeCampaignId ??
        null;
      return readJobFinderJobDetail(repository, { jobId, planId: activePlan });
    },
    async executeAction(actionId, input) {
      const { executeDesktopJobFinderAction } =
        await import("./desktop-actions");
      return executeDesktopJobFinderAction(actionId, input);
    },
    isResumeImportActive: isDesktopResumeImportActive,
    async prepareAppNavigation() {
      if (input.browserHost === "embedded") {
        await getEmbeddedBrowser().command({ type: "minimize" });
      }
    },
    readResumeBatch: readUiResumeBatch,
    stopResumeBatch: () => {
      const batch = stopUiResumeBatch();
      if (batch) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send(
              "job-finder:assistant:resume-batch-stop",
              batch.id,
            );
          }
        }
      }
      return batch;
    },
    async startSearch({ searchRequest, targetId }) {
      const service = await getJobFinderWorkspaceService();
      const before = await readWorkspaceProjection(service);
      if (before.activeDiscoveryRun?.state === "running")
        return {
          runId: before.activeDiscoveryRun.id,
          message: "A search is already running.",
        };
      const startedAt = new Date().toISOString();
      let complete!: (runId: string | null) => void;
      const started = new Promise<string | null>((resolve) => {
        complete = resolve;
      });
      let failure: unknown;
      const publishProgress = createSearchProgressPublisher();
      const activity = (event: DiscoveryActivityEvent) => {
        complete(event.runId);
        publishProgress();
      };
      const work = service.runAgentDiscovery(
        activity,
        undefined,
        targetId ?? undefined,
        searchRequest,
      );
      void work
        .then(
          (snapshot) => {
            const run =
              snapshot.activeDiscoveryRun ??
              snapshot.recentDiscoveryRuns.find(
                (entry) => entry.startedAt >= startedAt,
              );
            complete(run?.id ?? null);
          },
          (error: unknown) => {
            failure = error;
            complete(null);
          },
        )
        .finally(() => publishJobFinderWorkspaceUpdate());
      const timer = setTimeout(() => complete(null), SEARCH_START_TIMEOUT_MS);
      let runId: string | null;
      try {
        runId = await started;
      } finally {
        clearTimeout(timer);
      }
      return runId
        ? { runId, message: "The search started." }
        : {
            runId: null,
            message:
              failure instanceof Error
                ? failure.message
                : "The search did not start. Check that at least one job source is on.",
          };
    },
    async cancelSearch(runId) {
      const service = await getJobFinderWorkspaceService();
      await service.cancelDiscoveryRun(runId);
      publishJobFinderWorkspaceUpdate();
    },
    async startApplications({ jobIds, mode, conversationId }) {
      await getJobFinderWorkspaceService();
      if (!conversationId)
        throw new Error(
          "Record the person's sidebar instruction before applying.",
        );
      const store = getApplicationStore();
      const queuedJobIds: string[] = [];
      const heldBack: { jobId: string; title: string; reason: string }[] = [];
      for (let offset = 0; offset < jobIds.length; offset += 200) {
        const batch = jobIds.slice(offset, offset + 200);
        const ids = batch.map((id) => Number(id));
        if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
          throw new Error("Use job ids from Find jobs or Shortlisted.");
        const before = new Map(
          store.forJobs(ids).map((row) => [row.jobId, row]),
        );
        store.applyJobs(
          { selection: { ids } },
          mode === "autonomous_submit" ? mode : "confirm_before_submit",
          { conversationId, mode },
        );
        for (const id of ids) {
          const job = getJobStore().getJob(id);
          const previous = before.get(id);
          if (job?.stage !== "resume")
            heldBack.push({
              jobId: String(id),
              title: job?.title ?? String(id),
              reason:
                "Approve this job's resume on Shortlisted before applying.",
            });
          else if (previous && !["stopped", "failed"].includes(previous.state))
            heldBack.push({
              jobId: String(id),
              title: job.title,
              reason: "This application is already queued, prepared, or sent.",
            });
          else queuedJobIds.push(String(id));
        }
      }
      return { startedJobIds: [], queuedJobIds, heldBack, runId: null };
    },
    async sendPreparedApplications({ jobIds }) {
      await getJobFinderWorkspaceService();
      const runner = await getApplicationService();
      const store = getApplicationStore();
      const sentJobIds: string[] = [];
      const failed: { jobId: string; reason: string }[] = [];
      for (const jobId of jobIds) {
        const [row] = Number.isSafeInteger(Number(jobId))
          ? store.forJobs([Number(jobId)])
          : [];
        try {
          if (row && (await runner.sendPrepared(row.id)))
            sentJobIds.push(jobId);
          else
            failed.push({
              jobId,
              reason: row
                ? (store.getApplication(row.id)?.error ??
                  "This application is not ready to send.")
                : "No application for this job.",
            });
        } catch (error) {
          failed.push({
            jobId,
            reason:
              error instanceof Error
                ? error.message.slice(0, 300)
                : "It could not be sent.",
          });
        }
      }
      return { sentJobIds, failed };
    },
    async checkSource(targetId, options) {
      const service = await getJobFinderWorkspaceService();
      await service.runSourceDebug(targetId, options?.signal, () =>
        publishJobFinderWorkspaceUpdate(),
      );
      publishJobFinderWorkspaceUpdate();
    },
    async listDocuments() {
      const resumes = await listResumeDocuments().catch(() => []);
      return [
        ...resumes.map((document) => document.asset),
        ...(await library.list({ includeDeleted: false })).assets,
      ];
    },
    async readDocumentText(documentId) {
      if (documentId === ORIGINAL_RESUME_DOCUMENT_ID) {
        const service = await getJobFinderWorkspaceService();
        return (await readProfile(service)).baseResume.textContent ?? null;
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
      const service = await getJobFinderWorkspaceService();
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
        await waitForAssistantResumeImport(service, imported, options);
      } finally {
        publishJobFinderWorkspaceUpdate();
      }
    },
    publishWorkspaceUpdate: () => publishJobFinderWorkspaceUpdate(),
  };
  if (input.browserHost === "embedded") {
    ports.browser = createAssistantBrowserPort(
      getEmbeddedBrowser(),
      async () => {
        const service = await getJobFinderWorkspaceService();
        return readWorkspaceProjection(service);
      },
    );
  }
  return ports;
}
