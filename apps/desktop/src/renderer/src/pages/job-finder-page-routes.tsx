import { createElement, lazy, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { JobFinderRouteErrorBoundary } from "./job-finder-route-error-boundary";
import { getDefaultProfileRoute } from "@renderer/features/job-finder/lib/job-finder-utils";
import { Navigate, useLocation, useOutletContext } from "react-router-dom";
import { isProfileSetupJustFinished } from "./use-job-finder-page-controller-actions";
import {
  markGuidedSetupAutoOpenSpent,
  shouldAutoOpenGuidedSetup,
} from "@renderer/features/job-finder/components/profile/setup/guided-setup-auto-open";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type {
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { ProfileScreen } from "@renderer/features/job-finder/screens/profile-screen";
import { HomeScreen } from "@renderer/features/home/home-screen";

// The canonical workflow surfaces (Profile, Find jobs, Shortlisted,
// Applications) are part of the initial-route bundle so their real headings
// mount on the first commit without a Suspense placeholder. Long-tail route
// surfaces stay lazy: they are independent chunks loaded only when their
// route is rendered, and this file keeps their shared loading fallback so a
// first visit is explicit and recoverable instead of rendering a blank page.
function createSharedRouteLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  const loader = Object.assign(
    () => {
      promise ??= load().then((module) => {
        loader.loaded = module;
        return module;
      });
      return promise;
    },
    { loaded: null as T | null },
  );
  return loader;
}

/**
 * A lazy screen that renders at once when its code has already arrived (the
 * idle preload below). `React.lazy` suspends on its first render even then,
 * and React keeps a fallback it revealed for about 300 ms, so a preloaded
 * screen still opened ~340 ms after the click. The choice is made once per
 * mount, so a screen never swaps component type under its own state.
 */
function lazyScreen<P extends object>(
  loader: ReturnType<
    typeof createSharedRouteLoader<{ default: ComponentType<P> }>
  >,
): ComponentType<P> {
  const Lazy = lazy(loader) as unknown as ComponentType<P>;
  return function LazyScreen(props: P) {
    const [Screen] = useState<ComponentType<P>>(
      () => loader.loaded?.default ?? Lazy,
    );
    return createElement(Screen, props);
  };
}

const loadProfileSetupScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/components/profile/setup/profile-setup-screen")
  ).ProfileSetupScreen,
}));
const loadSettingsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/settings-screen")
  ).SettingsScreen,
}));

// Every other screen's code is fetched once the window is idle, so the first
// click on any of them renders at once instead of waiting on its chunk.
if (import.meta.env.MODE !== "test" && typeof window !== "undefined") {
  const preloadScreens = () => {
    for (const load of [
      loadSettingsScreen,
      loadProfileSetupScreen,
    ])
      void load().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(preloadScreens, { timeout: 4000 });
  else window.setTimeout(preloadScreens, 2000);
}

const ProfileSetupScreen = lazyScreen(loadProfileSetupScreen);
const SettingsScreen = lazyScreen(loadSettingsScreen);

function useJobFinderPageContext() {
  return useOutletContext<JobFinderPageContext>();
}

type CampaignJobIndex = ReadonlyArray<{
  readonly id: string;
  readonly jobIds: ReadonlySet<string>;
}>;

/**
 * One membership index per campaign, built once per scope calculation.
 * `resolveCampaignForJobs` runs once per apply run and once per application
 * record, so a linear `Array.includes` per (campaign, job) pair turned an
 * ordinary Applications render into quadratic work at the sizes this product
 * targets (5,000 discovered jobs / 1,001 application records).
 */
function indexCampaignJobIds(
  campaigns: JobFinderRendererWorkspaceSnapshot["campaigns"],
): CampaignJobIndex {
  return campaigns.map((campaign) => ({
    id: campaign.id,
    jobIds: new Set(campaign.jobIds),
  }));
}

// Campaign order and the "exactly one campaign owns every job" rule are
// unchanged: the first match wins only while it stays the sole match.
function resolveCampaignForJobs(
  campaignIndex: CampaignJobIndex,
  jobIds: readonly string[],
): string | null {
  if (jobIds.length === 0) return null;
  let campaignId: string | null = null;
  for (const campaign of campaignIndex) {
    if (!jobIds.every((jobId) => campaign.jobIds.has(jobId))) continue;
    if (campaignId !== null) return null;
    campaignId = campaign.id;
  }
  return campaignId;
}

function onlyValue(values: ReadonlySet<string>): string | null {
  if (values.size !== 1) return null;
  for (const value of values) return value;
  return null;
}

export function selectCampaignApplicationsScope(
  workspace: JobFinderRendererWorkspaceSnapshot,
  allPlans = false,
  campaignId = workspace.activeCampaignId,
) {
  const activeCampaign = workspace.campaigns.find(
    (campaign) => campaign.id === campaignId,
  );
  if (allPlans) {
    return {
      activeCampaign: null,
      applicationAttempts: workspace.applicationAttempts,
      applicationRecords: workspace.applicationRecords,
      applyJobResults: workspace.applyJobResults,
      applyRuns: workspace.applyRuns,
      discoveryJobs: workspace.discoveryJobs,
      selectedApplyRunId: workspace.selectedApplyRunId,
    };
  }
  if (!activeCampaign) {
    return {
      activeCampaign: null,
      applicationAttempts: [],
      applicationRecords: [],
      applyJobResults: [],
      applyRuns: [],
      discoveryJobs: [],
      selectedApplyRunId: null,
    };
  }

  const campaignIndex = indexCampaignJobIds(workspace.campaigns);
  const runCampaignById = new Map(
    workspace.applyRuns.map((run) => [
      run.id,
      run.campaignId ?? resolveCampaignForJobs(campaignIndex, run.jobIds),
    ]),
  );
  const resultsByApplicationRecordId = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["applyJobResults"]
  >();
  for (const result of workspace.applyJobResults) {
    if (!result.applicationRecordId) continue;
    const results =
      resultsByApplicationRecordId.get(result.applicationRecordId) ?? [];
    results.push(result);
    resultsByApplicationRecordId.set(result.applicationRecordId, results);
  }
  const recordCampaignById = new Map<string, string | null>();
  for (const record of workspace.applicationRecords) {
    const linkedResults = resultsByApplicationRecordId.get(record.id) ?? [];
    const linkedCampaignIds = new Set(
      linkedResults.flatMap((result) => {
        const campaignId = runCampaignById.get(result.runId) ?? null;
        return campaignId ? [campaignId] : [];
      }),
    );
    recordCampaignById.set(
      record.id,
      linkedResults.length > 0
        ? onlyValue(linkedCampaignIds)
        : resolveCampaignForJobs(campaignIndex, [record.jobId]),
    );
  }

  const applicationRecords = workspace.applicationRecords.filter(
    (record) => recordCampaignById.get(record.id) === activeCampaign.id,
  );
  const applicationRecordIds = new Set(
    applicationRecords.map((record) => record.id),
  );
  const applyRuns = workspace.applyRuns.filter(
    (run) => runCampaignById.get(run.id) === activeCampaign.id,
  );
  const applyRunIds = new Set(applyRuns.map((run) => run.id));
  const recordsByJobId = new Map<string, string[]>();
  for (const record of applicationRecords) {
    const ids = recordsByJobId.get(record.jobId) ?? [];
    ids.push(record.id);
    recordsByJobId.set(record.jobId, ids);
  }
  const applyJobResults = workspace.applyJobResults.filter((result) => {
    if (!applyRunIds.has(result.runId)) return false;
    if (result.applicationRecordId) {
      return applicationRecordIds.has(result.applicationRecordId);
    }
    return (recordsByJobId.get(result.jobId)?.length ?? 0) === 1;
  });
  const applicationAttempts = workspace.applicationAttempts.filter(
    (attempt) => {
      if (attempt.applicationRecordId) {
        return applicationRecordIds.has(attempt.applicationRecordId);
      }
      return (recordsByJobId.get(attempt.jobId)?.length ?? 0) === 1;
    },
  );
  const campaignJobIds = new Set(activeCampaign.jobIds);

  return {
    activeCampaign,
    applicationAttempts,
    applicationRecords,
    applyJobResults,
    applyRuns,
    discoveryJobs: workspace.discoveryJobs.filter((job) =>
      campaignJobIds.has(job.id),
    ),
    selectedApplyRunId: applyRunIds.has(workspace.selectedApplyRunId ?? "")
      ? workspace.selectedApplyRunId
      : null,
  };
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
  const context = useJobFinderPageContext();
  // A workspace that has not started setup opens guided setup directly; Home
  // is one screen of hallway before it. The redirect is spent immediately so
  // the sidebar's Home destination still works.
  if (shouldAutoOpenGuidedSetup(context.workspace.profileSetupState)) {
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
      discoveryRunFeedback={context.discoveryRunFeedback}
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
      activeDiscoveryRun={context.workspace.activeDiscoveryRun}
      discoveryRuns={context.workspace.recentDiscoveryRuns}
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
