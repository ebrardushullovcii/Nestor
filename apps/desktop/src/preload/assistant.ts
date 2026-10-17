import {
  AssistantNavigationAcknowledgmentSchema,
  AssistantAnswerQuestionInputSchema,
  AssistantAttachFileResultSchema,
  AssistantConversationListSchema,
  AssistantConversationSchema,
  AssistantConversationViewSchema,
  AssistantEventSchema,
  AssistantMentionSearchResultSchema,
  AssistantMessageSchema,
  AssistantReadConversationInputSchema,
  AssistantReplayEventsInputSchema,
  AssistantReplayEventsResultSchema,
  AssistantResolveProposalInputSchema,
  AssistantSendMessageInputSchema,
  AssistantSendMessageResultSchema,
  AssistantStatusSchema,
  AssistantResumeBatchStateSchema,
  NonEmptyStringSchema,
  AssistantUndoChangeInputSchema,
  AssistantUndoChangeResultSchema,
  type DesktopAssistantBridge,
} from "@nestor/contracts";

/**
 * The assistant's typed bridge. Every call is schema-checked on both sides;
 * the renderer never sees a file path, an IPC channel or a Node primitive.
 */

export const ASSISTANT_EVENT_CHANNEL = "job-finder:assistant:event";

export function createAssistantBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void;
  removeListener: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void;
  pathForFile: (file: File) => string;
}): DesktopAssistantBridge {
  return {
    async acknowledgeNavigation(input) {
      await ipc.invoke(
        "job-finder:assistant:acknowledge-navigation",
        AssistantNavigationAcknowledgmentSchema.parse(input),
      );
    },
    stopResumeBatch: async () => {
      await ipc.invoke("job-finder:assistant:stop-resume-batch");
    },
    syncResumeBatch: async (state) =>
      AssistantResumeBatchStateSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:sync-resume-batch",
          AssistantResumeBatchStateSchema.parse(state),
        ),
      ),
    onResumeBatchStop: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = NonEmptyStringSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on("job-finder:assistant:resume-batch-stop", handler);
      return () =>
        ipc.removeListener("job-finder:assistant:resume-batch-stop", handler);
    },
    getStatus: async () =>
      AssistantStatusSchema.parse(
        await ipc.invoke("job-finder:assistant:get-status"),
      ),
    listConversations: async () =>
      AssistantConversationListSchema.parse(
        await ipc.invoke("job-finder:assistant:list-conversations"),
      ),
    createConversation: async () =>
      AssistantConversationSchema.parse(
        await ipc.invoke("job-finder:assistant:create-conversation"),
      ),
    selectConversation: async (conversationId) => {
      await ipc.invoke("job-finder:assistant:select-conversation", {
        conversationId,
      });
    },
    readConversation: async (input) =>
      AssistantConversationViewSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:read-conversation",
          AssistantReadConversationInputSchema.parse(input),
        ),
      ),
    sendMessage: async (input) =>
      AssistantSendMessageResultSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:send-message",
          AssistantSendMessageInputSchema.parse(input),
        ),
      ),
    stop: async (conversationId) => {
      await ipc.invoke("job-finder:assistant:stop", { conversationId });
    },
    answerQuestion: async (input) =>
      AssistantSendMessageResultSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:answer-question",
          AssistantAnswerQuestionInputSchema.parse(input),
        ),
      ),
    resolveProposal: async (input) =>
      AssistantMessageSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:resolve-proposal",
          AssistantResolveProposalInputSchema.parse(input),
        ),
      ),
    undoChange: async (input) =>
      AssistantUndoChangeResultSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:undo-change",
          AssistantUndoChangeInputSchema.parse(input),
        ),
      ),
    deleteConversation: async (conversationId) => {
      await ipc.invoke("job-finder:assistant:delete-conversation", {
        conversationId,
      });
    },
    replayEvents: async (input) =>
      AssistantReplayEventsResultSchema.parse(
        await ipc.invoke(
          "job-finder:assistant:replay-events",
          AssistantReplayEventsInputSchema.parse(input),
        ),
      ),
    searchMentions: async (query) =>
      AssistantMentionSearchResultSchema.parse(
        await ipc.invoke("job-finder:assistant:search-mentions", { query }),
      ),
    attachFile: async (file) => {
      // A dropped file's path is read here and handed to main, which copies
      // it into the file library; the renderer only gets a document id.
      const filePath = file ? ipc.pathForFile(file) || null : null;
      return AssistantAttachFileResultSchema.parse(
        await ipc.invoke("job-finder:assistant:attach-file", { filePath }),
      );
    },
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = AssistantEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on(ASSISTANT_EVENT_CHANNEL, handler);
      return () => ipc.removeListener(ASSISTANT_EVENT_CHANNEL, handler);
    },
  };
}
