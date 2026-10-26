import { useCallback, useEffect, useRef, useState } from "react";
import { afterFirstScreen } from "../lib/after-first-screen";
import type {
  AssistantActivity,
  AssistantNavigationDisplay,
  AssistantAttachment,
  AssistantContextReference,
  AssistantConversation,
  AssistantEntityRef,
  AssistantEvent,
  AssistantMessage,
  AssistantStatus,
  AssistantTaskPlan,
  AssistantTurn,
} from "@nestor/contracts";
import { describeFailure } from "../lib/describe-failure";

/**
 * The sidebar's view of the main-owned conversation. It reads the
 * conversation, then follows events from a sequence cursor; a gap or a
 * reload replays from the cursor, so nothing is lost or shown twice.
 */

export interface AssistantConversationState {
  status: AssistantStatus | null;
  conversations: AssistantConversation[];
  conversationId: string | null;
  messages: AssistantMessage[];
  hasOlder: boolean;
  activeTurn: AssistantTurn | null;
  activity: AssistantActivity | null;
  draftText: string | null;
  progress: string[];
  stall: string | null;
  plans: AssistantTaskPlan[];
  pendingMessageIds: string[];
  error: string | null;
  loading: boolean;
}

const initialState: AssistantConversationState = {
  status: null,
  conversations: [],
  conversationId: null,
  messages: [],
  hasOlder: false,
  activeTurn: null,
  activity: null,
  draftText: null,
  progress: [],
  stall: null,
  plans: [],
  pendingMessageIds: [],
  error: null,
  loading: true,
};

function upsertMessage(
  messages: readonly AssistantMessage[],
  message: AssistantMessage,
): AssistantMessage[] {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index >= 0) {
    const next = [...messages];
    next[index] = message;
    return next;
  }
  return [...messages, message].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  );
}

function describeError(error: unknown): string {
  return describeFailure(error, {
    action: "reach the assistant",
    unknownSentence: "Try again in a moment.",
  }).userMessage;
}

export function applyAssistantEvent(
  state: AssistantConversationState,
  event: AssistantEvent,
): AssistantConversationState {
  const payload = event.payload;
  if (payload.type === "conversation_updated") {
    const exists = state.conversations.some(
      (entry) => entry.id === payload.conversation.id,
    );
    return {
      ...state,
      conversations: exists
        ? state.conversations.map((entry) =>
            entry.id === payload.conversation.id ? payload.conversation : entry,
          )
        : [payload.conversation, ...state.conversations],
    };
  }
  if (payload.type === "conversation_deleted") {
    return {
      ...state,
      conversations: state.conversations.filter(
        (entry) => entry.id !== event.conversationId,
      ),
      ...(state.conversationId === event.conversationId
        ? {
            conversationId: null,
            messages: [],
            activeTurn: null,
            activity: null,
            draftText: null,
            hasOlder: false,
            progress: [],
            stall: null,
            plans: [],
            pendingMessageIds: [],
            error: null,
          }
        : {}),
    };
  }
  if (event.conversationId !== state.conversationId) return state;
  switch (payload.type) {
    case "message_added":
    case "message_updated":
      return {
        ...state,
        messages: upsertMessage(state.messages, payload.message),
        ...(payload.message.role === "assistant" &&
        payload.type === "message_added"
          ? { draftText: null }
          : {}),
        pendingMessageIds: state.pendingMessageIds.filter(
          (id) => id !== payload.message.id,
        ),
      };
    case "turn_updated": {
      const running = payload.turn.status === "running";
      return {
        ...state,
        activeTurn: running ? payload.turn : null,
        ...(running
          ? {}
          : { activity: null, draftText: null, stall: null, progress: [] }),
        ...(running && state.activeTurn?.id !== payload.turn.id
          ? { progress: [], stall: null }
          : {}),
      };
    }
    case "text_delta":
      return { ...state, draftText: payload.text, stall: null };
    case "activity":
      return { ...state, activity: payload.activity, stall: null };
    case "progress":
      return {
        ...state,
        progress: [...state.progress, payload.text].slice(-4),
        stall: null,
      };
    case "stall":
      return { ...state, stall: payload.text };
    case "plan_updated":
      return {
        ...state,
        plans:
          payload.plan.status === "active"
            ? [
                payload.plan,
                ...state.plans.filter((plan) => plan.id !== payload.plan.id),
              ]
            : state.plans.filter((plan) => plan.id !== payload.plan.id),
      };
    default:
      return state;
  }
}

export function useAssistantConversation(options: {
  onOpenRoute: (route: string) => Promise<AssistantNavigationDisplay> | void;
}) {
  const bridge =
    typeof window === "undefined" ? undefined : window.nestor?.assistant;
  const [state, setState] = useState<AssistantConversationState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cursor = useRef(0);
  const replaying = useRef(false);
  const loadingOlder = useRef(new Set<string>());
  const onOpenRoute = useRef(options.onOpenRoute);
  onOpenRoute.current = options.onOpenRoute;

  const loadConversation = useCallback(
    async (conversationId: string | null) => {
      if (!bridge) return;
      if (!conversationId) {
        cursor.current = 0;
        setState((current) => ({
          ...current,
          conversationId: null,
          messages: [],
          activeTurn: null,
          activity: null,
          draftText: null,
          plans: [],
          progress: [],
          stall: null,
          loading: false,
        }));
        return;
      }
      try {
        const view = await bridge.readConversation({ conversationId });
        cursor.current = view.lastSequence;
        setState((current) => ({
          ...current,
          conversationId,
          messages: view.messages,
          hasOlder: view.hasOlderMessages,
          activeTurn: view.activeTurn,
          activity: view.activity,
          draftText: view.draftText,
          plans: view.plans,
          pendingMessageIds: view.pendingMessageIds,
          progress: [],
          stall: null,
          error: null,
          loading: false,
        }));
      } catch (error) {
        setState((current) => ({
          ...current,
          error: describeError(error),
          loading: false,
        }));
      }
    },
    [bridge],
  );

  const replayFromCursor = useCallback(async () => {
    const conversationId = stateRef.current.conversationId;
    if (!bridge || !conversationId || replaying.current) return;
    replaying.current = true;
    try {
      const result = await bridge.replayEvents({
        conversationId,
        afterSequence: cursor.current,
      });
      if (result.reset) {
        await loadConversation(conversationId);
        return;
      }
      for (const event of result.events) {
        cursor.current = Math.max(cursor.current, event.sequence);
        setState((current) => applyAssistantEvent(current, event));
      }
    } finally {
      replaying.current = false;
    }
  }, [bridge, loadConversation]);

  useEffect(() => {
    if (!bridge) {
      setState((current) => ({ ...current, loading: false }));
      return undefined;
    }
    let disposed = false;
    const unsubscribe = bridge.onEvent((event) => {
      if (
        event.payload.type === "open_route" &&
        event.conversationId === stateRef.current.conversationId
      ) {
        const requestId = event.payload.navigationRequestId;
        if (requestId) {
          void Promise.resolve(onOpenRoute.current(event.payload.route))
            .then((display) => {
              if (display)
                return bridge.acknowledgeNavigation({
                  ...display,
                  conversationId: event.conversationId,
                  navigationRequestId: requestId,
                });
              return undefined;
            })
            .catch(() => undefined);
        } else
          void Promise.resolve(onOpenRoute.current(event.payload.route)).catch(
            () => undefined,
          );
      }
      if (event.sequence === 0) {
        setState((current) => applyAssistantEvent(current, event));
        return;
      }
      if (event.conversationId === stateRef.current.conversationId) {
        if (event.sequence <= cursor.current) return;
        if (event.sequence > cursor.current + 1 && cursor.current > 0) {
          void replayFromCursor();
          return;
        }
        cursor.current = event.sequence;
      }
      setState((current) => applyAssistantEvent(current, event));
    });
    // The first read makes main load the Assistant; it waits for the
    // first screen so launch is not held behind it.
    afterFirstScreen(
      () =>
        void (async () => {
          try {
            if (disposed) return;
            const [status, list] = await Promise.all([
              bridge.getStatus(),
              bridge.listConversations(),
            ]);
            if (disposed) return;
            setState((current) => ({
              ...current,
              status,
              conversations: list.conversations,
            }));
            const current = list.conversations.find(
              (entry) =>
                entry.id === list.currentConversationId &&
                entry.status === "active",
            );
            await loadConversation(current?.id ?? null);
          } catch (error) {
            if (!disposed) {
              setState((current) => ({
                ...current,
                error: describeError(error),
                loading: false,
              }));
            }
          }
        })(),
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge, loadConversation, replayFromCursor]);

  const send = useCallback(
    async (input: {
      text: string;
      mentions: AssistantEntityRef[];
      attachments: AssistantAttachment[];
      context: AssistantContextReference;
    }): Promise<boolean> => {
      if (!bridge) return false;
      const clientMessageId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      try {
        const result = await bridge.sendMessage({
          conversationId: stateRef.current.conversationId,
          clientMessageId,
          text: input.text,
          context: input.context,
        });
        if (result.conversationId !== stateRef.current.conversationId) {
          await loadConversation(result.conversationId);
        } else {
          setState((current) => ({
            ...current,
            messages: upsertMessage(current.messages, result.message),
            pendingMessageIds: result.steering
              ? [...current.pendingMessageIds, result.message.id]
              : current.pendingMessageIds,
            error: null,
          }));
        }
        return true;
      } catch (error) {
        setState((current) => ({ ...current, error: describeError(error) }));
        return false;
      }
    },
    [bridge, loadConversation],
  );

  const stop = useCallback(async () => {
    const conversationId = stateRef.current.conversationId;
    if (!bridge || !conversationId) return;
    await bridge.stop(conversationId).catch(() => undefined);
  }, [bridge]);

  const newChat = useCallback(async () => {
    if (!bridge) return;
    try {
      const conversation = await bridge.createConversation();
      setState((current) => ({
        ...current,
        conversations: [
          conversation,
          ...current.conversations.filter(
            (entry) => entry.id !== conversation.id,
          ),
        ],
      }));
      await loadConversation(conversation.id);
    } catch (error) {
      setState((current) => ({ ...current, error: describeError(error) }));
    }
  }, [bridge, loadConversation]);

  const selectConversation = useCallback(
    async (conversationId: string) => {
      if (!bridge) return;
      await bridge.selectConversation(conversationId).catch(() => undefined);
      await loadConversation(conversationId);
    },
    [bridge, loadConversation],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      if (!bridge) return;
      await bridge.deleteConversation(conversationId);
      setState((current) => ({
        ...current,
        conversations: current.conversations.filter(
          (entry) => entry.id !== conversationId,
        ),
      }));
      if (stateRef.current.conversationId === conversationId)
        await loadConversation(null);
    },
    [bridge, loadConversation],
  );

  const undo = useCallback(
    async (
      receiptId: string,
      context?: AssistantContextReference,
    ): Promise<string | null> => {
      const conversationId = stateRef.current.conversationId;
      if (!bridge || !conversationId) return null;
      try {
        const result = await bridge.undoChange({
          conversationId,
          receiptId,
          context,
        });
        return result.message;
      } catch (error) {
        return describeError(error);
      }
    },
    [bridge],
  );

  const resolveProposal = useCallback(
    async (input: {
      messageId: string;
      proposalId: string;
      action: "accept" | "reject";
    }) => {
      const conversationId = stateRef.current.conversationId;
      if (!bridge || !conversationId) return;
      try {
        const message = await bridge.resolveProposal({
          conversationId,
          ...input,
          itemIds: [],
        });
        setState((current) => ({
          ...current,
          messages: upsertMessage(current.messages, message),
        }));
      } catch (error) {
        setState((current) => ({ ...current, error: describeError(error) }));
      }
    },
    [bridge],
  );

  const answerQuestion = useCallback(
    async (input: {
      questionId: string;
      answer: string;
      context: AssistantContextReference;
    }) => {
      const conversationId = stateRef.current.conversationId;
      if (!bridge || !conversationId) return;
      try {
        const result = await bridge.answerQuestion({
          conversationId,
          questionId: input.questionId,
          answer: input.answer,
          clientMessageId: `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          context: input.context,
        });
        setState((current) => ({
          ...current,
          messages: upsertMessage(current.messages, result.message),
        }));
      } catch (error) {
        setState((current) => ({ ...current, error: describeError(error) }));
      }
    },
    [bridge],
  );

  const loadOlder = useCallback(async () => {
    const current = stateRef.current;
    if (!bridge || !current.conversationId || !current.hasOlder) return;
    const conversationId = current.conversationId;
    if (loadingOlder.current.has(conversationId)) return;
    const oldest = current.messages[0];
    if (!oldest) return;
    loadingOlder.current.add(conversationId);
    try {
      const view = await bridge.readConversation({
        conversationId,
        beforeMessageId: oldest.id,
      });
      setState((previous) => {
        if (previous.conversationId !== conversationId) return previous;
        const existingIds = new Set(
          previous.messages.map((message) => message.id),
        );
        return {
          ...previous,
          messages: [
            ...view.messages.filter((message) => !existingIds.has(message.id)),
            ...previous.messages,
          ],
          hasOlder: view.hasOlderMessages,
          error: null,
        };
      });
    } catch (error) {
      setState((previous) =>
        previous.conversationId === conversationId
          ? { ...previous, error: describeError(error) }
          : previous,
      );
    } finally {
      loadingOlder.current.delete(conversationId);
    }
  }, [bridge]);

  const refreshStatus = useCallback(async () => {
    if (!bridge) return;
    const status = await bridge.getStatus().catch(() => null);
    if (status) setState((current) => ({ ...current, status }));
  }, [bridge]);

  return {
    state,
    available: Boolean(bridge),
    send,
    stop,
    newChat,
    selectConversation,
    deleteConversation,
    undo,
    resolveProposal,
    answerQuestion,
    loadOlder,
    refreshStatus,
    clearError: () => setState((current) => ({ ...current, error: null })),
  };
}
