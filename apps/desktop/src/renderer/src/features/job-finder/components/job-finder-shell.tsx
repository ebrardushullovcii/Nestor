import { lazy, Suspense, type CSSProperties, type ReactNode } from "react";
import { animateIn, ENTER_FROM_BELOW } from "@renderer/lib/motion";
import { BrowserPeek } from "./browser-peek";
import { AssistantSidebarSlot } from "../assistant/assistant-sidebar-slot";
import { SpeedTip } from "./speed-tip";
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
import {
  BellRing,
  ClipboardCheck,
  Compass,
  FileText,
  House,
  Keyboard,
  Minus,
  PanelLeft,
  Search,
  Settings,
  Square,
  UserRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  DesktopWindowControlsState,
  JobStageCounts,
  LaunchContext,
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
import { JOB_FINDER_GLOBAL_SEARCH_LABEL } from "../lib/job-finder-global-search";
import {
  createSharedRouteLoader,
  lazyScreen,
  preloadWhenIdle,
} from "@renderer/lib/lazy-screen";
import { JobFinderTaskCenter } from "./task-center/job-finder-task-center";
import { toDestinationBadgeCount } from "../lib/destination-counts";
import {
  SHELL_HEADER_MASK_HEIGHT_CLASS,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS,
} from "../lib/job-finder-shell-gutters";
import {
  SCREEN_ENTRIES,
  searchSavedJobs,
} from "../lib/build-job-finder-global-search-entries";
import type { JobFinderGlobalSearchEntry } from "../lib/job-finder-global-search";
import {
  formatJobFinderShortcutCombo,
  getJobFinderShortcutKeycaps,
  getJobFinderAriaKeyshortcuts,
} from "../lib/job-finder-shortcuts";
import { useJobFinderShellShortcuts } from "../lib/use-job-finder-shell-shortcuts";
import { useHistoryNavigationShortcuts } from "../lib/use-history-navigation-shortcuts";
import { getDefaultProfileRoute } from "../lib/job-finder-utils";
import { JobFinderShellBrand } from "./job-finder-shell-brand";
import { installScrollActivity } from "@renderer/lib/scroll-activity";
import {
  HEADER_TOOL_ACTIVE_CLASS,
  HEADER_TOOL_CLASS,
  HEADER_TOOL_COUNTED_LABEL_CLASS,
  HEADER_TOOL_ICON_CLASS,
  HEADER_TOOL_LABEL_CLASS,
} from "./header-tool";
import { HeaderToolCount } from "./header-tool-count";
import {
  JOB_FINDER_SHORTCUTS_DIALOG_LABEL,
  JobFinderShortcutsDialog,
} from "./job-finder-shortcuts-dialog";

// The reset notice reads its state after the first screen, so its code (and
// the schema it checks that state with) loads then too.
const StartupResetRecoveryBanner = lazy(async () => ({
  default: (await import("./startup-reset-recovery-banner"))
    .StartupResetRecoveryBanner,
}));

interface JobFinderShellProps {
  children: ReactNode;
  onNavigate?: (path: string) => void;
  platform: "darwin" | "linux" | "win32";
  /** Jobs per stage in the job store, for the list badges. */
  stageCounts?: JobStageCounts | null;
  needsYouCount?: number;
  /** Settings and setup state read at launch. */
  startupContext?: LaunchContext | null;
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

export const LOCKED_LAYOUT_SCREENS: readonly JobFinderScreen[] = [
  "profile",
  "discovery",
  "review-queue",
  "applications",
  "actions",
];

// The main window is frameless on Windows (`frame: !(isMac || isWindows)` in
// main/setup/window-shell.ts) and this header paints its own caption buttons,
// so there is no Window Controls Overlay and no `env(titlebar-area-*)` to read.
// The reserved width is therefore the exact width of the buttons rendered
// below: minimize (w-11) + maximize (w-11) + close (w-12) = 8.5rem.
const WINDOWS_CAPTION_CONTROLS_INSET = "8.5rem";
// macOS uses `titleBarStyle: "hiddenInset"`, so the native traffic lights are
// painted over the left edge of this header outside native fullscreen.
const MACOS_TRAFFIC_LIGHT_INSET = "5.5rem";
/**
 * Below this window width the sidebar is always the icon rail: one navigation
 * model at every width, never a strip of top tabs.
 */
export const SIDEBAR_RAIL_MAX_WIDTH_PX = 1199;
const SIDEBAR_EXPANDED_WIDTH = "13.5rem";
const SIDEBAR_RAIL_WIDTH = "3.75rem";

function useIsNarrowWindow(): boolean {
  const query = `(max-width: ${SIDEBAR_RAIL_MAX_WIDTH_PX}px)`;
  const [narrow, setNarrow] = useState(() => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);
  return narrow;
}

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
 * A destination count sits in a fixed-width right column of its row, in
 * tabular figures, so a count changing from 9 to 10 or appearing at all never
 * moves the label. It follows the row's colour (muted at rest).
 */
export const DESTINATION_COUNT_INLINE_LAYOUT_CLASS =
  "ml-auto w-9 shrink-0 justify-end text-current";
/**
 * The attention state (Needs you): the same slot, in the warning colours, so
 * "work waiting on you" is told apart from inventory before reading.
 */
export const DESTINATION_COUNT_ATTENTION_CLASS =
  "ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-(--warning-surface) px-1.5 text-xs font-medium text-(--warning-text) tabular-nums";
/**
 * On the icon rail every count moves to its own line under the icon, inside
 * the 44px item: two and three digits and "999+" fit without touching the
 * glyph or being cut by the rail's edge.
 */
export const DESTINATION_COUNT_RAIL_MARKER_LAYOUT_CLASS = "shrink-0";

/* ------------------------------------------------------------------------ *
 * Shell chrome.
 *
 * One navigation model at every width: a 48px header row and a left sidebar
 * that is a 216px list of one-line destinations, or a 60px icon rail below
 * 1200px and while the assistant is docked. There is no top-tab strip.
 * ------------------------------------------------------------------------ */

export const SHELL_HEADER_CLASS =
  "@container/shell-header relative z-50 h-12 shrink-0 overflow-visible border-b border-(--border-subtle) bg-(--shell-header-bg) sm:fixed sm:inset-x-0 sm:top-0";
export const SHELL_HEADER_GRID_CLASS =
  "job-finder-shell-grid grid h-12 grid-rows-[3rem] items-center overflow-visible pl-2 pr-2 sm:pl-3 sm:pr-3";
export const SHELL_BRAND_ROW_CLASS =
  "col-start-1 row-start-1 flex h-12 min-w-0 items-center";
export const SHELL_SIDEBAR_CLASS =
  "fixed bottom-0 left-0 top-12 z-40 hidden w-(--job-finder-side-width) overflow-hidden border-r border-(--border-subtle) bg-(--sidebar-bg) transition-[width] duration-(--duration-base) ease-(--ease-standard) sm:block";
/** One-line 36px destination: icon, label, right-aligned count. */
export const SHELL_SIDEBAR_ROW_CLASS =
  "job-finder-sidebar-row relative inline-flex h-9 w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden rounded-(--radius-button) px-2.5 text-left text-sm font-normal text-foreground-soft outline-none transition-colors duration-(--duration-fast) focus-ring";
/**
 * A rail item: the icon at a fixed height and a line under it for a count,
 * so every icon on the rail sits at the same place whether or not its
 * destination has a count.
 */
export const SHELL_SIDEBAR_ROW_COLLAPSED_CLASS =
  "h-11 flex-col justify-start gap-0.5 px-0 pt-2 text-center";
// The keyboard-shortcuts reference is one small square beside Settings at the
// foot of the sidebar: it opens a dialog, so it is not a destination row.
export const SHELL_SIDEBAR_SHORTCUTS_BUTTON_CLASS =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-button) text-foreground-soft outline-none transition-colors duration-(--duration-fast) focus-ring";
export const SHELL_SIDEBAR_ROW_INACTIVE_CLASS =
  "hover:bg-accent hover:text-foreground active:bg-pressed";
// The selected destination: accent tint, a 2px accent bar on the leading
// edge (drawn inside the box, so nothing moves), medium weight, accent icon.
// Identical in both themes.
export const SHELL_SIDEBAR_ROW_ACTIVE_CLASS =
  "selected-bar bg-(--nav-active-surface) font-medium text-(--nav-active-foreground) [&>svg]:text-primary [&>span>svg]:text-primary";

export function SidebarDestinationLabel({
  label,
  collapsed,
}: {
  label: string;
  collapsed: boolean;
}) {
  return (
    <span className={cn("min-w-0 flex-1 truncate", collapsed && "sr-only")}>
      {label}
    </span>
  );
}
export const SHELL_ROOT_CLASS =
  "flex h-dvh min-h-0 flex-col overflow-hidden text-foreground";
export const SHELL_CONTENT_CLASS =
  "flex min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-(--duration-base) ease-(--ease-standard) sm:pt-12 sm:pl-(--job-finder-side-width)";
export const SHELL_MAIN_SCROLLING_CLASS = cn(
  "relative min-h-0 min-w-0 flex-1 overflow-x-hidden outline-none",
  "screen-scroll-area overflow-y-auto px-4 [scrollbar-gutter:stable]",
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
);
export const SHELL_MAIN_LOCKED_CLASS = cn(
  "relative min-h-0 min-w-0 flex-1 overflow-x-hidden outline-none",
  "overflow-hidden px-3 pb-3 pt-0 sm:px-4",
);
export const SHELL_ROUTE_CONTAINER_BASE_CLASS =
  "mx-auto w-full max-w-472 min-w-0";
/**
 * One vertical rhythm for every route root, declared by the wrapper so every
 * route root spends the same value.
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
    // The noun stays in the accessible name; the warning colours are what
    // tell a sighted reader this number is work waiting on them.
    return (
      <span aria-hidden="true" className={DESTINATION_COUNT_ATTENTION_CLASS}>
        {count.toLocaleString("en-US")}
        {noun ? <span className="sr-only"> {noun}</span> : null}
      </span>
    );
  }

  // Inventory, and every count on the rail: the shared primitive owns the
  // shape. It is announced through the row's own accessible name, never twice.
  return (
    <Count
      aria-hidden="true"
      className={
        markerOnly
          ? DESTINATION_COUNT_RAIL_MARKER_LAYOUT_CLASS
          : DESTINATION_COUNT_INLINE_LAYOUT_CLASS
      }
      value={count}
      variant={markerOnly ? "rail-marker" : "inline"}
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
    ? `${label}: ${count.toLocaleString()} ${noun ?? "need attention"}`
    : label;
}

/**
 * A destination count in words, exact and with what it counts ("2 to
 * review"): the row's accessible description and, with its label, its
 * tooltip, so a count that covers part of a screen says which part and a
 * rail figure shortened to "12.3k" has the exact number one hover away. The
 * accessible name stays the destination's own name.
 */
function describeScreenCount(screen: {
  count: number | null;
  countNoun?: string | undefined;
}): string | undefined {
  if (screen.count === null || screen.count <= 0) return undefined;
  return `${screen.count.toLocaleString()} ${screen.countNoun ?? ""}`.trimEnd();
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

// The search palette opens on Ctrl+K, never at launch: its code loads once
// the window is idle, so the first open is still immediate.
const loadGlobalSearchDialog = createSharedRouteLoader(async () => ({
  default: (await import("./job-finder-global-search"))
    .JobFinderGlobalSearchDialog,
}));
preloadWhenIdle([loadGlobalSearchDialog]);
const GlobalSearchDialog = lazyScreen(loadGlobalSearchDialog);

export function JobFinderShell({
  children,
  onNavigate,
  platform,
  stageCounts = null,
  needsYouCount = 0,
  startupContext = null,
}: JobFinderShellProps) {
  const settings = startupContext?.settings ?? {};
  const profileSetupState = startupContext?.profileSetupState ?? null;
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
    enabled: collapsesSideMenuWithAssistant(settings),
    isSideMenuCollapsed: isSidebarCollapsed,
    setSideMenuCollapsed: setIsSidebarCollapsed,
  });
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [globalSearchFocusRequest, setGlobalSearchFocusRequest] = useState(0);
  const [isShortcutsDialogOpen, setIsShortcutsDialogOpen] = useState(false);
  // Below 1200px the sidebar is always the rail; the person's own saved
  // preference applies again once the window is wide enough.
  const isNarrowWindow = useIsNarrowWindow();
  const isRail = isSidebarCollapsed || isNarrowWindow;
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
    /** What the count counts ("to review"): its description and tooltip. */
    countNoun?: string | undefined;
    /**
     * The count covers part of its screen (Shortlisted's To review tab,
     * Applications' sent ones): the full sidebar shows the noun at rest
     * ("2 to review"), so it never reads as the screen's whole total.
     */
    countScoped?: boolean;
    icon: LucideIcon;
  }

  // Every badge is the job store's own count for the list its destination
  // shows, so a badge and its page cannot disagree.
  const screenDefinitions = useMemo<readonly ShellScreenDefinition[]>(() => {
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
        count: toDestinationBadgeCount(stageCounts?.found ?? 0),
        countKind: "inventory",
        countNoun: "found",
        icon: Compass,
      },
      {
        id: "review-queue",
        label: "Shortlisted",
        // The screen's "To review" tab; approved resumes are its other tab.
        count: toDestinationBadgeCount(stageCounts?.shortlisted ?? 0),
        countKind: "inventory",
        countNoun: "to review",
        countScoped: true,
        icon: ClipboardCheck,
      },
      {
        id: "applications",
        label: "Applications",
        // Sent applications; the screen's All also counts ones still
        // being prepared.
        count: toDestinationBadgeCount(stageCounts?.applied ?? 0),
        countKind: "inventory",
        countNoun: "sent",
        countScoped: true,
        icon: FileText,
      },
      {
        id: "actions",
        label: "Needs you",
        count: toDestinationBadgeCount(needsYouCount),
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
  }, [stageCounts, needsYouCount]);

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
  // The sidebar's scrolling list is the journey alone. Settings is not a step
  // of it, so it is pinned at the foot of the sidebar with the
  // keyboard-shortcuts reference beside it, outside the scroll region.
  const settingsScreen = screenDefinitions.find(
    (screen) => screen.id === "settings",
  );
  const sidebarGroups = [
    {
      label: "Your job search",
      screens: primaryScreens,
    },
  ];

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
        ? profileSetupState
          ? getDefaultProfileRoute(profileSetupState)
          : "/job-finder/profile"
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
    setIsGlobalSearchOpen(true);
    setGlobalSearchFocusRequest((request) => request + 1);
  }

  function openShortcutsDialog() {
    setIsShortcutsDialogOpen(true);
  }

  function handleGlobalSearchNavigate(entry: JobFinderGlobalSearchEntry) {
    if (onNavigate) {
      onNavigate(entry.href);
      return;
    }
    void navigate(entry.href);
  }

  // One row treatment for every sidebar destination, so Settings at the foot
  // cannot drift from the journey rows. On the rail the label moves into a
  // tooltip and the count into a corner pill off the glyph.
  function renderSidebarDestination(screen: ShellScreenDefinition) {
    const isActive = activeScreen === screen.id;
    const row = (
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
          isRail && SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
          isActive
            ? SHELL_SIDEBAR_ROW_ACTIVE_CLASS
            : SHELL_SIDEBAR_ROW_INACTIVE_CLASS,
        )}
        key={isRail ? undefined : screen.id}
        onClick={() => handleScreenChange(screen.id)}
        // Inventory counts say what they count; attention counts already
        // do in their name.
        aria-description={
          screen.countKind === "inventory"
            ? describeScreenCount(screen)
            : undefined
        }
        // The rail's tooltip says it; the full sidebar names the count's
        // scope on hover.
        title={
          !isRail && describeScreenCount(screen)
            ? `${screen.label} · ${describeScreenCount(screen)}`
            : undefined
        }
        type="button"
      >
        <screen.icon aria-hidden="true" className="size-4 shrink-0" />
        {isRail ? (
          // The count's line under the icon; kept empty without a count.
          <span className="flex h-4 w-full justify-center" data-rail-count>
            {screen.count !== null ? (
              <ScreenCountBadge
                count={screen.count}
                kind={screen.countKind}
                markerOnly
                noun={screen.countNoun}
              />
            ) : null}
          </span>
        ) : null}
        <SidebarDestinationLabel collapsed={isRail} label={screen.label} />
        {!isRail && screen.count !== null && screen.countScoped ? (
          // The scope in words at rest: "2 to review", "1 sent".
          <span
            aria-hidden="true"
            className="ml-auto shrink-0 whitespace-nowrap text-(length:--text-small) tabular-nums text-current"
            data-sidebar-count-scoped
          >
            {screen.count.toLocaleString("en-US")}{" "}
            <span className="text-foreground-soft">{screen.countNoun}</span>
          </span>
        ) : !isRail && screen.count !== null ? (
          <ScreenCountBadge
            count={screen.count}
            kind={screen.countKind}
            markerOnly={false}
            noun={screen.countNoun}
          />
        ) : null}
      </button>
    );
    if (!isRail) return row;
    return (
      <Tooltip delayDuration={0} key={screen.id}>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right">
          {describeScreenCount(screen)
            ? `${screen.label} · ${describeScreenCount(screen)}`
            : screen.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  useJobFinderShellShortcuts({
    isOverlayOpen: isGlobalSearchOpen || isShortcutsDialogOpen,
    isSearchOpen: isGlobalSearchOpen,
    onOpenGlobalSearch: openGlobalSearch,
    onOpenShortcuts: openShortcutsDialog,
    ...(assistant ? { onToggleAssistant: assistant.toggle } : {}),
    onToggleSidebar: toggleSidebar,
  });
  useHistoryNavigationShortcuts(stepHistory);
  // Scroll areas show their thumb while they scroll (styles/globals.css).
  useEffect(() => installScrollActivity(), []);
  useEffect(
    // A clicked "Search finished" notice opens the screen it is about.
    () =>
      window.nestor?.jobFinder?.onOpenRoute?.((route) => void navigate(route)),
    [navigate],
  );

  const sideWidth = isRail ? SIDEBAR_RAIL_WIDTH : SIDEBAR_EXPANDED_WIDTH;
  const needsYouBadge = actionScreen?.count ?? 0;
  const needsYouActive = activeScreen === "actions";

  return (
    <div
      data-job-finder-shell
      data-sidebar-collapsed={isRail ? "true" : "false"}
      className={cn(SHELL_ROOT_CLASS, `platform-${platform}`)}
      style={
        {
          "--job-finder-side-width": sideWidth,
        } as CSSProperties
      }
    >
      {/* The first thing Tab reaches, and the only way past the chrome
          without walking it. Visible only while focused. */}
      <button
        className="sr-only z-[100] rounded-(--radius-button) bg-popover px-4 py-2 text-(length:--text-small) font-medium text-foreground shadow-lg outline-none focus-ring focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3"
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
              // Keep clear of the macOS traffic lights in normal and
              // maximized windows, then reclaim the space in native fullscreen.
              paddingInlineStart:
                isMac && !windowControlsState.isFullScreen
                  ? MACOS_TRAFFIC_LIGHT_INSET
                  : undefined,
            }}
          >
            <div
              className="flex min-w-0 items-center"
              data-desktop-brand-region
            >
              <JobFinderShellBrand
                moduleSwitch={{
                  onSelectModule: handleModuleSelect,
                  style: noDragRegionStyle,
                }}
              />
            </div>
          </div>

          {/* The header tools: quiet ghost buttons of fixed width, icons only
              below 75rem of header (1200px at default text) with the name
              in a tooltip, counts in corner badges
              off the glyph so nothing moves when a count appears. */}
          <div
            aria-label="Notifications and actions"
            // Above the brand row: in a window narrower than the app's
            // own minimum (zoomed text), the brand's words can run under
            // the tools, and the tools must still take the click.
            className="relative z-10 col-start-2 row-start-1 flex h-12 min-w-0 items-center justify-end gap-1"
            data-header-tools
            role="group"
            style={{
              ...noDragRegionStyle,
              // The last tool's corner count pill (6px past the button)
              // keeps at least 8px from the window's edge.
              marginInlineEnd: isWindows
                ? WINDOWS_CAPTION_CONTROLS_INSET
                : "0.5rem",
            }}
          >
            <button
              aria-keyshortcuts={getJobFinderAriaKeyshortcuts(
                "mod+k",
                platform,
              )}
              aria-label={JOB_FINDER_GLOBAL_SEARCH_LABEL}
              className={HEADER_TOOL_CLASS}
              onClick={openGlobalSearch}
              title={`${JOB_FINDER_GLOBAL_SEARCH_LABEL} (${formatJobFinderShortcutCombo("mod+k", platform)})`}
              type="button"
            >
              <Search aria-hidden="true" className="size-4 shrink-0" />
              <span className={HEADER_TOOL_LABEL_CLASS}>Search</span>
              {/* Key chips joined by "+", as every shortcut is written. */}
              <span
                aria-hidden="true"
                className="hidden items-center gap-0.5 @min-[75rem]/shell-header:inline-flex"
              >
                {getJobFinderShortcutKeycaps("mod+k", platform).map(
                  (keycap, index) => (
                    <span
                      className="inline-flex items-center gap-0.5"
                      key={keycap}
                    >
                      {index > 0 ? (
                        <span className="text-xs leading-4 text-muted-foreground">
                          +
                        </span>
                      ) : null}
                      <kbd className="rounded-(--radius-small) border border-(--border-subtle) px-1 text-xs leading-4 font-normal text-muted-foreground">
                        {keycap}
                      </kbd>
                    </span>
                  ),
                )}
              </span>
            </button>
            <JobFinderTaskCenter
              onNavigate={(path) => {
                if (onNavigate) {
                  onNavigate(path);
                } else {
                  void navigate(path);
                }
              }}
            />
            <AssistantToggle platform={platform} />
            <BrowserPeek
              onRecordSend={() => {
                void navigate("/job-finder/applications");
              }}
              onOpenApplication={(jobId) => {
                void navigate(`/job-finder/applications?jobId=${jobId}`);
              }}
              chromeInsetStart={
                isMac && !windowControlsState.isFullScreen
                  ? MACOS_TRAFFIC_LIGHT_INSET
                  : undefined
              }
              hasUnresolvedAttention={needsYouCount > 0}
            />
            {actionScreen ? (
              <button
                aria-current={needsYouActive ? "page" : undefined}
                aria-label={`Needs you: ${needsYouBadge} unresolved`}
                className={cn(
                  HEADER_TOOL_CLASS,
                  needsYouActive && HEADER_TOOL_ACTIVE_CLASS,
                )}
                onClick={() => handleScreenChange("actions")}
                title={`Needs you: ${needsYouBadge} unresolved`}
                type="button"
              >
                {/* On the bell's corner, inside the button: the pill keeps
                    10px from the window's top edge. */}
                <span className={HEADER_TOOL_ICON_CLASS}>
                  <BellRing aria-hidden="true" className="size-4 shrink-0" />
                  <HeaderToolCount count={needsYouBadge} tone="attention" />
                </span>
                <span className={HEADER_TOOL_COUNTED_LABEL_CLASS}>
                  Needs you
                </span>
              </button>
            ) : null}
          </div>

          {isWindows ? (
            <div
              className="absolute right-0 top-0 z-40 flex h-12 items-stretch"
              role="group"
              aria-label="Window controls"
              style={noDragRegionStyle}
            >
              <Button
                aria-label="Minimize window"
                className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
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
                className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
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
      </header>

      <aside
        aria-label="Job Finder sidebar"
        // The sidebar owns its own vertical scrolling: at short window heights
        // the journey is taller than the column, and a clipped list hides
        // real destinations. The pinned foot stays out of that scroller.
        className={SHELL_SIDEBAR_CLASS}
        data-job-finder-sidebar
      >
        <div
          className="flex h-full min-h-0 flex-col px-2 py-2"
          // Expanded, the menu is laid out at its full width from the first
          // frame and the sidebar's growing edge uncovers it, as a drawer
          // opens: labels never show cut short ("Fin…") while it widens.
          style={
            isRail
              ? undefined
              : { width: `calc(${SIDEBAR_EXPANDED_WIDTH} - 1px)` }
          }
        >
          <nav
            aria-label="Job Finder sidebar destinations"
            data-scroll-gutter="none"
            className="grid min-h-0 min-w-0 flex-1 content-start gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain"
            data-job-finder-sidebar-scroll-region
          >
            {sidebarGroups.map((group) => (
              <section
                key={group.label}
                aria-label={group.label}
                className={cn(
                  "grid min-w-0 gap-0.5",
                  isRail && "overflow-visible",
                )}
                role="group"
              >
                {group.screens.map((screen) =>
                  renderSidebarDestination(screen),
                )}
              </section>
            ))}
          </nav>
          <div
            aria-label="Workspace"
            className={cn(
              "mt-2 flex min-w-0 shrink-0 border-t border-(--border-subtle) pt-2",
              isRail ? "flex-col gap-0.5" : "items-center gap-0.5",
            )}
            data-job-finder-sidebar-footer
            role="group"
          >
            <div className={cn("min-w-0", !isRail && "flex-1")}>
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
                    isRail
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
              <TooltipContent side={isRail ? "right" : "top"}>
                {`${JOB_FINDER_SHORTCUTS_DIALOG_LABEL} · ?`}
              </TooltipContent>
            </Tooltip>
            {/* The fold control. Below 1200px the rail is the only layout, so
                the control is not offered there. */}
            {isNarrowWindow ? null : (
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
                    className={cn(
                      isRail
                        ? cn(
                            SHELL_SIDEBAR_ROW_CLASS,
                            SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
                          )
                        : SHELL_SIDEBAR_SHORTCUTS_BUTTON_CLASS,
                      SHELL_SIDEBAR_ROW_INACTIVE_CLASS,
                    )}
                    data-job-finder-sidebar-toggle
                    onClick={toggleSidebar}
                    type="button"
                  >
                    <PanelLeft aria-hidden="true" className="size-4 shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side={isRail ? "right" : "top"}>
                  {`${isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} · ${formatJobFinderShortcutCombo("mod+b", platform)}`}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </aside>

      {isGlobalSearchOpen ? (
        <Suspense fallback={null}>
          <GlobalSearchDialog
            entries={SCREEN_ENTRIES}
            searchMore={searchSavedJobs}
            focusRequest={globalSearchFocusRequest}
            onClose={() => setIsGlobalSearchOpen(false)}
            onNavigate={handleGlobalSearchNavigate}
          />
        </Suspense>
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

      {/* Content passes under the fixed header with no seam; the mask is
          opaque across exactly the shell's 12px top gutter and stops there. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none fixed right-0 top-12 left-(--job-finder-side-width) z-30 hidden sm:block",
          SHELL_HEADER_MASK_HEIGHT_CLASS,
          "bg-(--background)",
        )}
        data-job-finder-shell-header-mask
      />
      {/* The assistant docks on the right; the content gives it its width
          instead of being covered (ADR 0037). */}
      <AssistantSidebarSlot />
      <SpeedTip />
      <div
        className={SHELL_CONTENT_CLASS}
        data-job-finder-shell-content
        style={{
          paddingRight: "var(--assistant-sidebar-reserved, 0px)",
          // With enlarged text a toast takes a band below the content
          // instead of covering it (components/ui/toast.tsx).
          paddingBottom: "var(--toast-band, 0px)",
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
            style={SHELL_ROUTE_SECTION_GAP_STYLE}
          >
            {/* Each screen mounts fresh per path inside the outlet, except
                the kept lists, so the container itself is not keyed. */}
            <Suspense fallback={null}>
              <StartupResetRecoveryBanner key={location.pathname} />
            </Suspense>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
