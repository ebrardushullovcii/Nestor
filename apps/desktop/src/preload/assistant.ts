import type {
  AssistantAttachFileResult,
  AssistantConversation,
  AssistantConversationList,
  AssistantConversationView,
  AssistantEvent,
  AssistantMentionSearchResult,
  AssistantMessage,
  AssistantReplayEventsResult,
  AssistantSendMessageResult,
  AssistantStatus,
  AssistantUndoChangeResult,
  DesktopAssistantBridge,
} from "@nestor/contracts";

/**
 * The assistant's typed bridge. Main checks every input and result against
 * its schema; the bridge passes them through, so the preload builds no schema
 * when the window opens. The renderer never sees a file path, an IPC channel
 * or a Node primitive.
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
      await ipc.invoke("job-finder:assistant:acknowledge-navigation", input);
    },

    getStatus: async () =>
      (await ipc.invoke("job-finder:assistant:get-status")) as AssistantStatus,
    listConversations: async () =>
      (await ipc.invoke(
        "job-finder:assistant:list-conversations",
      )) as AssistantConversationList,
    createConversation: async () =>
      (await ipc.invoke(
        "job-finder:assistant:create-conversation",
      )) as AssistantConversation,
    selectConversation: async (conversationId) => {
      await ipc.invoke("job-finder:assistant:select-conversation", {
        conversationId,
      });
    },
    readConversation: async (input) =>
      (await ipc.invoke(
        "job-finder:assistant:read-conversation",
        input,
      )) as AssistantConversationView,
    sendMessage: async (input) =>
      (await ipc.invoke(
        "job-finder:assistant:send-message",
        input,
      )) as AssistantSendMessageResult,
    stop: async (conversationId) => {
      await ipc.invoke("job-finder:assistant:stop", { conversationId });
    },
    answerQuestion: async (input) =>
      (await ipc.invoke(
        "job-finder:assistant:answer-question",
        input,
      )) as AssistantSendMessageResult,
    resolveProposal: async (input) =>
      (await ipc.invoke(
        "job-finder:assistant:resolve-proposal",
        input,
      )) as AssistantMessage,
    undoChange: async (input) =>
      (await ipc.invoke(
        "job-finder:assistant:undo-change",
        input,
      )) as AssistantUndoChangeResult,
    deleteConversation: async (conversationId) => {
      await ipc.invoke("job-finder:assistant:delete-conversation", {
        conversationId,
      });
    },
    replayEvents: async (input) =>
      (await ipc.invoke(
        "job-finder:assistant:replay-events",
        input,
      )) as AssistantReplayEventsResult,
    searchMentions: async (query) =>
      (await ipc.invoke("job-finder:assistant:search-mentions", {
        query,
      })) as AssistantMentionSearchResult,
    attachFile: async (file) => {
      // A dropped file's path is read here and handed to main, which copies
      // it into the file library; the renderer only gets a document id.
      const filePath = file ? ipc.pathForFile(file) || null : null;
      return (await ipc.invoke("job-finder:assistant:attach-file", {
        filePath,
      })) as AssistantAttachFileResult;
    },
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        listener(payload as AssistantEvent);
      };
      ipc.on(ASSISTANT_EVENT_CHANNEL, handler);
      return () => ipc.removeListener(ASSISTANT_EVENT_CHANNEL, handler);
    },
  };
}
