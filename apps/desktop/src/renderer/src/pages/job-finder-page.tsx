import { useStageCounts } from "@renderer/features/job-lists/use-stage-counts";
import type { JobFinderWorkspaceState } from "@renderer/features/job-finder/hooks/use-job-finder-workspace";
import {
  needsLegacyWorkspace,
  useLegacyWorkspaceWanted,
} from "@renderer/features/job-finder/lib/legacy-workspace-demand";
import { useNeedsYouCount } from "@renderer/features/needs-you/use-needs-you-count";
import { AssistantProvider } from "../features/job-finder/assistant/assistant-provider";
import { JobFinderShell } from "@renderer/features/job-finder/components/job-finder-shell";
import {
  startLaunchReads,
  useLaunchReads,
} from "@renderer/features/job-finder/lib/launch-reads";
import {
  getRouteSkeletonPanes,
  RouteSkeleton,
} from "@renderer/features/job-finder/components/route-skeleton";
import { StartupDatabaseRecoveryNotice } from "@renderer/features/job-finder/components/startup-database-recovery-notice";
import { ThemeProvider } from "@renderer/app/theme-provider";
import {
  ClipboardCheck,
  Compass,
  FileText,
  House,
  Settings,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDismissToastsOnScreenChange } from "@renderer/components/ui/toast";
import { buildJobFinderStartupDatabaseRecoveryBlockedDetail } from "../../../shared/job-finder-startup-db-recovery";
import { WorkspaceStateScreen } from "./job-finder-page-routes";
import { JobFinderWindowCloseGuard } from "./job-finder-window-close-guard";
import { JobFinderKeptRoutesOutlet } from "./job-finder-kept-routes";
import type { JobFinderPageContext } from "./job-finder-page-context";
import { useLegacyControllerView } from "./legacy-controller-view";

export type { JobFinderPageContext } from "./job-finder-page-context";
export {
  JobFinderHomeRoute,
  JobFinderProfileRoute,
  JobFinderProfileSetupRoute,
  JobFinderRouteErrorBoundary,
  JobFinderSettingsRoute,
} from "./job-finder-page-routes";

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

const openingShellAllDestinations = [
  ...openingShellPrimaryDestinations,
  ...openingShellFooterDestinations,
];

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

/** The shell draws at once; the bridge's own answer replaces this later. */
const INITIAL_PLATFORM = readInitialDesktopPlatform() ?? "win32";

function getOpeningRouteLabel(pathname: string): string {
  return (
    openingShellAllDestinations.find((destination) =>
      pathname.startsWith(destination.path),
    )?.label ?? "Home"
  );
}

// The first frame's rows are asked for before React renders anything.
startLaunchReads();

export {};

const MemoizedJobFinderShell = memo(JobFinderShell);
const JobFinderPageRouteContext = createContext<JobFinderPageContext | null>(
  null,
);

const JobFinderWorkspaceStateContext = createContext<JobFinderWorkspaceState>({
  status: "loading",
});

function JobFinderPageOutlet() {
  const context = useContext(JobFinderPageRouteContext);
  const workspaceState = useContext(JobFinderWorkspaceStateContext);
  const location = useLocation();
  const skeleton = (
    <RouteSkeleton
      panes={getRouteSkeletonPanes(location.pathname)}
      title={getOpeningRouteLabel(location.pathname)}
    />
  );

  // Profile, setup and Settings still read the old workspace; they wait for
  // it here while every other screen opens straight from the store.
  if (!context && needsLegacyWorkspace(location.pathname)) {
    if (workspaceState.status !== "error") return skeleton;
    // A typed recovery incident offers no retry: retrying would run recovery
    // again with no new information, and every retained file stays as it is.
    return (
      <WorkspaceStateScreen
        {...(workspaceState.startupDatabaseRecovery
          ? {}
          : {
              action: {
                label: "Retry opening Job Finder",
                onClick: workspaceState.retry,
              },
            })}
        kicker="Workspace error"
        message={
          workspaceState.startupDatabaseRecovery
            ? buildJobFinderStartupDatabaseRecoveryBlockedDetail({
                incidentId: workspaceState.startupDatabaseRecovery.incidentId,
                outcome: workspaceState.startupDatabaseRecovery.outcome,
              })
            : workspaceState.message
        }
        title="Couldn't open Job Finder"
        tone="error"
      />
    );
  }

  return (
    <JobFinderKeptRoutesOutlet
      context={context}
      fallback={skeleton}
      readyMarker={<JobFinderRouteReadyMarker />}
    />
  );
}

// Outlet reads its context independently. Updating the inspected row no longer
// sends a new children prop through the shell and its workspace-wide summaries.
const jobFinderPageOutlet = <JobFinderPageOutlet />;

const loadLegacyController = () => import("./job-finder-legacy-controller");
const JobFinderLegacyController = lazy(async () => ({
  default: (await loadLegacyController()).JobFinderLegacyController,
}));

const IDLE_WORKSPACE_STATE: JobFinderWorkspaceState = { status: "loading" };

export function JobFinderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // A toast is news about the screen it was raised on (ADR 0042); it does
  // not follow the person to the next one. It lives here, above the shell's
  // route container, which remounts its content for every screen.
  useDismissToastsOnScreenChange(location.pathname);
  const stageCounts = useStageCounts();
  const needsYouCount = useNeedsYouCount();
  const startupContext = useLaunchReads().context;
  const loadWorkspace = useLegacyWorkspaceWanted(location.pathname);
  const legacy = useLegacyControllerView();
  const shellMarkedRef = useRef(false);
  const context = legacy?.context ?? null;
  const workspace = legacy?.workspace ?? null;

  // The router wraps a plain navigate in a transition, which rendered the
  // next screen in 5 ms slices over several frames; a click should land in
  // the next frame.
  const navigateDirectly = useCallback(
    (path: string) => void navigate(path, { flushSync: true }),
    [navigate],
  );

  useEffect(() => {
    if (shellMarkedRef.current) return;
    shellMarkedRef.current = true;
    markJobFinderTiming("job-finder:shell:mounted");
  }, []);

  useEffect(() => {
    markJobFinderTiming(`job-finder:route:${location.pathname}:committed`);
  }, [location.pathname]);

  return withJobFinderWindowCloseGuard(
    <ThemeProvider
      preference={
        legacy?.appearanceTheme ||
        startupContext?.settings?.appearanceTheme ||
        "system"
      }
    >
      {loadWorkspace ? (
        <Suspense fallback={null}>
          <JobFinderLegacyController />
        </Suspense>
      ) : null}
      <AssistantProvider>
        <JobFinderWorkspaceStateContext.Provider
          value={legacy?.workspaceState ?? IDLE_WORKSPACE_STATE}
        >
          <JobFinderPageRouteContext.Provider value={context}>
            <MemoizedJobFinderShell
              needsYouCount={needsYouCount}
              {...(legacy
                ? {
                    onDismissSavedStatus: legacy.dismissSavedStatus,
                    onRetrySave: legacy.retryLastSave,
                    saveState: legacy.saveState,
                  }
                : {})}
              onNavigate={legacy?.navigateFromShell ?? navigateDirectly}
              platform={legacy?.platform ?? INITIAL_PLATFORM}
              stageCounts={stageCounts}
              startupContext={startupContext}
              workspace={workspace}
            >
              {jobFinderPageOutlet}
            </MemoizedJobFinderShell>
          </JobFinderPageRouteContext.Provider>
        </JobFinderWorkspaceStateContext.Provider>
      </AssistantProvider>
      {/* The window-close responder is mounted once by
          withJobFinderWindowCloseGuard above this tree. */}
      <StartupDatabaseRecoveryNotice />
    </ThemeProvider>,
  );
}
