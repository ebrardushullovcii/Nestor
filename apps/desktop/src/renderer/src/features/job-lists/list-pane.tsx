import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import { ListChecks } from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import type { AssistantJobView, AssistantTrackerView } from "@nestor/contracts";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { FitText, reasonLines } from "@renderer/components/ui/fit-text";
import { SelectableRow } from "@renderer/components/ui/selectable-row";
import {
  jobFinderListRegionClassName,
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
  jobFinderListRowTitleLineClassName,
} from "@renderer/features/job-finder/components/list-row";
import {
  LIST_DETAIL_COLUMNS_CLASS,
  TABLE_DETAIL_COLUMNS_CLASS,
} from "@renderer/features/job-finder/components/list-detail-columns";
import { useKeptRouteHidden } from "@renderer/features/job-finder/lib/kept-route-visibility";
import { cn } from "@renderer/lib/cn";

import {
  allLoadedSelected,
  clearSelected,
  isSelected,
  isSelecting,
  NO_SELECTION,
  SELECTING,
  selectAll,
  stepSelectAll,
  type ListSelection,
} from "./list-selection";
import { ListReadError } from "./list-read-error";
import { DetailSheetForcedContext } from "./sheet-mode";
import { modShortcut } from "./platform-keys";

/** "Employer · Place · Mode", then without its last parts, down to the employer. */
function metaLines(meta: string): string[] {
  const parts = meta.split(" · ");
  return parts.map((_, index) =>
    parts.slice(0, parts.length - index).join(" · "),
  );
}

/** The meta's room on a row's second line: at most half of it. */
function halfTheLine(box: HTMLElement): number {
  return (box.parentElement?.clientWidth ?? 0) / 2;
}

/**
 * "Select all"'s room: the bar's free region (it grows from nothing, so its
 * width never depends on the label in it), less the button's padding and
 * border. Not the button: the button is as wide as the label it holds.
 */
function selectAllRegion(box: HTMLElement): HTMLElement | null {
  return box.closest<HTMLElement>("[data-select-all-room]");
}
function selectAllRoom(box: HTMLElement): number {
  const region = selectAllRegion(box);
  return region ? region.clientWidth - 18 : 0;
}
function watchSelectAllRoom(box: HTMLElement) {
  return [selectAllRegion(box)];
}

/** The id the list rows point at, so assistive tech knows where details go. */
export const LIST_DETAIL_REGION_ID = "list-detail";

/**
 * Whether lists and their details stack right now: the `stacked` variant in
 * styles/globals.css, read in script (below 1024px, or below 1280px while
 * the assistant is docked).
 */
export function isStackedLayout(): boolean {
  // In rem of the root font, as the variant's container query measures it:
  // larger text stacks the panes as a narrower window would.
  const rootPx =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const width = (document.body?.clientWidth || window.innerWidth) / rootPx;
  if (width < 64) return true;
  return (
    width < 80 &&
    document.documentElement.getAttribute("data-assistant-sidebar") === "docked"
  );
}

/**
 * The one list and details layout: the list on the left, the selected row's
 * details on the right wherever there is room (the `split` variant: from
 * 1024px, or 1280px beside a docked assistant), stacked otherwise. Every
 * list screen uses it; `table` gives the list most of the width.
 *
 * With `sheet`, a stacked layout never scrolls the page: the list keeps the
 * whole height and the details open as a sheet over it (`sheet.open`), so
 * the list underneath keeps its place and its open row.
 */
export function ListDetailLayout(props: {
  list: ReactNode;
  detail: ReactNode;
  table?: boolean;
  state?: AssistantJobView;
  applicationState?: AssistantTrackerView;
  /**
   * `onClose` puts the sheet away: Escape inside it, and the layout leaving
   * sheet mode (a wider window, the assistant undocked, details that fit
   * beside the list again).
   */
  sheet?: { open: boolean; onClose?: () => void };
  /** The split's columns, instead of the shared list-and-details split. */
  columnsClassName?: string;
  /**
   * The details need more width than the split can give at this size: the
   * list takes the whole width and the details open as a sheet over it, as
   * they do where the layout stacks. Needs `sheet`.
   */
  sheetAlways?: boolean;
  /** The layout's own box, for a screen that measures its width. */
  rootRef?: Ref<HTMLDivElement>;
  /** Custom properties the columns read (`--reading-list`). */
  rootStyle?: CSSProperties;
  /**
   * An always-sheet opened beside the docked assistant spans the chat's
   * width too (the chat comes back on Back), for details that cannot be
   * read in the main column alone (a resume page at 1024).
   */
  sheetOverAssistant?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const keptHidden = useKeptRouteHidden();
  const overAssistant = useSheetOverAssistant({
    enabled:
      (props.sheetOverAssistant ?? false) &&
      (props.sheetAlways ?? false) &&
      (props.sheet?.open ?? false) &&
      !keptHidden,
    panelRef,
  });
  useSheetFocus({
    open: props.sheet?.open ?? false,
    always: props.sheetAlways ?? false,
    onClose: props.sheet?.onClose,
    listRef,
    panelRef,
  });
  const columns =
    props.columnsClassName ??
    (props.table ? TABLE_DETAIL_COLUMNS_CLASS : LIST_DETAIL_COLUMNS_CLASS);
  if (props.sheet) {
    const always = props.sheetAlways ?? false;
    return (
      <DetailSheetForcedContext.Provider value={always}>
        <div
          className={cn(
            "relative grid min-h-72 flex-1 grid-rows-[minmax(0,1fr)] gap-4 split:h-full",
            always ? "h-full grid-cols-[minmax(0,1fr)]" : columns,
          )}
          data-application-list-state={
            props.applicationState
              ? JSON.stringify(props.applicationState)
              : undefined
          }
          data-detail-sheet={props.sheet.open ? "open" : "closed"}
          data-detail-sheet-always={always ? "" : undefined}
          data-job-list-state={
            props.state ? JSON.stringify(props.state) : undefined
          }
          ref={props.rootRef}
          style={props.rootStyle}
        >
          {/* `contents`: the list stays the grid's own column; the wrapper
              only carries `inert` while a sheet covers it. */}
          <div className="contents" data-detail-sheet-list ref={listRef}>
            {props.list}
          </div>
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-col",
              always
                ? props.sheet.open
                  ? "absolute inset-0 z-20 overflow-hidden rounded-(--radius-panel) bg-(--background) shadow-lg"
                  : "hidden"
                : props.sheet.open
                  ? "stacked:absolute stacked:inset-0 stacked:z-20 stacked:overflow-hidden stacked:rounded-(--radius-panel) stacked:bg-(--background) stacked:shadow-lg"
                  : "stacked:hidden",
              // No details to show (nothing to pick yet): no column for them.
              props.detail === null && "hidden",
            )}
            data-detail-sheet-panel
            data-detail-sheet-over-assistant={overAssistant ? "" : undefined}
            ref={panelRef}
            style={overAssistant ?? undefined}
          >
            {props.detail}
          </div>
        </div>
      </DetailSheetForcedContext.Provider>
    );
  }
  return (
    <div
      data-application-list-state={
        props.applicationState
          ? JSON.stringify(props.applicationState)
          : undefined
      }
      data-job-list-state={
        props.state ? JSON.stringify(props.state) : undefined
      }
      className={cn(
        "grid min-h-0 flex-1 gap-4 split:h-full split:grid-rows-[minmax(0,1fr)]",
        columns,
      )}
      ref={props.rootRef}
      style={props.rootStyle}
    >
      {props.list}
      {props.detail}
    </div>
  );
}

/** Whether a details panel lies over its list right now (sheet mode). */
export function sheetCoversList(panel: HTMLElement): boolean {
  const { position } = getComputedStyle(panel);
  return position === "absolute" || position === "fixed";
}

/** The sheet's distance from the window's right edge when it spans the chat. */
const SHEET_OVER_ASSISTANT_GUTTER = 16;

/**
 * While `enabled` and the assistant is docked, the sheet's box: the layout's
 * own top, left and height, reaching across the chat to the window's right
 * gutter. `<html data-reading-over-assistant>` hides the chat panel under it
 * (styles/globals.css), so nothing behind the sheet takes Tab or a click.
 * The person docking, undocking or reopening the assistant while the sheet
 * is open is a request to see it: the sheet goes back to the main column.
 */
function useSheetOverAssistant(props: {
  enabled: boolean;
  panelRef: { current: HTMLDivElement | null };
}): CSSProperties | null {
  const { enabled, panelRef } = props;
  const [box, setBox] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const html = document.documentElement;
    const root = panelRef.current?.parentElement;
    if (!enabled || !root) {
      setBox(null);
      return undefined;
    }
    const docked = () =>
      html.getAttribute("data-assistant-sidebar") === "docked";
    if (!docked()) {
      setBox(null);
      return undefined;
    }
    const measure = () => {
      const rect = root.getBoundingClientRect();
      setBox({
        position: "fixed",
        left: rect.left,
        top: rect.top,
        height: rect.height,
        width: Math.max(
          rect.width,
          window.innerWidth - rect.left - SHEET_OVER_ASSISTANT_GUTTER,
        ),
        zIndex: 30,
      });
    };
    measure();
    html.setAttribute("data-reading-over-assistant", "");
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      html.removeAttribute("data-reading-over-assistant");
      setBox(null);
    };
    const changes = new MutationObserver(release);
    changes.observe(html, {
      attributeFilter: ["data-assistant-sidebar"],
      attributes: true,
    });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!released) measure();
          });
    resize?.observe(root);
    const onResize = () => {
      if (!released) measure();
    };
    window.addEventListener("resize", onResize);
    return () => {
      changes.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", onResize);
      html.removeAttribute("data-reading-over-assistant");
    };
  }, [enabled, panelRef]);
  return box;
}

/** Whether `node` is drawn: neither it nor an ancestor up to `root` is `display: none`. */
function isDrawn(node: Element, root: Element): boolean {
  if (!root.isConnected) return false;
  for (let at: Element | null = node; at; at = at.parentElement) {
    if (getComputedStyle(at).display === "none") return false;
    if (at === root) return true;
  }
  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * While a details sheet covers the list (stacked, or a screen that reads its
 * details in a sheet), the list is inert, so Tab and a screen reader cannot
 * wander into rows nobody can see, and focus moves into the sheet (its Back
 * button). Escape anywhere in the sheet puts it away (a field leaves the
 * field first, an open menu closes first). When the sheet goes away, focus
 * returns to the open row, which is still chosen and in view.
 *
 * The layout can leave sheet mode with the sheet still open: the window
 * widens, the assistant undocks, the screen's details fit beside the list
 * again. The details then sit beside the list, so the sheet is put away and
 * the list takes clicks again (it stayed inert, and its rows could not be
 * clicked); focus stays where it was, in details that are still shown.
 */
function useSheetFocus(props: {
  open: boolean;
  always: boolean;
  onClose: (() => void) | undefined;
  listRef: { current: HTMLDivElement | null };
  panelRef: { current: HTMLDivElement | null };
}) {
  const { open, always, listRef, panelRef } = props;
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  // Set when the sheet goes away with focus in it (see below).
  const returnFocus = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const panel = panelRef.current;
    if (!open || !list || !panel) return undefined;
    let covering = false;
    // Whether focus belongs in the sheet: it was put there (or there was
    // nothing to put it on yet) and the person has not moved it elsewhere.
    let holding = false;
    const sheetTarget = () =>
      panel.querySelector<HTMLElement>("[data-detail-sheet-back] button") ??
      panel.querySelector<HTMLElement>(
        "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
    const sync = () => {
      const now = sheetCoversList(panel);
      list.inert = now;
      if (!now) {
        // `covering` stays as it was, so the cleanup hands focus on.
        onClose.current?.();
        return;
      }
      if (!covering && !panel.contains(document.activeElement)) {
        holding = true;
        sheetTarget()?.focus({ preventScroll: true });
      }
      covering = true;
    };
    sync();
    // The sheet's contents can change under focus: a loading pane (no Back
    // yet, or its own Back) gives way to the details, which brings a new
    // Back. Focus that fell to the page with it goes to the new Back, so
    // opening a sheet always ends on "Back to the list", never on body.
    const onFocusIn = (event: FocusEvent) => {
      holding = event.target instanceof Node && panel.contains(event.target);
    };
    document.addEventListener("focusin", onFocusIn, true);
    const contents = new MutationObserver(() => {
      if (!covering || !holding) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body) return;
      sheetTarget()?.focus({ preventScroll: true });
    });
    contents.observe(panel, { childList: true, subtree: true });
    // Capture, so the list's own Escape (leave select mode) waits its turn.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !covering) return;
      const target = event.target;
      const loose =
        target === null ||
        target === document.body ||
        target === document.documentElement;
      // Only this sheet's own Escape: a kept screen's sheet hidden behind
      // another screen, or the docked assistant, is left alone.
      if (
        loose
          ? panel.getClientRects().length === 0
          : !(target instanceof Node && panel.contains(target))
      )
        return;
      if (isTypingTarget(target)) return;
      if (
        target instanceof HTMLElement &&
        (target.closest("[role='menu'], [role='listbox'], [role='menubar']") ||
          target.getAttribute("aria-expanded") === "true")
      )
        return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", sync);
    // Docking the assistant changes the layout without resizing the window.
    const docking = new MutationObserver(sync);
    docking.observe(document.documentElement, {
      attributeFilter: ["data-assistant-sidebar"],
      attributes: true,
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", sync);
      document.removeEventListener("focusin", onFocusIn, true);
      contents.disconnect();
      docking.disconnect();
      list.inert = false;
      if (!covering) return;
      const focused = document.activeElement;
      // Focus on a control that went with the sheet (its Back button, or
      // the whole sheet) returns to the open row; details still shown
      // beside the list keep it.
      const lost =
        focused === null ||
        focused === document.body ||
        (panel.contains(focused) && !isDrawn(focused, panel));
      if (lost || (panel.contains(focused) && sheetCoversList(panel)))
        returnFocus.current = true;
    };
  }, [open, always, listRef, panelRef]);
  // After the commit: React puts focus back where it was before a commit's
  // DOM changes, which undid focus moved in the cleanup above.
  useLayoutEffect(() => {
    if (!returnFocus.current) return;
    returnFocus.current = false;
    listRef.current
      ?.querySelector<HTMLElement>(
        "[data-list-row-id] [aria-controls][tabindex='0']",
      )
      ?.focus({ preventScroll: true });
  });
}

/**
 * Whether the list around a row is in select mode, read when a row is
 * pressed. A stable getter, so entering the mode re-renders no row: the tick
 * boxes and the room for them come from the pane's `data-selecting`.
 */
const ListModeContext = createContext<{ isSelecting: () => boolean }>({
  isSelecting: () => false,
});

/**
 * What pressing a row does. Outside select mode a press opens the row;
 * Shift (a range) or Cmd/Ctrl ticks it instead and starts select mode. In
 * select mode every press only ticks: the open row, its details (or the
 * sheet over the list) and keyboard focus stay where they are, so ticking
 * ten rows never replaces what the person is reading ten times. J/K still
 * move the open row, and Done (or Escape) goes back to opening on a press.
 */
export function useRowPress(
  id: number,
  onActivate: (id: number) => void,
  onToggle: (id: number, shiftKey: boolean) => void,
) {
  const mode = useContext(ListModeContext);
  const ticks = (event: MouseEvent) =>
    event.shiftKey || event.metaKey || event.ctrlKey || mode.isSelecting();
  return {
    // A ticking press keeps focus where it was (and Shift+click would
    // otherwise select the text between two rows).
    onMouseDown: (event: MouseEvent) => {
      if (ticks(event)) event.preventDefault();
    },
    onClick: (event: MouseEvent) => {
      if (ticks(event)) onToggle(id, event.shiftKey);
      else onActivate(id);
    },
  };
}

/**
 * A row's left padding: 16px, and 44px in select mode so the tick box has
 * the row's leading slot. The text moves once, over 160ms, when the mode
 * starts or ends; never when a row is ticked.
 */
export const LIST_ROW_SELECT_PAD_CLASS =
  "transition-[background-color,box-shadow,padding-left] duration-(--duration-base) ease-(--ease-standard) group-data-[selecting=true]/list:pl-11";

/**
 * A row's tick box, in the leading slot it gets in select mode. Hidden (and
 * out of reach) outside the mode; its whole 44px strip is the click target.
 * It sits above the row (z-20), which rises to z-10 when focused, so the open
 * row's tint never covers its own box.
 */
export function ListRowCheck(props: {
  id: number;
  label: string;
  checked: boolean;
  onToggle: (id: number, shiftKey: boolean) => void;
  align?: "top" | "center";
}) {
  return (
    <div
      className={cn(
        "invisible absolute inset-y-0 left-0 z-20 flex w-11 cursor-pointer justify-center opacity-0 transition-[opacity,visibility] duration-(--duration-base) ease-(--ease-standard) group-data-[selecting=true]/list:visible group-data-[selecting=true]/list:opacity-100",
        props.align === "center" ? "items-center" : "items-start pt-4",
      )}
      data-list-row-check
      onClick={(event) => {
        if (event.target === event.currentTarget)
          props.onToggle(props.id, event.shiftKey);
      }}
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
    >
      <Checkbox
        aria-label={`Select ${props.label}`}
        checked={props.checked}
        onClick={(event) => {
          event.preventDefault();
          props.onToggle(props.id, event.shiftKey);
        }}
        // X and Space tick the open row; fifty boxes in the tab order would
        // bury the toolbar.
        tabIndex={-1}
      />
    </div>
  );
}

/**
 * One row: title (with one badge slot), meta and status lines. Selection
 * never changes the row's size, and an empty meta or status line keeps its
 * height, so every row of a windowed list is the same height. A list that
 * passes neither `status` nor `trailing` draws two lines: title and meta.
 */
export const ListRowFrame = memo(function ListRowFrame(
  props: ListRowState & {
    id: number;
    title: string;
    onActivate: (id: number) => void;
    onToggle: (id: number, shiftKey: boolean) => void;
    /** Trailing on the title line: a score, a status badge. */
    badge?: ReactNode;
    /** Before the title, decorative: a job site's own icon. */
    titleLead?: ReactNode;
    /** Under the title: employer, place. */
    meta: string;
    /**
     * After the meta on the same line: why it fits. It keeps at least half
     * the line, so a long employer and place never push the reason out;
     * the place gives way first.
     */
    metaReason?: string | undefined;
    /** The reason in a few words, for a narrow row (a job's `fitShort`). */
    metaReasonShort?: string | null | undefined;
    /** Right end of the meta line, quiet: an age. */
    metaTrailing?: ReactNode;
    /** Third line: why it fits, what it is waiting on. */
    status?: ReactNode;
    /** Right end of the third line: dates, sources. */
    trailing?: ReactNode;
    /**
     * What the row's badge, status and trailing say, in words, for its
     * accessible name (they may be marks or elements). The name is built
     * from these and the title, meta and reason, never read off the drawn
     * text, so it is the same at every width and in select mode.
     */
    nameParts?: {
      badge?: string | null | undefined;
      status?: string | null | undefined;
      trailing?: string | null | undefined;
    };
  },
) {
  const press = useRowPress(props.id, props.onActivate, props.onToggle);
  const name = rowName({
    title: props.title,
    badge: props.nameParts?.badge,
    meta: props.meta,
    reason: props.metaReason,
    status:
      props.nameParts?.status ??
      (typeof props.status === "string" ? props.status : null),
    trailing:
      props.nameParts?.trailing ??
      (typeof props.trailing === "string" ? props.trailing : null),
  });
  return (
    <li
      className={cn(
        "relative min-w-0",
        // A windowed list draws only nearby rows already. Skipped rendering
        // there made the rows above the view report the 92px placeholder
        // instead of their own height.
        props.index === undefined &&
          "[contain-intrinsic-size:auto_92px] [content-visibility:auto]",
      )}
      data-list-row-id={props.id}
      {...listRowPlacement(props)}
    >
      <ListRowCheck
        checked={props.checked}
        id={props.id}
        label={props.title}
        onToggle={props.onToggle}
      />
      <SelectableRow
        aria-controls={LIST_DETAIL_REGION_ID}
        aria-label={name}
        className={cn(jobFinderListRowClassName, LIST_ROW_SELECT_PAD_CLASS)}
        onClick={press.onClick}
        onMouseDown={press.onMouseDown}
        selected={props.active}
        checked={props.checked}
        tabIndex={props.active ? 0 : -1}
      >
        <div className={cn(jobFinderListRowLinesClassName, "@container/row")}>
          <div className={jobFinderListRowTitleLineClassName}>
            {props.titleLead ? (
              <span className="flex min-w-0 items-center gap-2">
                {props.titleLead}
                <strong
                  className={jobFinderListRowTitleClassName}
                  title={props.title}
                >
                  {props.title}
                </strong>
              </span>
            ) : (
              <strong
                className={jobFinderListRowTitleClassName}
                title={props.title}
              >
                {props.title}
              </strong>
            )}
            {props.badge ? (
              <div className={jobFinderListRowBadgeSlotClassName}>
                {props.badge}
              </div>
            ) : null}
          </div>
          {props.metaReason ? (
            <div className="flex min-h-[1lh] min-w-0 items-baseline gap-3 text-(length:--text-small)">
              <span
                className="flex min-w-0 flex-1 items-baseline"
                title={`${props.meta} · ${props.metaReason}`}
              >
                {/* Both halves end on a word, never mid-word: the place
                    gives way first (employer · place, then the employer
                    alone, within half the line), and the reason keeps
                    the rest: whole, its short form, or cut after a word
                    with "…" (never a clause passed off as the whole). */}
                <FitText
                  boxClassName="max-w-1/2 shrink-0"
                  candidates={metaLines(props.meta)}
                  className={jobFinderListRowMetaClassName}
                  room={halfTheLine}
                  title={null}
                />
                <span
                  aria-hidden="true"
                  className="shrink-0 px-1 text-foreground-soft"
                >
                  ·
                </span>
                <FitText
                  candidates={reasonLines(
                    props.metaReason,
                    props.metaReasonShort,
                  )}
                  className={jobFinderListRowMetaClassName}
                  title={null}
                />
              </span>
              {props.metaTrailing}
            </div>
          ) : props.metaTrailing ? (
            <div className="flex min-h-[1lh] min-w-0 items-baseline gap-3 text-(length:--text-small)">
              <span
                className={cn(jobFinderListRowMetaClassName, "flex-1")}
                title={props.meta}
              >
                {props.meta}
              </span>
              {props.metaTrailing}
            </div>
          ) : (
            <span
              className={cn(jobFinderListRowMetaClassName, "min-h-[1lh]")}
              title={props.meta}
            >
              {props.meta}
            </span>
          )}
          {props.status !== undefined || props.trailing !== undefined ? (
            <div className="flex min-h-5 min-w-0 items-baseline gap-3 leading-5">
              <span
                className={cn(
                  jobFinderListRowStatusClassName,
                  "flex-1 text-foreground-soft",
                )}
              >
                {props.status}
              </span>
              {props.trailing ? (
                <span className="shrink-0 text-(length:--text-small) text-foreground-soft">
                  {props.trailing}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </SelectableRow>
    </li>
  );
});

/**
 * A row's accessible name from its data, parts joined by ", ": "Senior
 * Frontend Engineer, 92, Strong fit, Pine Ledger Co, Berlin, Remote, Strong
 * React and TypeScript match, today". The meta's "·" separators become
 * commas; nothing drawn (a cut place, a hidden age) changes it.
 */
export function rowName(parts: {
  title: string;
  badge?: string | null | undefined;
  meta?: string | null | undefined;
  reason?: string | null | undefined;
  status?: string | null | undefined;
  trailing?: string | null | undefined;
}): string {
  return (
    [
      parts.title,
      parts.badge,
      ...(parts.meta ?? "").split(/\s*·\s*/u),
      parts.reason,
      parts.status,
      parts.trailing,
    ]
      // A part's own closing full stop would read ".," before the next one.
      .map((part) => part?.trim().replace(/\.+$/u, ""))
      .filter(Boolean)
      .join(", ")
  );
}

const SKELETON_WIDTHS = [
  ["w-3/5", "w-2/5", "w-3/4"],
  ["w-1/2", "w-1/3", "w-2/3"],
  ["w-2/3", "w-2/5", "w-1/2"],
  ["w-2/5", "w-1/4", "w-3/5"],
] as const;

/**
 * A loading row laid out line for line like `ListRowFrame`: the same box,
 * padding, divider and line heights, so the rows that replace it land
 * exactly where it was.
 */
export function ListRowSkeleton(props: { index: number; lines?: 2 | 3 }) {
  const [title, meta, status] =
    SKELETON_WIDTHS[props.index % SKELETON_WIDTHS.length]!;
  const lines = props.lines ?? 3;
  return (
    <li aria-hidden="true" className="min-w-0" data-list-row-skeleton>
      <div
        className={cn(
          jobFinderListRowClassName,
          "border-solid group-data-[selecting=true]/list:pl-11",
        )}
      >
        <div className={jobFinderListRowLinesClassName}>
          <div className={jobFinderListRowTitleLineClassName}>
            <div className="flex min-h-[1lh] min-w-0 flex-1 items-center text-(length:--text-heading-3)">
              <span className={cn("skeleton block h-[0.75em]", title)} />
            </div>
            <span className="skeleton block h-5 w-16 shrink-0 self-center" />
          </div>
          <div className="flex min-h-[1lh] items-center text-(length:--text-small)">
            <span
              className={cn(
                "skeleton block h-[0.8em]",
                lines === 2 ? status : meta,
              )}
            />
          </div>
          {lines === 3 ? (
            <div className="flex min-h-5 items-center gap-3 leading-5">
              <span className={cn("skeleton block h-3", status)} />
              <span className="skeleton ml-auto block h-3 w-20" />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export interface ListRowState {
  active: boolean;
  checked: boolean;
  /** In a windowed list: the row's place, its offset and the list's size. */
  index?: number | undefined;
  top?: number | undefined;
  setSize?: number | undefined;
  /** A row that just left the list, drawn while it fades and collapses. */
  exiting?: boolean | undefined;
  /**
   * In a windowed list, just after rows left or came back: where this row
   * was drawn before (it slides from there to its place), or that it is new
   * at its place (it fades in once the rows around it have moved).
   */
  motion?: RowMotionState | undefined;
}

/** How one row of a windowed list moves when rows leave or come back. */
export type RowMotionState =
  | { kind: "move"; from: number; generation: number }
  | { kind: "enter" };

/**
 * Where a row of a windowed list sits: placed at its offset, and numbered for
 * assistive tech, which sees only the rows in the window. Nothing for a list
 * that renders every row. A leaving row is marked so it fades out unseen by
 * assistive tech.
 */
export function listRowPlacement(state: ListRowState): {
  style?: CSSProperties;
  "aria-posinset"?: number;
  "aria-setsize"?: number | undefined;
  "aria-hidden"?: true;
  "data-exiting"?: "";
  "data-row-moving"?: "a" | "b";
  "data-row-entering"?: "";
} {
  const exiting = state.exiting
    ? ({ "aria-hidden": true, "data-exiting": "" } as const)
    : {};
  if (state.index === undefined || state.top === undefined) return exiting;
  const motion = state.motion;
  return {
    ...exiting,
    ...(motion?.kind === "move"
      ? // Two names, so a second change restarts the slide.
        { "data-row-moving": motion.generation % 2 === 0 ? "a" : "b" }
      : motion?.kind === "enter"
        ? { "data-row-entering": "" }
        : {}),
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      transform: `translateY(${state.top}px)`,
      ...(motion?.kind === "move"
        ? ({ "--row-from": `${motion.from}px` } as CSSProperties)
        : {}),
    },
    ...(state.exiting
      ? {}
      : { "aria-posinset": state.index + 1, "aria-setsize": state.setSize }),
  };
}

/** A row's height before the first one is measured. */
const ROW_HEIGHT = 92;
/** Rows drawn past each end of the window. */
const OVERSCAN = 6;
/** Skeleton rows while a list loads: enough to fill a tall pane. */
const SKELETON_ROWS = 8;
/** How long a leaving row stays drawn: the 160ms exit plus a frame. */
const EXIT_MS = 200;
/** More rows than this leaving at once just go. */
const MAX_EXITING = 40;

interface ExitingRow<Row> {
  row: Row;
  /** Its place in the rows before it left. */
  index: number;
  /** Its offset in a windowed list, when it was drawn. */
  top: number | undefined;
}

/**
 * Rows that just left the list (hidden, shortlisted, approved), kept for one
 * short fade while the rows below close the gap. A new list (loading) or a
 * row that was never drawn just goes.
 */
function useExitingRows<Row extends { id: number }>(
  rows: readonly Row[],
  loading: boolean,
  windowed: boolean,
  drawnTops: { current: ReadonlyMap<number, number> },
  listKey: string,
): ExitingRow<Row>[] {
  const [state, setState] = useState<{
    rows: readonly Row[];
    exiting: ExitingRow<Row>[];
    listKey: string;
  }>({ rows, exiting: [], listKey });
  if (state.listKey !== listKey) {
    // Another list (a tab, a filter): its rows did not leave this one, and
    // its empty state shows at once (a To review row never fades out over
    // an empty Approved list).
    setState({ rows, exiting: [], listKey });
  } else if (state.rows !== rows) {
    const still = new Set(rows.map((row) => row.id));
    const left = loading
      ? []
      : state.rows.flatMap((row, index) => {
          if (still.has(row.id)) return [];
          const top = drawnTops.current.get(row.id);
          if (windowed && top === undefined) return [];
          return [{ row, index, top }];
        });
    const kept = state.exiting.filter((entry) => !still.has(entry.row.id));
    setState({
      rows,
      listKey,
      exiting:
        left.length > 0 && left.length <= MAX_EXITING
          ? [...kept, ...left]
          : // The same leaving rows keep the same array, so a refresh
            // while they fade does not restart their timer (rows that
            // refresh faster than the fade would never leave).
            kept.length === state.exiting.length
            ? state.exiting
            : kept,
    });
  }
  const { exiting } = state;
  useEffect(() => {
    if (exiting.length === 0) return undefined;
    const timer = window.setTimeout(
      () => setState((current) => ({ ...current, exiting: [] })),
      EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exiting]);
  return exiting;
}

/**
 * How the rows of a windowed list move when some leave (Hide, Shortlist,
 * Approve) or come back (Undo). A windowed row is placed at an offset, so a
 * leaving row cannot fold away in the flow: drawn at its old offset it
 * printed over the row sliding into that place, and a returning row printed
 * over the row still sliding out of its place. Instead the leaving row is
 * not drawn, every row that stays slides from where it was to its new
 * place (they keep their order, so no two ever share a slot), and a row
 * that comes back fades in only once the rows around it have moved.
 * Nothing moves for a new list, more rows arriving at the end, a re-sort or
 * a change of more than `MAX_EXITING` rows.
 */
function useRowMotion<Row extends { id: number }>(
  rows: readonly Row[],
  loading: boolean,
  windowed: boolean,
  drawnTops: { current: ReadonlyMap<number, number> },
  rowHeight: number,
  listKey: string,
): ReadonlyMap<number, RowMotionState> {
  const [state, setState] = useState<{
    rows: readonly Row[];
    motion: ReadonlyMap<number, RowMotionState>;
    generation: number;
    listKey: string;
  }>({ rows, motion: new Map(), generation: 0, listKey });
  if (state.listKey !== listKey) {
    // Another list: nothing moves, it is simply shown.
    setState({
      rows,
      motion: new Map(),
      generation: state.generation + 1,
      listKey,
    });
  } else if (state.rows !== rows) {
    const before = new Map(state.rows.map((row, index) => [row.id, index]));
    const still = new Set(rows.map((row) => row.id));
    const left = state.rows.filter((row) => !still.has(row.id)).length;
    const returned = rows.filter(
      (row, index) => !before.has(row.id) && index < state.rows.length,
    ).length;
    const generation = state.generation + 1;
    const motion = new Map<number, RowMotionState>();
    let ordered = true;
    let last = -1;
    for (const row of rows) {
      const was = before.get(row.id);
      if (was === undefined) continue;
      if (was < last) ordered = false;
      last = was;
    }
    if (
      windowed &&
      !loading &&
      ordered &&
      (left > 0 || returned > 0) &&
      left <= MAX_EXITING &&
      returned <= MAX_EXITING
    )
      rows.forEach((row, index) => {
        const was = before.get(row.id);
        if (was === undefined) {
          if (index < state.rows.length) motion.set(row.id, { kind: "enter" });
          return;
        }
        if (was === index) return;
        motion.set(row.id, {
          kind: "move",
          from: drawnTops.current.get(row.id) ?? was * rowHeight,
          generation,
        });
      });
    setState({
      rows,
      // Still nothing moving: the same empty map, so nothing re-renders.
      motion:
        motion.size === 0 && state.motion.size === 0 ? state.motion : motion,
      generation,
      listKey,
    });
  }
  const { motion } = state;
  useEffect(() => {
    if (motion.size === 0) return undefined;
    // The slide, then the fade-in after it, then a frame.
    const timer = window.setTimeout(
      () => setState((current) => ({ ...current, motion: new Map() })),
      EXIT_MS * 2,
    );
    return () => window.clearTimeout(timer);
  }, [motion]);
  return motion;
}

/**
 * The list half of a list screen. Its header has two rows of fixed height:
 * the list's own tools (filter, sort), which stay put in every mode, and a
 * status row that shows the count and a Select button, or, in select mode,
 * the tri-state box, "N selected", "Select all N matching", the list's bulk
 * actions, Clear and Done. Then the rows (or skeleton rows while they load),
 * and more rows as the person scrolls to the end. Rows render through
 * `renderRow`, usually as a `ListRowFrame`.
 */
export function ListPane<Row extends { id: number }>(props: {
  label: string;
  /**
   * Which list this is (its tab and filter): rows of another list never
   * fade out of it. The label by default.
   */
  listKey?: string;
  rows: readonly Row[];
  /** How many rows match; exact once a capped count is read. */
  total: number;
  totalCapped: boolean;
  loading: boolean;
  /**
   * Rows are on their way although none are here yet (a first search is
   * running): skeleton rows instead of the empty message.
   */
  pending?: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onVisibleRows?: (rows: readonly Row[]) => void;
  activeId: number | null;
  selection: ListSelection;
  onSelectionChange: Dispatch<SetStateAction<ListSelection>>;
  selectedCount: number;
  /** "Select all" on a capped list while its exact count is read. */
  counting?: boolean;
  /**
   * Instead of "N selected", when the count could not be read ("Couldn't
   * count"): the bar never states a number the work would not match.
   */
  countText?: string | undefined;
  renderRow: (row: Row, state: ListRowState) => ReactNode;
  /** A loading row shaped like this list's rows; `ListRowSkeleton` by default. */
  renderSkeletonRow?: (index: number) => ReactNode;
  /** Filter, sort and other tools; shown in every mode. */
  toolbar?: ReactNode;
  /** The status row outside select mode; "N jobs" by default. */
  summary?: ReactNode;
  /** The list's bulk actions in select mode, main one first. */
  bulkActions?: ReactNode;
  empty: ReactNode;
  /**
   * The last read failed: the full error state with no rows, a one-line
   * warning above rows already shown. Both offer `onRetry`.
   */
  error?: string | null;
  onRetry?: () => void;
  /** Below the rows (or the empty message): a group that is not selectable. */
  footer?: ReactNode;
  /**
   * Under the last row of a whole list with no footer: one quiet line on
   * what fills it next, so a short list ends on purpose, not in blank pane.
   */
  endNote?: ReactNode;
  /** Singular noun for the rows, e.g. "job". */
  noun?: string;
  /** Stacked, the list takes the full height (its details open as a sheet). */
  fillStacked?: boolean;
  /**
   * Draw only the rows in view (plus the open one), so a list of thousands
   * costs what a list of twenty does. Rows must share one height and place
   * themselves with `listRowPlacement`.
   */
  windowed?: boolean;
}) {
  const noun = props.noun ?? "job";
  const sentinel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { onLoadMore, hasMore, rows } = props;
  const windowed = props.windowed ?? false;
  const selecting = isSelecting(props.selection);
  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;
  const mode = useMemo(() => ({ isSelecting: () => selectingRef.current }), []);

  // Rows share one height (each line is cut to one line), taken from the
  // tallest row drawn, so a denser list or a larger font still lines up. It
  // only grows until the window or text size changes. Taking it from the
  // first drawn row flipped it between a shorter and a taller row while
  // scrolling; each flip laid the list out again until React stopped the
  // loop (error #185), and rows taller than the measured one overlapped.
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT);
  const measured = useRef(0);
  const [, remeasure] = useState(0);
  useEffect(() => {
    if (!windowed) return undefined;
    const reset = () => {
      measured.current = 0;
      remeasure((n) => n + 1);
    };
    window.addEventListener("resize", reset);
    // The list's own width changes without the window's too: the assistant
    // docks beside it, or a kept list is shown again. Rows measured at
    // another width would leave gaps (or overlap) at this one.
    const scroller = scrollRef.current;
    let width = scroller?.clientWidth ?? 0;
    const observer =
      scroller && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const next = scroller.clientWidth;
            if (next === width) return;
            width = next;
            reset();
          })
        : null;
    if (scroller) observer?.observe(scroller);
    return () => {
      window.removeEventListener("resize", reset);
      observer?.disconnect();
    };
  }, [windowed]);
  useLayoutEffect(() => {
    if (!windowed) return;
    let tallest = 0;
    for (const row of listRef.current?.children ?? [])
      if (
        row instanceof HTMLElement &&
        !row.hasAttribute("data-exiting") &&
        !row.hasAttribute("data-list-row-skeleton")
      )
        tallest = Math.max(tallest, row.offsetHeight);
    if (tallest <= measured.current) return;
    measured.current = tallest;
    if (tallest !== rowHeight) setRowHeight(tallest);
  });

  const activeIndex =
    props.activeId === null
      ? -1
      : rows.findIndex((row) => row.id === props.activeId);
  const virtualizer = useVirtualizer({
    enabled: windowed,
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: OVERSCAN,
    // The open row is always drawn, so it keeps focus and its key handling
    // when the person scrolls away from it.
    rangeExtractor: (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes;
      return [...indexes, activeIndex].sort((a, b) => a - b);
    },
  });
  useEffect(() => {
    if (windowed) virtualizer.measure();
  }, [rowHeight, virtualizer, windowed]);
  // A scroll box with no height has no layout to window by (a test's DOM):
  // every row is drawn, as an unwindowed list does.
  const drawWindow = windowed && virtualizer.scrollRect?.height !== 0;
  const windowItems = virtualizer.getVirtualItems();
  const visibleRows = useMemo(
    () =>
      drawWindow
        ? windowItems.flatMap((item) => {
            const row = rows[item.index];
            return row ? [row] : [];
          })
        : rows,
    [drawWindow, rows, windowItems],
  );
  useEffect(() => {
    props.onVisibleRows?.(visibleRows);
  }, [props.onVisibleRows, visibleRows]);

  // Where each drawn row sat, so a row that leaves fades out in its place.
  const drawnTops = useRef<ReadonlyMap<number, number>>(new Map());
  // A windowed list never draws a leaving row (its rows move instead); a
  // list in the flow folds the leaving row away in place.
  // A list with another name (a tab, a filter) is another list.
  const listKey = props.listKey ?? props.label;
  const exiting = useExitingRows(
    rows,
    props.loading,
    drawWindow,
    drawnTops,
    listKey,
  );
  const motion = useRowMotion(
    rows,
    props.loading,
    drawWindow,
    drawnTops,
    rowHeight,
    listKey,
  );
  useLayoutEffect(() => {
    drawnTops.current = new Map(
      drawWindow
        ? windowItems.flatMap((item) => {
            const row = rows[item.index];
            return row ? [[row.id, item.start] as const] : [];
          })
        : [],
    );
  });

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, props.rows.length]);

  // The open row stays in view in its list: when it opens (a click, J/K,
  // the next row after a move or an Undo), when it first arrives in a list
  // that opened with it already chosen, and when the list starts windowing.
  // Only the list scrolls, never the page around it, and a row already in
  // view does not move. A row the person scrolled away from is left alone
  // until it changes again.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const activePresent = activeIndex >= 0;
  useEffect(() => {
    if (props.activeId === null || !activePresent) return;
    if (drawWindow) {
      if (activeIndexRef.current >= 0)
        virtualizer.scrollToIndex(activeIndexRef.current, { align: "auto" });
      return;
    }
    const scroller = scrollRef.current;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-list-row-id="${props.activeId}"]`,
    );
    if (!scroller || !row) return;
    const box = scroller.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) scroller.scrollTop -= box.top - at.top;
    else if (at.bottom > box.bottom)
      scroller.scrollTop += Math.min(at.bottom - box.bottom, at.top - box.top);
  }, [props.activeId, activePresent, virtualizer, drawWindow]);

  // Keyboard focus follows the open row while it is in the list: J/K (or
  // the next row opening after the open one left) move focus with it, so X
  // ticks the row the person sees open and Tab goes on from there, not from
  // the row first clicked. Focus elsewhere (the details, a field, the
  // toolbar) is left alone.
  const rowFocused = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || props.activeId === null) return;
    const focused = document.activeElement;
    const inList = focused instanceof HTMLElement && list.contains(focused);
    // A focused row that left the list drops focus to the page.
    const dropped =
      (focused === null || focused === document.body) && rowFocused.current;
    if (!inList && !dropped) return;
    const row = list.querySelector<HTMLElement>(
      `[data-list-row-id="${props.activeId}"]:not([data-exiting]) [aria-controls]`,
    );
    if (row && row !== focused) row.focus({ preventScroll: true });
  }, [props.activeId]);

  // A bulk action (or Clear, or Done) takes away the button that had focus.
  // Focus then goes to the open row, where J/K and X carry on, instead of
  // falling to the page.
  const sectionRef = useRef<HTMLElement>(null);
  const barFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const was = barFocus.current;
    if (!was || (was.isConnected && !was.matches(":disabled"))) return;
    barFocus.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== was) return;
    const section = sectionRef.current;
    (
      section?.querySelector<HTMLElement>(
        "[data-list-row-id] [aria-controls][tabindex='0']",
      ) ?? section?.querySelector<HTMLElement>("[data-list-status] button")
    )?.focus({ preventScroll: true });
  });

  // Rows re-sorting around the open one (a live fit re-check moves scores,
  // a search adds jobs above it) keep the open row where the person sees
  // it: the list scrolls by however far the row moved. A row already out of
  // view, a new list and the person's own scrolling are left alone. The order
  // itself stays live, so the list never shows a stale sort.
  const anchor = useRef<{ id: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const id = props.activeId;
    const row =
      id === null
        ? null
        : listRef.current?.querySelector<HTMLElement>(
            `[data-list-row-id="${id}"]:not([data-exiting])`,
          );
    if (!scroller || !row || id === null) {
      anchor.current = null;
      return;
    }
    const box = scroller.getBoundingClientRect();
    const offset =
      row.getBoundingClientRect().top - box.top + scroller.scrollTop;
    const before = anchor.current;
    anchor.current = { id, offset };
    if (!before || before.id !== id || before.offset === offset) return;
    const shownAt = before.offset - scroller.scrollTop;
    if (shownAt + row.offsetHeight <= 0 || shownAt >= scroller.clientHeight)
      return;
    scroller.scrollTop += offset - before.offset;
  }, [rows, props.activeId, rowHeight]);

  // A windowed list never draws its leaving rows, so they hold nothing up.
  const leaving = drawWindow ? 0 : exiting.length;
  const showSkeleton =
    rows.length === 0 && leaving === 0 && (props.loading || props.pending);
  const showEmpty =
    rows.length === 0 && leaving === 0 && !props.loading && !props.pending;
  const fitContent = rows.length > 0 && !hasMore && !showSkeleton && !showEmpty;
  const complete = !hasMore && !props.totalCapped && rows.length >= props.total;
  const loadedAll = allLoadedSelected(props.selection, rows);
  const allChecked =
    rows.length > 0 &&
    (props.selection.all
      ? props.selection.ids.size === 0
      : loadedAll && complete);
  const capped = props.totalCapped ? "+" : "";
  const totalText = `${props.total.toLocaleString()}${capped}`;
  const nouns = `${noun}${props.total === 1 ? "" : "s"}`;
  const selectedText = `${props.selectedCount.toLocaleString()}${
    props.selection.all ? capped : ""
  }`;
  // "Select all N matching" is in the bar from the moment select mode
  // opens, not only once every loaded row is ticked: the scope a bulk
  // action can reach is always stated in words.
  const offerAll =
    !props.selection.all &&
    rows.length > 0 &&
    !allChecked &&
    (props.totalCapped || props.selectedCount < props.total);
  const select = props.onSelectionChange;
  const allMatchingLabel = props.totalCapped
    ? "Select all matching"
    : `Select all ${totalText} matching`;

  // No "0 jobs" over rows that are on their way.
  const summary =
    props.loading || (props.pending && rows.length === 0) ? (
      <span
        aria-label={`Loading ${noun}s`}
        className="skeleton inline-block h-3 w-20 align-middle"
        role="status"
      />
    ) : props.error && rows.length === 0 ? null : ( // unknown, and the state below says so. // Nor "0 jobs" over a list that could not be read: the count is
      (props.summary ?? (
        <span className="tabular-nums">
          {totalText} {nouns}
        </span>
      ))
    );

  return (
    <ListModeContext.Provider value={mode}>
      <section
        aria-label={props.label}
        // Stacked above its details the page scrolls, so the list keeps a
        // height of its own: about five rows, never one. Under a details
        // sheet the list has the whole height instead.
        className={cn(
          "group/list surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) split:h-full",
          props.fillStacked
            ? "h-full"
            : "stacked:h-[min(36rem,75vh)] stacked:shrink-0",
          // Beside its details, a whole list shorter than the pane ends at
          // its last row (and its end note) instead of sitting over a tall
          // blank card; a longer one still fills the height and scrolls.
          // While it loads it keeps the full height its skeleton draws.
          fitContent && "split:h-auto split:max-h-full split:self-start",
        )}
        data-fit-content={fitContent ? "" : undefined}
        data-selecting={selecting ? "true" : "false"}
        ref={sectionRef}
      >
        {props.toolbar ? (
          <div
            className="flex min-h-12 shrink-0 items-center gap-2 border-b border-(--surface-panel-border) px-3 py-2"
            data-list-toolbar
          >
            {props.toolbar}
          </div>
        ) : null}
        <header
          className={cn(
            // One 44px row; a narrow list in select mode takes a second
            // row for its verbs (below).
            "@container/listbar flex min-h-11 shrink-0 items-center gap-2 border-b border-(--surface-panel-border) px-3",
            // A list that could not be read has no count to show and no
            // rows to select: no empty bar over its error.
            props.error && rows.length === 0 && !selecting && "hidden",
          )}
          data-list-status
          onBlur={(event) => {
            // Focus that moves on by itself (Tab, a click elsewhere) is
            // the person's; only a button that disappears hands it on.
            if (event.relatedTarget) barFocus.current = null;
          }}
          onFocus={(event) => {
            barFocus.current = event.target;
          }}
        >
          {selecting ? (
            <div
              // A narrow bar (under 28rem: the reading list beside a
              // resume, a docked list) has two rows from the moment select
              // mode opens, before anything is ticked, so ticking never
              // moves the rows: the count and "Select all N matching" on
              // the first, the verbs and Done in words on the second.
              className="flex min-w-0 flex-1 items-center gap-2 @max-md/listbar:flex-wrap @max-md/listbar:gap-y-1.5 @max-md/listbar:py-1.5"
              data-selection-bar
            >
              <span className="flex w-6 shrink-0 justify-center">
                <Checkbox
                  aria-label={
                    props.selectedCount > 0
                      ? "Clear the selection"
                      : complete
                        ? `Select all ${totalText} ${nouns}`
                        : `Select all ${rows.length.toLocaleString()} shown ${noun}${rows.length === 1 ? "" : "s"}`
                  }
                  checked={
                    allChecked
                      ? true
                      : props.selectedCount > 0
                        ? "indeterminate"
                        : false
                  }
                  disabled={rows.length === 0}
                  onCheckedChange={() =>
                    select((current) =>
                      props.selectedCount > 0
                        ? clearSelected(current)
                        : stepSelectAll(current, rows, complete),
                    )
                  }
                  // The tooltip says what a click does now, like the name:
                  // with anything ticked the box clears, it never selects.
                  title={
                    props.selectedCount > 0
                      ? "Clear the selection"
                      : `Select all · ${modShortcut("A")}`
                  }
                />
              </span>
              {/* The count is never cut ("2 s"): it keeps its whole width,
                  and "Select all" takes the room left beside it. */}
              <span
                aria-live="polite"
                className="shrink-0 whitespace-nowrap text-(length:--text-small) font-medium tabular-nums text-foreground"
                data-selection-count
              >
                {props.countText ??
                  (props.counting
                    ? "Counting…"
                    : props.selectedCount === 0 && !props.selection.all
                      ? // Nothing ticked yet: what to do, not "0 selected".
                        `Tick ${noun}s`
                      : `${selectedText} selected`)}
              </span>
              <div
                className="flex min-w-0 flex-1 basis-0 items-center gap-2 overflow-hidden"
                data-select-all-room
              >
                {offerAll ? (
                  <Button
                    // The full words are its name; a narrow bar drops
                    // "matching" so the actions keep their room, but never
                    // the verb: a bare "All 60" beside "50 selected" read
                    // as a count, not as a button. When neither form fits,
                    // the button is not drawn at all (no blank button in
                    // the Tab order); ⌘A still selects all matching.
                    aria-label={allMatchingLabel}
                    className="min-w-0 shrink px-2 has-[[data-fit-none]]:invisible"
                    onClick={() => select(selectAll())}
                    size="toolbar"
                    title={`${allMatchingLabel} · ${modShortcut("A")} again`}
                    type="button"
                    variant="ghost"
                  >
                    {/* One wording on every list, "Select all N matching";
                        a cramped bar says "Select all N", whole, or leaves
                        it to the tri-state box (never "elect all"). */}
                    <FitText
                      boxClassName="min-w-0"
                      candidates={[
                        allMatchingLabel,
                        props.totalCapped
                          ? "Select all"
                          : `Select all ${totalText}`,
                      ]}
                      className="text-(--link)"
                      room={selectAllRoom}
                      title={null}
                      watch={watchSelectAllRoom}
                    />
                  </Button>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2 @max-md/listbar:min-h-8 @max-md/listbar:basis-full @max-md/listbar:pl-8">
                {props.selectedCount > 0 ? props.bulkActions : null}
                {/* The tri-state box clears too; a narrow bar drops the
                    word so the count and the actions fit. */}
                <Button
                  className="hidden @xl/listbar:inline-flex"
                  disabled={props.selectedCount === 0}
                  onClick={() => select(SELECTING)}
                  size="toolbar"
                  type="button"
                  variant="ghost"
                >
                  Clear
                </Button>
                <Button
                  className="ml-auto"
                  onClick={() => select(NO_SELECTION)}
                  size="toolbar"
                  title="Leave select mode · Esc"
                  type="button"
                  variant="outline"
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* 24px tall (in the 44px bar), so an action inside the line
                  ("Show all") has a whole 24px target the clip keeps. */}
              <div className="min-w-0 flex-1 truncate py-0.5 text-(length:--text-small) text-foreground-soft">
                {summary}
              </div>
              <Button
                className={cn(rows.length === 0 && "invisible")}
                disabled={rows.length === 0}
                onClick={() => select(SELECTING)}
                size="toolbar"
                title={`Select ${noun}s to act on several at once · X or ${modShortcut("A")}`}
                type="button"
                variant="ghost"
              >
                <ListChecks aria-hidden="true" />
                Select
              </Button>
            </>
          )}
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-locked-pane-scroll-region
          ref={scrollRef}
        >
          {props.error && props.onRetry && !showEmpty && !showSkeleton ? (
            <ListReadError
              error={props.error}
              inline
              onRetry={props.onRetry}
              what={props.label}
            />
          ) : null}
          {showEmpty ? (
            <div className="p-6">
              {props.error && props.onRetry ? (
                <ListReadError
                  error={props.error}
                  onRetry={props.onRetry}
                  what={props.label}
                />
              ) : (
                props.empty
              )}
            </div>
          ) : (
            // One list element from loading to loaded, so the rows that
            // arrive replace the skeleton rows in place.
            <ul
              aria-busy={showSkeleton || undefined}
              aria-label={props.label}
              className={jobFinderListRegionClassName}
              data-list-collapsing={
                exiting.length > 0 || motion.size > 0 ? "" : undefined
              }
              onBlur={() => {
                rowFocused.current = false;
              }}
              onFocus={(event) => {
                rowFocused.current =
                  event.target.closest("[data-list-row-id]") !== null;
              }}
              ref={listRef}
              style={
                drawWindow && !showSkeleton
                  ? { position: "relative", height: virtualizer.getTotalSize() }
                  : undefined
              }
            >
              {showSkeleton ? (
                Array.from({ length: SKELETON_ROWS }, (_, index) => (
                  <Fragment key={`skeleton-${index}`}>
                    {props.renderSkeletonRow ? (
                      props.renderSkeletonRow(index)
                    ) : (
                      <ListRowSkeleton index={index} />
                    )}
                  </Fragment>
                ))
              ) : drawWindow ? (
                <>
                  {windowItems.map((item) => {
                    const row = rows[item.index];
                    if (!row) return null;
                    return (
                      <Fragment key={row.id}>
                        {props.renderRow(row, {
                          active: row.id === props.activeId,
                          checked: isSelected(props.selection, row.id),
                          index: item.index,
                          top: item.start,
                          setSize: props.totalCapped ? -1 : props.total,
                          motion: motion.get(row.id),
                        })}
                      </Fragment>
                    );
                  })}
                </>
              ) : (
                withExiting(rows, exiting).map((entry) =>
                  "exiting" in entry ? (
                    <Fragment key={`exiting-${entry.row.id}`}>
                      {props.renderRow(entry.row, {
                        active: false,
                        checked: false,
                        exiting: true,
                      })}
                    </Fragment>
                  ) : (
                    <Fragment key={entry.id}>
                      {props.renderRow(entry, {
                        active: entry.id === props.activeId,
                        checked: isSelected(props.selection, entry.id),
                      })}
                    </Fragment>
                  ),
                )
              )}
            </ul>
          )}
          {hasMore || showSkeleton ? null : props.footer}
          {props.endNote &&
          !props.footer &&
          !hasMore &&
          !showSkeleton &&
          !showEmpty &&
          !props.error &&
          rows.length > 0 ? (
            <p
              className="px-4 py-3 text-(length:--text-small) text-foreground-soft"
              data-list-end
            >
              {props.endNote}
            </p>
          ) : null}
          {hasMore ? (
            <div
              className="py-4 text-center text-(length:--text-small) text-foreground-muted"
              ref={sentinel}
            >
              Loading more…
            </div>
          ) : null}
        </div>
      </section>
    </ListModeContext.Provider>
  );
}

/** The rows in order, with each leaving row back at the place it left. */
function withExiting<Row extends { id: number }>(
  rows: readonly Row[],
  exiting: readonly ExitingRow<Row>[],
): (Row | (ExitingRow<Row> & { exiting: true }))[] {
  if (exiting.length === 0) return [...rows];
  const out: (Row | (ExitingRow<Row> & { exiting: true }))[] = [...rows];
  for (const entry of [...exiting].sort((a, b) => a.index - b.index))
    out.splice(Math.min(entry.index, out.length), 0, {
      ...entry,
      exiting: true,
    });
  return out;
}
