import { BrowserWindow, dialog } from "electron";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  AssistantNavigationAcknowledgmentSchema,
  AssistantAnswerQuestionInputSchema,
  AssistantAttachFileInputSchema,
  AssistantAttachFileResultSchema,
  AssistantConversationIdInputSchema,
  AssistantConversationListSchema,
  AssistantConversationSchema,
  AssistantConversationViewSchema,
  AssistantMentionSearchInputSchema,
  AssistantMentionSearchResultSchema,
  AssistantMessageSchema,
  AssistantReadConversationInputSchema,
  AssistantReplayEventsInputSchema,
  AssistantReplayEventsResultSchema,
  AssistantResolveProposalInputSchema,
  AssistantSendMessageInputSchema,
  AssistantSendMessageResultSchema,
  AssistantStatusSchema,
  AssistantUndoChangeInputSchema,
  AssistantUndoChangeResultSchema,
  type CandidateAssetKind,
} from "@nestor/contracts";

import { getAssistantHost } from "../services/assistant/assistant-service";
import { getCandidateAssetLibrary } from "../services/job-finder/candidate-asset-library-instance";
import { noteExplicitUserStart } from "../services/job-finder/runtime";

/**
 * Typed IPC for the assistant sidebar. Messages arrive only from the app's
 * own window: that is the trusted ingress that lets a message authorize
 * work (ADR 0039). Page content in the browser has no bridge at all.
 */

function assertAppWindow(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.webContents.id !== event.sender.id) {
    throw new Error("The assistant only takes messages from the app window.");
  }
}

export function inferAssetKind(fileName: string): CandidateAssetKind {
  const lower = fileName.toLowerCase();
  if (/\.(png|jpe?g|gif|webp)$/u.test(lower)) return "image";
  if (/resume|\bcv\b|curriculum/u.test(lower)) return "resume";
  if (/cover|letter/u.test(lower)) return "cover_letter";
  if (/transcript/u.test(lower)) return "transcript";
  if (/certificat/u.test(lower)) return "certificate";
  if (/portfolio/u.test(lower)) return "portfolio";
  if (/\.(pdf|docx?|txt|rtf|odt)$/u.test(lower)) return "resume";
  return "other";
}

export function registerAssistantRouteHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    "job-finder:assistant:acknowledge-navigation",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const input = AssistantNavigationAcknowledgmentSchema.parse(payload);
      (await getAssistantHost()).acknowledgeNavigation(input);
    },
  );
  ipcMain.handle("job-finder:assistant:get-status", async () => {
    const host = await getAssistantHost();
    return AssistantStatusSchema.parse(host.getStatus());
  });

  ipcMain.handle("job-finder:assistant:list-conversations", async () => {
    const host = await getAssistantHost();
    return AssistantConversationListSchema.parse(
      await host.listConversations(),
    );
  });

  ipcMain.handle("job-finder:assistant:create-conversation", async (event) => {
    assertAppWindow(event);
    const host = await getAssistantHost();
    return AssistantConversationSchema.parse(await host.createConversation());
  });

  ipcMain.handle(
    "job-finder:assistant:select-conversation",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const { conversationId } =
        AssistantConversationIdInputSchema.parse(payload);
      const host = await getAssistantHost();
      await host.selectConversation(conversationId);
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    "job-finder:assistant:read-conversation",
    async (_event, payload: unknown) => {
      const input = AssistantReadConversationInputSchema.parse(payload);
      const host = await getAssistantHost();
      return AssistantConversationViewSchema.parse(
        await host.readConversation(input),
      );
    },
  );

  ipcMain.handle(
    "job-finder:assistant:send-message",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const input = AssistantSendMessageInputSchema.parse(payload);
      noteExplicitUserStart();
      const host = await getAssistantHost();
      return AssistantSendMessageResultSchema.parse(
        await host.sendMessage(input),
      );
    },
  );

  ipcMain.handle(
    "job-finder:assistant:stop",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const { conversationId } =
        AssistantConversationIdInputSchema.parse(payload);
      const host = await getAssistantHost();
      await host.stop(conversationId);
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    "job-finder:assistant:answer-question",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const input = AssistantAnswerQuestionInputSchema.parse(payload);
      noteExplicitUserStart();
      const host = await getAssistantHost();
      return AssistantSendMessageResultSchema.parse(
        await host.answerQuestion(input),
      );
    },
  );

  ipcMain.handle(
    "job-finder:assistant:resolve-proposal",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const input = AssistantResolveProposalInputSchema.parse(payload);
      const host = await getAssistantHost();
      return AssistantMessageSchema.parse(await host.resolveProposal(input));
    },
  );

  ipcMain.handle(
    "job-finder:assistant:undo-change",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const input = AssistantUndoChangeInputSchema.parse(payload);
      const host = await getAssistantHost();
      return AssistantUndoChangeResultSchema.parse(
        await host.undoChange(
          input.conversationId,
          input.receiptId,
          input.context,
        ),
      );
    },
  );

  ipcMain.handle(
    "job-finder:assistant:delete-conversation",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const { conversationId } =
        AssistantConversationIdInputSchema.parse(payload);
      const host = await getAssistantHost();
      await host.deleteConversation(conversationId);
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    "job-finder:assistant:replay-events",
    async (_event, payload: unknown) => {
      const input = AssistantReplayEventsInputSchema.parse(payload);
      const host = await getAssistantHost();
      return AssistantReplayEventsResultSchema.parse(
        await host.replayEvents(input),
      );
    },
  );

  ipcMain.handle(
    "job-finder:assistant:search-mentions",
    async (_event, payload: unknown) => {
      const input = AssistantMentionSearchInputSchema.parse(payload ?? {});
      const host = await getAssistantHost();
      return AssistantMentionSearchResultSchema.parse({
        candidates: await host.searchMentions(input.query ?? ""),
      });
    },
  );

  /**
   * Files reach the assistant only through main: a path from a file the
   * person dropped (read by the preload from the dropped File) or the native
   * picker. The file is copied into the person's file library and the model
   * sees its document id, never a path.
   */
  ipcMain.handle(
    "job-finder:assistant:attach-file",
    async (event, payload: unknown) => {
      assertAppWindow(event);
      const input = AssistantAttachFileInputSchema.parse(payload ?? {});
      let filePaths: string[] = input.filePath ? [input.filePath] : [];
      if (filePaths.length === 0) {
        const window = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: "Attach files for the assistant",
          properties: ["openFile" as const, "multiSelections" as const],
          filters: [
            {
              name: "Documents",
              extensions: [
                "pdf",
                "docx",
                "doc",
                "txt",
                "rtf",
                "odt",
                "png",
                "jpg",
                "jpeg",
              ],
            },
          ],
        };
        const picked = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        if (picked.canceled || picked.filePaths.length === 0) {
          return AssistantAttachFileResultSchema.parse({
            attachment: null,
            message: null,
          });
        }
        filePaths = picked.filePaths.slice(0, 5);
      }
      const attached: {
        documentId: string;
        fileName: string;
        kind: string;
      }[] = [];
      const failures: string[] = [];
      for (const filePath of filePaths) {
        const fileName = filePath.split(/[\\/]/u).at(-1) ?? "file";
        try {
          const result = await getCandidateAssetLibrary().importFromSourcePath(
            filePath,
            {
              kind: inferAssetKind(fileName),
              sensitivity: "sensitive",
              // Same consent as adding a file in Profile > Files: the person
              // gave it to Job Finder to use in their applications.
              consentScope: "job_application_attachment",
              retention: "until_deleted",
            },
          );
          if (result.status === "imported") {
            attached.push({
              documentId: result.asset.id,
              fileName: result.asset.originalName,
              kind: result.asset.kind,
            });
          } else {
            failures.push(`${fileName} was not attached.`);
          }
        } catch (error) {
          failures.push(
            error instanceof Error
              ? `${fileName}: ${error.message.slice(0, 200)}`
              : `${fileName} could not be attached.`,
          );
        }
      }
      return AssistantAttachFileResultSchema.parse({
        attachment: attached[0] ?? null,
        attachments: attached,
        message:
          failures.length > 0
            ? failures.join(" ").slice(0, 400)
            : attached.length === 0
              ? "The file could not be attached."
              : null,
      });
    },
  );
}
