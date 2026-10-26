import { useEffect } from "react";
import type { ReactNode } from "react";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import {
  createSharedRouteLoader,
  lazyScreen,
  preloadWhenIdle,
} from "@renderer/lib/lazy-screen";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { JobFinderRouteErrorBoundary } from "./job-finder-route-error-boundary";
import { getDefaultProfileRoute } from "@renderer/features/job-finder/lib/job-finder-utils";
import { Navigate, useLocation, useOutletContext } from "react-router-dom";
import { useLaunchReads } from "@renderer/features/job-finder/lib/launch-reads";
import { requestLegacyWorkspace } from "@renderer/features/job-finder/lib/legacy-workspace-demand";
import { isProfileSetupJustFinished } from "./profile-setup-finished";
import {
  markGuidedSetupAutoOpenSpent,
  shouldAutoOpenGuidedSetup,
} from "@renderer/features/job-finder/components/profile/setup/guided-setup-auto-open";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { HomeScreen } from "@renderer/features/home/home-screen";

// Screens that still read the old workspace (Profile, setup, Settings) wait
// for it anyway, so their code is its own chunk, fetched once the window is
// idle or on the first visit, whichever comes first.
const loadProfileSetupScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/components/profile/setup/profile-setup-screen")
  ).ProfileSetupScreen,
}));
const loadProfileScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/profile-screen")
  ).ProfileScreen,
}));
const loadSettingsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/settings-screen")
  ).SettingsScreen,
}));

preloadWhenIdle([
  loadProfileScreen,
  loadSettingsScreen,
  loadProfileSetupScreen,
]);

const ProfileScreen = lazyScreen(loadProfileScreen);
const ProfileSetupScreen = lazyScreen(loadProfileSetupScreen);
const SettingsScreen = lazyScreen(loadSettingsScreen);

function useJobFinderPageContext() {
  return useOutletContext<JobFinderPageContext>();
}

export function WorkspaceStateScreen(props: {
  action?: { label: string; onClick: () => void };
  fillAvailableViewport?: boolean;
  kicker: string;
  message: string;
  title: string;
  tone?: "default" | "error";
}) {
  return (
    <main
      // A route-level state is not a crash: dead-centring a small card in a
      // full empty viewport read like one. Only the viewport-filling startup
      // screens stay centred; in-route states sit near the top of the content.
      className={
        props.fillAvailableViewport
          ? "grid min-h-[calc(100dvh-7.25rem)] flex-1 place-items-center bg-canvas px-6 py-10 text-center xl:min-h-[calc(100dvh-3.5rem)]"
          : "grid min-h-full flex-1 content-start justify-items-center bg-canvas px-6 pb-10 pt-12 text-center"
      }
      data-workspace-state-viewport-fill={
        props.fillAvailableViewport ? "true" : undefined
      }
    >
      <div
        aria-atomic="true"
        aria-live={props.tone === "error" ? "assertive" : "polite"}
        className={cn(
          "grid w-full max-w-(--workspace-state-card-max-width) justify-items-center gap-3 rounded-(--workspace-state-card-radius) p-8 shadow-(--workspace-state-card-shadow)",
          props.tone === "error"
            ? "border border-critical/35 bg-(--workspace-state-card-bg-error)"
            : "border border-border-subtle bg-(--workspace-state-card-bg-default)",
          // An in-route card at the shared 34rem cap wrapped its own heading
          // mid-phrase; the startup screens keep the narrower measure.
          props.fillAvailableViewport ? null : "sm:max-w-[42rem]",
        )}
        data-workspace-state-screen
        role={props.tone === "error" ? "alert" : "status"}
      >
        <p className="text-(length:--text-tiny) uppercase tracking-[0.24em] text-foreground-muted">
          {props.kicker}
        </p>
        <h1 className="text-balance" data-workspace-state-title>
          {props.title}
        </h1>
        <p data-workspace-state-message>{props.message}</p>
        {props.action ? (
          <Button
            className="mt-2 w-fit"
            onClick={props.action.onClick}
            type="button"
          >
            {props.action.label}
          </Button>
        ) : null}
      </div>
    </main>
  );
}

type JobFinderDeferredCollection =
  JobFinderRendererWorkspaceSnapshot["hydration"]["deferredCollections"][number];

export function isJobFinderHydratingCollections(
  workspace: JobFinderRendererWorkspaceSnapshot,
  collections: readonly JobFinderDeferredCollection[],
): boolean {
  return (
    workspace.hydration.phase === "bootstrap" &&
    collections.some((collection) =>
      workspace.hydration.deferredCollections.includes(collection),
    )
  );
}

/**
 * Bootstrap snapshots intentionally leave large collections empty. Routes
 * that depend on those collections must not render an empty result state or
 * offer actions that the workspace hook will reject while hydration runs.
 */
export function JobFinderHydrationGate(props: {
  children: ReactNode;
  collections: readonly JobFinderDeferredCollection[];
  workspace: JobFinderRendererWorkspaceSnapshot;
  /** What the screen can already show from the database while it loads. */
  launchView?: ReactNode;
}) {
  const isHydrating = isJobFinderHydratingCollections(
    props.workspace,
    props.collections,
  );

  if (!isHydrating) {
    return props.children;
  }

  if (props.launchView) {
    return props.launchView;
  }

  return (
    <WorkspaceStateScreen
      kicker="Job Finder"
      message="We’re loading your saved workspace data from disk. This page will appear here as soon as it is ready."
      title="Loading your workspace"
    />
  );
}

export { JobFinderRouteErrorBoundary };

export function JobFinderHomeRoute() {
  // Home opens before any old workspace loads, so setup state comes from the
  // launch read until a screen that needs that workspace has loaded it.
  const context = useOutletContext<JobFinderPageContext | null>();
  const launched = useLaunchReads().context;
  // No workspace yet is a first launch, so setup opens. A workspace the launch
  // read could not read leaves setup unknown until the old workspace loads.
  const unreadable = !context && launched?.workspace === "unreadable";
  useEffect(() => {
    if (unreadable) requestLegacyWorkspace();
  }, [unreadable]);
  const setupKnown = Boolean(context) || (launched !== null && !unreadable);
  const setupState =
    context?.workspace.profileSetupState ?? launched?.profileSetupState ?? null;
  // A workspace that has not started setup opens guided setup directly; Home
  // is one screen of hallway before it. The redirect is spent immediately so
  // the sidebar's Home destination still works.
  if (setupKnown && shouldAutoOpenGuidedSetup(setupState)) {
    markGuidedSetupAutoOpenSpent();
    return <Navigate replace to="/job-finder/profile/setup" />;
  }
  return <HomeScreen />;
}

export function JobFinderProfileRoute() {
  const context = useJobFinderPageContext();
  const location = useLocation();
  const forceFullProfile = Boolean(
    (location.state as { forceFullProfile?: boolean } | null)?.forceFullProfile,
  );
  const resolvedProfileRoute = getDefaultProfileRoute(
    context.workspace.profileSetupState,
    {
      forceFullProfile,
    },
  );

  if (resolvedProfileRoute !== "/job-finder/profile") {
    return <Navigate replace to={resolvedProfileRoute} />;
  }

  return (
    <ProfileScreen
      onApplyProfileSetupReviewAction={context.onApplyProfileSetupReviewAction}
      actionState={context.actionState}
      importResumeGuardMessage={context.importResumeGuardMessage}
      pendingActions={{
        analyzeProfile: context.isPending(
          jobFinderPendingActions.profileAnalyze(),
        ),
        browserSession: (targetId) =>
          context.isPending(
            jobFinderPendingActions.browserSessionTarget(targetId),
          ),
        importResume: context.isPending(
          jobFinderPendingActions.profileImport(),
        ),
        profileCopilotBusy: context.profileCopilotBusy,
        profileMutation: context.isPending(
          jobFinderPendingActions.profileMutation(),
        ),
        profileSetup: context.isPending(jobFinderPendingActions.profileSetup()),
        profileReviewItem: (reviewItemId) =>
          context.isPending(
            jobFinderPendingActions.profileReviewItem(reviewItemId),
          ),
        sourceDebug: (targetId) =>
          context.isPending(jobFinderPendingActions.sourceDebug(targetId)),
        sourceInstruction: (targetId) =>
          context.isPending(
            jobFinderPendingActions.sourceInstruction(targetId),
          ),
        sourceInstructionVerify: (instructionId) =>
          context.isPending(
            jobFinderPendingActions.sourceInstructionVerify(instructionId),
          ),
        targetDiscovery: (targetId) =>
          context.isPending(jobFinderPendingActions.discoveryTarget(targetId)),
      }}
      onAnalyzeProfileFromResume={context.onAnalyzeProfileFromResume}
      onApplyResumeTimelineRepairAction={
        context.onApplyResumeTimelineRepairAction
      }
      onGetSourceDebugRunDetails={context.onGetSourceDebugRunDetails}
      onImportResume={context.onImportResume}
      onRetryInterruptedImport={() =>
        context.onImportResume({ retryInterrupted: true })
      }
      onOpenBrowserSessionForTarget={(targetId) => {
        void context.onOpenBrowserSession({ targetId });
      }}
      onProfileSurfaceDirtyChange={context.onProfileSurfaceDirtyChange}
      onProfileSurfaceDraftEdited={context.onProfileSurfaceDraftEdited}
      onResumeProfileSetup={context.onResumeProfileSetup}
      {...(context.onRunDiscoveryForTarget
        ? { onRunDiscoveryForTarget: context.onRunDiscoveryForTarget }
        : {})}
      onRunSourceDebug={context.onRunSourceDebug}
      onSaveAll={context.onSaveAll}
      onSaveSourceInstructionArtifact={context.onSaveSourceInstructionArtifact}
      onVerifySourceInstructions={context.onVerifySourceInstructions}
      latestResumeImportReviewCandidates={
        context.workspace.latestResumeImportReviewCandidates
      }
      resumeImportProgress={context.resumeImportProgress}
      latestResumeImportRun={context.workspace.latestResumeImportRun}
      profile={context.workspace.profile}
      profileSetupState={context.workspace.profileSetupState}
      recentSourceDebugRuns={context.workspace.recentSourceDebugRuns}
      resumeApplicationMode={context.workspace.settings?.resumeApplicationMode}
      onUpdateResumeApproach={(resumeApproach) =>
        context.onUpdateAiBehavior({ resumeApproach })
      }
      searchPreferences={context.workspace.searchPreferences}
      sourceAccessPrompts={context.workspace.sourceAccessPrompts}
      sourceInstructionArtifacts={context.workspace.sourceInstructionArtifacts}
    />
  );
}

export function JobFinderProfileSetupRoute() {
  const context = useJobFinderPageContext();

  if (context.workspace.profileSetupState.status === "completed") {
    // A setup finished in this session hands off to Find jobs; a completed
    // setup revisited later goes back to the full Profile editor.
    return (
      <Navigate
        replace
        to={
          isProfileSetupJustFinished()
            ? "/job-finder/discovery"
            : "/job-finder/profile"
        }
      />
    );
  }

  return (
    <ProfileSetupScreen
      actionState={context.actionState}
      importResumeGuardMessage={context.importResumeGuardMessage}
      isImportResumePending={context.isPending(
        jobFinderPendingActions.profileImport(),
      )}
      isProfileSetupPending={context.isPending(
        jobFinderPendingActions.profileSetup(),
      )}
      isReviewItemPending={(reviewItemId) =>
        context.isPending(
          jobFinderPendingActions.profileReviewItem(reviewItemId),
        )
      }
      latestResumeImportReviewCandidates={
        context.workspace.latestResumeImportReviewCandidates
      }
      latestResumeImportRun={context.workspace.latestResumeImportRun}
      resumeImportProgress={context.resumeImportProgress}
      onApplyProfileSetupReviewAction={context.onApplyProfileSetupReviewAction}
      onContinueToProfile={context.onOpenProfile}
      onImportResume={context.onImportResume}
      onRetryInterruptedImport={() =>
        context.onImportResume({ retryInterrupted: true })
      }
      onAnalyzeProfileFromResume={context.onAnalyzeProfileFromResume}
      isAnalyzeProfilePending={context.isPending(
        jobFinderPendingActions.profileAnalyze(),
      )}
      onCancelImportResume={context.onCancelImportResume}
      onProfileSurfaceDirtyChange={context.onProfileSurfaceDirtyChange}
      onProfileSurfaceDraftEdited={context.onProfileSurfaceDraftEdited}
      onResumeSetup={context.onResumeProfileSetup}
      onRunSourceDebug={context.onRunSourceDebug}
      onSaveSetupStep={context.onSaveSetupStep}
      profile={context.workspace.profile}
      profileSetupState={context.workspace.profileSetupState}
      recentSourceDebugRuns={context.workspace.recentSourceDebugRuns}
      {...(context.workspace.settings.resumeApplicationMode
        ? {
            resumeApplicationMode:
              context.workspace.settings.resumeApplicationMode,
          }
        : {})}
      searchPreferences={context.workspace.searchPreferences}
    />
  );
}

export function JobFinderSettingsRoute() {
  const context = useJobFinderPageContext();

  return (
    <SettingsScreen
      availableResumeTemplates={context.workspace.availableResumeTemplates}
      browserSession={context.workspace.browserSession}
      isWorkspaceResetPending={context.isPending(
        jobFinderPendingActions.workspaceReset(),
      )}
      onResetWorkspace={context.onResetWorkspace}
      onSettingsDraftEdited={context.onSettingsDraftEdited}
      // Pass-through on purpose: these handlers resolve false when a save
      // did not commit, and each section needs the real promise so its
      // pending state lasts for the IPC call and false can surface as a
      // failure instead of a local saved message.
      onUpdateAppearanceTheme={context.onUpdateAppearanceTheme}
      onUpdateApplicationDefaults={context.onUpdateApplicationDefaults}
      onUpdateWorkspaceBehavior={context.onUpdateWorkspaceBehavior}
      onUpdateAiBehavior={context.onUpdateAiBehavior}
      settings={context.workspace.settings}
    />
  );
}
