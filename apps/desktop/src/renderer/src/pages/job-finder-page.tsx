import { useStageCounts } from "@renderer/features/job-lists/use-stage-counts";
import type { JobFinderWorkspaceState } from "@renderer/features/job-finder/hooks/use-job-finder-workspace";
import {
  needsLegacyWorkspace,
  useLegacyWorkspaceWanted,
} from "@renderer/features/job-finder/lib/legacy-workspace-demand";
import { useNeedsYouCount } from "@renderer/features/needs-you/use-needs-you-count";
import { AssistantProvider } from "../features/job-finder/assistant/assistant-provider";
import {
  JobFinderShell,
} from "@renderer/features/job-finder/components/job-finder-shell";
import {
  startLaunchReads,
  useLaunchReads,
} from "@renderer/features/job-finder/lib/launch-reads";
import { SourceCheckQueueRunner } from "@renderer/features/job-finder/lib/source-check-queue-runner";
import {
  getRouteSkeletonPanes,
  RouteSkeleton,
} from "@renderer/features/job-finder/components/route-skeleton";
import { StartupDatabaseRecoveryNotice } from "@renderer/features/job-finder/components/startup-database-recovery-notice";
import { ThemeProvider } from "@renderer/app/theme-provider";
import { Button } from "@renderer/components/ui/button";
import { useModalFocusTrap } from "@renderer/features/job-finder/components/profile/use-modal-focus-trap";
import {
  ClipboardCheck,
  Compass,
  FileText,
  House,
  Settings,
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
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, } from "react-router-dom";
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

export function JobFinderPage() {
  const location = useLocation();
  // A toast is news about the screen it was raised on (ADR 0042); it does
  // not follow the person to the next one. It lives here, above the shell's
  // route container, which remounts its content for every screen.
  useDismissToastsOnScreenChange(location.pathname);
  const stageCounts = useStageCounts();
  const needsYouCount = useNeedsYouCount();
  const startupContext = useLaunchReads().context;
  const loadWorkspace = useLegacyWorkspaceWanted(location.pathname);
  const shellMarkedRef = useRef(false);
  const {
    appearanceTheme,
    applyCopilotVisualCheckpointRequest,
    cancelApplyCopilotVisualCheckpointRequest,
    context,
    dismissSavedStatus,
    navigateFromShell,
    platform,
    resolveUnsavedChangesLeave,
    resolveUnsavedChangesStay,
    retryLastSave,
    saveState,
    resolveApplyCopilotVisualCheckpointRequest,
    unsavedChangesConfirmation,
    workspace,
    workspaceState,
  } = useJobFinderPageController(loadWorkspace);

  const latestShellState = useRef({ context, workspace });
  useLayoutEffect(() => {
    latestShellState.current = { context, workspace };
  }, [context, workspace]);
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
  const onUndoRecentChange = useCallback(
    (change: RecentChange) =>
      latestShellState.current.context?.onUndoRecentChange(change) ??
      Promise.resolve(false),
    [],
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
        appearanceTheme ||
        startupContext?.settings?.appearanceTheme ||
        "system"
      }
    >
      {workspace ? (
        <MemoizedSourceCheckQueueRunner
          isSourceDebugPending={isSourceDebugPending}
          onRunSourceDebug={onRunSourceDebug}
          recentSourceDebugRuns={workspace.recentSourceDebugRuns}
        />
      ) : null}
      <AssistantProvider>
        <JobFinderWorkspaceStateContext.Provider value={workspaceState}>
          <JobFinderPageRouteContext.Provider value={context}>
            <MemoizedJobFinderShell
              isResumeImportPending={
                context?.isPending(jobFinderPendingActions.profileImport()) ??
                false
              }
              needsYouCount={needsYouCount}
              onDismissSavedStatus={dismissSavedStatus}
              onNavigate={navigateFromShell}
              onRetrySave={retryLastSave}
              onUndoRecentChange={onUndoRecentChange}
              platform={platform ?? INITIAL_PLATFORM}
              resumeImportProgress={context?.resumeImportProgress ?? null}
              saveState={saveState}
              stageCounts={stageCounts}
              startupContext={startupContext}
              workspace={workspace}
            >
              {jobFinderPageOutlet}
            </MemoizedJobFinderShell>
          </JobFinderPageRouteContext.Provider>
        </JobFinderWorkspaceStateContext.Provider>
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
      {/* The window-close responder is mounted once by
          withJobFinderWindowCloseGuard above this tree. */}
      <StartupDatabaseRecoveryNotice />
    </ThemeProvider>,
  );
}
