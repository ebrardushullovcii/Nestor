import {
  useCallback,
  useEffect,
  useDeferredValue,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Input } from "@renderer/components/ui/input";
import {
  searchJobFinderEntries,
  type JobFinderGlobalSearchEntry,
  type JobFinderGlobalSearchKind,
} from "../lib/job-finder-global-search";
import { isImeComposingEvent } from "../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../lib/job-finder-overlay-ownership";

const kindLabels: Record<JobFinderGlobalSearchKind, string> = {
  application: "Applications",
  campaign: "Search plans",
  company: "Companies",
  document: "Resumes",
  job: "Jobs and companies",
  screen: "Go to",
};

export const JOB_FINDER_GLOBAL_SEARCH_LABEL = "Search your workspace";

/**
 * The entries, or a function that builds them. Indexing every saved job took
 * ~50 ms at 12k jobs, so the palette opens first and builds its index once
 * the window is idle or a query needs it, whichever comes first.
 */
export type JobFinderGlobalSearchEntries =
  | readonly JobFinderGlobalSearchEntry[]
  | (() => readonly JobFinderGlobalSearchEntry[]);

function resolveEntries(
  entries: JobFinderGlobalSearchEntries,
): readonly JobFinderGlobalSearchEntry[] {
  return typeof entries === "function" ? entries() : entries;
}

export function JobFinderGlobalSearch(props: {
  campaignId?: string | null;
  entries: JobFinderGlobalSearchEntries;
  onNavigate: (entry: JobFinderGlobalSearchEntry) => void;
  resultsLayout?: "overlay" | "in-flow";
}) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const scopeHelpId = `${inputId}-scope-help`;
  const [query, setQuery] = useState("");
  const [isPopupDismissed, setIsPopupDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const deferredQuery = useDeferredValue(query);
  const isQueryLongEnough = deferredQuery.trim().length >= 2;
  const groups = useMemo(
    () =>
      isQueryLongEnough
        ? searchJobFinderEntries(resolveEntries(props.entries), deferredQuery, {
            ...(props.campaignId !== undefined
              ? { campaignId: props.campaignId }
              : {}),
          })
        : [],
    [deferredQuery, isQueryLongEnough, props.campaignId, props.entries],
  );
  const visibleEntries = useMemo(
    () => groups.flatMap((group) => [...group.entries]),
    [groups],
  );
  const optionElementsRef = useRef<Array<HTMLElement | null>>([]);
  const groupOffsets = useMemo(() => {
    let offset = 0;
    return groups.map((group) => {
      const start = offset;
      offset += group.entries.length;
      return start;
    });
  }, [groups]);
  const resultCount = visibleEntries.length;
  const isPopupOpen = !isPopupDismissed && query.trim().length >= 2;
  const activeOptionId =
    isPopupOpen &&
    activeIndex >= 0 &&
    activeIndex < visibleEntries.length &&
    resultCount > 0
      ? `${inputId}-option-${activeIndex}`
      : undefined;

  // Keyboard-driven highlight moves must bring the active row into view;
  // scrolling follows the option the aria-activedescendant points at.
  useEffect(() => {
    if (!isPopupOpen || activeIndex < 0) {
      return;
    }
    optionElementsRef.current[activeIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [activeIndex, isPopupOpen]);

  function selectEntry(entry: JobFinderGlobalSearchEntry) {
    props.onNavigate(entry);
    setQuery("");
    setActiveIndex(-1);
    setIsPopupDismissed(false);
  }

  function handleQueryChange(nextQuery: string) {
    setQuery(nextQuery.slice(0, 200));
    setActiveIndex(-1);
    setIsPopupDismissed(false);
  }

  function dismissPopup() {
    setIsPopupDismissed(true);
    setActiveIndex(-1);
  }

  function moveActiveOption(nextIndex: number) {
    setActiveIndex(Math.max(0, Math.min(nextIndex, visibleEntries.length - 1)));
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // IME composition owns the keyboard until the candidate string commits;
    // navigation or selection keys must never fire mid-composition.
    if (isImeComposingEvent(event.nativeEvent)) {
      return;
    }
    if (!isPopupOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dismissPopup();
      return;
    }
    if (visibleEntries.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveOption(activeIndex < 0 ? 0 : activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveOption(activeIndex < 0 ? 0 : activeIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveActiveOption(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveActiveOption(visibleEntries.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected =
        activeIndex >= 0 && activeIndex < visibleEntries.length
          ? visibleEntries[activeIndex]
          : visibleEntries[0];
      if (selected) {
        selectEntry(selected);
      }
    }
  }

  return (
    <section
      className="relative grid gap-2"
      aria-labelledby={`${inputId}-label`}
    >
      <label
        className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted"
        htmlFor={inputId}
        id={`${inputId}-label`}
      >
        {JOB_FINDER_GLOBAL_SEARCH_LABEL}
      </label>
      <p className="sr-only" id={scopeHelpId}>
        Everything saved on this device is searchable. Jobs outside the current
        search plan say so in their description.
      </p>
      <Input
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-controls={isPopupOpen && resultCount > 0 ? listboxId : undefined}
        aria-describedby={scopeHelpId}
        aria-expanded={isPopupOpen}
        autoComplete="off"
        id={inputId}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder="Search jobs, applications, plans, resumes, or a screen"
        role="combobox"
        type="search"
        value={query}
      />
      {isPopupOpen ? (
        <div
          className={`surface-panel-shell z-40 mt-2 max-h-[min(32rem,calc(100dvh-14rem))] overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-3 shadow-(--modal-shadow) ${
            props.resultsLayout === "in-flow"
              ? "relative"
              : "absolute left-0 right-0 top-full"
          }`}
          data-job-finder-global-search-results
        >
          <p
            aria-live="polite"
            className="px-2 pb-2 text-xs text-foreground-muted"
            role="status"
          >
            {resultCount} {resultCount === 1 ? "result" : "results"}
          </p>
          {groups.length === 0 ? (
            <p className="rounded-(--radius-field) px-3 py-5 text-center text-sm text-foreground-soft">
              Nothing in your saved jobs, companies, applications, or resumes
              matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            <div
              aria-label="Search results"
              className="grid"
              id={listboxId}
              role="listbox"
            >
              {groups.map((group, groupIndex) => (
                <div
                  aria-label={kindLabels[group.kind]}
                  className="grid gap-1 py-1"
                  key={group.kind}
                  role="group"
                >
                  <p className="px-2 text-xs font-semibold uppercase tracking-(--tracking-label) text-foreground-muted">
                    {kindLabels[group.kind]}
                  </p>
                  {group.entries.map((entry, entryIndex) => {
                    const optionIndex =
                      (groupOffsets[groupIndex] ?? 0) + entryIndex;
                    return (
                      <button
                        aria-selected={optionIndex === activeIndex}
                        className={`grid w-full min-w-0 rounded-(--radius-field) px-3 py-2 text-left hover:bg-(--surface-panel-raised) focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 ${
                          optionIndex === activeIndex
                            ? "bg-(--surface-panel-raised)"
                            : ""
                        }`}
                        id={`${inputId}-option-${optionIndex}`}
                        key={`${entry.kind}:${entry.id}`}
                        onClick={() => selectEntry(entry)}
                        // Options stay pointer-selectable but out of the Tab
                        // order; the combobox input owns keyboard traversal
                        // through aria-activedescendant.
                        tabIndex={-1}
                        role="option"
                        type="button"
                        ref={(element) => {
                          optionElementsRef.current[optionIndex] = element;
                        }}
                      >
                        <strong
                          className="min-w-0 break-words text-sm text-(--text-headline)"
                          title={entry.title}
                        >
                          {entry.title}
                        </strong>
                        <span
                          className="min-w-0 break-words text-xs text-foreground-muted"
                          title={entry.subtitle}
                        >
                          {entry.subtitle}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function getDialogFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true",
  );
}

export function JobFinderGlobalSearchDialog(props: {
  campaignId?: string | null;
  entries: JobFinderGlobalSearchEntries;
  focusRequest: number;
  onClose: () => void;
  onNavigate: (entry: JobFinderGlobalSearchEntry) => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const { isTopmost: isDialogTopmost } = useJobFinderOverlayOwnership({
    active: true,
    close: () => props.onClose(),
  });

  const focusSearchInput = useCallback(() => {
    const input = panelRef.current?.querySelector<HTMLInputElement>("input");
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    const appRoot = document.getElementById("root");
    const previousInert = appRoot?.getAttribute("inert") ?? null;
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    appRoot?.setAttribute("inert", "");
    appRoot?.setAttribute("aria-hidden", "true");
    const frame = requestAnimationFrame(focusSearchInput);
    return () => {
      cancelAnimationFrame(frame);
      if (appRoot) {
        if (previousInert === null) appRoot.removeAttribute("inert");
        else appRoot.setAttribute("inert", previousInert);
        if (previousAriaHidden === null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", previousAriaHidden);
      }
      const elementToRestore = restoreFocusRef.current;
      if (elementToRestore instanceof HTMLElement) {
        elementToRestore.focus({ preventScroll: true });
      }
    };
  }, [focusSearchInput]);

  useEffect(() => {
    const { entries } = props;
    if (typeof entries !== "function") return undefined;
    if (typeof window.requestIdleCallback !== "function") {
      const timer = window.setTimeout(entries, 50);
      return () => window.clearTimeout(timer);
    }
    const handle = window.requestIdleCallback(() => entries(), {
      timeout: 500,
    });
    return () => window.cancelIdleCallback(handle);
  }, [props.entries]);

  useEffect(() => {
    if (props.focusRequest === 0) {
      return;
    }
    const frame = requestAnimationFrame(focusSearchInput);
    return () => cancelAnimationFrame(frame);
  }, [focusSearchInput, props.focusRequest]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key === "Escape") {
        // A surface opened above this dialog owns the first Escape.
        if (!isDialogTopmost()) {
          return;
        }
        event.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDialogTopmost, props.onClose]);

  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") {
      return;
    }
    const focusableElements = Array.from(
      panelRef.current ? getDialogFocusableElements(panelRef.current) : [],
    );
    if (focusableElements.length === 0) {
      return;
    }
    event.preventDefault();
    const currentIndex = focusableElements.findIndex(
      (element) => element === document.activeElement,
    );
    const nextIndex = event.shiftKey
      ? (currentIndex - 1 + focusableElements.length) % focusableElements.length
      : (currentIndex + 1) % focusableElements.length;
    focusableElements[nextIndex]?.focus();
  }

  function handleNavigate(entry: JobFinderGlobalSearchEntry) {
    props.onNavigate(entry);
    props.onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[70]" role="presentation">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-(--modal-scrim) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
        onClick={props.onClose}
      />
      <section
        aria-label={JOB_FINDER_GLOBAL_SEARCH_LABEL}
        aria-modal="true"
        className="absolute inset-x-4 top-16 mx-auto max-h-[calc(100dvh-5rem)] max-w-xl overflow-y-auto rounded-2xl border border-(--surface-panel-border) bg-(--surface-panel-raised) p-3 shadow-(--modal-shadow) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:slide-in-from-top-1 motion-safe:duration-150"
        onKeyDown={handlePanelKeyDown}
        ref={panelRef}
        role="dialog"
      >
        <div className="mb-2 flex justify-end">
          <button
            className="rounded-(--radius-field) px-3 py-2 text-sm font-medium text-foreground-muted hover:bg-(--surface-panel-raised) hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
            onClick={props.onClose}
            type="button"
          >
            Close search
          </button>
        </div>
        <JobFinderGlobalSearch
          {...(props.campaignId !== undefined
            ? { campaignId: props.campaignId }
            : {})}
          entries={props.entries}
          onNavigate={handleNavigate}
          resultsLayout="in-flow"
        />
      </section>
    </div>,
    document.body,
  );
}
