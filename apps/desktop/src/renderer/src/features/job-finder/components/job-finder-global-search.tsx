import { Input } from "@renderer/components/ui/input";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { SearchX, X } from "lucide-react";
import {
  JOB_FINDER_GLOBAL_SEARCH_LABEL,
  searchJobFinderEntries,
  type JobFinderGlobalSearchEntry,
  type JobFinderGlobalSearchKind,
} from "../lib/job-finder-global-search";
import { useJobFinderOverlayOwnership } from "../lib/job-finder-overlay-ownership";
import { isImeComposingEvent } from "../lib/job-finder-shortcuts";

// Re-exported for screens and tests that name the palette.
export { JOB_FINDER_GLOBAL_SEARCH_LABEL };

const kindLabels: Record<JobFinderGlobalSearchKind, string> = {
  application: "Applications",
  job: "Jobs",
  screen: "Go to",
};

/** Finds more entries for a query, such as saved jobs from the job store. */
export type JobFinderGlobalSearchMore = (query: string) => Promise<{
  entries: readonly JobFinderGlobalSearchEntry[];
  /** Part of the search could not be read; `entries` is what came back. */
  incomplete: boolean;
  /** None of it could be read. */
  failed: boolean;
}>;

const RECENT_KEY = "nestor.workspace-search.recent.v1";
const RECENT_MAX = 5;
const entryKey = (entry: JobFinderGlobalSearchEntry) =>
  `${entry.kind}:${entry.id}`;

function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(RECENT_KEY) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(entry: JobFinderGlobalSearchEntry): void {
  try {
    const key = entryKey(entry);
    const next = [key, ...readRecent().filter((item) => item !== key)].slice(
      0,
      RECENT_MAX,
    );
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Without storage there is simply no recent list.
  }
}

export function JobFinderGlobalSearch(props: {
  entries: readonly JobFinderGlobalSearchEntry[];
  onNavigate: (entry: JobFinderGlobalSearchEntry) => void;
  searchMore?: JobFinderGlobalSearchMore;
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
  const [more, setMore] = useState<{
    query: string;
    entries: readonly JobFinderGlobalSearchEntry[];
    incomplete: boolean;
    failed: boolean;
  }>({ query: "", entries: [], incomplete: false, failed: false });
  // Bumped by "Try again" to search the same words again.
  const [attempt, setAttempt] = useState(0);
  const { searchMore } = props;
  useEffect(() => {
    if (!isQueryLongEnough || !searchMore) return undefined;
    let current = true;
    void searchMore(deferredQuery.trim()).then(
      (found) => {
        if (current) setMore({ query: deferredQuery, ...found });
      },
      () => {
        if (current)
          setMore({
            query: deferredQuery,
            entries: [],
            incomplete: true,
            failed: true,
          });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, deferredQuery, isQueryLongEnough, searchMore]);
  const retry = () => {
    setMore((previous) => ({ ...previous, query: "" }));
    setAttempt((count) => count + 1);
  };
  const groups = useMemo(
    () =>
      isQueryLongEnough
        ? searchJobFinderEntries(props.entries, deferredQuery, {
            found: more.query === deferredQuery ? more.entries : [],
          })
        : [],
    [deferredQuery, isQueryLongEnough, more, props.entries],
  );
  // Saved jobs are still being read for what was typed.
  const searching = Boolean(searchMore) && more.query !== deferredQuery;
  const incomplete =
    !searching && more.query === deferredQuery && more.incomplete;
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
  // The first result is highlighted until the person moves, so the row Enter
  // opens is always the one that looks chosen.
  const highlighted =
    resultCount === 0
      ? -1
      : activeIndex < 0
        ? 0
        : Math.min(activeIndex, resultCount - 1);
  const activeOptionId =
    isPopupOpen && highlighted >= 0
      ? `${inputId}-option-${highlighted}`
      : undefined;

  // Keyboard-driven highlight moves must bring the active row into view;
  // scrolling follows the option the aria-activedescendant points at.
  useEffect(() => {
    if (!isPopupOpen || highlighted < 0) {
      return;
    }
    optionElementsRef.current[highlighted]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [highlighted, isPopupOpen]);

  // What was opened from here lately, still in the workspace: shown while
  // nothing is typed, so the empty search is a way back, not a blank box.
  const [recentVersion, setRecentVersion] = useState(0);
  const recent = useMemo(() => {
    const byKey = new Map(
      props.entries.map((entry) => [entryKey(entry), entry]),
    );
    return readRecent()
      .map((key) => byKey.get(key))
      .filter((entry): entry is JobFinderGlobalSearchEntry => Boolean(entry));
  }, [props.entries, recentVersion]);

  function selectEntry(entry: JobFinderGlobalSearchEntry) {
    rememberRecent(entry);
    setRecentVersion((version) => version + 1);
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
      moveActiveOption(highlighted + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveOption(highlighted - 1);
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
      const selected = visibleEntries[highlighted] ?? visibleEntries[0];
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
        className="text-(length:--text-tiny) tracking-(--tracking-label) text-foreground-muted"
        data-title-role="dialog"
        htmlFor={inputId}
        id={`${inputId}-label`}
      >
        {JOB_FINDER_GLOBAL_SEARCH_LABEL}
      </label>
      <p className="sr-only" id={scopeHelpId}>
        Everything saved on this device is searchable.
      </p>
      <Input
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-controls={isPopupOpen && resultCount > 0 ? listboxId : undefined}
        aria-describedby={scopeHelpId}
        aria-expanded={isPopupOpen}
        autoComplete="off"
        // One × in this dialog: its Esc close. The browser's own clear
        // glyph (a heavier ×, an inch from it) is not drawn.
        className="[&::-webkit-search-cancel-button]:appearance-none"
        id={inputId}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder="Search jobs, applications, or a screen"
        role="combobox"
        type="search"
        value={query}
      />
      {!isPopupOpen ? (
        <p className="px-1 text-xs text-foreground-muted">
          Type two or more letters. ↑ ↓ move, Enter opens, Esc closes.
        </p>
      ) : null}
      {!isPopupOpen &&
      props.resultsLayout === "in-flow" &&
      query.trim() === "" &&
      recent.length > 0 ? (
        <section
          aria-label="Recent"
          className="grid gap-1 border-t border-(--surface-panel-border) pt-2"
          data-job-finder-global-search-recent
        >
          <p className="px-2 pt-1 text-xs font-semibold text-foreground-soft">
            Recent
          </p>
          {recent.map((entry) => (
            <button
              className="grid w-full min-w-0 rounded-(--radius-field) px-3 py-2 text-left transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-none focus-ring"
              key={entryKey(entry)}
              onClick={() => selectEntry(entry)}
              type="button"
            >
              <strong className="min-w-0 truncate text-sm text-(--text-headline)">
                {entry.title}
              </strong>
              <span className="min-w-0 truncate text-xs text-foreground-muted">
                {entry.subtitle}
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {isPopupOpen ? (
        <div
          className={
            props.resultsLayout === "in-flow"
              ? // Inside the search dialog the results are the dialog's own
                // body: no second box and shadow inside the first.
                "relative max-h-[min(32rem,calc(100dvh-14rem))] overflow-y-auto border-t border-(--surface-panel-border) pt-2"
              : "surface-panel-shell absolute left-0 right-0 top-full z-40 mt-2 max-h-[min(32rem,calc(100dvh-14rem))] overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-3 shadow-(--modal-shadow)"
          }
          data-job-finder-global-search-results
        >
          <p
            aria-live="polite"
            className="px-2 pb-2 text-xs text-foreground-muted"
            role="status"
          >
            {searching
              ? "Searching your saved jobs…"
              : incomplete && resultCount === 0
                ? null
                : `${resultCount} ${resultCount === 1 ? "result" : "results"}`}
          </p>
          {incomplete ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm text-foreground-soft"
              role="alert"
            >
              <span>
                {more.failed
                  ? "Your saved jobs could not be searched."
                  : more.entries.length > 0
                    ? "Some of your saved jobs could not be searched; these are the ones that could."
                    : "Some of your saved jobs could not be searched, and none of the rest match."}
              </span>
              <button
                className="rounded-(--radius-field) px-2 py-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-ring"
                onClick={retry}
                type="button"
              >
                Try again
              </button>
            </div>
          ) : null}
          {groups.length === 0 && !searching && !incomplete ? (
            <div
              className="grid justify-items-center gap-1 px-3 py-6 text-center"
              data-job-finder-global-search-empty
            >
              <SearchX
                aria-hidden="true"
                className="mb-1 size-5 text-foreground-muted"
              />
              <p className="text-sm font-medium text-(--text-headline)">
                No results for &ldquo;{query.trim()}&rdquo;
              </p>
              <p className="max-w-sm text-(length:--text-small) text-foreground-soft">
                Try a company, a job title, or a screen such as Settings. Hidden
                jobs are searched too.
              </p>
            </div>
          ) : groups.length === 0 ? null : (
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
                  <p
                    className="flex items-center justify-between px-2 pt-1 text-xs font-semibold text-foreground-soft"
                    data-job-finder-global-search-group
                  >
                    {kindLabels[group.kind]}
                    <span className="font-normal tabular-nums text-foreground-muted">
                      {group.entries.length.toLocaleString()}
                    </span>
                  </p>
                  {group.entries.map((entry, entryIndex) => {
                    const optionIndex =
                      (groupOffsets[groupIndex] ?? 0) + entryIndex;
                    return (
                      <button
                        aria-selected={optionIndex === highlighted}
                        className={`grid w-full min-w-0 rounded-(--radius-field) px-3 py-2 text-left transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-none focus-ring ${
                          optionIndex === highlighted
                            ? "bg-accent-tint selected-bar"
                            : ""
                        }`}
                        data-highlighted={
                          optionIndex === highlighted ? "true" : undefined
                        }
                        onMouseMove={() => {
                          if (optionIndex !== highlighted)
                            setActiveIndex(optionIndex);
                        }}
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
  entries: readonly JobFinderGlobalSearchEntry[];
  focusRequest: number;
  onClose: () => void;
  onNavigate: (entry: JobFinderGlobalSearchEntry) => void;
  searchMore?: JobFinderGlobalSearchMore;
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
        className="absolute inset-x-4 top-16 mx-auto max-h-[calc(100dvh-5rem)] max-w-xl overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel-raised) p-3 shadow-(--modal-shadow) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:slide-in-from-top-1 motion-safe:duration-150"
        onKeyDown={handlePanelKeyDown}
        ref={panelRef}
        role="dialog"
      >
        <button
          aria-label="Close search"
          className="absolute right-3 top-2.5 inline-flex h-6 items-center gap-1 rounded-(--radius-small) px-1.5 text-xs text-foreground-muted hover:bg-accent hover:text-foreground focus-visible:outline-none focus-ring"
          onClick={props.onClose}
          title="Close (Esc)"
          type="button"
        >
          <kbd className="font-sans">Esc</kbd>
          <X aria-hidden="true" className="size-3.5" />
        </button>
        <JobFinderGlobalSearch
          entries={props.entries}
          onNavigate={handleNavigate}
          {...(props.searchMore ? { searchMore: props.searchMore } : {})}
          resultsLayout="in-flow"
        />
      </section>
    </div>,
    document.body,
  );
}
