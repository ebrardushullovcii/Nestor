import type { CSSProperties, ReactNode } from "react";
import { animateIn, ENTER_FROM_BELOW } from "@renderer/lib/motion";
import type { RecentChange } from "../lib/recent-changes";
import { BrowserPeek } from "./browser-peek";
import { AssistantSidebar } from "../assistant/assistant-sidebar";
import { AssistantToggle } from "../assistant/assistant-toggle";
import { useAssistant } from "../assistant/assistant-provider";
import { useAssistantSideMenuCollapse } from "../assistant/use-assistant-side-menu-collapse";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  BellRing,
  Menu,
  ClipboardCheck,
  Compass,
  FileText,
  House,
  Keyboard,
  Layers3,
  Minus,
  Search,
  Settings,
  Square,
  UserRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  DesktopWindowControlsState,
  DiscoveryActivityEvent,
  GroupedManualAnswerDecision,
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportProgressEvent,
  SuiteModule,
} from "@nestor/contracts";
import { collapsesSideMenuWithAssistant } from "@nestor/contracts";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@renderer/components/ui/button";
import { Count } from "@renderer/components/ui/count";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import type { JobFinderScreen } from "../lib/job-finder-types";
import type { JobFinderSaveState } from "@renderer/pages/job-finder-save-state";
import { JobFinderSaveStatus } from "./job-finder-save-status";
import {
  JOB_FINDER_GLOBAL_SEARCH_LABEL,
  JobFinderGlobalSearchDialog,
} from "./job-finder-global-search";
import { JobFinderTaskCenter } from "./task-center/job-finder-task-center";
import { StartupResetRecoveryBanner } from "./startup-reset-recovery-banner";
import { countNeedsYouItems } from "../lib/needs-you-count";
import {
  countApplicationRecords,
  countDiscoveryVisibleJobs,
  countNeedsYou,
  selectCampaignJobIds,
  toDestinationBadgeCount,
} from "../lib/destination-counts";
import { useSearchLiveCounts } from "../lib/search-change-feed";
import { useLaunchReads } from "../lib/launch-reads";
import {
  SHELL_HEADER_MASK_HEIGHT_CLASS,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS,
} from "../lib/job-finder-shell-gutters";
import { buildJobFinderGlobalSearchEntries } from "../lib/build-job-finder-global-search-entries";
import type { JobFinderGlobalSearchEntry } from "../lib/job-finder-global-search";
import {
  formatJobFinderShortcutCombo,
  getJobFinderAriaKeyshortcuts,
} from "../lib/job-finder-shortcuts";
import { isImeComposingEvent } from "../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../lib/job-finder-overlay-ownership";
import { useJobFinderShellShortcuts } from "../lib/use-job-finder-shell-shortcuts";
import { useHistoryNavigationShortcuts } from "../lib/use-history-navigation-shortcuts";
import { getDefaultProfileRoute } from "../lib/job-finder-utils";
import { JobFinderShellBrand } from "./job-finder-shell-brand";
import {
  BoundedFloatingSurfaceScrollHint,
  boundedFloatingSurfaceStyle,
  useBoundedFloatingSurface,
  useBoundedFloatingSurfaceScrollState,
} from "./bounded-floating-surface";
import {
  JOB_FINDER_SHORTCUTS_DIALOG_LABEL,
  JobFinderShortcutsDialog,
} from "./job-finder-shortcuts-dialog";
import { readFullWorkspaceIfBehind } from "../lib/workspace-view-refresh";

interface JobFinderShellProps {
  children: ReactNode;
  isDiscoveryPending?: boolean;
  isResumeImportPending?: boolean;
  liveDiscoveryEvents?: readonly DiscoveryActivityEvent[];
  onCancelApplyRun?: (runId: string) => Promise<boolean>;
  onCancelDiscovery?: (runId: string) => Promise<boolean>;
  onDismissSavedStatus?: () => void;
  onNavigate?: (path: string) => void;
  onPrepareRemainingJobs?: (
    jobIds: readonly string[],
  ) => void | Promise<unknown>;
  onUndoRecentChange?: (change: RecentChange) => Promise<boolean>;
  onRetrySave?: () => void;
  platform: "darwin" | "linux" | "win32";
  resumeImportProgress?: ResumeImportProgressEvent | null;
  saveState?: JobFinderSaveState;
  /** Shortlisted jobs whose resume waits to be read, from the job store. */
  toReviewCount?: number | null;
  workspace: JobFinderRendererWorkspaceSnapshot;
}

const screenRouteMap: Record<Exclude<JobFinderScreen, "profile">, string> = {
  home: "/job-finder/home",
  discovery: "/job-finder/discovery",
  "review-queue": "/job-finder/review-queue",
  applications: "/job-finder/applications",
  actions: "/job-finder/actions",
  settings: "/job-finder/settings",
};

const screenLabelMap: Record<JobFinderScreen, string> = {
  home: "Home",
  profile: "Profile",
  discovery: "Find jobs",
  "review-queue": "Shortlisted",
  applications: "Applications",
  actions: "Needs you",
  settings: "Settings",
};

/**
 * Thin adapter over the one exported owner in `lib/needs-you-count.ts`. The
 * shell no longer derives this population itself; the argument order is kept
 * so existing callers and tests read the same helper.
 */
export function countUnresolvedUserActions(
  requests:
    | JobFinderRendererWorkspaceSnapshot["userActionRequests"]
    | undefined,
  groupedDecisions?: readonly GroupedManualAnswerDecision[],
): number {
  return countNeedsYouItems({ groupedDecisions, requests });
}

export const LOCKED_LAYOUT_SCREENS: readonly JobFinderScreen[] = [
  "profile",
  "discovery",
  "review-queue",
  "applications",
];

// The More menu's own preferred width, and the height it needs for seven
// destinations plus their group labels and the shortcuts entry. Supplying the
// desired height keeps the menu below its trigger whenever it genuinely fits
// there and only flips it upward when it does not.
// The main window is frameless on Windows (`frame: !(isMac || isWindows)` in
// main/setup/window-shell.ts) and this header paints its own caption buttons,
// so there is no Window Controls Overlay and no `env(titlebar-area-*)` to read.
// The reserved width is therefore the exact width of the buttons rendered
// below: minimize (w-11) + maximize (w-11) + close (w-12) = 8.5rem.
const WINDOWS_CAPTION_CONTROLS_INSET = "8.5rem";
// macOS uses `titleBarStyle: "hiddenInset"`, so the native traffic lights are
// painted over the left edge of this header outside native fullscreen.
const MACOS_TRAFFIC_LIGHT_INSET = "5.5rem";
const MORE_MENU_WIDTH_PX = 264;
const MORE_MENU_DESIRED_HEIGHT_PX = 440;

interface CompactRouteScrollEdges {
  end: boolean;
  start: boolean;
}

function readCompactRouteScrollEdges(
  element: HTMLDivElement,
): CompactRouteScrollEdges {
  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  return {
    start: element.scrollLeft > 1,
    end: element.scrollLeft < maxScrollLeft - 1,
  };
}

const NO_ROUTE_SCROLL_EDGES: CompactRouteScrollEdges = {
  end: false,
  start: false,
};

export const SIDEBAR_COLLAPSED_STORAGE_KEY =
  "nestor.job-finder.sidebar-collapsed.v1";

/**
 * Inventory counts describe workspace volume and are the bare number: a plain
 * number beside a destination name means "this is how much is in there".
 * Attention counts describe work waiting on the user, so they are never bare —
 * they carry a filled marker and a noun ("2 to review"), because a bare
 * attention number beside "Companies" read as an inventory count and was wrong
 * by an order of magnitude.
 */
type ScreenCountKind = "attention" | "inventory";

/**
 * The shell's own layout for a destination count, on top of the shared
 * `<Count variant="inline">` shape: pushed to the row's trailing edge, and
 * `text-current` so the figure follows the active row's colour instead of
 * sitting at the primitive's resting muted tone.
 *
 * The shape itself is no longer restated here. The expanded sidebar (>=1440)
 * and the compact top navigation (<1440) used to paint two shapes for the same
 * number — a plain "13" and a filled pill "13", one breakpoint apart; both now
 * render the one `<Count>` primitive, so they cannot drift again.
 */
export const DESTINATION_COUNT_INLINE_LAYOUT_CLASS = "mr-1 ml-auto shrink-0";
/**
 * The attention state, and the one destination count `<Count>` cannot own: the
 * qualifying noun has to render visibly beside the figure ("2 to review", "1
 * blocked"), because a bare number in this position reads as inventory — and
 * `Count` deliberately takes no children. It is a filled marker so a sighted
 * reader can tell "work waiting on you" from inventory before reading the noun.
 */
export const DESTINATION_COUNT_ATTENTION_CLASS =
  "mr-1 ml-auto inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-full bg-primary-fill px-1.5 text-(length:--text-tiny) font-semibold text-primary-fill-foreground tabular-nums";
/**
 * The collapsed rail has no room for an inline number or a noun, so every
 * count moves to the shared `<Count variant="rail-marker">` corner marker —
 * still one treatment, a different state. It is anchored to the icon, not
 * the row, and lifted to the icon's top-right corner so it overlaps only the
 * corner of the glyph the way a badge does. The accessible name still
 * carries the qualifier.
 */
export const DESTINATION_COUNT_RAIL_MARKER_LAYOUT_CLASS =
  // Anchored by its left edge at the icon's right side so a wide "99+" grows
  // into the free rail instead of back over the glyph; anchored on the right
  // it covered the top of the Find jobs and Shortlisted icons.
  "absolute -top-2 left-[calc(100%-0.625rem)] shrink-0";

/* ------------------------------------------------------------------------ *
 * Shell chrome.
 *
 * The opening frame in `pages/job-finder-page.tsx` paints the same header,
 * rail and route wrapper before the loaded shell mounts. It used to hold
 * seventeen hand-copied class strings kept honest only by a parity test, so a
 * drift on either side was a first-paint jump waiting for someone to update
 * one copy. The chrome is exported here instead: both shells now read the same
 * strings and the parity is structural.
 * ------------------------------------------------------------------------ */

/**
 * Sticky shell edges use the shared panel border. `border-border/15` was a
 * one-off dilution that rendered the header seam and the rail edge below the
 * 3:1 non-text floor in both themes.
 */
export const SHELL_HEADER_CLASS =
  "relative z-50 shrink-0 overflow-visible border-b border-(--surface-panel-shell-border) bg-(--shell-header-bg) backdrop-blur-sm sm:fixed sm:inset-x-0 sm:top-0 xl:h-14";
export const SHELL_HEADER_GRID_CLASS =
  "job-finder-shell-grid grid grid-rows-[3.5rem_auto_auto] items-stretch overflow-visible pl-2 pr-2 sm:grid-rows-[3.5rem_3.75rem] sm:pl-3 sm:pr-3 xl:grid-rows-[3.5rem]";
/**
 * The module switcher is the subtitle of the brand lockup in the header
 * (`JobFinderShellBrand`), so there is exactly one instance at every width and
 * the sidebar, the compact destination card and the collapsed rail carry none.
 */
export const SHELL_BRAND_ROW_CLASS = cn(
  "col-start-1 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6",
  // At the wide layout column 1 is the 17rem sidebar column, and it narrows to
  // 4rem when the rail collapses. The wordmark does not fit there, and it
  // wrapped onto a second line that spilled out of the 3.5rem header and under
  // the page title. The brand row therefore spans the sidebar column and the
  // content column (col-end-3, never the col-span shorthand, which would reset
  // col-start) so the lockup stays on one line in the top bar.
  "min-[1440px]:col-end-3",
);
export const SHELL_SIDEBAR_CLASS =
  "fixed bottom-0 left-0 top-14 z-40 hidden w-(--job-finder-side-width) overflow-hidden border-r border-(--surface-panel-shell-border) bg-(--shell-header-bg) min-[1440px]:block";
export const SHELL_SIDEBAR_ROW_CLASS =
  "job-finder-sidebar-row inline-flex min-h-9 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-(--radius-button) border-l-2 border-transparent px-2 py-1.5 text-left text-sm font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40";
export const SHELL_SIDEBAR_ROW_COLLAPSED_CLASS =
  "relative min-h-10 justify-center border-l-0 px-0 text-center";
// The keyboard-shortcuts reference is one small square beside Settings at the
// foot of the rail, not a destination row: it opens a dialog, so it gets a
// row's hover and focus treatment in a 36px box rather than a full-width line.
export const SHELL_SIDEBAR_SHORTCUTS_BUTTON_CLASS =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-button) border-l-2 border-transparent text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40";
// Hover styling is scoped to inactive rows so it cannot wash the selected fill
// back out. In the light theme a solid hover fill read as a second selection,
// so hover is a translucent wash plus a border tick: exactly one row is ever
// filled.
export const SHELL_SIDEBAR_ROW_INACTIVE_CLASS =
  "hover:border-l-(--border-strong) hover:bg-secondary/50 hover:text-foreground";
// The selected destination needs a fill the eye separates from the rail, not a
// 2px bar over a near-identical tint: --nav-active-surface stays >=3:1
// non-text against --shell-header-bg in both themes, and the bolder label plus
// the accent bar keep the state legible without relying on colour.
export const SHELL_SIDEBAR_ROW_ACTIVE_CLASS =
  "border-l-(--nav-active-bar) bg-(--nav-active-surface) font-semibold text-(--nav-active-foreground)";

const sidebarDescriptions: Partial<Record<string, string>> = {
  Home: "Your next step",
  Profile: "Experience & documents",
  "Find jobs": "Discover opportunities",
  Shortlisted: "Review & prepare",
  Applications: "Track your progress",
};

export function SidebarDestinationLabel({
  label,
  collapsed,
}: {
  label: string;
  collapsed: boolean;
}) {
  const description = sidebarDescriptions[label];
  return (
    <span className={cn("min-w-0 truncate", collapsed && "sr-only")}>
      <span className="block truncate">{label}</span>
      {!collapsed && description ? (
        <span aria-hidden="true" className="job-finder-sidebar-description">
          {description}
        </span>
      ) : null}
    </span>
  );
}
export const SHELL_ROOT_CLASS =
  "flex h-dvh min-h-0 flex-col overflow-hidden text-foreground";
export const SHELL_CONTENT_CLASS =
  "flex min-h-0 min-w-0 flex-1 flex-col sm:pt-[7.25rem] xl:pt-14 min-[1440px]:pl-(--job-finder-side-width)";
export const SHELL_MAIN_SCROLLING_CLASS = cn(
  "relative min-h-0 min-w-0 flex-1 overflow-x-hidden outline-none",
  "screen-scroll-area overflow-y-auto px-3 min-[1440px]:px-4",
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
);
export const SHELL_MAIN_LOCKED_CLASS = cn(
  "relative min-h-0 min-w-0 flex-1 overflow-x-hidden outline-none",
  // Important for the same reason the header reserves above: `sm:px-3` still
  // matches at >=1440px and Tailwind v4 emits it after every arbitrary
  // variant, so a plain `min-[1440px]:px-4` silently lost and the wide layout
  // kept the 12px compact gutter. The scrolling branch needs no override: its
  // narrow value is the unprefixed base, which always loses to a variant.
  "overflow-hidden px-2 pb-3 pt-0 sm:px-3 min-[1440px]:!px-4",
);
export const SHELL_ROUTE_CONTAINER_BASE_CLASS =
  "mx-auto w-full max-w-472 min-w-0";
/**
 * One pill class for every control in the compact top-navigation row,
 * including the `More` trigger.
 */
export const COMPACT_NAV_PILL_CLASS =
  "inline-flex h-9 min-h-9 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-(--radius-button) border-b-2 border-transparent px-2 py-2 text-(length:--text-small) font-medium text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:gap-2 sm:px-3";
/**
 * The compact row used --accent, which sits at 1.16-1.27:1 on the nav bar and
 * cannot be told from a hovered neighbour. It now uses the same
 * --nav-active-surface treatment the sidebar adopted, plus a bar and a bolder
 * label so the state does not rest on colour alone.
 */
export const COMPACT_NAV_PILL_ACTIVE_CLASS =
  "border-b-(--nav-active-bar) bg-(--nav-active-surface) font-semibold text-(--nav-active-foreground)";
/**
 * One vertical rhythm for every route root. Route roots used to pick their own
 * (`gap-5` Home, `gap-3` Documents and Settings, `gap-(--gap-content)`
 * Profile, `gap-4`/`gap-5` elsewhere) with no rule; the wrapper now declares
 * the token so every route root can spend the same value.
 *
 * TODO(PKG-02): promote this declaration into `:root` in `styles/globals.css`
 * beside `--gap-section` and drop the inline style.
 */
export const SHELL_ROUTE_SECTION_GAP_STYLE = {
  "--gap-route-section": "var(--gap-card)",
} as CSSProperties;

interface ScreenCountBadgeProps {
  count: number;
  kind: ScreenCountKind;
  /** Attention only: the noun that keeps the number from reading as inventory. */
  noun?: string | undefined;
  /** Collapsed rail: no room for the noun, marker treatment only. */
  markerOnly?: boolean | undefined;
}

export function ScreenCountBadge({
  count,
  kind,
  markerOnly,
  noun,
}: ScreenCountBadgeProps) {
  if (kind === "attention" && !markerOnly) {
    return (
      <span className={DESTINATION_COUNT_ATTENTION_CLASS}>
        {count}
        {noun ? (
          <span className="whitespace-nowrap font-medium">{noun}</span>
        ) : null}
      </span>
    );
  }

  // Inventory, and every count on the collapsed rail: the shared primitive
  // owns the shape, so the same number cannot change shape one breakpoint
  // apart. It is announced through the row's own accessible name, never twice.
  return (
    <Count
      aria-hidden="true"
      className={
        markerOnly
          ? DESTINATION_COUNT_RAIL_MARKER_LAYOUT_CLASS
          : DESTINATION_COUNT_INLINE_LAYOUT_CLASS
      }
      value={count}
      variant={markerOnly ? "rail-marker" : "pill"}
    />
  );
}

function getScreenAccessibleName(
  label: string,
  count: number | null,
  kind: ScreenCountKind,
  noun?: string,
): string {
  return kind === "attention" && count !== null && count > 0
    ? `${label}: ${count} ${noun ?? "need attention"}`
    : label;
}

export function getInitialSidebarCollapsedState(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function getFocusableElements(excludedRoot: HTMLElement | null): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    if (excludedRoot?.contains(element)) {
      return false;
    }

    return (
      element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true"
    );
  });
}

function getActiveScreen(pathname: string): JobFinderScreen {
  if (pathname === "/job-finder" || pathname === "/job-finder/") {
    return "home";
  }

  if (pathname.endsWith("/home")) {
    return "home";
  }

  if (pathname.endsWith("/discovery")) {
    return "discovery";
  }

  if (pathname.includes("/review-queue")) {
    return "review-queue";
  }

  if (pathname.endsWith("/applications")) {
    return "applications";
  }

  if (pathname.endsWith("/actions")) {
    return "actions";
  }

  if (pathname.endsWith("/settings")) {
    return "settings";
  }

  return "profile";
}

export function JobFinderShell({
  children,
  isDiscoveryPending = false,
  isResumeImportPending = false,
  liveDiscoveryEvents = [],
  onCancelApplyRun,
  onCancelDiscovery,
  onDismissSavedStatus,
  onNavigate,
  onPrepareRemainingJobs,
  onUndoRecentChange,
  onRetrySave,
  platform,
  resumeImportProgress = null,
  saveState,
  toReviewCount = null,
  workspace,
}: JobFinderShellProps) {
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  const location = useLocation();
  const navigate = useNavigate();
  const stepHistory = useCallback(
    (step: -1 | 1) => {
      void navigate(step);
    },
    [navigate],
  );
  const mainRef = useRef<HTMLElement | null>(null);
  // Whether the person left the page scrolled. Writing a scroll position
  // forces a layout of the new screen, so a page already at the top is left
  // alone; scroll events land before the next frame's callbacks.
  const isMainScrolledRef = useRef(false);
  const routeContainerRef = useRef<HTMLDivElement | null>(null);
  const enteredPathRef = useRef(location.pathname);
  const dragRegionStyle = { WebkitAppRegion: "drag" } as CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;
  const [windowControlsState, setWindowControlsState] =
    useState<DesktopWindowControlsState>({
      isClosable: true,
      isFullScreen: false,
      isMaximized: false,
      isMinimizable: true,
    });
  // The live region is written directly: as state, the announcement re-rendered
  // the whole shell twice on every navigation.
  const routeAnnouncementRef = useRef<HTMLSpanElement | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    getInitialSidebarCollapsedState,
  );
  const assistant = useAssistant();
  // Fold the side menu while the assistant is docked beside the page; the
  // person's own toggle (button or shortcut) always wins and is what is saved.
  const { notePersonToggledSideMenu } = useAssistantSideMenuCollapse({
    assistantOpen: assistant?.open ?? false,
    assistantWidth: assistant?.width ?? 0,
    enabled: collapsesSideMenuWithAssistant(workspace.settings ?? {}),
    isSideMenuCollapsed: isSidebarCollapsed,
    setSideMenuCollapsed: setIsSidebarCollapsed,
  });
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [globalSearchFocusRequest, setGlobalSearchFocusRequest] = useState(0);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isShortcutsDialogOpen, setIsShortcutsDialogOpen] = useState(false);
  const [focusedMoreMenuItemIndex, setFocusedMoreMenuItemIndex] = useState(0);
  // Only compact top navigation uses More; the sidebar pins Settings below
  // its primary destinations.
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuScrollRef = useRef<HTMLDivElement | null>(null);
  const moreMenuItemRefs = useRef<Array<HTMLElement | null>>([]);
  const moreMenuInitialFocusRef = useRef<"first" | "last">("first");
  const compactRouteScrollRef = useRef<HTMLDivElement | null>(null);
  const compactMeasureRef = useRef<HTMLDivElement | null>(null);
  const [compactVisibleCount, setCompactVisibleCount] = useState(5);
  const [compactPreferredWidth, setCompactPreferredWidth] = useState<
    number | null
  >(null);
  const [compactRouteScrollEdges, setCompactRouteScrollEdges] =
    useState<CompactRouteScrollEdges>(NO_ROUTE_SCROLL_EDGES);
  // The header actions sit over the compact navigation row below 1280px, and
  // with their labels shown (1100px and up) they are wider than the fixed
  // 20rem the row reserved, so the destinations ran under Search and
  // Activity. The row reserves the group's measured width instead.
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  const [headerActionsWidth, setHeaderActionsWidth] = useState<number | null>(
    null,
  );
  useLayoutEffect(() => {
    const actions = headerActionsRef.current;
    if (!actions) return undefined;
    const measure = () => {
      setHeaderActionsWidth(Math.ceil(actions.getBoundingClientRect().width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(actions);
    return () => observer.disconnect();
  }, []);
  // The palette index is only ever read by the open dialog, so it is built on
  // demand (at idle once the palette shows, or by the first query), once per
  // workspace, and never while the palette is closed.
  const loadGlobalSearchEntries = useMemo(() => {
    let entries: readonly JobFinderGlobalSearchEntry[] | null = null;
    return () => {
      // The palette lists every job: one full read if the lists fell behind.
      readFullWorkspaceIfBehind();
      return (entries ??= buildJobFinderGlobalSearchEntries(workspace));
    };
  }, [workspace]);

  const activeScreen = useMemo(
    () => getActiveScreen(location.pathname),
    [location.pathname],
  );
  const activeScreenLabel = screenLabelMap[activeScreen];
  const usesLockedScreenLayout = useMemo(
    () => LOCKED_LAYOUT_SCREENS.includes(activeScreen),
    [activeScreen],
  );
  interface ShellScreenDefinition {
    id: string;
    label: string;
    count: number | null;
    countKind: ScreenCountKind;
    /** Attention destinations only: the noun rendered beside the number. */
    countNoun?: string | undefined;
    icon: LucideIcon;
  }

  // Every badge below reads one exported owner from `lib/destination-counts.ts`
  // named for its population. No count is derived inline here any more: four
  // of them used to count something other than what their destination page
  // prints, and nothing could hold the two together.
  const launchCounts = useLaunchReads().counts;
  const searchCounts = useSearchLiveCounts(workspace);
  const screenDefinitions = useMemo<readonly ShellScreenDefinition[]>(() => {
    const campaignJobIds = selectCampaignJobIds(workspace);
    // Until the jobs load, the three list badges come from the database, and
    // so do they during a search on screens that do not sync for it.
    const openingCounts =
      workspace.hydration?.phase === "bootstrap" ? launchCounts : searchCounts;

    return [
      {
        id: "home",
        label: "Home",
        count: null,
        countKind: "inventory",
        icon: House,
      },
      {
        id: "profile",
        label: "Profile",
        count: null,
        countKind: "inventory",
        icon: UserRound,
      },
      {
        id: "discovery",
        label: "Find jobs",
        count: toDestinationBadgeCount(
          openingCounts?.discovery ??
            countDiscoveryVisibleJobs(workspace, campaignJobIds),
        ),
        countKind: "inventory",
        icon: Compass,
      },
      {
        id: "review-queue",
        label: "Shortlisted",
        count: toDestinationBadgeCount(toReviewCount ?? 0),
        countKind: "inventory",
        icon: ClipboardCheck,
      },
      {
        id: "applications",
        label: "Applications",
        count: toDestinationBadgeCount(
          openingCounts?.applications ??
            countApplicationRecords(workspace, campaignJobIds),
        ),
        countKind: "inventory",
        icon: FileText,
      },
      {
        id: "actions",
        label: "Needs you",
        count: toDestinationBadgeCount(countNeedsYou(workspace)),
        countKind: "attention",
        countNoun: "unresolved",
        icon: BellRing,
      },
      {
        id: "settings",
        label: "Settings",
        count: null,
        countKind: "inventory",
        icon: Settings,
      },
    ];
  }, [launchCounts, searchCounts, toReviewCount, workspace]);

  const actionScreen = screenDefinitions.find(
    (screen) => screen.id === "actions",
  );
  const primaryScreens = useMemo(
    () =>
      screenDefinitions.filter((screen) =>
        [
          "home",
          "profile",
          "discovery",
          "review-queue",
          "applications",
        ].includes(screen.id),
      ),
    [screenDefinitions],
  );
  const compactPrimaryScreens = primaryScreens.slice(0, compactVisibleCount);
  const compactHiddenScreens = primaryScreens.slice(compactVisibleCount);
  // Measured again only when the destinations change. A count changing its
  // badge's width reaches the observer below; re-measuring on every
  // workspace update forced a page layout after each Find jobs decision.
  const primaryScreenKey = primaryScreens
    .map((screen) => `${screen.id}:${screen.label}`)
    .join("|");
  useLayoutEffect(() => {
    const scroll = compactRouteScrollRef.current;
    const measurement = compactMeasureRef.current;
    if (!scroll || !measurement) return undefined;
    const measure = () => {
      if (scroll.clientWidth <= 0) return;
      const widths = Array.from(
        measurement.children,
        (child) => (child as HTMLElement).getBoundingClientRect().width,
      );
      const gap =
        Number.parseFloat(getComputedStyle(measurement).columnGap) || 4;
      setCompactPreferredWidth(
        widths.reduce((sum, width) => sum + width, 0) +
          gap * Math.max(0, widths.length - 1) +
          (moreButtonRef.current?.getBoundingClientRect().width ?? 0) +
          24,
      );
      let used = 0;
      let count = 0;
      for (const width of widths) {
        used += width + (count > 0 ? gap : 0);
        if (used > scroll.clientWidth - 8) break;
        count += 1;
      }
      setCompactVisibleCount(Math.max(1, count));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(measurement);
    return () => observer.disconnect();
  }, [primaryScreenKey]);
  // Grouped by what each destination *is*, not by which part of the product
  // introduced it. The person's own files live under Profile › Files now, so
  // the workspace group is Settings alone.
  // Order follows the declared id list rather than the order the definitions
  // happen to be built in, so the menu's reading order is the one written here.
  const selectMenuScreens = (ids: readonly JobFinderScreen[]) =>
    ids.flatMap((id) => screenDefinitions.filter((screen) => screen.id === id));
  const menuGroups = [
    ...(compactHiddenScreens.length > 0
      ? [{ label: "Your job search", screens: compactHiddenScreens }]
      : []),
    {
      label: "Workspace",
      screens: selectMenuScreens(["settings"]),
    },
  ];
  const moreMenuItemCount = menuGroups.reduce(
    (count, group) => count + group.screens.length,
    0,
  );
  const moreMenuItemIndexes = new Map(
    menuGroups
      .flatMap((group) => group.screens)
      .map((screen, index) => [screen.id, index] as const),
  );
  const hiddenAttentionCount = 0;
  // The sidebar's scrolling list is the journey alone. Settings is not a step
  // of it, so it is pinned at the foot of the rail with the keyboard-shortcuts
  // reference beside it, outside the scroll region. The compact top
  // navigation, which genuinely has no room, keeps its More menu.
  const settingsScreen = screenDefinitions.find(
    (screen) => screen.id === "settings",
  );
  const sidebarGroups = [
    {
      label: "Your job search",
      screens: primaryScreens,
    },
  ];

  const moreMenuClose = useCallback(() => {
    setIsMoreOpen(false);
    moreButtonRef.current?.focus();
  }, []);

  // Register the Planning popover on the shared LIFO stack while it is open so
  // stacked surfaces close one per Escape and shell aliases stay blocked.
  const { isTopmost: isMoreMenuTopmost } = useJobFinderOverlayOwnership({
    active: isMoreOpen,
    close: moreMenuClose,
  });

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !moreButtonRef.current?.contains(target) &&
        !moreMenuRef.current?.contains(target)
      ) {
        setIsMoreOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      // Inner controls and overlays above this menu keep first claim.
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key !== "Escape" || !isMoreMenuTopmost()) {
        return;
      }
      event.preventDefault();
      moreMenuClose();
    };

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isMoreMenuTopmost, isMoreOpen, moreMenuClose]);

  // One bounded placement for the menu: it flips above its trigger when the
  // space below cannot hold it, shifts back inside the viewport horizontally,
  // and never claims more height than the window actually has.
  const moreMenuPlacement = useBoundedFloatingSurface({
    // The compact trigger opens leftward; alignment stays automatic so a
    // narrow window can still shift the surface back inside the viewport.
    alignment: "auto",
    desiredHeight: MORE_MENU_DESIRED_HEIGHT_PX,
    open: isMoreOpen,
    preferredWidth: MORE_MENU_WIDTH_PX,
    minWidth: 96,
    triggerRef: moreButtonRef,
  });

  const moreMenuScrollState = useBoundedFloatingSurfaceScrollState(
    moreMenuScrollRef,
    isMoreOpen,
    `${moreMenuItemCount}:${moreMenuPlacement?.maxHeight ?? 0}`,
  );

  useEffect(() => {
    if (!isMoreOpen) {
      return;
    }
    // The shortcuts entry is the trailing item at index `moreMenuItemCount`.
    const initialIndex =
      moreMenuInitialFocusRef.current === "last" ? moreMenuItemCount : 0;
    setFocusedMoreMenuItemIndex(initialIndex);
    const frame = requestAnimationFrame(() => {
      moreMenuItemRefs.current[initialIndex]?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isMoreOpen, moreMenuItemCount]);

  useLayoutEffect(() => {
    // The header strip only shows below 1440px; scrolling a hidden pill into
    // view still forced a layout of the whole new screen.
    if (window.matchMedia?.("(min-width: 1440px)").matches) return;
    compactRouteScrollRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeScreen]);

  useLayoutEffect(() => {
    const element = compactRouteScrollRef.current;
    if (!element) {
      return;
    }
    setCompactRouteScrollEdges(readCompactRouteScrollEdges(element));
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            setCompactRouteScrollEdges(readCompactRouteScrollEdges(element));
          });
    const handleWindowResize = () => {
      setCompactRouteScrollEdges(readCompactRouteScrollEdges(element));
    };
    observer?.observe(element);
    // Route buttons and badges resize without resizing the scrollport box,
    // so the content wrapper is observed too or fades drift out of truth.
    const contentElement = element.firstElementChild;
    if (contentElement instanceof HTMLElement) {
      observer?.observe(contentElement);
    }
    window.addEventListener("resize", handleWindowResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useLayoutEffect(() => {
    const main = mainRef.current;
    // A destination section owns its focus and scroll position. Resetting the
    // shell after it mounts would send an anchored Settings link back to top.
    const hasDestinationAnchor = Boolean(location.hash);
    const usesNarrowShellReflow =
      window.matchMedia?.("(max-width: 639px)").matches ?? false;
    document.title = `${activeScreenLabel} | Job Finder | Nestor`;
    const announcement = routeAnnouncementRef.current;
    if (announcement) announcement.textContent = "";
    if (!hasDestinationAnchor) {
      if (isMainScrolledRef.current) main?.scrollTo({ top: 0 });
      main?.focus({ preventScroll: true });
    }
    if (usesNarrowShellReflow && !hasDestinationAnchor) {
      main?.scrollIntoView({ block: "start" });
    }
    // The new screen is already there; it settles in over 160 ms.
    if (enteredPathRef.current !== location.pathname) {
      enteredPathRef.current = location.pathname;
      animateIn(routeContainerRef.current, ENTER_FROM_BELOW);
    }

    const frame = window.requestAnimationFrame(() => {
      if (!hasDestinationAnchor && isMainScrolledRef.current) {
        main?.scrollTo({ top: 0 });
      }
      try {
        globalThis.performance?.mark?.(
          `job-finder:route:${location.pathname}:feedback-committed`,
        );
      } catch {
        // Navigation timing is diagnostic only and must never block routing.
      }
      if (announcement)
        announcement.textContent = `${activeScreenLabel} opened.`;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeScreenLabel, location.hash, location.pathname]);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = window.nestor.window.onControlsStateChange(
      (controlsState) => {
        if (!cancelled) {
          setWindowControlsState(controlsState);
        }
      },
    );

    void window.nestor.window
      .getControlsState()
      .then((controlsState) => {
        if (!cancelled) {
          setWindowControlsState(controlsState);
        }
      })
      .catch(() => {
        // Keep the initial fallback state when the window bridge is unavailable.
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function runWindowAction(
    action: () => Promise<DesktopWindowControlsState>,
  ): Promise<void> {
    try {
      const nextControlsState = await action();
      setWindowControlsState(nextControlsState);
    } catch {
      // Keep the current controls state if the desktop action fails.
    }
  }

  function minimizeWindow() {
    void runWindowAction(() => window.nestor.window.minimize());
  }

  function toggleWindowExpand() {
    void runWindowAction(() => window.nestor.window.toggleMaximize());
  }

  function closeWindow() {
    void window.nestor.window.close();
  }

  function handleScreenChange(nextScreen: string) {
    const nextPath =
      nextScreen === "profile"
        ? getDefaultProfileRoute(workspace.profileSetupState)
        : screenRouteMap[nextScreen as Exclude<JobFinderScreen, "profile">];

    const nextPathname = nextPath.split(/[?#]/, 1)[0] ?? nextPath;
    try {
      globalThis.performance?.mark?.(
        `job-finder:route:${nextPathname}:navigation-start`,
      );
    } catch {
      // Navigation timing is diagnostic only and must never block routing.
    }

    // Straight to the screen in one commit. Every screen's code is fetched
    // ahead of time, and a cold one shows its own opening surface, so a
    // transition only made each click wait while React rendered in slices.
    if (onNavigate) {
      onNavigate(nextPath);
    } else {
      void navigate(nextPath);
    }
  }

  // The switch's only destination: the other module. Selecting the module the
  // user is already in is a no-op inside the control itself.
  function handleModuleSelect(moduleName: SuiteModule) {
    if (moduleName === "job-finder") {
      return;
    }

    if (onNavigate) {
      onNavigate("/live-assistant");
      return;
    }

    void navigate("/live-assistant");
  }

  function closeMoreMenuAndMoveFocus(direction: -1 | 1) {
    const trigger = moreButtonRef.current;
    const focusableElements = getFocusableElements(moreMenuRef.current);
    const triggerIndex = trigger ? focusableElements.indexOf(trigger) : -1;
    const target =
      triggerIndex >= 0
        ? (focusableElements[triggerIndex + direction] ?? trigger)
        : trigger;

    setIsMoreOpen(false);
    requestAnimationFrame(() => target?.focus());
  }

  function toggleSidebar() {
    notePersonToggledSideMenu();
    setIsSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_STORAGE_KEY,
          String(next),
        );
      } catch {
        // The layout still works when persistence is unavailable.
      }
      return next;
    });
  }

  function openGlobalSearch() {
    setIsMoreOpen(false);
    setIsGlobalSearchOpen(true);
    setGlobalSearchFocusRequest((request) => request + 1);
  }

  function openShortcutsDialog() {
    setIsMoreOpen(false);
    setIsShortcutsDialogOpen(true);
  }

  function handleGlobalSearchNavigate(entry: JobFinderGlobalSearchEntry) {
    if (onNavigate) {
      onNavigate(entry.href);
      return;
    }
    void navigate(entry.href);
  }

  // One row treatment for every sidebar destination, primary or secondary, so
  // the inline "Everything else" groups cannot drift from the journey rows.
  function renderSidebarDestination(screen: ShellScreenDefinition) {
    const isActive = activeScreen === screen.id;
    return (
      <Tooltip delayDuration={0} key={screen.id}>
        <TooltipTrigger asChild>
          <button
            aria-current={isActive ? "page" : undefined}
            aria-label={getScreenAccessibleName(
              screen.label,
              screen.count,
              screen.countKind,
              screen.countNoun,
            )}
            className={cn(
              SHELL_SIDEBAR_ROW_CLASS,
              isSidebarCollapsed && SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
              isActive ? "" : SHELL_SIDEBAR_ROW_INACTIVE_CLASS,
              isActive ? SHELL_SIDEBAR_ROW_ACTIVE_CLASS : "",
            )}
            onClick={() => handleScreenChange(screen.id)}
            type="button"
          >
            {isSidebarCollapsed && screen.count !== null ? (
              // The marker is positioned against the icon, so the two share
              // one relative box; a row without a count keeps the bare icon.
              <span className="relative inline-flex shrink-0">
                <screen.icon aria-hidden="true" className="size-4 shrink-0" />
                <ScreenCountBadge
                  count={screen.count}
                  kind={screen.countKind}
                  markerOnly
                  noun={screen.countNoun}
                />
              </span>
            ) : (
              <screen.icon aria-hidden="true" className="size-4 shrink-0" />
            )}
            <SidebarDestinationLabel
              collapsed={isSidebarCollapsed}
              label={screen.label}
            />
            {!isSidebarCollapsed && screen.count !== null ? (
              <ScreenCountBadge
                count={screen.count}
                kind={screen.countKind}
                markerOnly={false}
                noun={screen.countNoun}
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{screen.label}</TooltipContent>
      </Tooltip>
    );
  }

  useJobFinderShellShortcuts({
    isOverlayOpen: isMoreOpen || isGlobalSearchOpen || isShortcutsDialogOpen,
    isSearchOpen: isGlobalSearchOpen,
    onOpenGlobalSearch: openGlobalSearch,
    onOpenShortcuts: openShortcutsDialog,
    ...(assistant ? { onToggleAssistant: assistant.toggle } : {}),
    onToggleSidebar: toggleSidebar,
  });
  useHistoryNavigationShortcuts(stepHistory);
  useEffect(
    // A clicked "Search finished" notice opens the screen it is about.
    () =>
      window.nestor?.jobFinder?.onOpenRoute?.((route) => void navigate(route)),
    [navigate],
  );

  return (
    <div
      data-job-finder-shell
      data-sidebar-collapsed={isSidebarCollapsed ? "true" : "false"}
      className={cn(SHELL_ROOT_CLASS, `platform-${platform}`)}
      style={
        {
          "--job-finder-side-width": isSidebarCollapsed ? "4rem" : "17rem",
          "--job-finder-side-width-sm": isSidebarCollapsed ? "4rem" : "17rem",
        } as CSSProperties
      }
    >
      {/* The first thing Tab reaches, and the only way past the chrome
          without walking it. Tabbing forward from the end of a route wrapped
          straight onto Minimize / Restore / Close; from here one keypress
          lands in the route instead. Visible only while focused, so it costs
          a pointer user nothing. */}
      <button
        className="sr-only z-[100] rounded-(--radius-button) bg-(--surface-panel-raised) px-4 py-2 text-(length:--text-small) font-medium text-foreground shadow-xl outline-none focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:ring-[3px] focus-visible:ring-ring/45"
        data-job-finder-skip-to-content
        onClick={() => {
          const main = mainRef.current;
          if (!main) return;
          main.focus();
          main.scrollTo?.({ top: 0 });
        }}
        type="button"
      >
        Skip to the page
      </button>
      <header
        data-job-finder-shell-header
        className={SHELL_HEADER_CLASS}
        style={dragRegionStyle}
      >
        <div className={SHELL_HEADER_GRID_CLASS}>
          <div
            className={SHELL_BRAND_ROW_CLASS}
            data-desktop-brand
            style={{
              ...dragRegionStyle,
              // Keep clear of visible macOS traffic lights in normal and
              // maximized windows, then reclaim the space in native fullscreen.
              // This is the reserve the sidebar header inherits: the wordmark
              // and the module switch below it both sit inside this row's
              // leading track, so neither can land under the traffic lights.
              // The trailing edge mirrors the reserve so the row still reads
              // straight against the caption buttons.
              paddingInlineStart:
                isMac && !windowControlsState.isFullScreen
                  ? MACOS_TRAFFIC_LIGHT_INSET
                  : undefined,
              paddingInlineEnd:
                isMac && !windowControlsState.isFullScreen
                  ? MACOS_TRAFFIC_LIGHT_INSET
                  : undefined,
            }}
          >
            <div
              className="col-start-1 flex min-w-0 items-center justify-self-start"
              data-desktop-brand-region
            >
              <JobFinderShellBrand
                moduleSwitch={{
                  onSelectModule: handleModuleSelect,
                  style: noDragRegionStyle,
                }}
              />
            </div>

            {/* Trailing region. Windows paints its caption buttons over this
                edge (the window is frameless, so there is no Window Controls
                Overlay to measure); reserving their exact width here keeps
                header content out from under them, and the reserve lives
                inside the right track rather than as padding on the row. */}
            <div
              aria-hidden="true"
              className="col-start-2 min-w-0 justify-self-end"
              data-desktop-header-window-control-inset
              style={{
                ...dragRegionStyle,
                inlineSize: isWindows
                  ? WINDOWS_CAPTION_CONTROLS_INSET
                  : undefined,
              }}
            />
          </div>

          <div
            className="absolute right-0 top-0 z-40 flex h-14 items-stretch justify-end"
            style={dragRegionStyle}
          >
            {isWindows ? (
              <div
                className="flex h-full items-stretch gap-0"
                role="group"
                aria-label="Window controls"
                style={noDragRegionStyle}
              >
                <Button
                  aria-label="Minimize window"
                  className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--surface-panel-raised) hover:text-foreground"
                  disabled={!windowControlsState.isMinimizable}
                  onClick={minimizeWindow}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Minus className="size-3.5" />
                </Button>
                <Button
                  aria-label={
                    windowControlsState.isMaximized
                      ? "Restore window"
                      : "Maximize window"
                  }
                  className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--surface-panel-raised) hover:text-foreground"
                  onClick={toggleWindowExpand}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Square className="size-3.5" />
                </Button>
                <Button
                  aria-label="Close window"
                  className="h-full w-12 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--button-close-hover) hover:text-primary-fill-foreground"
                  disabled={!windowControlsState.isClosable}
                  onClick={closeWindow}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>

          <nav
            aria-label="Job Finder sections"
            // The destination card is centred on the same axis as the module
            // switcher above it instead of hugging the left edge. The
            // notification/action group is absolutely positioned over this
            // row, so its reserved width has to grow with the labels it shows
            // and the card centres inside whatever space is left: on macOS
            // that group moves up to the header row at >=900px, so this row is
            // free and the card lands on the true window centre. Elsewhere the
            // group stays here until 1440px, and reserving it on both sides
            // would squeeze the card into a scroller at the 1024px minimum, so
            // the trailing reserve is kept one-sided and the card centres in
            // the remaining width rather than clipping or wrapping.
            // The `min-[900px]` reserve is marked important on purpose.
            // Tailwind v4 emits arbitrary `min-[…]` media variants *before*
            // the named breakpoints, so at >=900px the still-matching
            // `sm:pr-64` came later in the stylesheet and won at equal
            // specificity: every compact width from 1024 to 1280 reserved
            // 256px it was not supposed to reserve, and the destination card
            // sat 127px left of the module switcher it is meant to share an
            // axis with. Importance is how the rest of this header already
            // pins a wider band over a narrower one (`min-[900px]:!top-0`,
            // `min-[1440px]:!pt-14`); do not drop it back to a plain utility.
            className={cn(
              "col-span-2 col-start-1 row-start-2 flex min-w-0 items-center justify-center overflow-visible sm:col-span-1 sm:col-start-1 sm:justify-center min-[1440px]:hidden",
              // From 1280px the header is one row: the card moves up between
              // the brand and the (icon-only) actions, sized to its content
              // so the rest of the row stays a window drag area.
              "xl:row-start-1 xl:justify-self-center",
              isMac
                ? "sm:pr-64 max-[899px]:pr-40 min-[900px]:!pr-0 xl:ml-56 xl:mr-[17rem]"
                : "sm:pr-64 max-[899px]:pr-40 min-[900px]:!pr-[max(20rem,calc(var(--job-finder-header-actions-width,0px)+0.75rem))] xl:!pr-0 xl:ml-40 xl:mr-[25rem]",
            )}
            style={
              headerActionsWidth === null
                ? noDragRegionStyle
                : ({
                    ...noDragRegionStyle,
                    "--job-finder-header-actions-width": `${headerActionsWidth}px`,
                  } as CSSProperties)
            }
          >
            <div
              className="relative flex w-fit min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-visible rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel) p-1 sm:gap-1.5"
              data-job-finder-compact-navigation
              style={
                compactPreferredWidth === null
                  ? undefined
                  : { width: compactPreferredWidth }
              }
            >
              <div className="relative min-w-0 flex-1">
                <div
                  aria-hidden="true"
                  className="pointer-events-none invisible absolute flex w-max gap-1 sm:gap-1.5"
                  ref={compactMeasureRef}
                >
                  {primaryScreens.map((screen) => (
                    <span
                      className={cn(COMPACT_NAV_PILL_CLASS, "font-semibold")}
                      key={screen.id}
                    >
                      <span className="shrink-0 whitespace-nowrap leading-tight">
                        {screen.label}
                      </span>
                      {screen.count !== null ? (
                        <ScreenCountBadge
                          count={screen.count}
                          kind={screen.countKind}
                          noun={screen.countNoun}
                        />
                      ) : null}
                    </span>
                  ))}
                </div>
                <div
                  className="overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                  data-job-finder-compact-navigation-scroll
                  onScroll={(event) => {
                    setCompactRouteScrollEdges(
                      readCompactRouteScrollEdges(event.currentTarget),
                    );
                  }}
                  ref={compactRouteScrollRef}
                >
                  <div
                    className="flex min-w-max flex-nowrap items-center gap-1 sm:gap-1.5"
                    data-job-finder-compact-navigation-content
                  >
                    {compactPrimaryScreens.map((screen) => (
                      <button
                        aria-current={
                          activeScreen === screen.id ? "page" : undefined
                        }
                        key={screen.id}
                        className={cn(
                          COMPACT_NAV_PILL_CLASS,
                          activeScreen === screen.id
                            ? COMPACT_NAV_PILL_ACTIVE_CLASS
                            : "",
                        )}
                        onClick={() => handleScreenChange(screen.id)}
                        onFocus={(event) => {
                          event.currentTarget.scrollIntoView({
                            block: "nearest",
                            inline: "nearest",
                          });
                        }}
                        type="button"
                      >
                        <span className="shrink-0 whitespace-nowrap leading-tight">
                          {screen.label}
                        </span>
                        {screen.count !== null ? (
                          <ScreenCountBadge
                            count={screen.count}
                            kind={screen.countKind}
                            noun={screen.countNoun}
                          />
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Edge fades assume LTR; the product ships LTR-only today. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-(--surface-panel) to-transparent",
                    compactRouteScrollEdges.start ? "opacity-100" : "opacity-0",
                  )}
                  data-job-finder-compact-navigation-fade-start
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-(--surface-panel) to-transparent",
                    compactRouteScrollEdges.end ? "opacity-100" : "opacity-0",
                  )}
                  data-job-finder-compact-navigation-fade-end
                />
              </div>
              <div className="relative z-10 shrink-0">
                <button
                  aria-expanded={isMoreOpen}
                  aria-label={`More${hiddenAttentionCount > 0 ? `: ${hiddenAttentionCount} need attention` : ""}`}
                  // The same pill as its neighbours. It used to be a bordered,
                  // filled, 4px-taller control in a row of flat text pills, so
                  // it read as a different class of thing; the icon and the
                  // active treatment are what mark it now.
                  className={cn(
                    COMPACT_NAV_PILL_CLASS,
                    menuGroups.some((group) =>
                      group.screens.some(
                        (screen) => activeScreen === screen.id,
                      ),
                    )
                      ? COMPACT_NAV_PILL_ACTIVE_CLASS
                      : "",
                  )}
                  onClick={() => {
                    moreMenuInitialFocusRef.current = "first";
                    setIsMoreOpen((open) => !open);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
                      return;
                    }
                    if (!isMoreOpen) {
                      event.preventDefault();
                      moreMenuInitialFocusRef.current =
                        event.key === "ArrowUp" ? "last" : "first";
                      setIsMoreOpen(true);
                    }
                  }}
                  ref={moreButtonRef}
                  title="More"
                  type="button"
                >
                  <Layers3 aria-hidden="true" className="size-3.5" />
                  {/* An icon-only control gave compact widths no readable
                      label; the accessible name still comes from aria-label. */}
                  <span
                    className="whitespace-nowrap leading-tight"
                    data-job-finder-compact-more-label
                  >
                    More
                  </span>
                  {hiddenAttentionCount > 0 ? (
                    <ScreenCountBadge
                      count={hiddenAttentionCount}
                      kind="attention"
                      noun="need you"
                    />
                  ) : null}
                </button>
                {isMoreOpen
                  ? createPortal(
                      <div
                        aria-label="More"
                        className="fixed z-[60] grid min-w-0 max-w-[calc(100vw-1rem)] grid-rows-[minmax(0,1fr)_auto] gap-1 overflow-hidden rounded-2xl border border-(--control-border) bg-(--surface-panel-raised) p-2 shadow-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150"
                        data-job-finder-more-menu
                        data-side={moreMenuPlacement?.side ?? "bottom"}
                        style={boundedFloatingSurfaceStyle(moreMenuPlacement)}
                        onKeyDown={(event) => {
                          if (event.key === "Tab") {
                            event.preventDefault();
                            closeMoreMenuAndMoveFocus(event.shiftKey ? -1 : 1);
                            return;
                          }
                          if (
                            event.key !== "ArrowDown" &&
                            event.key !== "ArrowUp" &&
                            event.key !== "Home" &&
                            event.key !== "End"
                          ) {
                            return;
                          }

                          // Roving order comes from the managed refs so the
                          // popover never needs menu semantics to stay
                          // keyboard-navigable.
                          const menuItems = moreMenuItemRefs.current.filter(
                            (element): element is HTMLElement =>
                              element instanceof HTMLElement,
                          );
                          if (menuItems.length === 0) {
                            return;
                          }

                          event.preventDefault();
                          const activeIndex = menuItems.findIndex(
                            (item) => item === document.activeElement,
                          );
                          const currentIndex =
                            activeIndex >= 0
                              ? activeIndex
                              : focusedMoreMenuItemIndex;
                          const nextIndex =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? menuItems.length - 1
                                : event.key === "ArrowDown"
                                  ? (currentIndex + 1) % menuItems.length
                                  : (currentIndex - 1 + menuItems.length) %
                                    menuItems.length;
                          setFocusedMoreMenuItemIndex(nextIndex);
                          menuItems[nextIndex]?.focus();
                        }}
                        ref={moreMenuRef}
                        role="navigation"
                      >
                        {/* The scroll row has to be a *bounded* box, not just
                            a `min-h-0` block: a plain block child sizes to its
                            content, so at short window heights the destination
                            list grew past this row, was clipped by the surface,
                            and painted across the footer entry — Settings and
                            Keyboard shortcuts overlapped and neither was
                            hittable. `grid-rows-[minmax(0,1fr)]` pins the
                            region to the row the surface actually has, which is
                            what makes `overflow-y-auto` below engage. */}
                        <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden">
                          <div
                            className="min-h-0 min-w-0 overflow-y-auto overscroll-contain"
                            data-job-finder-more-menu-scroll-region
                            ref={moreMenuScrollRef}
                          >
                            {menuGroups.map((group) => (
                              <div
                                key={group.label}
                                className="grid gap-1"
                                role="group"
                                aria-label={group.label}
                              >
                                <span className="px-3 pt-1 text-(length:--text-tiny) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                                  {group.label}
                                </span>
                                {group.screens.map((screen) => {
                                  const menuItemIndex =
                                    moreMenuItemIndexes.get(screen.id) ?? 0;
                                  return (
                                    <button
                                      aria-label={getScreenAccessibleName(
                                        screen.label,
                                        screen.count,
                                        screen.countKind,
                                        screen.countNoun,
                                      )}
                                      aria-current={
                                        activeScreen === screen.id
                                          ? "page"
                                          : undefined
                                      }
                                      key={screen.id}
                                      className={cn(
                                        "inline-flex min-h-10 min-w-0 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-(length:--text-small) font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-[899px]:min-h-8 max-[899px]:py-1",
                                        activeScreen === screen.id
                                          ? "bg-secondary text-foreground"
                                          : "",
                                      )}
                                      onClick={() => {
                                        setIsMoreOpen(false);
                                        handleScreenChange(screen.id);
                                      }}
                                      onFocus={() =>
                                        setFocusedMoreMenuItemIndex(
                                          menuItemIndex,
                                        )
                                      }
                                      ref={(element) => {
                                        moreMenuItemRefs.current[
                                          menuItemIndex
                                        ] = element;
                                      }}
                                      tabIndex={
                                        menuItemIndex ===
                                        focusedMoreMenuItemIndex
                                          ? 0
                                          : -1
                                      }
                                      type="button"
                                    >
                                      <span className="flex min-w-0 items-center gap-2">
                                        <screen.icon
                                          aria-hidden="true"
                                          className="size-4 shrink-0"
                                        />
                                        <span className="truncate">
                                          {screen.label}
                                        </span>
                                      </span>
                                      {screen.count !== null ? (
                                        <ScreenCountBadge
                                          count={screen.count}
                                          kind={screen.countKind}
                                          noun={screen.countNoun}
                                        />
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                          {/* Hints sit at the edge they describe; the previous
                            affordance printed "More content above ↑" in the
                            popover's bottom footer. */}
                          <BoundedFloatingSurfaceScrollHint
                            edge="start"
                            visible={
                              moreMenuScrollState.hasOverflow &&
                              !moreMenuScrollState.atStart
                            }
                          />
                          <BoundedFloatingSurfaceScrollHint
                            edge="end"
                            visible={
                              moreMenuScrollState.hasOverflow &&
                              !moreMenuScrollState.atEnd
                            }
                          />
                        </div>
                        {/* Reference material, not a destination: one row that
                            opens the shortcuts dialog, instead of the ~270px
                            shortcut table that stopped this menu from showing
                            its own destinations. */}
                        <button
                          className="inline-flex min-h-10 min-w-0 shrink-0 items-center justify-between gap-3 rounded-xl border-t border-(--surface-panel-border) px-3 py-2 text-left text-(length:--text-small) font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                          data-job-finder-more-menu-shortcuts-entry
                          onClick={openShortcutsDialog}
                          onFocus={() =>
                            setFocusedMoreMenuItemIndex(moreMenuItemCount)
                          }
                          ref={(element) => {
                            moreMenuItemRefs.current[moreMenuItemCount] =
                              element;
                          }}
                          tabIndex={
                            focusedMoreMenuItemIndex === moreMenuItemCount
                              ? 0
                              : -1
                          }
                          type="button"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <Keyboard
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                            <span className="truncate">
                              {JOB_FINDER_SHORTCUTS_DIALOG_LABEL}
                            </span>
                          </span>
                          <kbd className="inline-flex min-w-6 shrink-0 items-center justify-center rounded-(--radius-field) border border-(--surface-panel-border) bg-(--input) px-1.5 py-0.5 text-(length:--text-tiny) font-medium text-foreground">
                            ?
                          </kbd>
                        </button>
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            </div>
          </nav>

          <div
            aria-label="Notifications and actions"
            className={cn(
              // `sm:absolute sm:z-10` made this group its own stacking
              // context at layer 10, and the Tasks popover inside it declares
              // `z-40` precisely so it can sit over the page. Nested in a
              // z-10 ancestor that declaration could never take effect below
              // 1440px, where the group is not `static`. The group now sits on
              // the same layer the wide breakpoint already used, so the
              // popover hit-tests where it paints at every width.
              "col-span-2 col-start-1 row-start-3 flex min-w-0 items-center justify-center gap-1.5 pr-2 max-[899px]:gap-1 max-[899px]:pr-1 sm:absolute sm:z-40 sm:w-auto sm:justify-end min-[1440px]:gap-2 min-[1440px]:!static min-[1440px]:col-span-1 min-[1440px]:col-start-3 min-[1440px]:row-start-1",
              isMac
                ? "sm:right-0 sm:top-14 sm:h-[3.75rem] min-[900px]:!top-0 min-[900px]:!h-14"
                : "sm:right-0 sm:top-14 sm:h-[3.75rem] xl:top-0 xl:h-14 xl:mr-36 min-[1440px]:!z-40",
            )}
            ref={headerActionsRef}
            role="group"
            style={noDragRegionStyle}
          >
            <button
              aria-keyshortcuts={getJobFinderAriaKeyshortcuts(
                "mod+k",
                platform,
              )}
              aria-label={JOB_FINDER_GLOBAL_SEARCH_LABEL}
              className="inline-flex h-10 min-h-10 min-w-10 items-center justify-center rounded-(--radius-button) border border-(--control-border) bg-(--surface-panel) px-2 text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-[899px]:min-w-9 max-[899px]:px-1.5"
              onClick={openGlobalSearch}
              title={`${JOB_FINDER_GLOBAL_SEARCH_LABEL} (${formatJobFinderShortcutCombo("mod+k", platform)})`}
              type="button"
            >
              <Search aria-hidden="true" className="size-4 shrink-0" />
            </button>
            <JobFinderTaskCenter
              isDiscoveryPending={isDiscoveryPending}
              isResumeImportPending={isResumeImportPending}
              liveDiscoveryEvents={liveDiscoveryEvents}
              onCancelApplyRun={onCancelApplyRun}
              onCancelDiscovery={onCancelDiscovery}
              onNavigate={(path) => {
                if (onNavigate) {
                  onNavigate(path);
                } else {
                  void navigate(path);
                }
              }}
              onPrepareRemainingJobs={onPrepareRemainingJobs}
              onUndoRecentChange={onUndoRecentChange}
              resumeImportProgress={resumeImportProgress}
              workspace={workspace}
            />
            <AssistantToggle platform={platform} />
            <BrowserPeek
              onRecordSend={() => {
                void navigate("/job-finder/applications");
              }}
              chromeInsetStart={
                isMac && !windowControlsState.isFullScreen
                  ? MACOS_TRAFFIC_LIGHT_INSET
                  : undefined
              }
              hasUnresolvedAttention={countNeedsYou(workspace) > 0}
            />
            {actionScreen ? (
              <button
                aria-current={activeScreen === "actions" ? "page" : undefined}
                aria-label={`Needs you: ${actionScreen.count ?? 0} unresolved`}
                className={cn(
                  "inline-flex h-10 min-h-10 min-w-10 items-center justify-center gap-2 rounded-(--radius-button) border border-(--control-border) bg-(--surface-panel) px-2.5 py-2 text-(length:--text-small) font-medium text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 min-[1440px]:px-3 max-[899px]:gap-1 max-[899px]:px-2",
                  activeScreen === "actions"
                    ? "border-(--nav-active-bar) bg-(--nav-active-surface) font-semibold text-(--nav-active-foreground)"
                    : "",
                )}
                onClick={() => handleScreenChange("actions")}
                title={`Needs you: ${actionScreen.count ?? 0} unresolved`}
                type="button"
              >
                <BellRing aria-hidden="true" className="size-4 shrink-0" />
                {/* A bare bell and a number read as an unlabelled glyph pill
                    beside the task-center pill. The compact navigation row
                    reserves the width this label needs. */}
                <span className="hidden whitespace-nowrap min-[900px]:inline max-[1099px]:!hidden xl:max-[1440px]:!hidden">
                  Needs you
                </span>
                {actionScreen.count !== null ? (
                  <ScreenCountBadge
                    count={actionScreen.count}
                    kind="attention"
                    noun={actionScreen.countNoun}
                  />
                ) : null}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <aside
        aria-label="Job Finder sidebar"
        // The rail owns its own vertical scrolling: at short window heights the
        // journey plus every secondary destination is taller than the column,
        // and a clipped rail hides real destinations. `overflow-hidden` here
        // keeps the pinned toggle row out of that inner scroller.
        className={SHELL_SIDEBAR_CLASS}
        data-job-finder-sidebar
      >
        <div
          className={cn(
            "flex h-full min-h-0 flex-col",
            isSidebarCollapsed ? "px-2 py-3" : "px-4 py-4",
          )}
        >
          <div
            className={cn(
              "mb-1 flex h-10 shrink-0 items-center",
              isSidebarCollapsed ? "justify-center" : "justify-between",
            )}
            data-job-finder-sidebar-toggle
            style={{ ...noDragRegionStyle }}
          >
            {!isSidebarCollapsed ? (
              <span className="job-finder-sidebar-heading">
                Your job search
              </span>
            ) : null}
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  aria-keyshortcuts={getJobFinderAriaKeyshortcuts(
                    "mod+b",
                    platform,
                  )}
                  aria-label={
                    isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
                  }
                  className="flex size-9 items-center justify-center rounded-(--radius-field) text-foreground-muted outline-none transition-colors hover:bg-(--surface-panel-raised) hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  onClick={toggleSidebar}
                  type="button"
                >
                  <Menu aria-hidden="true" className="size-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side={isSidebarCollapsed ? "right" : "bottom"}>
                {`${isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} · ${formatJobFinderShortcutCombo("mod+b", platform)}`}
              </TooltipContent>
            </Tooltip>
          </div>
          <nav
            aria-label="Job Finder sidebar destinations"
            className={cn(
              // `content-start` keeps the grid rows at their own height once the
              // nav becomes the flexible scroll owner, so a short list is not
              // stretched down the column.
              "grid min-h-0 min-w-0 flex-1 content-start overflow-x-hidden overflow-y-auto overscroll-contain",
              isSidebarCollapsed ? "gap-2" : "gap-4",
            )}
            data-job-finder-sidebar-scroll-region
          >
            {sidebarGroups.map((group) => (
              <section
                key={group.label}
                aria-label={group.label}
                className="grid min-w-0 gap-1"
                role="group"
              >
                {/* The group name remains available to assistive technology. */}
                <div
                  className={cn(
                    "grid min-w-0 overflow-hidden",
                    isSidebarCollapsed ? "gap-1.5" : "gap-0.5",
                  )}
                >
                  {group.screens.map((screen) =>
                    renderSidebarDestination(screen),
                  )}
                </div>
              </section>
            ))}
          </nav>
          <div
            aria-label="Workspace"
            className={cn(
              "mt-2 flex min-w-0 shrink-0 border-t border-(--surface-panel-border) pt-2",
              isSidebarCollapsed
                ? "flex-col-reverse gap-0.5"
                : "flex-wrap items-center gap-1",
            )}
            data-job-finder-sidebar-footer
            role="group"
          >
            {/* Settings is the last thing on the rail, pinned under the
                journey rather than scrolling with it, with the shortcuts
                reference as one small control beside it (above it on the
                collapsed rail, so the gear stays at the very bottom). */}
            {/* Safeguards sits quietly above Settings (ordered last in the
                collapsed column, which is reversed), so the person can always
                reach it. It carries no count: what it blocks shows in
                Activity. */}

            <div className={cn("min-w-0", !isSidebarCollapsed && "flex-1")}>
              {settingsScreen ? renderSidebarDestination(settingsScreen) : null}
            </div>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  aria-keyshortcuts={getJobFinderAriaKeyshortcuts(
                    "?",
                    platform,
                  )}
                  aria-label={JOB_FINDER_SHORTCUTS_DIALOG_LABEL}
                  className={cn(
                    isSidebarCollapsed
                      ? cn(
                          SHELL_SIDEBAR_ROW_CLASS,
                          SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
                        )
                      : SHELL_SIDEBAR_SHORTCUTS_BUTTON_CLASS,
                    SHELL_SIDEBAR_ROW_INACTIVE_CLASS,
                  )}
                  data-job-finder-sidebar-shortcuts-entry
                  onClick={openShortcutsDialog}
                  type="button"
                >
                  <Keyboard aria-hidden="true" className="size-4 shrink-0" />
                  <span className="sr-only">
                    {JOB_FINDER_SHORTCUTS_DIALOG_LABEL}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {`${JOB_FINDER_SHORTCUTS_DIALOG_LABEL} · ?`}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </aside>

      {saveState && onRetrySave ? (
        <JobFinderSaveStatus
          layoutKey={location.pathname}
          onDismissSaved={onDismissSavedStatus}
          onRetry={onRetrySave}
          saveState={saveState}
        />
      ) : null}

      {isGlobalSearchOpen ? (
        <JobFinderGlobalSearchDialog
          entries={loadGlobalSearchEntries}
          focusRequest={globalSearchFocusRequest}
          onClose={() => setIsGlobalSearchOpen(false)}
          onNavigate={handleGlobalSearchNavigate}
        />
      ) : null}

      <JobFinderShortcutsDialog
        onClose={() => setIsShortcutsDialogOpen(false)}
        open={isShortcutsDialogOpen}
        platform={platform}
      />

      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        ref={routeAnnouncementRef}
        role="status"
      />

      {/* Content passes under the fixed header with no seam, so a title or a
          card sitting at the boundary paints sliced through its glyphs. The
          mask is opaque across exactly the shell's 12px top gutter and stops
          there: a fade tail past the gutter sat over the first row of every
          route at scroll 0 and read as a shadow across its buttons and text. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none fixed inset-x-0 top-[7.25rem] z-30 hidden sm:block xl:top-14 min-[1440px]:left-(--job-finder-side-width)",
          SHELL_HEADER_MASK_HEIGHT_CLASS,
          "bg-(--shell-header-bg)",
        )}
        data-job-finder-shell-header-mask
      />
      {/* The assistant docks on the right; the content gives it its width
          instead of being covered (ADR 0037). */}
      <AssistantSidebar />
      <div
        className={SHELL_CONTENT_CLASS}
        data-job-finder-shell-content
        style={{
          paddingRight: "var(--assistant-sidebar-reserved, 0px)",
        }}
      >
        <main
          aria-label={activeScreenLabel}
          className={
            usesLockedScreenLayout
              ? SHELL_MAIN_LOCKED_CLASS
              : SHELL_MAIN_SCROLLING_CLASS
          }
          onScroll={(event) => {
            isMainScrolledRef.current = event.currentTarget.scrollTop > 0;
          }}
          ref={mainRef}
          tabIndex={-1}
        >
          <div
            className={cn(
              SHELL_ROUTE_CONTAINER_BASE_CLASS,
              usesLockedScreenLayout ? "h-full min-h-0" : "min-h-full",
            )}
            data-job-finder-route-container
            ref={routeContainerRef}
            // One rhythm token for every route root, declared by the wrapper
            // that owns the route rather than picked per screen.
            style={SHELL_ROUTE_SECTION_GAP_STYLE}
          >
            {/* Each screen mounts fresh per path inside the outlet, except
                the kept lists, so the container itself is not keyed. */}
            <StartupResetRecoveryBanner key={location.pathname} />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
