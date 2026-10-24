import { withJobFinderWorkspaceUpdates } from "../services/job-finder/workspace-updates";
import { ApplicationLetterGroundingError } from "@nestor/job-finder";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { isDesktopTestApiEnabled } from "../services/job-finder/test-api";
import { getJobFinderUserDataDirectory } from "../services/job-finder/paths";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  ApplicationDocumentExportResultSchema,
  ApplicationDocumentListResultSchema,
  ApplicationDocumentRevisionSchema,
  ApproveApplicationDocumentInputSchema,
  ExportApplicationDocumentInputSchema,
  EditApplicationDocumentInputSchema,
  ListApplicationDocumentsInputSchema,
  ProposeApplicationDocumentInputSchema,
  type ApplicationDocumentRevision,
  type ApplyRunDetails,
  type ApplicationQuestionRecord,
  type JobFinderWorkspaceSnapshot,
  type SavedJob,
} from "@nestor/contracts";
import {
  ApplicationDocumentLibraryError,
  type ApplicationDocumentLibrary,
} from "../services/job-finder/application-document-library";
import { getApplicationDocumentLibrary } from "../services/job-finder/application-document-library-instance";
import { getJobFinderWorkspaceService } from "../services/job-finder";

interface ApplicationDocumentRouteDependencies {
  library: ApplicationDocumentLibrary;
  getWorkspaceProjection: () => Promise<JobFinderWorkspaceSnapshot>;
  /** The one job, record and result a listing needs; read by id. */
  getApplicationDocumentContext?: (
    jobId: string,
    applicationRecordId: string,
  ) => Promise<ApplicationDocumentContext | null>;
  getApplyRunDetails: (
    runId: string,
    jobId: string,
    applicationRecordId: string,
  ) => Promise<ApplyRunDetails>;
  refreshApprovedLetter?: (
    document: ApplicationDocumentRevision,
  ) => Promise<void>;
  selectExportPath: (
    event: IpcMainInvokeEvent | null,
    defaultFileName: string,
  ) => Promise<string | null>;
  /** Model-written, fact-checked draft text. Null reports a failed draft. */
  writeDocumentText?: (input: {
    jobId: string;
    kind: "cover_letter" | "short_response";
    questionPrompt: string | null;
    priorText: string | null;
  }) => Promise<string | null>;
}

interface ApplicationDocumentContext {
  profile: JobFinderWorkspaceSnapshot["profile"];
  job: SavedJob | null;
  applicationRecord:
    | JobFinderWorkspaceSnapshot["applicationRecords"][number]
    | null;
  latestResult: JobFinderWorkspaceSnapshot["applyJobResults"][number] | null;
}

async function selectExportPath(
  event: IpcMainInvokeEvent | null,
  defaultFileName: string,
) {
  if (!event) {
    const directory = isDesktopTestApiEnabled()
      ? path.join(getJobFinderUserDataDirectory(), "exports") : app.getPath("downloads");
    await mkdir(directory, { recursive: true });
    return path.join(directory, `${Date.now()}_${path.basename(defaultFileName)}`);
  }
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options = {
    title: "Export application document",
    defaultPath: defaultFileName,
    filters: [{ name: "Text document", extensions: ["txt"] }],
  };
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? null : (result.filePath ?? null);
}

function wrapStorageError(error: unknown): never {
  if (error instanceof ApplicationDocumentLibraryError) throw error;
  throw new ApplicationDocumentLibraryError(
    "The application document operation could not be completed.",
  );
}

export function createApplicationDocumentOperations(
  dependencies: ApplicationDocumentRouteDependencies = {
    library: getApplicationDocumentLibrary(),
    getWorkspaceProjection: async () => {
      const workspace = await getJobFinderWorkspaceService();
      if (!workspace.getWorkspaceProjection) {
        throw new Error("Application document context is unavailable.");
      }
      return workspace.getWorkspaceProjection();
    },
    getApplicationDocumentContext: async (jobId, applicationRecordId) => {
      const workspace = await getJobFinderWorkspaceService();
      return (
        (await workspace.getApplicationDocumentContext?.(
          jobId,
          applicationRecordId,
        )) ?? null
      );
    },
    getApplyRunDetails: async (runId, jobId, applicationRecordId) => {
      const workspace = await getJobFinderWorkspaceService();
      return workspace.getApplyRunDetails(runId, jobId, applicationRecordId);
    },
    refreshApprovedLetter: async (document) => {
      const workspace = await getJobFinderWorkspaceService();
      await workspace.refreshApprovedApplicationLetter(document);
    },
    selectExportPath,
    writeDocumentText: async (input) => {
      const workspace = await getJobFinderWorkspaceService();
      return workspace.writeApplicationDocumentText(input);
    },
  },
) {
  const operations = new Map<string, (event: IpcMainInvokeEvent | null, payload: unknown) => Promise<unknown>>();
  const add = (name: string, operation: (event: IpcMainInvokeEvent | null, payload: unknown) => Promise<unknown>) => operations.set(name, operation);
  // A listing needs one job, its record and its newest result. Reading them
  // by id kept opening Applications from rebuilding all saved jobs.
  const readApplicationDocumentContext = async (
    jobId: string,
    applicationRecordId: string,
  ): Promise<ApplicationDocumentContext | null> => {
    const direct = await dependencies.getApplicationDocumentContext?.(
      jobId,
      applicationRecordId,
    );
    if (direct) return direct;
    const snapshot = await dependencies.getWorkspaceProjection();
    return {
      profile: snapshot.profile,
      job: snapshot.discoveryJobs.find((entry) => entry.id === jobId) ?? null,
      applicationRecord:
        snapshot.applicationRecords.find(
          (entry) => entry.id === applicationRecordId && entry.jobId === jobId,
        ) ?? null,
      latestResult:
        [...snapshot.applyJobResults]
          .filter(
            (entry) =>
              entry.jobId === jobId &&
              entry.applicationRecordId === applicationRecordId,
          )
          .sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
          )[0] ?? null,
    };
  };

  add(
    "job-finder:list-application-documents",
    async (_event, payload) => {
      try {
        const input = ListApplicationDocumentsInputSchema.parse(payload);
        const listed = await dependencies.library.list(input);
        const context = await readApplicationDocumentContext(
          input.jobId,
          input.applicationRecordId,
        ).catch(() => null);
        if (!context) return ApplicationDocumentListResultSchema.parse(listed);
        const { job, applicationRecord } = context;
        const result = context.latestResult;
        const letter = result?.reviewCard?.letter;
        const documentId =
          result && letter
            ? `attached_letter_${result.id}_${createHash("sha256").update(letter.text).digest("hex").slice(0, 16)}`
            : null;
        // A letter already kept here, such as the approved one going on the
        // form, is not saved again as another proposed copy.
        if (
          job &&
          applicationRecord &&
          letter &&
          documentId &&
          ![...listed.documents, ...(listed.approvedRevisions ?? [])].some(
            (entry) =>
              entry.id === documentId ||
              entry.content.trim() === letter.text.trim(),
          )
        ) {
          try {
            await dependencies.library.propose({
              createDocumentId: documentId,
              reviewReason: letter.reviewReason ?? null,
              kind: "cover_letter",
              writtenContent: letter.text,
              grounding: {
                profile: context.profile,
                job,
                applicationRecord,
                question: null,
              },
            });
          } catch {
            // A failed background capture must never hide existing drafts.
            return ApplicationDocumentListResultSchema.parse(listed);
          }
          return ApplicationDocumentListResultSchema.parse(
            await dependencies.library.list(input),
          );
        }
        return ApplicationDocumentListResultSchema.parse(listed);
      } catch (error) {
        return wrapStorageError(error);
      }
    },
  );

  add(
    "job-finder:propose-application-document",
    async (_event, payload) => {
      try {
        const input = ProposeApplicationDocumentInputSchema.parse(payload);
        const snapshot = await dependencies.getWorkspaceProjection();
        const job = snapshot.discoveryJobs.find(
          (entry) => entry.id === input.jobId,
        );
        const applicationRecord = snapshot.applicationRecords.find(
          (entry) => entry.id === input.applicationRecordId,
        );
        if (!job || !applicationRecord || applicationRecord.jobId !== job.id) {
          throw new ApplicationDocumentLibraryError(
            "The selected application no longer matches this job.",
          );
        }
        let question: ApplicationQuestionRecord | null = null;
        if (input.question) {
          const details = await dependencies.getApplyRunDetails(
            input.question.runId,
            job.id,
            applicationRecord.id,
          );
          const result = details.result;
          const hasExactRunResultLineage =
            details.run.id === input.question.runId &&
            details.run.jobIds.includes(job.id) &&
            result?.runId === input.question.runId &&
            result.jobId === job.id &&
            result.applicationRecordId === applicationRecord.id;
          question = hasExactRunResultLineage
            ? (details.questionRecords.find(
                (entry) =>
                  entry.id === input.question?.questionId &&
                  entry.runId === input.question.runId &&
                  entry.jobId === job.id &&
                  entry.applicationRecordId === applicationRecord.id &&
                  entry.resultId === result?.id,
              ) ?? null)
            : null;
          if (!question) {
            throw new ApplicationDocumentLibraryError(
              "The selected attachment question is stale or belongs to another application.",
            );
          }
        }
        const priorText = input.documentId
          ? ((
              await dependencies.library.list({
                jobId: job.id,
                applicationRecordId: applicationRecord.id,
              })
            ).documents.find((entry) => entry.id === input.documentId)
              ?.content ?? null)
          : null;
        let writtenContent: string | null = null;
        let reviewReason: string | null = null;
        if (dependencies.writeDocumentText) {
          try {
            writtenContent = await dependencies.writeDocumentText({
              jobId: job.id,
              kind: input.kind,
              questionPrompt: question?.prompt ?? null,
              priorText,
            });
          } catch (error) {
            if (!(error instanceof ApplicationLetterGroundingError)) {
              throw new ApplicationDocumentLibraryError(
                "Job Finder could not write this draft right now. Try again.",
              );
            }
            writtenContent = error.draftText;
            reviewReason = error.message;
          }
        }
        if (dependencies.writeDocumentText && !writtenContent?.trim()) {
          throw new ApplicationDocumentLibraryError(
            "Job Finder could not write and check this document. Try again; no draft was kept.",
          );
        }
        return ApplicationDocumentRevisionSchema.parse(
          await dependencies.library.propose({
            writtenContent,
            reviewReason,
            kind: input.kind,
            ...(input.documentId ? { documentId: input.documentId } : {}),
            ...(input.expectedRevision
              ? { expectedRevision: input.expectedRevision }
              : {}),
            grounding: {
              profile: snapshot.profile,
              job,
              applicationRecord,
              question,
            },
          }),
        );
      } catch (error) {
        return wrapStorageError(error);
      }
    },
  );

  add(
    "job-finder:approve-application-document",
    async (event, payload) => {
      try {
        const input = ApproveApplicationDocumentInputSchema.parse(payload);
        const approved = await dependencies.library.approve(
          input.documentId,
          input.expectedRevision,
        );
        if (dependencies.refreshApprovedLetter) {
          if (event) {
            await withJobFinderWorkspaceUpdates(event.sender, () => dependencies.refreshApprovedLetter!(approved));
          } else {
            await dependencies.refreshApprovedLetter(approved);
          }
        }
        return ApplicationDocumentRevisionSchema.parse(approved);
      } catch (error) {
        return wrapStorageError(error);
      }
    },
  );

  add(
    "job-finder:edit-application-document",
    async (_event, payload) => {
      try {
        const input = EditApplicationDocumentInputSchema.parse(payload);
        return ApplicationDocumentRevisionSchema.parse(
          await dependencies.library.edit(
            input.documentId,
            input.expectedRevision,
            input.content,
          ),
        );
      } catch (error) {
        return wrapStorageError(error);
      }
    },
  );

  add(
    "job-finder:export-application-document",
    async (event, payload) => {
      try {
        const input = ExportApplicationDocumentInputSchema.parse(payload);
        const document = await dependencies.library.getApproved(
          input.documentId,
          input.expectedRevision,
        );
        const filePath = await dependencies.selectExportPath(
          event,
          dependencies.library.buildDefaultFileName(document),
        );
        if (!filePath) {
          return ApplicationDocumentExportResultSchema.parse({
            status: "cancelled",
          });
        }
        const bytes = Buffer.from(document.content, "utf8");
        await writeFile(filePath, bytes, { flag: "w", mode: 0o600 });
        const updated = await dependencies.library.recordExport(
          input.documentId,
          input.expectedRevision,
        );
        return ApplicationDocumentExportResultSchema.parse({
          status: "exported",
          document: updated,
          fileName: path.basename(filePath),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.byteLength,
        });
      } catch (error) {
        return wrapStorageError(error);
      }
    },
  );
  return operations;
}

export function registerApplicationDocumentRouteHandlers(
  ipcMain: IpcMain, dependencies?: ApplicationDocumentRouteDependencies,
) {
  for (const [name, operation] of createApplicationDocumentOperations(dependencies)) {
    ipcMain.handle(name, (event, payload: unknown) => operation(event, payload));
  }
}

export async function executeApplicationDocumentAction(actionId: string, input: unknown): Promise<unknown> {
  const operation = createApplicationDocumentOperations().get(`job-finder:${actionId}`);
  if (!operation) throw new Error("Unknown application document action.");
  return operation(null, input);
}
