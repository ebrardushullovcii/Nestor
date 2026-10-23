import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useEffectWhileKeptRouteShown } from "../lib/kept-route-visibility";
import type {
  AssistantAttachment,
  AssistantContextReference,
  AssistantEntityRef,
} from "@nestor/contracts";

import {
  composeContextReference,
  type AssistantContextPatch,
} from "./assistant-context-capture";

/**
 * Sidebar state shared by the shell, the screens and the sidebar itself.
 *
 * Screens publish what "this" means through `useAssistantContextSource`; the
 * getter is read when a message is sent, so the reference is fresh and a
 * screen that is no longer mounted contributes nothing. The sidebar never
 * opens by itself: only the toggle, ⌘I or an explicit entry point open it.
 */

export const ASSISTANT_SIDEBAR_MIN_WIDTH = 320;
export const ASSISTANT_SIDEBAR_MAX_WIDTH = 480;
export const ASSISTANT_SIDEBAR_DEFAULT_WIDTH = 400;
const STORAGE_KEY = "nestor.assistant-sidebar.v1";

interface StoredState {
  open: boolean;
  width: number;
}

function readStored(): StoredState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { open: false, width: ASSISTANT_SIDEBAR_DEFAULT_WIDTH };
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      open: parsed.open === true,
      width: clampWidth(
        typeof parsed.width === "number"
          ? parsed.width
          : ASSISTANT_SIDEBAR_DEFAULT_WIDTH,
      ),
    };
  } catch {
    return { open: false, width: ASSISTANT_SIDEBAR_DEFAULT_WIDTH };
  }
}

export function clampWidth(width: number): number {
  return Math.round(
    Math.min(
      ASSISTANT_SIDEBAR_MAX_WIDTH,
      Math.max(ASSISTANT_SIDEBAR_MIN_WIDTH, width),
    ),
  );
}

export interface AssistantPrefill {
  text: string;
  mentions: AssistantEntityRef[];
  sendNow: boolean;
}

interface AssistantProviderValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  width: number;
  setWidth: (width: number) => void;
  /** Narrow windows switch between the page and the chat instead of squeezing. */
  narrowView: "page" | "chat";
  setNarrowView: (view: "page" | "chat") => void;
  working: boolean;
  setWorking: (working: boolean) => void;
  focusRequest: number;
  prefill: AssistantPrefill | null;
  consumePrefill: () => AssistantPrefill | null;
  /** Opens the sidebar with an optional message, mention or both. */
  openWith: (options?: {
    text?: string;
    mention?: AssistantEntityRef;
    sendNow?: boolean;
  }) => void;
  registerContext: (
    id: string,
    getter: () => AssistantContextPatch | null,
    priority?: number,
  ) => () => void;
  captureContext: (extra: {
    mentions: AssistantEntityRef[];
    attachments: AssistantAttachment[];
  }) => Promise<AssistantContextReference>;
  /** The record the screen would send as "this" right now, if any. */
  peekFocus: () => AssistantEntityRef | null;
}

const AssistantContext = createContext<AssistantProviderValue | null>(null);

// The panel itself. `<html>` carries data-assistant-sidebar too (docked,
// narrow or closed, for styling), so a bare attribute selector matches every
// element on the page and would treat the whole page as the sidebar.
const SIDEBAR_PANEL = "aside[data-assistant-sidebar]";

export function AssistantProvider(props: { children: ReactNode }) {
  const location = useLocation();
  const stored = useMemo(readStored, []);
  const [open, setOpenState] = useState(stored.open);
  const [width, setWidthState] = useState(stored.width);
  const [narrowView, setNarrowView] = useState<"page" | "chat">("chat");
  const [working, setWorking] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [prefill, setPrefill] = useState<AssistantPrefill | null>(null);
  const sources = useRef(
    new Map<
      string,
      { getter: () => AssistantContextPatch | null; priority: number }
    >(),
  );
  const locationRef = useRef(location);
  locationRef.current = location;
  const lastSelection = useRef<{ text: string; at: number } | null>(null);
  // A selection belongs to the screen it was made on.
  useEffect(() => {
    lastSelection.current = null;
  }, [location.pathname]);

  const persist = useCallback((next: StoredState) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Remembering the sidebar is a convenience only.
    }
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (next) {
        setNarrowView("chat");
        setFocusRequest((value) => value + 1);
      }
      persist({ open: next, width });
    },
    [persist, width],
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      setWidthState(clamped);
      persist({ open, width: clamped });
    },
    [open, persist],
  );

  // Text the person selected on the page (outside the sidebar) is sent with
  // the next message as the selection.
  useEffect(() => {
    const onSelection = () => {
      const active = document.activeElement;
      // Text fields keep their selection out of window.getSelection().
      if (
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement
      ) {
        if (active.closest(SIDEBAR_PANEL)) return;
        const start = active.selectionStart ?? 0;
        const end = active.selectionEnd ?? 0;
        lastSelection.current =
          end > start
            ? {
                text: active.value.slice(start, end).slice(0, 4_000),
                at: Date.now(),
              }
            : // A caret placed in a page field means the person deselected.
              null;
        return;
      }
      const selection = window.getSelection();
      const anchor = selection?.anchorNode ?? null;
      const inSidebar =
        anchor instanceof Node &&
        (anchor instanceof Element ? anchor : anchor.parentElement)?.closest(
          SIDEBAR_PANEL,
        );
      if (inSidebar) return;
      const text = selection?.toString().trim() ?? "";
      // Moving focus to the composer passes through empty selections; only
      // a new selection replaces the one the person made.
      if (text.length > 0) {
        lastSelection.current = { text: text.slice(0, 4_000), at: Date.now() };
      }
    };
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("select", onSelection, true);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("select", onSelection, true);
    };
  }, []);

  const registerContext = useCallback(
    (id: string, getter: () => AssistantContextPatch | null, priority = 0) => {
      const entry = { getter, priority };
      sources.current.set(id, entry);
      return () => {
        if (sources.current.get(id) === entry) sources.current.delete(id);
      };
    },
    [],
  );

  const collectPatches = useCallback(() => {
    const patches: AssistantContextPatch[] = [];
    // Higher priority merges last and wins: a list that knows the ticked
    // rows beats the screen's own list.
    const ordered = [...sources.current.values()].sort(
      (left, right) => left.priority - right.priority,
    );
    for (const { getter } of ordered) {
      try {
        const patch = getter();
        if (patch) patches.push(patch);
      } catch {
        // A screen that cannot describe itself contributes nothing.
      }
    }
    return patches;
  }, []);

  const peekFocus = useCallback(
    () =>
      collectPatches().reduce<AssistantEntityRef | null>(
        (current, patch) => patch.focus ?? current,
        null,
      ),
    [collectPatches],
  );

  const captureContext = useCallback<AssistantProviderValue["captureContext"]>(
    async (extra) => {
      const patches = collectPatches();
      let browser: AssistantContextReference["browser"] = null;
      try {
        const state = await window.nestor?.browser?.getState();
        const tab = state?.tabs.find((entry) => entry.id === state.activeTabId);
        if (
          state &&
          tab &&
          state.phase !== "closed" &&
          state.presentation !== "minimized"
        ) {
          browser = {
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            visible: true,
          };
        }
      } catch {
        browser = null;
      }
      // A selection older than ten minutes is not what "this" means now.
      const held = lastSelection.current;
      const selectedText =
        held && Date.now() - held.at < 600_000 ? held.text : null;
      lastSelection.current = null;
      return composeContextReference({
        pathname: locationRef.current.pathname,
        search: locationRef.current.search,
        patches,
        browser,
        selectedText,
        mentions: extra.mentions,
        attachments: extra.attachments,
        now: new Date().toISOString(),
      });
    },
    [collectPatches],
  );

  const openWith = useCallback<AssistantProviderValue["openWith"]>(
    (options) => {
      if (options?.text || options?.mention) {
        setPrefill({
          text: options.text ?? "",
          mentions: options.mention ? [options.mention] : [],
          sendNow: options.sendNow === true,
        });
      }
      setOpen(true);
    },
    [setOpen],
  );

  const consumePrefill = useCallback(() => {
    const current = prefill;
    setPrefill(null);
    return current;
  }, [prefill]);

  const value = useMemo<AssistantProviderValue>(
    () => ({
      open,
      setOpen,
      toggle,
      width,
      setWidth,
      narrowView,
      setNarrowView,
      working,
      setWorking,
      focusRequest,
      prefill,
      consumePrefill,
      openWith,
      registerContext,
      captureContext,
      peekFocus,
    }),
    [
      open,
      setOpen,
      toggle,
      width,
      setWidth,
      narrowView,
      working,
      focusRequest,
      prefill,
      consumePrefill,
      openWith,
      registerContext,
      captureContext,
      peekFocus,
    ],
  );

  return (
    <AssistantContext.Provider value={value}>
      {props.children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantProviderValue | null {
  return useContext(AssistantContext);
}

/**
 * Publishes what the current screen means by "this". The getter runs when a
 * message is sent; keep it cheap and bounded.
 */
export function useAssistantContextSource(
  id: string,
  getter: () => AssistantContextPatch | null,
  options: { priority?: number } = {},
): void {
  const assistant = useAssistant();
  const priority = options.priority ?? 0;
  const getterRef = useRef(getter);
  getterRef.current = getter;
  const registerContext = assistant?.registerContext;
  // A screen kept mounted behind the one shown is not what the person sees.
  useEffectWhileKeptRouteShown(() => {
    if (!registerContext) return undefined;
    return registerContext(id, () => getterRef.current(), priority);
    // The registry holds a stable wrapper; only the id and priority matter.
  }, [registerContext, id, priority]);
}
