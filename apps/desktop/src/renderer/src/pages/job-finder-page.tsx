import { AssistantProvider } from "../features/job-finder/assistant/assistant-provider";
import {
  COMPACT_NAV_PILL_ACTIVE_CLASS,
  COMPACT_NAV_PILL_CLASS,
  getInitialSidebarCollapsedState,
  JobFinderShell,
  LOCKED_LAYOUT_SCREENS,
  SHELL_BRAND_ROW_CLASS,
  SHELL_CONTENT_CLASS,
  SHELL_HEADER_CLASS,
  SHELL_HEADER_GRID_CLASS,
  SHELL_MAIN_LOCKED_CLASS,
  SHELL_MAIN_SCROLLING_CLASS,
  SHELL_ROOT_CLASS,
  SHELL_ROUTE_CONTAINER_BASE_CLASS,
  SHELL_ROUTE_SECTION_GAP_STYLE,
  SHELL_SIDEBAR_CLASS,
  SHELL_SIDEBAR_ROW_ACTIVE_CLASS,
  SHELL_SIDEBAR_ROW_CLASS,
  SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
  SHELL_SIDEBAR_SHORTCUTS_BUTTON_CLASS,
  SHELL_SIDEBAR_ROW_INACTIVE_CLASS,
  ScreenCountBadge,
  SidebarDestinationLabel,
} from "@renderer/features/job-finder/components/job-finder-shell";
import {
  readLaunchDestinationCount,
  startLaunchReads,
  useLaunchReads,
} from "@renderer/features/job-finder/lib/launch-reads";
import { JobSearchHomeLaunch } from "@renderer/features/job-finder/screens/job-search-home/job-search-home-launch";
import {
  FindJobsLaunch,
  selectFindJobsLaunchPage,
} from "@renderer/features/job-finder/screens/discovery/find-jobs-launch";
import { JobFinderShellBrand } from "@renderer/features/job-finder/components/job-finder-shell-brand";
import { SourceCheckQueueRunner } from "@renderer/features/job-finder/lib/source-check-queue-runner";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { JOB_FINDER_SHORTCUTS_DIALOG_LABEL } from "@renderer/features/job-finder/components/job-finder-shortcuts-dialog";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import {
  getRouteSkeletonPanes,
  RouteSkeleton,
} from "@renderer/features/job-finder/components/route-skeleton";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { SHELL_HEADER_MASK_HEIGHT_CLASS } from "@renderer/features/job-finder/lib/job-finder-shell-gutters";
import { cn } from "@renderer/lib/cn";
import { StartupDatabaseRecoveryNotice } from "@renderer/features/job-finder/components/startup-database-recovery-notice";
import { ThemeProvider } from "@renderer/app/theme-provider";
import { Button } from "@renderer/components/ui/button";
import { useModalFocusTrap } from "@renderer/features/job-finder/components/profile/use-modal-focus-trap";
import {
  ClipboardCheck,
  Compass,
  FileText,
  House,
  Keyboard,
  Menu,
  Minus,
  Settings,
  Square,
  UserRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DesktopWindowControlsState } from "@nestor/contracts";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useDismissToastsOnScreenChange } from "@renderer/components/ui/toast";
import { buildJobFinderStartupDatabaseRecoveryBlockedDetail } from "../../../shared/job-finder-startup-db-recovery";
import { WorkspaceStateScreen } from "./job-finder-page-routes";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import { JobFinderUnsavedChangesDialog } from "./job-finder-unsaved-changes-dialog";
import { JobFinderWindowCloseGuard } from "./job-finder-window-close-guard";
import { JobFinderKeptRoutesOutlet } from "./job-finder-kept-routes";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type { RecentChange } from "@renderer/features/job-finder/lib/recent-changes";
import {
  type ApplyCopilotVisualCheckpointRequest,
  useJobFinderPageController,
} from "./use-job-finder-page-controller";

export {
  JobFinderActionsRoute,
  JobFinderApplicationsRoute,
  JobFinderCampaignsRoute,
  JobFinderDiscoveryRoute,
  JobFinderHomeRoute,
  JobFinderProfileRoute,
  JobFinderProfileSetupRoute,
  JobFinderRouteErrorBoundary,
  JobFinderResumeWorkspaceRoute,
  JobFinderReviewQueueRoute,
  JobFinderSettingsRoute,
} from "./job-finder-page-routes";
export type { JobFinderPageContext } from "./job-finder-page-context";

/**
 * Exactly one window-close responder stays mounted across every render state
 * of this page (loading, both post-ready error branches, loaded shell). It is
 * always the stable first child of the returned tree, so React preserves its
 * subscription and any parked close dialog across branch switches instead of
 * tearing the handshake down mid-decision.
 */
function withJobFinderWindowCloseGuard(content: ReactNode): ReactNode {
  return (
    <>
      <JobFinderWindowCloseGuard />
      {content}
    </>
  );
}

function markJobFinderTiming(markName: string, startMarkName?: string) {
  const performanceApi = globalThis.performance;
  if (!performanceApi?.mark) {
    return;
  }

  performanceApi.mark(markName);
  if (startMarkName && performanceApi.measure) {
    try {
      performanceApi.measure(markName, startMarkName, markName);
    } catch {
      // Performance diagnostics must never affect rendering or navigation.
    }
  }
}

function measureFromLatestJobFinderMark(
  measureName: string,
  startMarkName: string,
  endMarkName: string,
) {
  const performanceApi = globalThis.performance;
  if (!performanceApi?.getEntriesByName || !performanceApi.measure) {
    return;
  }

  const starts = performanceApi.getEntriesByName(startMarkName);
  const ends = performanceApi.getEntriesByName(endMarkName);
  const start = starts.at(-1);
  const end = ends.at(-1);
  if (!start || !end) {
    return;
  }

  try {
    performanceApi.measure(measureName, {
      start: start.startTime,
      end: end.startTime,
    });
  } catch {
    // Performance diagnostics must never affect rendering or navigation.
  }
}

function JobFinderRouteReadyMarker() {
  const location = useLocation();

  useEffect(() => {
    const routePath = location.pathname;
    const routeMark = `job-finder:route:${routePath}:meaningful-paint`;
    markJobFinderTiming(
      routeMark,
      `job-finder:route:${routePath}:navigation-start`,
    );
  }, [location.pathname]);

  return null;
}

const openingShellPrimaryDestinations: readonly {
  icon: LucideIcon;
  label: string;
  path: string;
}[] = [
  { icon: House, label: "Home", path: "/job-finder/home" },
  { icon: UserRound, label: "Profile", path: "/job-finder/profile" },
  { icon: Compass, label: "Find jobs", path: "/job-finder/discovery" },
  {
    icon: ClipboardCheck,
    label: "Shortlisted",
    path: "/job-finder/review-queue",
  },
  {
    icon: FileText,
    label: "Applications",
    path: "/job-finder/applications",
  },
];
const openingShellFooterDestinations: readonly {
  icon: LucideIcon;
  label: string;
  path: string;
}[] = [
  {
    icon: Settings,
    label: "Settings",
    path: "/job-finder/settings",
  },
];

// One journey group, exactly as the loaded shell's `sidebarGroups`. Home used
// to sit alone under an "Overview" eyebrow here, which is a second grouping
// the loaded rail does not have and a row of vertical offset that vanished on
// hydration.
const openingShellSidebarGroups: readonly {
  label: string;
  destinations: readonly {
    icon: LucideIcon;
    label: string;
    path: string;
  }[];
}[] = [
  { label: "Your job search", destinations: openingShellPrimaryDestinations },
];

const openingShellAllDestinations = [
  ...openingShellPrimaryDestinations,
  ...openingShellFooterDestinations,
];

/**
 * The chrome the opening frame and the loaded shell paint identically.
 *
 * These used to be seventeen hand-copied class strings kept honest only by a
 * parity test. `job-finder-shell.tsx` now exports its chrome, so both shells
 * read the same constants and the parity is structural rather than asserted.
 */

/**
 * Derived from the loaded shell's exported `LOCKED_LAYOUT_SCREENS`.
 *
 * Those four routes own their own inner scrolling, so the shell gives them a
 * bounded `pt-0 pb-3` pane instead of the scrolling route's 12/40px gutters.
 * Cold-starting on one of them and painting the scrolling branch snapped the
 * whole route on hydration — the exact shift this shell exists to remove, on
 * the routes users cold-start on most. It used to be a re-declared copy; the
 * shell exports the screen list now, so the two cannot drift apart.
 */
const OPENING_SHELL_LOCKED_ROUTE_PATHS = LOCKED_LAYOUT_SCREENS.map(
  (screen) => `/job-finder/${screen}`,
);

function isOpeningRouteLocked(pathname: string): boolean {
  return OPENING_SHELL_LOCKED_ROUTE_PATHS.some((path) =>
    pathname.startsWith(path),
  );
}

function readInitialDesktopPlatform(): "darwin" | "linux" | "win32" | null {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("mac") || userAgent.includes("macintosh")) {
    return "darwin";
  }
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "win32";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }
  return null;
}

/**
 * Loaded routes whose page title differs from the sidebar label. The opening
 * shell paints the loaded title, not the label, so hydration never swaps the
 * h1 text under the reader. Keep this in step with each screen's
 * `PageHeader` title.
 */
const OPENING_ROUTE_TITLE_OVERRIDES: Readonly<Record<string, string>> = {
  "/job-finder/review-queue": "Shortlisted",
};

function getOpeningRouteTitle(pathname: string, label: string): string {
  const override = Object.entries(OPENING_ROUTE_TITLE_OVERRIDES).find(
    ([path]) => pathname.startsWith(path),
  );
  return override ? override[1] : label;
}

function getOpeningRouteLabel(pathname: string): string {
  return (
    openingShellAllDestinations.find((destination) =>
      pathname.startsWith(destination.path),
    )?.label ?? "Home"
  );
}

function isOpeningDestinationActive(
  pathname: string,
  destinationPath: string,
): boolean {
  if (
    destinationPath === "/job-finder/home" &&
    (pathname === "/job-finder" || pathname === "/job-finder/")
  ) {
    return true;
  }
  return pathname.startsWith(destinationPath);
}

// The first frame's rows are asked for before React renders anything.
startLaunchReads();

function JobFinderOpeningShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<"darwin" | "linux" | "win32" | null>(
    readInitialDesktopPlatform,
  );
  const [windowControlsState, setWindowControlsState] =
    useState<DesktopWindowControlsState>({
      isClosable: true,
      isFullScreen: false,
      isMaximized: false,
      isMinimizable: true,
    });
  const [isSidebarCollapsed] = useState(getInitialSidebarCollapsedState);
  const launchReads = useLaunchReads();

  useLayoutEffect(() => {
    markJobFinderTiming("job-finder:opening-shell:committed");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.nestor
      .ping()
      .then((response) => {
        if (!cancelled) {
          setPlatform(response.platform);
        }
      })
      .catch(() => {
        // The workspace owner reports bootstrap errors; the opening header
        // simply keeps a neutral, inset-free platform state until then.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const windowBridge = window.nestor.window;
    if (
      !windowBridge ||
      typeof windowBridge.onControlsStateChange !== "function" ||
      typeof windowBridge.getControlsState !== "function"
    ) {
      return;
    }
    let cancelled = false;
    const unsubscribe = windowBridge.onControlsStateChange((state) => {
      if (!cancelled) {
        setWindowControlsState(state);
      }
    });
    void windowBridge
      .getControlsState()
      .then((state) => {
        if (!cancelled) {
          setWindowControlsState(state);
        }
      })
      .catch(() => {
        // The native controls retain their safe default state while opening.
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  const openingRouteLabel = getOpeningRouteLabel(location.pathname);
  const isOpeningHomeRoute = openingRouteLabel === "Home";
  const findJobsLaunchPage =
    location.pathname === "/job-finder/discovery" && !location.search
      ? selectFindJobsLaunchPage(launchReads)
      : null;
  const isLockedOpeningRoute = isOpeningRouteLocked(location.pathname);
  const dragRegionStyle = { WebkitAppRegion: "drag" } as CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

  async function runWindowAction(
    action: () => Promise<typeof windowControlsState>,
  ): Promise<void> {
    try {
      setWindowControlsState(await action());
    } catch {
      // Keep the opening shell usable if a native window action fails.
    }
  }

  function renderOpeningSidebarDestination(destination: {
    icon: LucideIcon;
    label: string;
    path: string;
  }) {
    const isActive = isOpeningDestinationActive(
      location.pathname,
      destination.path,
    );
    const launchCount = readLaunchDestinationCount(
      launchReads.counts,
      destination.path,
    );
    return (
      <button
        aria-current={isActive ? "page" : undefined}
        aria-label={destination.label}
        className={cn(
          SHELL_SIDEBAR_ROW_CLASS,
          isSidebarCollapsed && SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
          isActive ? "" : SHELL_SIDEBAR_ROW_INACTIVE_CLASS,
          isActive ? SHELL_SIDEBAR_ROW_ACTIVE_CLASS : "",
        )}
        key={destination.path}
        onClick={() => {
          void navigate(destination.path);
        }}
        type="button"
      >
        {isSidebarCollapsed && launchCount !== null ? (
          <span className="relative inline-flex shrink-0">
            <destination.icon aria-hidden="true" className="size-4 shrink-0" />
            <ScreenCountBadge count={launchCount} kind="inventory" markerOnly />
          </span>
        ) : (
          <destination.icon aria-hidden="true" className="size-4 shrink-0" />
        )}
        <SidebarDestinationLabel
          collapsed={isSidebarCollapsed}
          label={destination.label}
        />
        {!isSidebarCollapsed && launchCount !== null ? (
          <ScreenCountBadge count={launchCount} kind="inventory" />
        ) : null}
      </button>
    );
  }

  // `display: contents` keeps the live region from becoming a layout box of
  // its own, which would merge the header and the status row into one grid
  // cell and drop the 20px gap between them.
  const openingHeaderBlock = (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="contents"
      role="status"
    >
      <PageHeader
        description={
          isOpeningHomeRoute
            ? "See progress, open tasks, and the best next step."
            : `Opening your saved ${openingRouteLabel.toLowerCase()} workspace.`
        }
        title={getOpeningRouteTitle(location.pathname, openingRouteLabel)}
      />
      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-job-finder-opening-block="status"
      >
        <StatusBadge tone="muted">Opening saved workspace</StatusBadge>
      </div>
    </div>
  );

  const openingPlaceholderBlock = (
    <div
      aria-hidden="true"
      className={cn(
        "grid min-w-0 gap-5",
        isLockedOpeningRoute && "h-full min-h-0 content-start pt-5",
      )}
      data-job-finder-opening-placeholder
    >
      {isOpeningHomeRoute ? (
        <>
          <div
            className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-panel) border border-primary/40 bg-primary/10 p-5"
            data-job-finder-opening-block="recommended-next"
          >
            <div className="h-3 w-32 rounded bg-(--surface-panel-raised)" />
            <div className="h-5 w-72 max-w-full rounded bg-(--surface-panel-raised)" />
            <div className="h-4 w-full max-w-[52ch] rounded bg-(--surface-panel-raised)" />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="h-11 w-40 rounded-(--radius-button) bg-(--surface-panel-raised)" />
            </div>
          </div>
          <div
            className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
            data-job-finder-opening-block="search"
          >
            <div className="h-9 w-full rounded-(--radius-field) bg-(--surface-panel-raised)" />
          </div>
          <div
            className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
            data-job-finder-opening-block="notifications"
          >
            <div className="h-5 w-36 rounded bg-(--surface-panel-raised)" />
            <div className="h-4 w-64 max-w-full rounded bg-(--surface-panel-raised)" />
          </div>
        </>
      ) : (
        // Only Home has a primary-tinted recommended-next card. On every other
        // route that shape was a lie the user saw for a frame, so the rest of
        // the app opens on one neutral panel that fills the pane it reserves.
        <div
          className={cn(
            "surface-panel-shell grid min-w-0 content-start gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5",
            isLockedOpeningRoute ? "h-full min-h-0" : "min-h-56",
          )}
          data-job-finder-opening-block="route-placeholder"
        >
          <div className="h-4 w-36 rounded bg-(--surface-panel-raised)" />
          <div className="h-4 w-full max-w-[52ch] rounded bg-(--surface-panel-raised)" />
          <div className="h-4 w-64 max-w-full rounded bg-(--surface-panel-raised)" />
        </div>
      )}
    </div>
  );

  return (
    <div
      className={cn(SHELL_ROOT_CLASS, `platform-${platform ?? "unknown"}`)}
      data-job-finder-opening-shell
      data-job-finder-shell
      data-sidebar-collapsed={isSidebarCollapsed ? "true" : "false"}
      style={
        {
          "--job-finder-side-width": isSidebarCollapsed ? "4rem" : "17rem",
          "--job-finder-side-width-sm": isSidebarCollapsed ? "4rem" : "17rem",
        } as CSSProperties
      }
    >
      <header
        className={SHELL_HEADER_CLASS}
        data-job-finder-shell-header
        style={dragRegionStyle}
      >
        <div className={SHELL_HEADER_GRID_CLASS}>
          {/* Mirrors the shell header: wordmark left, native window-control
              inset right, and nothing in between. The module switch is not a
              header region any more — it heads the navigation surface, so the
              frame paints it in the compact destination card and in the
              sidebar header exactly where the loaded shell does. */}
          <div
            className={SHELL_BRAND_ROW_CLASS}
            data-desktop-brand
            style={
              {
                ...dragRegionStyle,
                // Reserve visible macOS traffic lights while opening, but
                // reclaim their space in native fullscreen. The trailing edge
                // mirrors the reserve so it cannot shift the centred track.
                paddingInlineStart:
                  isMac && !windowControlsState.isFullScreen
                    ? "5.5rem"
                    : undefined,
                paddingInlineEnd:
                  isMac && !windowControlsState.isFullScreen
                    ? "5.5rem"
                    : undefined,
              } as CSSProperties
            }
          >
            <div
              className="col-start-1 flex min-w-0 items-center justify-self-start"
              data-desktop-brand-region
            >
              <JobFinderShellBrand
                moduleSwitch={{
                  onSelectModule: () => {
                    void navigate("/live-assistant");
                  },
                  style: noDragRegionStyle,
                }}
              />
            </div>

            <div
              aria-hidden="true"
              className="col-start-2 min-w-0 justify-self-end"
              data-desktop-header-window-control-inset
              style={
                {
                  ...dragRegionStyle,
                  inlineSize: isWindows ? "8.5rem" : undefined,
                } as CSSProperties
              }
            />
          </div>

          <div
            className="absolute right-0 top-0 z-40 flex h-14 items-stretch justify-end"
            style={dragRegionStyle}
          >
            {isWindows ? (
              <div
                aria-label="Window controls"
                className="flex h-full items-stretch gap-0"
                role="group"
                style={noDragRegionStyle}
              >
                <Button
                  aria-label="Minimize window"
                  className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--surface-panel-raised) hover:text-foreground"
                  disabled={!windowControlsState.isMinimizable}
                  onClick={() => {
                    void runWindowAction(() => window.nestor.window.minimize());
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Minus aria-hidden="true" className="size-3.5" />
                </Button>
                <Button
                  aria-label={
                    windowControlsState.isMaximized
                      ? "Restore window"
                      : "Maximize window"
                  }
                  className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--surface-panel-raised) hover:text-foreground"
                  onClick={() => {
                    void runWindowAction(() =>
                      window.nestor.window.toggleMaximize(),
                    );
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Square aria-hidden="true" className="size-3.5" />
                </Button>
                <Button
                  aria-label="Close window"
                  className="h-full w-12 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--button-close-hover) hover:text-primary-fill-foreground"
                  disabled={!windowControlsState.isClosable}
                  onClick={() => {
                    void window.nestor.window.close();
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>

          <div
            aria-hidden="true"
            className={cn(
              "hidden min-[1440px]:col-span-1 min-[1440px]:col-start-3 min-[1440px]:row-start-1 min-[1440px]:block min-[1440px]:h-14 min-[1440px]:w-80",
              !isMac && "min-[1440px]:mr-36",
            )}
            data-job-finder-opening-actions
          />
          <nav
            aria-label="Job Finder sections"
            // Centred on the same axis as the module switcher above, with the
            // same one-sided trailing reserve the loaded shell keeps for its
            // notification group, so the compact card does not jump sideways
            // when the workspace resolves.
            //
            // The reserve is written as two non-overlapping bands rather than
            // as the loaded shell's three-utility form. There the sm-band
            // padding can only ever apply between 640 and 899, which is
            // exactly the band the max-width utility is meant to own, and it
            // wins there purely on emission order: Tailwind emits arbitrary
            // media variants before named breakpoints. The shell carries that
            // inversion as an audited exception in
            // tailwind-variant-order.test.ts, because the band sits below the
            // 1024px minimum supported width and a shell test pins the current
            // rendering there. Copying the form would have added a second,
            // unaudited instance, so the opening frame states its two bands
            // directly: identical winning padding at every supported width,
            // and no overlap left to resolve.
            className={cn(
              "col-span-2 col-start-1 row-start-2 flex min-w-0 items-center justify-center overflow-visible sm:col-span-1 sm:col-start-1 sm:justify-center min-[1440px]:hidden",
              // One header row from 1280px, as in the loaded shell.
              "xl:row-start-1 xl:justify-self-center",
              isMac
                ? "max-[899px]:pr-40 min-[900px]:pr-0 xl:ml-56 xl:mr-[17rem]"
                : "max-[899px]:pr-40 min-[900px]:max-[1279px]:pr-80 xl:ml-40 xl:mr-[25rem]",
            )}
            style={noDragRegionStyle}
          >
            <div
              className="relative flex w-fit min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-visible rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel) p-1 sm:gap-1.5"
              data-job-finder-compact-navigation
            >
              <div className="relative min-w-0 flex-1">
                <div className="overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                  <div className="flex min-w-max flex-nowrap items-center gap-1 sm:gap-1.5">
                    {openingShellPrimaryDestinations.map((destination) => {
                      const isActive = isOpeningDestinationActive(
                        location.pathname,
                        destination.path,
                      );
                      return (
                        <button
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            COMPACT_NAV_PILL_CLASS,
                            isActive ? COMPACT_NAV_PILL_ACTIVE_CLASS : "",
                          )}
                          key={destination.path}
                          onClick={() => {
                            void navigate(destination.path);
                          }}
                          type="button"
                        >
                          {destination.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </nav>
        </div>
      </header>

      <aside
        aria-label="Job Finder sidebar"
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
            style={noDragRegionStyle}
          >
            {!isSidebarCollapsed ? (
              <span className="job-finder-sidebar-heading">
                Your job search
              </span>
            ) : null}
            {/* The rail's collapse control is owned by the loaded shell; the
                opening frame paints the same 36px box in the same place so
                the icon does not slide when it becomes interactive. */}
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-(--radius-field) text-foreground-muted"
            >
              <Menu aria-hidden="true" className="size-5" />
            </span>
          </div>
          <nav
            aria-label="Job Finder sidebar destinations"
            className={cn(
              "grid min-h-0 min-w-0 flex-1 content-start overflow-x-hidden overflow-y-auto overscroll-contain",
              isSidebarCollapsed ? "gap-2" : "gap-4",
            )}
            data-job-finder-sidebar-scroll-region
            style={noDragRegionStyle}
          >
            {openingShellSidebarGroups.map((group) => (
              <section
                aria-label={group.label}
                className="grid min-w-0 gap-1"
                key={group.label}
                role="group"
              >
                <div
                  className={cn(
                    "grid min-w-0 overflow-hidden",
                    isSidebarCollapsed ? "gap-1.5" : "gap-0.5",
                  )}
                >
                  {group.destinations.map((destination) =>
                    renderOpeningSidebarDestination(destination),
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
            <div className={cn("min-w-0", !isSidebarCollapsed && "flex-1")}>
              {openingShellFooterDestinations.map((destination) =>
                renderOpeningSidebarDestination(destination),
              )}
            </div>
            {/* The shortcuts dialog belongs to the loaded shell. Its control
                is still reserved here, or the footer is narrower while
                opening and Settings shifts when it becomes interactive. */}
            <span
              aria-hidden="true"
              className={cn(
                isSidebarCollapsed
                  ? cn(
                      SHELL_SIDEBAR_ROW_CLASS,
                      SHELL_SIDEBAR_ROW_COLLAPSED_CLASS,
                    )
                  : SHELL_SIDEBAR_SHORTCUTS_BUTTON_CLASS,
              )}
              data-job-finder-sidebar-shortcuts-entry
            >
              <Keyboard aria-hidden="true" className="size-4 shrink-0" />
              <span className="sr-only">
                {JOB_FINDER_SHORTCUTS_DIALOG_LABEL}
              </span>
            </span>
          </div>
        </div>
      </aside>

      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none fixed inset-x-0 top-[7.25rem] z-30 hidden bg-(--shell-header-bg) sm:block xl:top-14 min-[1440px]:left-(--job-finder-side-width)",
          SHELL_HEADER_MASK_HEIGHT_CLASS,
        )}
        data-job-finder-shell-header-mask
      />
      <div className={SHELL_CONTENT_CLASS} data-job-finder-shell-content>
        <main
          aria-busy="true"
          aria-label={openingRouteLabel}
          className={
            isLockedOpeningRoute
              ? SHELL_MAIN_LOCKED_CLASS
              : SHELL_MAIN_SCROLLING_CLASS
          }
        >
          <div
            className={cn(
              SHELL_ROUTE_CONTAINER_BASE_CLASS,
              isLockedOpeningRoute ? "h-full min-h-0" : "min-h-full",
            )}
            data-job-finder-route-container
            style={SHELL_ROUTE_SECTION_GAP_STYLE}
          >
            {/* The loaded Home is a single column: page header, status row,
                one recommended-next card, then the full-width sections. The
                skeleton reserves the same blocks in the same order, so
                hydration replaces content instead of re-laying the page out.

                The locked routes go through the real `LockedScreenLayout`
                rather than a copy of it. That layout owns the 12px above a
                route title on the locked path (the shell gives those routes
                `pt-0` on `main` and the layout supplies `pt-3` itself, so the
                offset is the same on every route — see its F73 comment).
                Re-declaring the section here left the opening title 12px high
                and snapped it down on hydration on Profile, Find jobs and
                Applications, which is why it is the component and not another
                copied class string. */}
            {findJobsLaunchPage ? (
              <FindJobsLaunch {...findJobsLaunchPage} />
            ) : isLockedOpeningRoute ? (
              <LockedScreenLayout
                topContent={
                  <div className="grid min-w-0 gap-5">{openingHeaderBlock}</div>
                }
              >
                {openingPlaceholderBlock}
              </LockedScreenLayout>
            ) : isOpeningHomeRoute && launchReads.counts ? (
              <JobSearchHomeLaunch
                counts={launchReads.counts}
                onNavigate={(route) => {
                  void navigate(route);
                }}
              />
            ) : (
              <section className="grid min-w-0 gap-5 pb-8">
                {openingHeaderBlock}
                {openingPlaceholderBlock}
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export { JobFinderOpeningShell };

/**
 * The gate that runs before Job Finder opens a browser at a real employer's
 * application page. It used to be titled "Use visual checkpoints?" — a
 * sub-option — and both of its buttons proceeded, so the only way out was an
 * unlabelled header X. It is now framed around the commitment itself: it names
 * the job and employer, says a Job Finder browser window will open, states the
 * never-submits boundary as its own line, and offers a real Cancel.
 *
 * Visual checkpoints became an optional, unchecked checkbox rather than a fork,
 * so the safety property is unchanged and stronger: confirming without touching
 * anything resolves with checkpoints off, exactly as "Continue without" did, and
 * Escape, the scrim, Cancel and the header X all resolve through onClose, which
 * cancels the request. Nothing here submits an application.
 */
export function ApplyCopilotVisualCheckpointDialog(props: {
  onClose: () => void;
  /**
   * Returns a refusal sentence when the start could not begin. The dialog then
   * stays open and says so: pressing "Apply" and watching the
   * dialog close with nothing else happening is the defect this return value
   * exists to prevent.
   */
  onResolve: (
    visualCheckpointsEnabled: boolean,
  ) => string | null | void | Promise<string | null | void>;
  request: ApplyCopilotVisualCheckpointRequest | null;
}) {
  const dialogTitleId = useId();
  const descriptionId = useId();
  const boundaryId = useId();
  const checkpointsId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [visualCheckpointsEnabled, setVisualCheckpointsEnabled] =
    useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const open = props.request !== null;
  useModalFocusTrap(open, dialogRef, props.onClose);

  // Every open starts from the privacy-preserving default; consent is per run
  // and is never carried over from a previous preparation.
  useEffect(() => {
    if (open) {
      setVisualCheckpointsEnabled(false);
      setRefusal(null);
      setStarting(false);
    }
  }, [open, props.request]);

  // Declared after the shared trap so it runs second on open. Confirming
  // resolves with checkpoints off unless the user ticks the box, so initial
  // focus on the confirm action cannot enable screenshot sharing by accident.
  useEffect(() => {
    if (!open) {
      return;
    }
    confirmRef.current?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  // Identity and the honest statement of what will happen both come from the
  // request, so this shell renders whatever the caller supplies rather than
  // owning that copy.
  const jobIdentityLine = (props.request?.subject ?? "").trim() || null;
  const commitmentDescription = (props.request?.description ?? "").trim();
  // Safety backstop, not copy ownership: the caller's description carries the
  // never-submits boundary, and this shell states it itself if that sentence
  // is ever missing, so the gate can never appear without it.
  const describesSubmitBoundary = /submit|sending the application/i.test(
    commitmentDescription,
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-(--modal-scrim) px-4 py-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        aria-describedby={
          describesSubmitBoundary
            ? descriptionId
            : `${descriptionId} ${boundaryId}`
        }
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="surface-panel-shell grid max-h-[calc(100dvh-3rem)] w-full max-w-lg gap-5 overflow-y-auto rounded-(--radius-field) border border-(--surface-panel-border) p-5 shadow-(--modal-shadow)"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-2">
            <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
              Apply
            </p>
            {/* The heading is the identity: which application this gate is
                actually about. Group 6 supplies the subject line. */}
            <h2
              className="text-(--text-headline)"
              data-apply-checkpoint-dialog-job
              id={dialogTitleId}
            >
              {jobIdentityLine ?? "Prepare this application"}
            </h2>
          </div>
          {/* One close-affordance shape across every Job Finder dialog. */}
          <Button
            aria-label="Close"
            className="shrink-0"
            onClick={props.onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <div className="grid gap-3">
          <p
            className="text-(length:--text-item) leading-6 text-foreground-soft"
            id={descriptionId}
          >
            {commitmentDescription}
          </p>
          {describesSubmitBoundary ? null : (
            <p
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-3 py-2 text-(length:--text-item) font-medium leading-6 text-foreground"
              data-apply-checkpoint-dialog-boundary
              id={boundaryId}
            >
              Job Finder never submits the application. You review everything
              and send it yourself.
            </p>
          )}
        </div>
        {/* Checkpoints are an option on this commitment, not a second way to
            confirm it. Unchecked by default; confirming without touching it
            behaves exactly as the old "Continue without" choice. */}
        <label
          className="flex items-start gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-3"
          htmlFor={checkpointsId}
        >
          <input
            checked={visualCheckpointsEnabled}
            className="mt-1 size-4 shrink-0 accent-(--primary)"
            id={checkpointsId}
            onChange={(event) =>
              setVisualCheckpointsEnabled(event.target.checked)
            }
            type="checkbox"
          />
          <span className="grid gap-1">
            <span className="text-(length:--text-item) font-medium text-foreground">
              Take temporary screenshots while it works
            </span>
            <span className="text-(length:--text-small) leading-5 text-foreground-soft">
              Optional. Screenshots of the application page help Job Finder
              notice a stuck or misfilled form, and are deleted after the run.
            </span>
          </span>
        </label>
        {refusal ? (
          <p
            className="rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-item) leading-6 text-foreground"
            data-apply-checkpoint-dialog-refusal
            role="alert"
          >
            {refusal}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <Button onClick={props.onClose} type="button" variant="secondary">
            {refusal ? "Close" : "Cancel"}
          </Button>
          {refusal ? null : (
            <Button
              disabled={starting}
              onClick={() => {
                setStarting(true);
                void Promise.resolve(
                  props.onResolve(visualCheckpointsEnabled),
                ).then(
                  (message) => {
                    const sentence =
                      typeof message === "string" ? message.trim() : "";
                    setStarting(false);
                    if (sentence) {
                      setRefusal(sentence);
                    }
                  },
                  () => {
                    setStarting(false);
                    setRefusal(
                      "Job Finder could not start this preparation. Nothing was opened and nothing was sent.",
                    );
                  },
                );
              }}
              pending={starting}
              ref={confirmRef}
              type="button"
              variant="primary"
            >
              Apply
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const MemoizedJobFinderShell = memo(JobFinderShell);
const MemoizedSourceCheckQueueRunner = memo(SourceCheckQueueRunner);
const JobFinderPageRouteContext = createContext<JobFinderPageContext | null>(
  null,
);

function JobFinderPageOutlet() {
  const context = useContext(JobFinderPageRouteContext);
  const location = useLocation();

  return (
    <JobFinderKeptRoutesOutlet
      context={context}
      fallback={
        <RouteSkeleton
          panes={getRouteSkeletonPanes(location.pathname)}
          title={getOpeningRouteLabel(location.pathname)}
        />
      }
      readyMarker={<JobFinderRouteReadyMarker />}
    />
  );
}

// Outlet reads its context independently. Updating the inspected row no longer
// sends a new children prop through the shell and its workspace-wide summaries.
const jobFinderPageOutlet = <JobFinderPageOutlet />;

export function JobFinderPage() {
  const location = useLocation();
  // A toast is news about the screen it was raised on (ADR 0042); it does
  // not follow the person to the next one. It lives here, above the shell's
  // route container, which remounts its content for every screen.
  useDismissToastsOnScreenChange(location.pathname);
  const shellMarkedRef = useRef(false);
  const {
    appearanceTheme,
    applyCopilotVisualCheckpointRequest,
    cancelApplyCopilotVisualCheckpointRequest,
    context,
    dismissSavedStatus,
    navigateFromShell,
    platform,
    resolveResumeWorkspaceLeaveRequest,
    resolveUnsavedChangesLeave,
    resolveUnsavedChangesStay,
    retryLastSave,
    resumeWorkspaceLeaveConfirmation,
    saveState,
    resolveApplyCopilotVisualCheckpointRequest,
    unsavedChangesConfirmation,
    workspace,
    workspaceState,
  } = useJobFinderPageController();

  const latestShellState = useRef({ context, workspace });
  useLayoutEffect(() => {
    latestShellState.current = { context, workspace };
  }, [context, workspace]);
  const discoveryPendingScopes = useMemo(
    () => [
      jobFinderPendingActions.discoveryAll(),
      ...(workspace?.searchPreferences.discovery.targets ?? []).map((target) =>
        jobFinderPendingActions.discoveryTarget(target.id),
      ),
    ],
    [workspace?.searchPreferences.discovery.targets],
  );
  const isSourceDebugPending = useCallback(
    (targetId: string) =>
      latestShellState.current.context?.isPending(
        jobFinderPendingActions.sourceDebug(targetId),
      ) ?? false,
    [],
  );
  const onRunSourceDebug = useCallback<
    JobFinderPageContext["onRunSourceDebug"]
  >(
    (...args) => latestShellState.current.context?.onRunSourceDebug(...args),
    [],
  );
  const onCancelApplyRun = useCallback(async (runId: string) => {
    const current = latestShellState.current;
    if (!current.workspace || !current.context) return false;
    // Cancel stops the whole run. Prefer the actively filling result, then
    // its first assigned application; a batch can have several applications.
    let assignedResult = null;
    for (const result of current.workspace.applyJobResults) {
      if (result.runId !== runId || result.applicationRecordId === null)
        continue;
      assignedResult ??= result;
      if (result.state === "filling") {
        assignedResult = result;
        break;
      }
    }
    if (!assignedResult?.applicationRecordId) return false;
    return current.context.onCancelApplyRun({
      runId,
      jobId: assignedResult.jobId,
      applicationRecordId: assignedResult.applicationRecordId,
    });
  }, []);
  const onCancelDiscovery = useCallback(
    (runId: string) =>
      latestShellState.current.context?.onCancelDiscovery?.(runId) ??
      Promise.resolve(false),
    [],
  );
  const onPrepareRemainingJobs = useCallback(
    (jobIds: readonly string[]) =>
      latestShellState.current.context?.onStartAutoApplyQueue([...jobIds]),
    [],
  );
  const onUndoRecentChange = useCallback(
    (change: RecentChange) =>
      latestShellState.current.context?.onUndoRecentChange(change) ??
      Promise.resolve(false),
    [],
  );
  const onStopTailoredDraftPreparation = useCallback(
    () => latestShellState.current.context?.onStopTailoredDraftPreparation(),
    [],
  );

  useEffect(() => {
    if (!context || shellMarkedRef.current) {
      return;
    }

    shellMarkedRef.current = true;
    markJobFinderTiming("job-finder:shell:mounted");
    measureFromLatestJobFinderMark(
      "job-finder:shell:time",
      "job-finder:workspace:bootstrap:ready",
      "job-finder:shell:mounted",
    );
  }, [context]);

  // The context object changes with every workspace refresh; the route mark
  // belongs to route changes only (browsers keep every mark until cleared).
  const hasContext = Boolean(context);
  useEffect(() => {
    // The marker is a post-commit signal for direct hash changes and older
    // preload builds that do not expose bootstrap timing marks.
    if (!hasContext) {
      return;
    }
    markJobFinderTiming(`job-finder:route:${location.pathname}:committed`);
  }, [hasContext, location.pathname]);

  if (!context || !workspace || !platform) {
    if (workspaceState.status === "loading") {
      return withJobFinderWindowCloseGuard(<JobFinderOpeningShell />);
    }

    if (
      workspaceState.status === "error" &&
      workspaceState.startupDatabaseRecovery
    ) {
      // A typed recovery incident blocks the workspace on purpose: no retry
      // action is offered because retrying would re-run recovery without any
      // new information and every retained file stays untouched.
      return withJobFinderWindowCloseGuard(
        <WorkspaceStateScreen
          kicker="Workspace error"
          message={buildJobFinderStartupDatabaseRecoveryBlockedDetail({
            incidentId: workspaceState.startupDatabaseRecovery.incidentId,
            outcome: workspaceState.startupDatabaseRecovery.outcome,
          })}
          title="Couldn't open Job Finder"
          tone="error"
        />,
      );
    }

    return withJobFinderWindowCloseGuard(
      <WorkspaceStateScreen
        {...(workspaceState.status === "error"
          ? {
              action: {
                label: "Retry opening Job Finder",
                onClick: workspaceState.retry,
              },
            }
          : {})}
        kicker="Workspace error"
        message={
          workspaceState.status === "error"
            ? workspaceState.message
            : "Job Finder couldn't load."
        }
        title="Couldn't open Job Finder"
        tone="error"
      />,
    );
  }

  return withJobFinderWindowCloseGuard(
    <ThemeProvider preference={appearanceTheme || "system"}>
      <MemoizedSourceCheckQueueRunner
        isSourceDebugPending={isSourceDebugPending}
        onRunSourceDebug={onRunSourceDebug}
        recentSourceDebugRuns={workspace.recentSourceDebugRuns}
      />
      <AssistantProvider>
        <JobFinderPageRouteContext.Provider value={context}>
          <MemoizedJobFinderShell
            isDiscoveryPending={context.isAnyPending(discoveryPendingScopes)}
            isResumeImportPending={context.isPending(
              jobFinderPendingActions.profileImport(),
            )}
            liveDiscoveryEvents={context.liveDiscoveryEvents}
            onCancelApplyRun={onCancelApplyRun}
            {...(context.onCancelDiscovery ? { onCancelDiscovery } : {})}
            onDismissSavedStatus={dismissSavedStatus}
            onNavigate={navigateFromShell}
            onPrepareRemainingJobs={onPrepareRemainingJobs}
            onUndoRecentChange={onUndoRecentChange}
            onRetrySave={retryLastSave}
            onStopTailoredDraftPreparation={onStopTailoredDraftPreparation}
            platform={platform}
            resumeImportProgress={context.resumeImportProgress}
            saveState={saveState}
            tailoredDraftPreparation={context.tailoredDraftPreparation}
            workspace={workspace}
          >
            {jobFinderPageOutlet}
          </MemoizedJobFinderShell>
        </JobFinderPageRouteContext.Provider>
      </AssistantProvider>
      <ApplyCopilotVisualCheckpointDialog
        onClose={cancelApplyCopilotVisualCheckpointRequest}
        onResolve={resolveApplyCopilotVisualCheckpointRequest}
        request={applyCopilotVisualCheckpointRequest}
      />
      <JobFinderUnsavedChangesDialog
        confirmation={unsavedChangesConfirmation}
        onLeaveWithoutSaving={resolveUnsavedChangesLeave}
        onStay={resolveUnsavedChangesStay}
      />
      {/* Same branded dialog, second parked decision: actions that leave
          dirty Resume Studio work ask it through the controller's async
          request instead of a native window.confirm. */}
      <JobFinderUnsavedChangesDialog
        confirmation={resumeWorkspaceLeaveConfirmation}
        onLeaveWithoutSaving={() => resolveResumeWorkspaceLeaveRequest(true)}
        onStay={() => resolveResumeWorkspaceLeaveRequest(false)}
      />
      {/* The window-close responder is mounted once by
          withJobFinderWindowCloseGuard above this tree so it also answers on
          loading and error screens. */}
      <StartupDatabaseRecoveryNotice />
    </ThemeProvider>,
  );
}
