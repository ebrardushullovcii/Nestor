import { useToast } from "@renderer/components/ui/toast";
import {
  describeBrowserJobFailure,
  describeFailure,
} from "../lib/describe-failure";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Globe2,
  Import,
  KeyRound,
  LoaderCircle,
  Lock,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Play,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import {
  resolveBrowserAddress,
  type AddBrowserJobResult,
  type DesktopBrowserCommand,
  type DesktopBrowserImportSource,
  type DesktopBrowserState,
} from "@nestor/contracts";
import {
  JOB_FINDER_BROWSER_LABEL,
  OPEN_JOB_FINDER_BROWSER_ACTION,
} from "../lib/job-finder-browser-handoff-copy";
import {
  subscribeToJobFinderOverlays,
  useJobFinderOverlayOwnership,
} from "../lib/job-finder-overlay-ownership";
import {
  currentWorkItem,
  useWorkThrough,
  workThrough,
} from "../../needs-you/work-through";
import "./browser-peek.css";
import {
  BrowserPasswordOffer,
  BrowserPasswordPanel,
} from "./browser-passwords";

const initialState: DesktopBrowserState = {
  revision: 0,
  phase: "closed",
  presentation: "minimized",
  tabs: [],
  activeTabId: null,
  activity: null,
  attention: null,
  automationPaused: false,
};

/** A compact window glyph: distinct from the globe used for pages and tabs. */
function BrowserGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="browser-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.5" />
      <path d="M1.75 6.25h12.5" />
      <circle cx="4.4" cy="4.5" r="0.55" fill="currentColor" stroke="none" />
      <circle cx="6.4" cy="4.5" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

function BrowserBrandMark({
  browser,
}: {
  browser: DesktopBrowserImportSource["browser"];
}) {
  const letter = {
    chrome: "C",
    chromium: "C",
    brave: "B",
    edge: "E",
    arc: "A",
    firefox: "F",
  }[browser];
  return (
    <span className={`browser-brand-mark is-${browser}`} aria-hidden="true">
      {letter}
    </span>
  );
}

export function BrowserPeek(props: {
  hasUnresolvedAttention?: boolean;
  onRecordSend?: () => void;
  /** Opens a sent application's job in Applications. */
  onOpenApplication?: (jobId: number) => void;
  /**
   * Width the expanded browser's toolbar keeps clear at its leading edge, for
   * the native macOS traffic lights that paint above every overlay. Undefined
   * on other platforms and in native fullscreen.
   */
  chromeInsetStart?: string | undefined;
}) {
  const bridge = window.nestor?.browser;
  const { showToast } = useToast();
  const lastSendNotice = useRef<string | null>(null);
  const lastSentNotice = useRef<string | null | undefined>(undefined);
  const { walk } = useWorkThrough();
  const walkItem = walk && !walk.paused ? currentWorkItem(walk) : null;
  const signingIn = walkItem?.kind === "site" ? walkItem : null;
  const [addingJob, setAddingJob] = useState(false);
  const [savedJob, setSavedJob] = useState<AddBrowserJobResult | null>(null);
  const [shortlisting, setShortlisting] = useState(false);
  const addJob = async () => {
    if (!bridge || !state.activeTabId || addingJob) return;
    setMenuOpen(false);
    setAddingJob(true);
    setMessage(null);
    setSavedJob(null);
    try {
      const saved = await bridge.addCurrentJob({ tabId: state.activeTabId });
      setSavedJob(saved);
      setMessage(
        `Saved ${saved.title}${saved.company ? ` at ${saved.company}` : ""}.`,
      );
    } catch (error) {
      setMessage(describeBrowserJobFailure(error));
    } finally {
      setAddingJob(false);
    }
  };
  const shortlistSavedJob = async () => {
    if (!savedJob || shortlisting) return;
    setShortlisting(true);
    try {
      await window.nestor.jobs.run("move_jobs", {
        selection: { ids: [Number(savedJob.jobId)] },
        to: "shortlisted",
      });
      setMessage(
        `${savedJob.title}${savedJob.company ? ` at ${savedJob.company}` : ""} added to Shortlisted.`,
      );
      setSavedJob(null);
    } catch (error) {
      setSavedJob(null);
      setMessage(
        describeFailure(error, {
          unknownSentence: "Could not shortlist this job. Try again.",
        }).userMessage,
      );
    } finally {
      setShortlisting(false);
    }
  };
  const [state, setState] = useState(initialState);
  useEffect(() => {
    const notice = state.unboundSendNotice;
    if (!notice || lastSendNotice.current === notice.id) return;
    lastSendNotice.current = notice.id;
    showToast({
      id: "unbound-application-send",
      title: "This page is not linked to an application",
      description:
        "After the site confirms receipt, record which application you sent.",
      duration: 15_000,
      ...(props.onRecordSend
        ? {
            action: {
              label: "Record it in Applications",
              onClick: () => {
                void bridge?.command({ type: "minimize" });
                props.onRecordSend?.();
              },
            },
          }
        : {}),
    });
  }, [state.unboundSendNotice, showToast, props.onRecordSend, bridge]);
  // Main closes the sent form's tab and hides the peek when it was the last.
  useEffect(() => {
    if (state.revision === 0) return;
    const notice = state.sentNotice ?? null;
    // A notice already standing in the first state this window reads is old news.
    if (lastSentNotice.current === undefined) {
      lastSentNotice.current = notice?.id ?? null;
      return;
    }
    if (!notice || lastSentNotice.current === notice.id) return;
    lastSentNotice.current = notice.id;
    showToast({
      id: "application-sent",
      title: `Sent: ${notice.title}${notice.company ? ` at ${notice.company}` : ""}`,
      description: "Moved to Applied.",
      duration: 10_000,
      ...(props.onOpenApplication
        ? {
            action: {
              label: "Open in Applications",
              onClick: () => {
                void bridge?.command({ type: "minimize" });
                props.onOpenApplication?.(notice.jobId);
              },
            },
          }
        : {}),
    });
  }, [
    state.sentNotice,
    state.revision,
    showToast,
    props.onOpenApplication,
    bridge,
  ]);
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordPanel, setPasswordPanel] = useState(false);
  // App chrome cannot paint above the native page view, so while a menu or
  // picker is open the page is hidden behind a still of itself (Arc-style).
  const [pageHidden, setPageHidden] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [importPanel, setImportPanel] = useState<
    | null
    | { step: "loading" }
    | {
        step: "pick";
        sources: DesktopBrowserImportSource[];
        note: string | null;
      }
    | { step: "importing"; source: DesktopBrowserImportSource }
    | { step: "done"; ok: boolean; message: string }
  >(null);
  const [importSources, setImportSources] = useState<
    DesktopBrowserImportSource[] | null
  >(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  const shown = state.presentation !== "minimized" && state.phase !== "closed";
  const busy = state.phase === "working";
  const needsYou =
    state.phase === "needs_you" && props.hasUnresolvedAttention !== false;
  const paused = state.automationPaused;
  const blank = !active || active.url === "about:blank";
  const overlayRequested = menuOpen || importPanel !== null || passwordPanel;
  const accept = useCallback(
    (next: DesktopBrowserState) =>
      setState((current) =>
        next.revision >= current.revision ? next : current,
      ),
    [],
  );
  const command = useCallback(
    async (input: DesktopBrowserCommand) => {
      if (!bridge) return false;
      try {
        accept(await bridge.command(input));
        setMessage(null);
        setSavedJob(null);
        return true;
      } catch {
        setMessage(
          "The browser couldn’t complete that action. Try again or close and reopen it.",
        );
        return false;
      }
    },
    [bridge, accept],
  );
  const minimize = useCallback(() => {
    void command({ type: "minimize" });
  }, [command]);
  const { isTopmost } = useJobFinderOverlayOwnership({
    active: shown,
    close: minimize,
    modal: true,
  });

  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onStateChanged(accept);
    void bridge
      .getState()
      .then(accept)
      .catch(() => setMessage("Browser controls are unavailable."));
    const focus = bridge.onFocusAddress(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    });
    return () => {
      unsubscribe();
      focus();
    };
  }, [bridge, accept]);
  useEffect(() => {
    setAddress(active?.url === "about:blank" ? "" : (active?.url ?? ""));
  }, [active?.url, active?.id]);
  // The welcome screen names the browsers it can bring sign-ins from.
  useEffect(() => {
    if (!bridge || !shown || !blank || importSources !== null) return;
    void bridge
      .listImportSources()
      .then((listed) => setImportSources(listed.sources))
      .catch(() => setImportSources([]));
  }, [bridge, shown, blank, importSources]);
  useEffect(() => {
    if (!bridge || !shown) return;
    const measure = () => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      void bridge
        .setViewport({
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: rect.width,
          height: rect.height,
          visible: isTopmost() && !blank && !pageHidden,
        })
        .catch(() => undefined);
    };
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    const unsubscribe = subscribeToJobFinderOverlays(measure);
    window.addEventListener("resize", measure);
    const frame = requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      unsubscribe();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      void bridge
        .setViewport({ x: 0, y: 0, width: 0, height: 0, visible: false })
        .catch(() => undefined);
    };
  }, [bridge, shown, blank, pageHidden, state.presentation, isTopmost]);
  useEffect(() => {
    if (!bridge || !shown) return;
    if (!overlayRequested) {
      setPageHidden(false);
      setSnapshot(null);
      return;
    }
    if (blank) {
      setPageHidden(true);
      return;
    }
    let cancelled = false;
    void bridge
      .captureActivePage()
      .then((still) => {
        if (cancelled) return;
        setSnapshot(still.dataUrl);
        setPageHidden(true);
      })
      .catch(() => {
        if (!cancelled) setPageHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, shown, blank, overlayRequested]);
  useEffect(() => {
    if (!shown) return;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isTopmost()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (passwordPanel) setPasswordPanel(false);
        else if (importPanel) setImportPanel(null);
        else if (menuOpen) setMenuOpen(false);
        else minimize();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      }
      if (event.key === "Tab") {
        const items = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), a[href]",
          ) ?? []),
        ].filter((item) => item.getClientRects().length > 0);
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (root) root.inert = wasInert;
      triggerRef.current?.focus();
    };
  }, [shown, blank, isTopmost, minimize, importPanel, menuOpen, passwordPanel]);
  // The address bar takes focus when the person opens an empty browser, not
  // whenever the page goes blank under them (a sent form's tab closing).
  const wasShown = useRef(false);
  useEffect(() => {
    if (!shown) {
      if (wasShown.current && signingIn) workThrough.pause();
      wasShown.current = false;
      return;
    }
    if (wasShown.current) return;
    wasShown.current = true;
    if (blank) addressRef.current?.focus();
  }, [shown, blank, signingIn]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);
  useEffect(() => {
    if (!shown) {
      setMenuOpen(false);
      setPasswordPanel(false);
      setImportPanel(null);
    }
  }, [shown]);

  async function openImportPicker() {
    if (!bridge) return;
    setMenuOpen(false);
    setPasswordPanel(false);
    setImportPanel({ step: "loading" });
    try {
      const listed = await bridge.listImportSources();
      setImportSources(listed.sources);
      setImportPanel({
        step: "pick",
        sources: listed.sources,
        note: listed.note,
      });
    } catch {
      setImportPanel({
        step: "done",
        ok: false,
        message: "Installed browsers couldn’t be checked right now.",
      });
    }
  }
  async function importFrom(source: DesktopBrowserImportSource) {
    if (!bridge) return;
    setImportPanel({ step: "importing", source });
    try {
      const result = await bridge.importFromBrowser({ sourceId: source.id });
      setImportPanel({
        step: "done",
        ok: result.status === "imported",
        message: result.message,
      });
    } catch {
      setImportPanel({
        step: "done",
        ok: false,
        message:
          "The import couldn’t finish. Your existing sign-ins are still available.",
      });
    }
  }

  const status =
    state.phase === "closing"
      ? "Closing"
      : state.phase === "closed"
        ? "Closed"
        : state.phase === "pausing"
          ? "Pausing…"
          : busy
            ? // Every running step names itself in plain words ("Finding
              // jobs", "Preparing application"); "Agent" is an internal noun,
              // so the fallback says what is happening instead.
              (state.activity ?? "Working in this browser")
            : needsYou
              ? (state.attention?.title ?? "Needs you")
              : paused
                ? "You’re in control"
                : "Ready";
  const triggerState =
    state.phase === "closed" || state.phase === "closing"
      ? paused
        ? "paused"
        : "closed"
      : needsYou
        ? "needs-you"
        : busy
          ? "working"
          : paused
            ? "paused"
            : "open";
  const importable = (importSources ?? []).filter((source) => source.supported);
  const importableBrowsers = [
    ...new Set(importable.map((source) => source.browserLabel)),
  ];
  // During a walk through sign-ins its own bar says what to do next.
  const showNotice =
    addingJob || !!message || (!!state.attention && !blank && !signingIn);
  const isSecure = !!active?.url.startsWith("https://");
  const currentAddress = blank ? "" : (active?.url ?? "");
  const typing = address.trim() !== "" && address !== currentAddress;
  const typedResolution = typing ? resolveBrowserAddress(address) : null;
  const willSearch = typedResolution?.kind === "search";

  return (
    <>
      <button
        ref={triggerRef}
        className={`browser-peek-trigger is-${triggerState}`}
        type="button"
        disabled={!bridge}
        aria-label={`${OPEN_JOB_FINDER_BROWSER_ACTION} · ${status}`}
        title={`${JOB_FINDER_BROWSER_LABEL} · ${status}`}
        onClick={() => void command({ type: "open" })}
      >
        <span className="browser-trigger-icon">
          <BrowserGlyph size={17} />
          {triggerState !== "closed" && (
            <span className="browser-trigger-badge" aria-hidden="true">
              {triggerState === "needs-you" ? "!" : ""}
            </span>
          )}
        </span>
        {/* Same collapse as Tasks and Needs you: below 1100px the toolbar has
            to fit beside the section nav, and this label was the one that
            never gave way, so the toolbar overflowed onto "More". */}
        <span className="browser-trigger-label hidden min-[900px]:inline max-[1099px]:!hidden xl:max-[1440px]:!hidden">
          Browser
        </span>
      </button>
      {shown &&
        createPortal(
          <div
            className="browser-peek-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && isTopmost())
                minimize();
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={JOB_FINDER_BROWSER_LABEL}
              className={`browser-peek ${state.presentation === "expanded" ? "is-expanded" : ""} ${busy ? "is-working" : ""} ${needsYou ? "is-needs-you" : ""}`}
              style={
                props.chromeInsetStart
                  ? ({
                      "--browser-chrome-inset-start": props.chromeInsetStart,
                    } as CSSProperties)
                  : undefined
              }
            >
              <div className="browser-toolbar">
                <div className="browser-nav">
                  <button
                    type="button"
                    aria-label="Go back"
                    disabled={!active?.canGoBack}
                    onClick={() => void command({ type: "back" })}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Go forward"
                    disabled={!active?.canGoForward}
                    onClick={() => void command({ type: "forward" })}
                  >
                    <ArrowRight size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={
                      active?.loading ? "Stop loading" : "Reload page"
                    }
                    disabled={!active || blank}
                    onClick={() =>
                      void command({
                        type: active?.loading ? "stop" : "reload",
                      })
                    }
                  >
                    {active?.loading ? (
                      <Square size={12} />
                    ) : (
                      <RotateCw size={14} />
                    )}
                  </button>
                </div>
                <form
                  className={`browser-address ${busy ? "is-working" : ""} ${needsYou ? "is-needs-you" : ""}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!address.trim()) return;
                    void command({ type: "navigate", url: address });
                    addressRef.current?.blur();
                  }}
                >
                  <span className="browser-address-lead" aria-hidden="true">
                    {willSearch ? (
                      <Search size={13} />
                    ) : busy ? (
                      <LoaderCircle size={13} className="browser-spin" />
                    ) : isSecure ? (
                      <Lock size={12} />
                    ) : (
                      <Globe2 size={13} />
                    )}
                  </span>
                  <input
                    ref={addressRef}
                    aria-label="Website address"
                    placeholder="Search or enter a website address"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      // Escape restores the current address and leaves the
                      // bar, as in any browser; it must not hide the panel.
                      // An empty bar has nothing to restore, so Escape hides.
                      if (event.key !== "Escape") return;
                      if (address === "" && currentAddress === "") return;
                      event.preventDefault();
                      setAddress(currentAddress);
                      event.currentTarget.blur();
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {(busy ||
                    state.phase === "pausing" ||
                    (paused && !needsYou)) && (
                    <span className="browser-address-status" aria-live="polite">
                      <span className="browser-address-status-dot" />
                      {status}
                    </span>
                  )}
                  {typing && (
                    <button
                      type="submit"
                      className="browser-address-go"
                      aria-label={
                        willSearch ? "Search the web" : "Go to website"
                      }
                    >
                      {willSearch ? "Search" : "Go"}
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                </form>
                <div className="browser-window-actions">
                  {paused && !needsYou && state.phase !== "pausing" && (
                    <button
                      type="button"
                      className="browser-resume"
                      title="Hand the page back to the agent and resume activity"
                      onClick={() => void command({ type: "resume" })}
                    >
                      <Play size={12} />
                      Resume agent
                    </button>
                  )}
                  <button
                    type="button"
                    title="Saved passwords"
                    aria-label="Saved passwords"
                    onClick={() => {
                      setMenuOpen(false);
                      setImportPanel(null);
                      setPasswordPanel((open) => !open);
                    }}
                  >
                    <KeyRound size={16} />
                  </button>
                  <div className="browser-menu" ref={menuRef}>
                    <button
                      type="button"
                      aria-label="More browser actions"
                      aria-expanded={menuOpen}
                      aria-haspopup="menu"
                      onClick={() => setMenuOpen((open) => !open)}
                    >
                      <MoreHorizontal size={17} />
                    </button>
                    {menuOpen && (
                      <div className="browser-menu-list" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          disabled={blank}
                          title="Reload this tab using the browser’s original identity. Unsaved entries in this tab may be lost."
                          onClick={() => {
                            setMenuOpen(false);
                            void command({ type: "retry_verification" });
                          }}
                        >
                          <RotateCw size={14} /> Retry site verification
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={blank}
                          title="If verification keeps repeating, open the displayed address in your usual browser and apply by hand. Sign-ins and verification do not transfer back to Nestor."
                          onClick={() => {
                            setMenuOpen(false);
                            void command({ type: "open_in_browser" }).then(
                              (opened) => {
                                if (opened)
                                  setMessage(
                                    "Continue in your usual browser and apply by hand. Its sign-in and verification do not transfer back to Nestor. Nestor cannot observe or continue work in that browser.",
                                  );
                              },
                            );
                          }}
                        >
                          <ArrowUpRight size={14} /> Open in my browser
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={blank || busy || addingJob}
                          onClick={() => void addJob()}
                        >
                          <Plus size={14} />{" "}
                          {addingJob ? "Adding job…" : "Add this job"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={state.tabs.length >= 8}
                          onClick={() => {
                            setMenuOpen(false);
                            void command({ type: "new_tab" });
                          }}
                        >
                          <Plus size={14} /> New tab
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            void command({ type: "close_finished_tabs" });
                          }}
                        >
                          <X size={14} /> Close finished tabs
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void openImportPicker()}
                        >
                          <Import size={14} /> Bring sign-ins from another
                          browser…
                        </button>
                        <span className="browser-menu-separator" />
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() => {
                            setMenuOpen(false);
                            void command({ type: "close" });
                          }}
                        >
                          <X size={14} /> Close browser
                        </button>
                        <span className="browser-menu-hint">
                          Closing stops the agent’s activity and frees the
                          pages. Sign-ins are kept.
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    title={
                      state.presentation === "expanded"
                        ? "Shrink to peek"
                        : "Fill the window"
                    }
                    aria-label={
                      state.presentation === "expanded"
                        ? "Shrink to peek"
                        : "Fill the window"
                    }
                    onClick={() =>
                      void command({
                        type: "expand",
                        expanded: state.presentation !== "expanded",
                      })
                    }
                  >
                    {state.presentation === "expanded" ? (
                      <Minimize2 size={15} />
                    ) : (
                      <Maximize2 size={15} />
                    )}
                  </button>
                  <button
                    type="button"
                    title="Hide · the agent keeps working"
                    aria-label="Hide browser"
                    onClick={minimize}
                  >
                    <ChevronDown size={18} />
                  </button>
                </div>
              </div>
              {state.tabs.length > 1 && (
                <div
                  className="browser-tabs"
                  role="tablist"
                  aria-label="Browser tabs"
                >
                  {state.tabs.map((tab) => (
                    <div
                      className={`browser-tab ${tab.id === active?.id ? "is-active" : ""}`}
                      key={tab.id}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={tab.id === active?.id}
                        title={tab.title}
                        onClick={() =>
                          void command({ type: "select_tab", tabId: tab.id })
                        }
                      >
                        {tab.loading ? (
                          <LoaderCircle size={11} className="browser-spin" />
                        ) : (
                          <Globe2 size={11} />
                        )}
                        <span>{tab.title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Close tab ${tab.title}`}
                        onClick={() =>
                          void command({ type: "close_tab", tabId: tab.id })
                        }
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="browser-add-tab"
                    type="button"
                    disabled={state.tabs.length >= 8}
                    aria-label="New browser tab"
                    onClick={() => void command({ type: "new_tab" })}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              )}
              {signingIn && walk ? (
                <div
                  className="browser-notice is-walk"
                  role="status"
                  data-browser-walk
                >
                  <span className="browser-notice-text">
                    <strong>Signing in</strong> · {signingIn.label} ·{" "}
                    {walk.index + 1} of {walk.items.length}
                  </span>
                  <button
                    type="button"
                    className="browser-notice-action"
                    onClick={() => workThrough.doneWithSite()}
                  >
                    {walk.index + 1 < walk.items.length
                      ? "Done, next site"
                      : "Done"}
                  </button>
                  <button
                    type="button"
                    className="browser-notice-action"
                    onClick={() => workThrough.skip()}
                  >
                    Skip
                  </button>
                </div>
              ) : null}
              {showNotice && (
                <div
                  className={`browser-notice ${needsYou && !message ? "is-needs-you" : ""}`}
                  role="status"
                >
                  <span className="browser-notice-text">
                    {!addingJob && !message && state.attention && (
                      <strong>{state.attention.title}. </strong>
                    )}
                    {addingJob
                      ? "Adding this job…"
                      : (message ?? state.attention?.detail)}
                  </span>
                  {savedJob && !addingJob ? (
                    <button
                      type="button"
                      className="browser-notice-action"
                      disabled={shortlisting}
                      onClick={() => void shortlistSavedJob()}
                    >
                      {shortlisting ? "Shortlisting…" : "Shortlist"}
                    </button>
                  ) : null}
                  {message && !addingJob ? (
                    <button
                      type="button"
                      aria-label="Dismiss browser message"
                      onClick={() => {
                        setMessage(null);
                        setSavedJob(null);
                      }}
                    >
                      <X size={14} />
                    </button>
                  ) : paused ? (
                    <button
                      type="button"
                      className="browser-notice-action"
                      onClick={() => void command({ type: "resume" })}
                    >
                      Done, resume agent
                    </button>
                  ) : null}
                </div>
              )}
              {state.passwordPrompt && bridge && (
                <BrowserPasswordOffer
                  key={state.passwordPrompt.id}
                  prompt={state.passwordPrompt}
                  bridge={bridge}
                  message={setMessage}
                />
              )}
              <div
                ref={viewportRef}
                className={`browser-page-viewport ${blank ? "is-blank" : ""} ${pageHidden && !blank ? "is-covered" : ""}`}
              >
                {pageHidden && !blank && snapshot && (
                  <img
                    className="browser-page-snapshot"
                    src={snapshot}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                  />
                )}
                {passwordPanel && bridge && (
                  <BrowserPasswordPanel
                    bridge={bridge}
                    tabId={state.activeTabId}
                    close={() => setPasswordPanel(false)}
                  />
                )}
                {blank && !importPanel && !passwordPanel && (
                  <div className="browser-welcome">
                    <div className="browser-welcome-icon">
                      <BrowserGlyph size={30} />
                    </div>
                    <h2>Your browser, right here.</h2>
                    <p>
                      Sign in to job sites once. The agent browses in these same
                      tabs, and you can step in whenever it needs you.
                    </p>
                    <div className="browser-welcome-actions">
                      <button
                        type="button"
                        className="browser-welcome-go"
                        onClick={() => addressRef.current?.focus()}
                      >
                        Open a website <ArrowUpRight size={15} />
                      </button>
                      {importable.length > 0 && (
                        <button
                          type="button"
                          className="browser-welcome-import"
                          onClick={() => void openImportPicker()}
                        >
                          <Import size={14} />
                          Bring sign-ins from{" "}
                          {importableBrowsers.length === 1
                            ? importableBrowsers[0]
                            : importableBrowsers.length === 2
                              ? importableBrowsers.join(" or ")
                              : "another browser"}
                        </button>
                      )}
                    </div>
                    <div className="browser-welcome-notes">
                      <span>
                        <ShieldCheck size={14} /> Sign-ins stay on this device
                      </span>
                      <span>
                        <Check size={14} /> Hide it and the agent keeps going
                      </span>
                    </div>
                  </div>
                )}
                {importPanel && (
                  <div className="browser-import">
                    <div className="browser-import-card">
                      <div className="browser-import-head">
                        <div>
                          <h3>Bring your sign-ins over</h3>
                          <p>
                            Pick a browser you already use. Its saved sign-ins
                            are copied into this browser so job sites remember
                            you here too.
                          </p>
                        </div>
                        <button
                          type="button"
                          aria-label="Close import"
                          onClick={() => setImportPanel(null)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      {importPanel.step === "loading" && (
                        <div className="browser-import-empty">
                          <LoaderCircle size={16} className="browser-spin" />
                          Looking for browsers on this Mac…
                        </div>
                      )}
                      {importPanel.step === "pick" &&
                        (importPanel.sources.length === 0 ? (
                          <div className="browser-import-empty">
                            {importPanel.note ??
                              "No other browsers with saved sign-ins were found on this device."}
                          </div>
                        ) : (
                          <div className="browser-import-list" role="list">
                            {importPanel.sources.map((source) => (
                              <button
                                key={source.id}
                                type="button"
                                role="listitem"
                                className="browser-import-source"
                                disabled={!source.supported}
                                title={source.note ?? undefined}
                                onClick={() => void importFrom(source)}
                              >
                                <BrowserBrandMark browser={source.browser} />
                                <span className="browser-import-source-text">
                                  <span>{source.browserLabel}</span>
                                  <small>
                                    {source.profileLabel}
                                    {!source.supported &&
                                      " · can’t be read on this device"}
                                  </small>
                                </span>
                                <ArrowUpRight size={15} />
                              </button>
                            ))}
                          </div>
                        ))}
                      {importPanel.step === "importing" && (
                        <div className="browser-import-empty">
                          <LoaderCircle size={16} className="browser-spin" />
                          Bringing sign-ins over from{" "}
                          {importPanel.source.browserLabel}…
                        </div>
                      )}
                      {importPanel.step === "done" && (
                        <div
                          className={`browser-import-result ${importPanel.ok ? "is-ok" : ""}`}
                        >
                          {importPanel.ok ? (
                            <Check size={16} />
                          ) : (
                            <KeyRound size={16} />
                          )}
                          <span>{importPanel.message}</span>
                        </div>
                      )}
                      <div className="browser-import-foot">
                        {importPanel.step === "pick" &&
                        importPanel.sources.some((s) => s.note) ? (
                          <span>
                            {importPanel.sources.find((s) => s.note)?.note}
                          </span>
                        ) : (
                          <span>
                            Only sign-ins are copied. Passwords, bookmarks and
                            history stay where they are.
                          </span>
                        )}
                        {importPanel.step === "done" && (
                          <button
                            type="button"
                            className="browser-import-done"
                            onClick={() => setImportPanel(null)}
                          >
                            Done
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
