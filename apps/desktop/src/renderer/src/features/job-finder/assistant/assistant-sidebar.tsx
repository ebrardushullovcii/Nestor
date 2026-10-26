import { waitForDisplayedDestination } from "./navigation-display";
import { ASSISTANT_NARROW_CONTENT_MIN_WIDTH } from "./use-assistant-side-menu-collapse";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  History,
  LoaderCircle,
  Paperclip,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  AssistantAttachment,
  AssistantConversation,
  AssistantEntityRef,
  AssistantMentionCandidate,
  AssistantMessage,
} from "@nestor/contracts";
import {
  ASSISTANT_NAVIGATION_STATE,
  ASSISTANT_MESSAGE_MAX_CHARS,
} from "@nestor/contracts";

import { cn } from "@renderer/lib/cn";
import { isImeComposingEvent } from "../lib/job-finder-shortcuts";
import { describeScreen, screenForPathname } from "./assistant-context-capture";
import {
  AssistantMessageParts,
  type AssistantPartActions,
} from "./assistant-message-parts";
import { AssistantMarkdown } from "./assistant-markdown";
import {
  ASSISTANT_SIDEBAR_MAX_WIDTH,
  ASSISTANT_SIDEBAR_MIN_WIDTH,
  useAssistant,
} from "./assistant-provider";
import { useAssistantConversation } from "./use-assistant-conversation";

/**
 * The one assistant (ADR 0037): a sidebar docked right under the header.
 * The page shrinks to make room and is never covered; a window too narrow
 * for both switches between the page and the chat instead of squeezing.
 */

const NARROW_CONTENT_MIN_WIDTH = ASSISTANT_NARROW_CONTENT_MIN_WIDTH;

const STARTERS: Record<string, string[]> = {
  profile: [
    "What is weak or missing in my profile?",
    "Tighten my headline for the roles I target",
  ],
  resume_studio: [
    "What would you change to fit this job better?",
    "Make this resume fit on two pages",
  ],
  discovery: [
    "Which of these jobs fit me best, and why?",
    "Find remote roles that match my experience",
  ],
  review_queue: [
    "Which shortlisted jobs are ready to apply?",
    "Write the missing resumes for these jobs",
  ],
  applications: [
    "What is blocking my applications?",
    "Which applications need an answer from me?",
  ],
  home: [
    "What's blocking my applications? Fix what you can.",
    "Find new jobs that match my profile",
  ],
};

function useHeaderBottom(): number {
  const [bottom, setBottom] = useState(56);
  useLayoutEffect(() => {
    const header = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header]",
    );
    if (!header) return undefined;
    const measure = () =>
      setBottom(Math.max(0, Math.round(header.getBoundingClientRect().bottom)));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(header);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return bottom;
}

/** The visible embedded-browser page, which the next message will refer to. */
function useVisibleBrowserTitle(): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    const browser = window.nestor?.browser;
    if (!browser) return undefined;
    const read = (state: Awaited<ReturnType<typeof browser.getState>>) => {
      const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
      const visible =
        tab && state.phase !== "closed" && state.presentation !== "minimized";
      let host: string | null = null;
      try {
        host = tab ? new URL(tab.url).host || null : null;
      } catch {
        host = null;
      }
      setTitle(visible ? tab.title || host : null);
    };
    void browser.getState().then(read, () => undefined);
    return browser.onStateChanged((state) => read(state));
  }, []);
  return title;
}

/**
 * The record the next message would mean by "this" (the open job, resume or
 * application), so the header can name it. Screens publish it lazily, so it
 * is re-read after clicks, keys and navigation while the chat is shown.
 */
function useFocusLabel(
  peekFocus: (() => AssistantEntityRef | null) | undefined,
  shown: boolean,
  routeKey: string,
): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!shown || !peekFocus) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      clearTimeout(timer);
      // After the click's own render, when the screen's getter is current.
      timer = setTimeout(() => setLabel(peekFocus()?.label ?? null), 60);
    };
    read();
    document.addEventListener("pointerup", read, true);
    document.addEventListener("keyup", read, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerup", read, true);
      document.removeEventListener("keyup", read, true);
    };
  }, [peekFocus, shown, routeKey]);
  return shown ? label : null;
}

function useContentWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const measure = () => {
      const nav = document.querySelector<HTMLElement>(
        "[data-job-finder-sidebar]",
      );
      const navWidth =
        nav && getComputedStyle(nav).display !== "none"
          ? nav.getBoundingClientRect().width
          : 0;
      setWidth(window.innerWidth - navWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    const nav = document.querySelector<HTMLElement>(
      "[data-job-finder-sidebar]",
    );
    const observer =
      nav && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (nav) observer?.observe(nav);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);
  return width;
}

function Elapsed(props: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(
    0,
    Math.round((now - Date.parse(props.since)) / 1000),
  );
  return <span className="tabular-nums">{seconds}s</span>;
}

function HistoryMenu(props: {
  conversations: AssistantConversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const active = props.conversations.filter(
    (entry) => entry.status === "active",
  );
  const archived = props.conversations.filter(
    (entry) => entry.status === "archived",
  );
  const row = (conversation: AssistantConversation) => (
    <li className="group flex items-center gap-1" key={conversation.id}>
      <button
        aria-current={conversation.id === props.currentId ? "true" : undefined}
        className={cn(
          "min-w-0 flex-1 truncate rounded-(--radius-button) px-2 py-1.5 text-left text-[13px] outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40",
          conversation.id === props.currentId && "font-semibold",
        )}
        onClick={() => props.onSelect(conversation.id)}
        type="button"
      >
        {conversation.title}
      </button>
      {confirming === conversation.id ? (
        <button
          className="shrink-0 rounded-(--radius-button) px-2 py-1 text-[12px] text-destructive outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40"
          onClick={() => {
            setConfirming(null);
            props.onDelete(conversation.id);
          }}
          type="button"
        >
          Delete
        </button>
      ) : (
        <button
          aria-label={`Delete ${conversation.title}`}
          className="shrink-0 rounded-(--radius-button) p-1 text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover:opacity-100"
          onClick={() => setConfirming(conversation.id)}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </li>
  );
  return (
    <div
      className="absolute right-2 top-11 z-10 grid max-h-[60vh] w-[min(320px,calc(100%-16px))] gap-2 overflow-y-auto rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel) p-2 shadow-xl"
      data-assistant-history
      role="dialog"
      aria-label="Chat history"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      {active.length === 0 && archived.length === 0 ? (
        <p className="px-2 py-1 text-[13px] text-muted-foreground">
          No chats yet.
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul className="grid gap-0.5">{active.map(row)}</ul>
      ) : null}
      {archived.length > 0 ? (
        <div className="grid gap-0.5">
          <span className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Earlier chats
          </span>
          <ul className="grid gap-0.5">{archived.map(row)}</ul>
        </div>
      ) : null}
    </div>
  );
}

export function AssistantSidebar() {
  // Without the provider (tests, other modules) there is no sidebar and
  // nothing to measure.
  const assistant = useAssistant();
  if (!assistant) return null;
  return <AssistantSidebarPanel />;
}

function AssistantSidebarPanel() {
  const assistant = useAssistant();
  const navigate = useNavigate();
  const location = useLocation();
  const displayedLocation = useRef(location);
  displayedLocation.current = location;
  const headerBottom = useHeaderBottom();
  const browserChip = useVisibleBrowserTitle();
  const contentWidth = useContentWidth();
  const {
    state,
    available,
    send,
    stop,
    newChat,
    selectConversation,
    deleteConversation,
    undo,
    resolveProposal,
    answerQuestion,
    loadOlder,
    clearError,
  } = useAssistantConversation({
    onOpenRoute: async (route) => {
      assistant?.setNarrowView("page");
      await navigate(route, { state: ASSISTANT_NAVIGATION_STATE });
      return waitForDisplayedDestination(
        route,
        () =>
          `${displayedLocation.current.pathname}${displayedLocation.current.search}${displayedLocation.current.hash}`,
      );
    },
  });
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<AssistantEntityRef[]>([]);
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<
    AssistantMentionCandidate[]
  >([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  // "New messages" only when something arrived while scrolled up.
  const [hasUnseen, setHasUnseen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messageCount = state.messages.length;
  useEffect(() => {
    if (atBottom) setHasUnseen(false);
  }, [atBottom]);
  const lastSeenCount = useRef(messageCount);
  useEffect(() => {
    if (messageCount > lastSeenCount.current && !atBottom) setHasUnseen(true);
    lastSeenCount.current = messageCount;
  }, [messageCount, atBottom]);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    if (text)
      textarea.style.height = `${Math.min(192, window.innerHeight * 0.25, textarea.scrollHeight)}px`;
  }, [text]);
  const findRef = useRef<HTMLInputElement>(null);

  const open = assistant?.open ?? false;
  const width = assistant?.width ?? 400;
  const narrow = contentWidth - width < NARROW_CONTENT_MIN_WIDTH;
  const showPanel = open && (!narrow || assistant?.narrowView === "chat");
  const focusLabel = useFocusLabel(
    assistant?.peekFocus,
    showPanel,
    `${location.pathname}${location.search}`,
  );
  const running =
    state.activeTurn !== null ||
    state.activity?.toolName === "generate_resumes";

  // Reserve the sidebar's width so the page (and the browser beside it)
  // shrinks instead of being covered.
  useEffect(() => {
    const reserved = open && !narrow ? width : 0;
    document.documentElement.style.setProperty(
      "--assistant-sidebar-reserved",
      `${reserved}px`,
    );
    document.documentElement.dataset.assistantSidebar = open
      ? narrow
        ? "narrow"
        : "docked"
      : "closed";
    return () => {
      document.documentElement.style.setProperty(
        "--assistant-sidebar-reserved",
        "0px",
      );
      document.documentElement.dataset.assistantSidebar = "closed";
    };
  }, [open, narrow, width]);

  useEffect(() => {
    assistant?.setWorking(running);
  }, [assistant, running]);

  // Focus the composer when the sidebar is opened.
  useEffect(() => {
    if (!assistant?.focusRequest) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [assistant?.focusRequest]);

  // An entry point opened the sidebar with a message or a mention.
  useEffect(() => {
    if (!assistant?.prefill) return;
    const prefill = assistant.consumePrefill();
    if (!prefill) return;
    if (prefill.mentions.length > 0) {
      setMentions((current) => [
        ...current,
        ...prefill.mentions.filter(
          (mention) => !current.some((entry) => entry.id === mention.id),
        ),
      ]);
    }
    if (prefill.sendNow && prefill.text.trim()) {
      void submit(prefill.text, prefill.mentions);
    } else if (prefill.text) {
      setText(prefill.text);
    }
  }, [assistant?.prefill]);

  // Screen readers hear status changes, not every token.
  useEffect(() => {
    if (running) setAnnouncement("The assistant is working.");
    else if (state.messages.at(-1)?.role === "assistant")
      setAnnouncement("The assistant replied.");
  }, [running, state.messages]);
  useEffect(() => {
    if (state.stall) setAnnouncement(state.stall);
  }, [state.stall]);

  // Follow new text only while the person is at the bottom.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior });
  }, []);
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom();
  }, [
    state.messages,
    state.draftText,
    state.activity,
    state.progress,
    atBottom,
    scrollToBottom,
  ]);
  useLayoutEffect(() => {
    scrollToBottom();
    setAtBottom(true);
  }, [state.conversationId, scrollToBottom]);

  const onScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    setAtBottom(
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40,
    );
    if (thread.scrollTop < 40 && state.hasOlder) void loadOlder();
  };

  // @ mentions
  useEffect(() => {
    if (mentionQuery === null) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.nestor?.assistant
        ?.searchMentions(mentionQuery)
        .then((result) => {
          if (!cancelled) {
            setMentionCandidates(result.candidates.slice(0, 8));
            setMentionIndex(0);
          }
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionQuery]);

  const updateMentionQuery = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]{0,40})$/u.exec(before);
    setMentionQuery(match ? (match[1] ?? "") : null);
  };

  const chooseMention = (candidate: AssistantMentionCandidate) => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? text.length;
    const before = text
      .slice(0, caret)
      .replace(/@([^\s@]{0,40})$/u, `@${candidate.label} `);
    const next = `${before}${text.slice(caret)}`;
    setText(next);
    setMentions((current) =>
      current.some(
        (entry) => entry.id === candidate.id && entry.kind === candidate.kind,
      )
        ? current
        : [
            ...current,
            { kind: candidate.kind, id: candidate.id, label: candidate.label },
          ],
    );
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async (
    value: string,
    extraMentions: AssistantEntityRef[] = [],
  ) => {
    const message = value.trim();
    if (!message || !assistant) return;
    // Too long to send: keep the text and say so, instead of losing it.
    if (message.length > ASSISTANT_MESSAGE_MAX_CHARS) return;
    const allMentions = [...mentions, ...extraMentions].filter(
      (mention, index, list) =>
        list.findIndex(
          (entry) => entry.id === mention.id && entry.kind === mention.kind,
        ) === index,
    );
    const context = await assistant.captureContext({
      mentions: allMentions,
      attachments,
    });
    setText("");
    setMentions([]);
    setAttachments([]);
    setAttachNote(null);
    setAtBottom(true);
    const sent = await send({
      text: message,
      mentions: allMentions,
      attachments,
      context,
    });
    // A message that did not reach the assistant goes back in the box.
    if (!sent) {
      setText((current) => (current.trim() ? current : value));
      setMentions((current) => (current.length > 0 ? current : allMentions));
      setAttachments((current) => (current.length > 0 ? current : attachments));
    }
  };

  const attach = async (file?: File | null) => {
    const bridge = window.nestor?.assistant;
    if (!bridge) return;
    setAttachNote("Attaching…");
    try {
      const result = await bridge.attachFile(file ?? null);
      const added =
        result.attachments.length > 0
          ? result.attachments
          : result.attachment
            ? [result.attachment]
            : [];
      if (added.length > 0) {
        setAttachments((current) => [...current, ...added].slice(0, 5));
      }
      // A dropped file that did not attach says so; a closed picker says
      // nothing.
      setAttachNote(
        result.message ??
          (added.length === 0 && file
            ? "That file could not be attached."
            : null),
      );
    } catch {
      setAttachNote("That file could not be attached.");
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files].slice(0, 5);
    for (const file of files) void attach(file);
  };

  const onComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (isImeComposingEvent(event.nativeEvent)) return;
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (index) =>
            (index +
              (event.key === "ArrowDown" ? 1 : -1) +
              mentionCandidates.length) %
            mentionCandidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = mentionCandidates[mentionIndex];
        if (candidate) chooseMention(candidate);
        return;
      }
    }
    if (event.key === "Escape") {
      // Escape here closes a mention list, never the browser behind.
      event.preventDefault();
      setMentionQuery(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(text);
    }
  };

  // ⌘F searches the thread while focus is in the sidebar.
  const onSidebarKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => findRef.current?.focus());
    }
  };
  const findMatches = useMemo(() => {
    const query = findQuery.trim().toLowerCase();
    if (!findOpen || !query) return [] as string[];
    return state.messages
      .filter(
        (message) => !(message.role === "user" && message.origin === "host"),
      )
      .filter((message) =>
        message.parts.some(
          (part) =>
            part.type === "text" && part.text.toLowerCase().includes(query),
        ),
      )
      .map((message) => message.id);
  }, [findOpen, findQuery, state.messages]);
  useEffect(() => {
    const id = findMatches[findIndex];
    if (!id) return;
    document
      .querySelector(`[data-assistant-message="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [findIndex, findMatches]);

  const actions: AssistantPartActions = {
    onUndo: async (receiptId) =>
      undo(
        receiptId,
        await assistant?.captureContext({ mentions: [], attachments: [] }),
      ),
    onResolveProposal: resolveProposal,
    onAnswer: (questionId, answer) => {
      if (!assistant) return;
      void assistant
        .captureContext({ mentions: [], attachments: [] })
        .then((context) => answerQuestion({ questionId, answer, context }));
    },
    onOpenRoute: (route) => void navigate(route),
  };

  // Resizing from the left edge, within 320–480px.
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!assistant) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => {
      assistant.setWidth(startWidth + (startX - moveEvent.clientX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!assistant || typeof document === "undefined") return null;
  const screen = screenForPathname(location.pathname);
  const starters = STARTERS[screen] ?? STARTERS.home ?? [];
  const title =
    state.conversations.find((entry) => entry.id === state.conversationId)
      ?.title ?? "Assistant";
  const pending = new Set(state.pendingMessageIds);
  const lastReplyIsOutage =
    state.messages
      .at(-1)
      ?.parts.some(
        (part) => part.type === "notice" && part.kind === "outage",
      ) ?? false;
  const viewingArchive =
    state.conversations.find((entry) => entry.id === state.conversationId)
      ?.status === "archived";

  const panelStyle: CSSProperties = {
    top: headerBottom,
    width: narrow ? contentWidth : width,
  };

  return createPortal(
    <>
      {open && narrow && !showPanel ? (
        <div
          aria-label="Show the page or the chat"
          className="fixed bottom-4 left-4 z-[125] flex overflow-hidden rounded-full border border-(--control-border) bg-(--surface-panel) text-[13px] shadow-lg"
          data-assistant-narrow-switch
          role="group"
        >
          {(["page", "chat"] as const).map((view) => (
            <button
              aria-pressed={assistant.narrowView === view}
              className={cn(
                "px-3 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                assistant.narrowView === view
                  ? "bg-(--nav-active-surface) font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={view}
              onClick={() => assistant.setNarrowView(view)}
              type="button"
            >
              {view === "page" ? "Page" : "Chat"}
            </button>
          ))}
        </div>
      ) : null}
      <aside
        aria-label="Assistant"
        className={cn(
          "fixed bottom-0 right-0 z-[120] flex flex-col border-l border-(--surface-panel-shell-border) bg-background text-[14px] leading-[1.55] text-foreground",
          !showPanel && "hidden",
        )}
        data-assistant-sidebar
        data-assistant-narrow={narrow ? "true" : "false"}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDrop={onDrop}
        onKeyDown={onSidebarKeyDown}
        style={panelStyle}
      >
        {open && narrow ? (
          <div
            aria-label="Show the page or the chat"
            className="flex w-fit shrink-0 overflow-hidden rounded-full border border-(--control-border) bg-(--surface-panel) text-[13px] shadow-lg"
            data-assistant-narrow-switch
            role="group"
          >
            {(["page", "chat"] as const).map((view) => (
              <button
                aria-pressed={assistant.narrowView === view}
                className={cn(
                  "px-3 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  assistant.narrowView === view
                    ? "bg-(--nav-active-surface) font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={view}
                onClick={() => assistant.setNarrowView(view)}
                type="button"
              >
                {view === "page" ? "Page" : "Chat"}
              </button>
            ))}
          </div>
        ) : null}
        {!narrow ? (
          <div
            aria-label="Resize the assistant"
            aria-orientation="vertical"
            aria-valuemax={ASSISTANT_SIDEBAR_MAX_WIDTH}
            aria-valuemin={ASSISTANT_SIDEBAR_MIN_WIDTH}
            aria-valuenow={width}
            className="absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") assistant.setWidth(width + 16);
              if (event.key === "ArrowRight") assistant.setWidth(width - 16);
            }}
            onPointerDown={onResizeStart}
            role="separator"
            tabIndex={0}
          />
        ) : null}
        <header className="relative flex h-11 shrink-0 items-center gap-1 border-b border-(--surface-panel-shell-border) px-2">
          <div className="grid min-w-0 flex-1 px-1">
            <span className="truncate text-[13px] font-semibold">{title}</span>
            <span
              className="truncate text-[11px] text-muted-foreground"
              data-assistant-context-chip
            >
              Looking at:{" "}
              {browserChip
                ? `Browser · ${browserChip}`
                : focusLabel
                  ? `${describeScreen(screen)} · ${focusLabel}`
                  : describeScreen(screen)}
            </span>
          </div>
          <button
            aria-label="New chat"
            className="rounded-(--radius-button) p-1.5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            onClick={() => void newChat()}
            title="New chat"
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-expanded={historyOpen}
            aria-label="Chat history"
            className="rounded-(--radius-button) p-1.5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            onClick={() => setHistoryOpen((value) => !value)}
            title="Chat history"
            type="button"
          >
            <History aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label="Search this chat"
            className="rounded-(--radius-button) p-1.5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            onClick={() => {
              setFindOpen((value) => !value);
              requestAnimationFrame(() => findRef.current?.focus());
            }}
            title="Search this chat"
            type="button"
          >
            <Search aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label="Close the assistant"
            className="rounded-(--radius-button) p-1.5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            onClick={() => assistant.setOpen(false)}
            title="Close"
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
          {historyOpen ? (
            <HistoryMenu
              conversations={state.conversations}
              currentId={state.conversationId}
              onClose={() => setHistoryOpen(false)}
              onDelete={(id) => void deleteConversation(id)}
              onSelect={(id) => {
                setHistoryOpen(false);
                void selectConversation(id);
              }}
            />
          ) : null}
        </header>
        {findOpen ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-(--surface-panel-shell-border) px-2 py-1.5">
            <input
              aria-label="Find in this chat"
              className="min-w-0 flex-1 rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel) px-2 py-1 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              onChange={(event) => {
                setFindQuery(event.target.value);
                setFindIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && findMatches.length > 0) {
                  event.preventDefault();
                  setFindIndex(
                    (index) =>
                      (index + (event.shiftKey ? -1 : 1) + findMatches.length) %
                      findMatches.length,
                  );
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setFindOpen(false);
                  setFindQuery("");
                }
              }}
              placeholder="Find in this chat"
              ref={findRef}
              value={findQuery}
            />
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
              {findMatches.length > 0
                ? `${findIndex + 1} of ${findMatches.length}`
                : findQuery
                  ? "0"
                  : ""}
            </span>
          </div>
        ) : null}
        {/* A failed turn already says this as its reply; the banner only
            warns before a message is sent. */}
        {state.status && !state.status.available && !lastReplyIsOutage ? (
          <p
            className="shrink-0 border-b border-(--surface-panel-shell-border) px-3 py-2 text-[13px] text-muted-foreground"
            data-assistant-outage
          >
            {state.status.detail ??
              "The assistant's AI service is not reachable right now."}
          </p>
        ) : null}
        <div
          aria-live="off"
          className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3"
          data-assistant-thread
          onScroll={onScroll}
          ref={threadRef}
        >
          {!available ? (
            <p className="text-[13px] text-muted-foreground">
              The assistant is not available in this window.
            </p>
          ) : state.loading ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
              Loading
            </p>
          ) : state.messages.length === 0 && !running ? (
            <div className="grid gap-3" data-assistant-empty>
              <p className="text-muted-foreground">
                Ask about anything in Job Finder, or ask me to do it: change
                your profile, work on a resume, find and shortlist jobs, apply,
                or update your tracking.
              </p>
              <div className="grid gap-1.5">
                {starters.map((starter) => (
                  <button
                    className="rounded-(--radius-field) border border-(--control-border) px-3 py-2 text-left text-[13px] outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    key={starter}
                    onClick={() => void submit(starter)}
                    type="button"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="grid gap-4">
              {state.messages.map((message: AssistantMessage) => {
                const highlighted = findMatches[findIndex] === message.id;
                const isUser =
                  message.role === "user" && message.origin !== "host";
                if (message.role === "user" && message.origin === "host")
                  return null;
                return (
                  <li
                    className={cn(
                      "grid gap-1",
                      isUser ? "justify-items-end" : "justify-items-stretch",
                      highlighted &&
                        "rounded-(--radius-field) outline outline-2 outline-ring/60",
                    )}
                    data-assistant-message={message.id}
                    data-assistant-role={message.role}
                    key={message.id}
                  >
                    <div
                      className={cn(
                        "min-w-0",
                        isUser
                          ? "max-w-[88%] rounded-2xl rounded-br-md bg-(--surface-panel-raised) px-3 py-2"
                          : "w-full",
                      )}
                    >
                      <AssistantMessageParts
                        actions={actions}
                        message={message}
                      />
                    </div>
                    {!isUser &&
                    message.parts.some((part) => part.type === "text") ? (
                      <button
                        className="text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                        data-assistant-copy
                        onClick={() => {
                          const text = message.parts
                            .flatMap((part) =>
                              part.type === "text" ? [part.text] : [],
                            )
                            .join("\n\n");
                          void navigator.clipboard
                            ?.writeText(text)
                            .then(() => setCopiedId(message.id))
                            .catch(() => undefined);
                        }}
                        type="button"
                      >
                        {copiedId === message.id ? "Copied" : "Copy"}
                      </button>
                    ) : null}
                    {isUser && pending.has(message.id) ? (
                      <span className="text-[12px] text-muted-foreground">
                        Read at the next step
                      </span>
                    ) : null}
                  </li>
                );
              })}
              {running ? (
                <li className="grid gap-2" data-assistant-live-turn>
                  {state.progress.map((note, index) => (
                    <p
                      className="text-[13px] italic text-muted-foreground"
                      key={`${note}_${index}`}
                    >
                      {note}
                    </p>
                  ))}
                  {state.draftText ? (
                    <AssistantMarkdown content={state.draftText} />
                  ) : null}
                </li>
              ) : null}
            </ol>
          )}
          {!atBottom ? (
            <button
              className="sticky bottom-2 left-1/2 mx-auto flex -translate-x-0 items-center gap-1 rounded-full border border-(--control-border) bg-(--surface-panel) px-3 py-1 text-[12px] shadow outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40"
              onClick={() => {
                setAtBottom(true);
                scrollToBottom("smooth");
              }}
              type="button"
            >
              <ArrowDown aria-hidden="true" className="size-3" />
              {hasUnseen ? "New messages" : "Jump to latest"}
            </button>
          ) : null}
        </div>
        {running ? (
          <div
            className="flex shrink-0 items-center gap-2 border-t border-(--surface-panel-shell-border) px-3 py-2 text-[12.5px] text-muted-foreground"
            data-assistant-activity
          >
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
            <span className="min-w-0 flex-1 truncate">
              {state.stall ?? state.activity?.label ?? "Working"}
            </span>
            {state.activeTurn || state.activity ? (
              <Elapsed
                since={state.activity?.startedAt ?? state.activeTurn!.startedAt}
              />
            ) : null}
          </div>
        ) : null}
        {state.error ? (
          <div
            className="flex shrink-0 items-start gap-2 border-t border-(--surface-panel-shell-border) px-3 py-2 text-[13px]"
            role="alert"
          >
            <span className="min-w-0 flex-1">{state.error}</span>
            <button
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground"
              onClick={clearError}
              type="button"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        ) : null}
        <form
          className={cn(
            "relative grid shrink-0 gap-2 border-t border-(--surface-panel-shell-border) p-2",
            dragging && "bg-(--nav-active-surface)",
          )}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(text);
          }}
        >
          {mentionQuery !== null && mentionCandidates.length > 0 ? (
            <ul
              className="absolute bottom-full left-2 right-2 mb-1 grid max-h-64 overflow-y-auto rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel) p-1 shadow-xl"
              data-assistant-mentions
              role="listbox"
            >
              {mentionCandidates.map((candidate, index) => (
                <li key={`${candidate.kind}_${candidate.id}`}>
                  <button
                    aria-selected={index === mentionIndex}
                    className={cn(
                      "grid w-full rounded-(--radius-button) px-2 py-1.5 text-left",
                      index === mentionIndex && "bg-secondary",
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseMention(candidate);
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="truncate text-[13px]">
                      {candidate.label}
                    </span>
                    <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                      {candidate.kind}
                      {candidate.detail ? ` · ${candidate.detail}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {mentions.length > 0 || attachments.length > 0 || attachNote ? (
            <div className="flex flex-wrap gap-1">
              {mentions.map((mention) => (
                <span
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-(--surface-panel-raised) px-2 py-0.5 text-[12px]"
                  key={`${mention.kind}_${mention.id}`}
                >
                  <span className="truncate">
                    @{mention.label ?? mention.id}
                  </span>
                  <button
                    aria-label={`Remove ${mention.label ?? mention.id}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setMentions((current) =>
                        current.filter((entry) => entry !== mention),
                      )
                    }
                    type="button"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </span>
              ))}
              {attachments.map((attachment) => (
                <span
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-(--surface-panel-raised) px-2 py-0.5 text-[12px]"
                  key={attachment.documentId}
                >
                  <Paperclip aria-hidden="true" className="size-3" />
                  <span className="truncate">{attachment.fileName}</span>
                  <button
                    aria-label={`Remove ${attachment.fileName}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter(
                          (entry) => entry.documentId !== attachment.documentId,
                        ),
                      )
                    }
                    type="button"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </span>
              ))}
              {attachNote ? (
                <span className="text-[12px] text-muted-foreground">
                  {attachNote}
                </span>
              ) : null}
            </div>
          ) : null}
          <textarea
            aria-label="Message the assistant"
            className="max-h-[min(12rem,25vh)] min-h-[2.5rem] w-full resize-none rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel) px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            data-assistant-composer
            onChange={(event) => {
              setText(event.target.value);
              updateMentionQuery(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            onKeyDown={onComposerKeyDown}
            placeholder={
              viewingArchive
                ? "This chat is archived. Sending starts a new chat."
                : running
                  ? "Add to what I'm doing, or ask something else"
                  : "Ask or tell the assistant… (@ to mention)"
            }
            ref={textareaRef}
            rows={1}
            value={text}
          />
          <div className="flex items-center gap-1">
            <button
              aria-label="Attach a file"
              className="rounded-(--radius-button) p-1.5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
              onClick={() => void attach(null)}
              title="Attach a file (or drop one here)"
              type="button"
            >
              <Paperclip aria-hidden="true" className="size-4" />
            </button>
            <span className="flex-1" />
            {running ? (
              <button
                aria-label="Stop"
                className="inline-flex items-center gap-1.5 rounded-(--radius-button) border border-(--control-border) px-2.5 py-1.5 text-[13px] font-medium outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40"
                data-assistant-stop
                onClick={() => void stop()}
                type="button"
              >
                <Square aria-hidden="true" className="size-3 fill-current" />
                Stop
              </button>
            ) : null}
            <button
              aria-label="Send"
              className="inline-flex items-center justify-center rounded-(--radius-button) bg-primary p-1.5 text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-40"
              data-assistant-send
              disabled={
                !text.trim() || text.trim().length > ASSISTANT_MESSAGE_MAX_CHARS
              }
              type="submit"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </button>
          </div>
          {text.trim().length > ASSISTANT_MESSAGE_MAX_CHARS ? (
            <p
              className="text-[12px] text-(--status-danger-foreground,currentColor)"
              data-assistant-too-long
              role="status"
            >
              This message is {text.trim().length.toLocaleString()} characters;
              the limit is {ASSISTANT_MESSAGE_MAX_CHARS.toLocaleString()}.
              Shorten it or attach the text as a file.
            </p>
          ) : null}
        </form>
        <span
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          role="status"
        >
          {announcement}
        </span>
      </aside>
    </>,
    document.body,
  );
}
