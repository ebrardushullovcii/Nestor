import {
  createElement,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { projectPlanSafeguardPauses } from "@nestor/job-finder/plan-safeguard-pauses";
import type { ComponentType, ReactNode } from "react";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import { useJobStageCounts } from "@renderer/features/find-jobs/use-job-stage-counts";
import { readFullWorkspaceIfBehind } from "@renderer/features/job-finder/lib/workspace-view-refresh";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { JobFinderRouteErrorBoundary } from "./job-finder-route-error-boundary";
import { getDefaultProfileRoute } from "@renderer/features/job-finder/lib/job-finder-utils";
import {
  CAMPAIGN_PLAN_EDITOR_SEARCH_PARAM,
  CAMPAIGN_PLAN_EDITOR_SEARCH_VALUE,
} from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import {
  Navigate,
  useSearchParams,
  useLocation,
  useOutletContext,
} from "react-router-dom";
import { isProfileSetupJustFinished } from "./use-job-finder-page-controller-actions";
import {
  markGuidedSetupAutoOpenSpent,
  shouldAutoOpenGuidedSetup,
} from "@renderer/features/job-finder/components/profile/setup/guided-setup-auto-open";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type {
  CampaignRuleFunnelProjection,
  JobFinderRendererWorkspaceSnapshot,
  SaveCampaignRuleInput,
  SaveJobSearchCampaignInput,
  SetJobFinderActivityControlInput,
} from "@nestor/contracts";
import { ProfileScreen } from "@renderer/features/job-finder/screens/profile-screen";
import { readJobFinderNavigationContext } from "@renderer/features/job-finder/lib/job-finder-context-navigation";
import { useLaunchReads } from "@renderer/features/job-finder/lib/launch-reads";
import { JobSearchHomeLaunch } from "@renderer/features/job-finder/screens/job-search-home/job-search-home-launch";

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
const loadCampaignsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/campaigns/campaigns-screen")
  ).CampaignsScreen,
}));
const loadJobSearchHomeScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/job-search-home/job-search-home-screen")
  ).JobSearchHomeScreen,
}));
const loadActionsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/actions-screen")
  ).ActionsScreen,
}));
const loadSettingsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/job-finder/screens/settings-screen")
  ).SettingsScreen,
}));

// The app opens on Home, so its screen is fetched while the workspace loads
// rather than after it; by the time the workspace is ready the screen is too.
if (
  import.meta.env.MODE !== "test" &&
  typeof window !== "undefined" &&
  /^(#\/?(job-finder(\/home)?\/?)?)?$/.test(window.location.hash)
) {
  void loadJobSearchHomeScreen().catch(() => undefined);
}

// Every other screen's code is fetched once the window is idle, so the first
// click on any of them renders at once instead of waiting on its chunk.
if (import.meta.env.MODE !== "test" && typeof window !== "undefined") {
  const preloadScreens = () => {
    for (const load of [
      loadJobSearchHomeScreen,
      loadSettingsScreen,
      loadCampaignsScreen,
      loadActionsScreen,
      loadProfileSetupScreen,
    ])
      void load().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(preloadScreens, { timeout: 4000 });
  else window.setTimeout(preloadScreens, 2000);
}

const ProfileSetupScreen = lazyScreen(loadProfileSetupScreen);
const CampaignsScreen = lazyScreen(loadCampaignsScreen);
const JobSearchHomeScreen = lazyScreen(loadJobSearchHomeScreen);
const ActionsScreen = lazyScreen(loadActionsScreen);
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
  const launchReads = useLaunchReads();
  const [activityPending, setActivityPending] = useState(false);
  // A workspace that has not started setup opens guided setup directly; Home
  // is one screen of hallway before it. The redirect is spent immediately so
  // the sidebar's Home destination still works.
  const autoOpenGuidedSetup = shouldAutoOpenGuidedSetup(
    context.workspace.profileSetupState,
  );

  if (autoOpenGuidedSetup) {
    markGuidedSetupAutoOpenSpent();
    return <Navigate replace to="/job-finder/profile/setup" />;
  }

  const handleActivityControl = (input: SetJobFinderActivityControlInput) => {
    setActivityPending(true);
    void context.onSetActivityControl(input).finally(() => {
      setActivityPending(false);
    });
  };

  // The same adapter the shell's Tasks popover uses: the cancel command wants
  // the run's current job and record, which Home does not hold.
  const stopApplyRun = (runId: string) => {
    const run = context.workspace.applyRuns.find(
      (candidate) => candidate.id === runId,
    );
    const result = (context.workspace.applyJobResults ?? []).find(
      (candidate) =>
        candidate.runId === runId &&
        (run?.currentJobId ? candidate.jobId === run.currentJobId : true) &&
        Boolean(candidate.applicationRecordId),
    );
    if (!result?.applicationRecordId) return;
    void context.onCancelApplyRun({
      runId,
      jobId: result.jobId,
      applicationRecordId: result.applicationRecordId,
    });
  };

  // Find jobs' count comes from the job store, which is open at launch.
  const jobCounts = useJobStageCounts();
  const findJobsCounts = jobCounts
    ? { visible: jobCounts.found, weaker: 0 }
    : null;
  return (
    <JobFinderHydrationGate
      collections={
        findJobsCounts ? HOME_FIRST_VIEW_COLLECTIONS : HOME_REQUIRED_COLLECTIONS
      }
      launchView={
        launchReads.counts ? (
          <JobSearchHomeLaunch
            counts={launchReads.counts}
            onNavigate={context.onNavigateSafely}
          />
        ) : undefined
      }
      workspace={context.workspace}
    >
      <JobSearchHomeScreen
        findJobsCounts={findJobsCounts}
        actionState={context.actionState}
        activityPending={activityPending}
        applicationAutomationMode={
          context.workspace.settings.applicationAutomationMode ?? "confirm_before_submit"
        }
        browserSessionPending={context.isPending(
          jobFinderPendingActions.browserSession(),
        )}
        campaignNotificationAllPending={context.isPending(
          jobFinderPendingActions.campaignNotificationAll(),
        )}
        campaignNotificationPending={(notificationId) =>
          context.isPending(
            jobFinderPendingActions.campaignNotification(notificationId),
          )
        }
        campaignNotifications={context.workspace.campaignNotifications}
        discoveryRunFeedback={context.discoveryRunFeedback}
        discoveryRunPending={context.isPending(
          jobFinderPendingActions.discoveryAll(),
        )}
        isDiscoveryPending={context.isPending(
          jobFinderPendingActions.discoveryAll(),
        )}
        isResumeImportPending={context.isPending(
          jobFinderPendingActions.profileImport(),
        )}
        liveDiscoveryEvents={context.liveDiscoveryEvents}
        onApplyToJobs={(jobIds) =>
          context.onStartAutoApplyQueue(
            [...jobIds],
            context.workspace.settings.applicationAutomationMode ?? "confirm_before_submit",
            { stayOnCurrentPage: true },
          )
        }
        onSendPreparedApplications={context.onSendPreparedApplications}
        onResumeSetup={context.onResumeProfileSetup}
        onMarkAllCampaignNotificationsRead={
          context.onMarkAllCampaignNotificationsRead
        }
        onMarkCampaignNotificationRead={context.onMarkCampaignNotificationRead}
        onNavigate={context.onNavigateSafely}
        onOpenBrowserSession={() => {
          void context.onOpenBrowserSession();
        }}
        onPauseActivity={() =>
          handleActivityControl({
            paused: true,
            reason: "Paused by you.",
            pauseBehavior: "finish_current",
          })
        }
        onResumeActivity={() => handleActivityControl({ paused: false })}
        {...(context.onRunAgentDiscovery
          ? { onRunDiscovery: context.onRunAgentDiscovery }
          : {})}
        onSelectCampaign={(campaignId) => {
          void context.onSelectCampaign(campaignId);
        }}
        onStopApply={stopApplyRun}
        onControlApplyQueue={context.onControlApplyQueue}
        {...(context.onCancelDiscovery
          ? {
              onStopSearch: (runId: string) => {
                void context.onCancelDiscovery?.(runId);
              },
            }
          : {})}
        resumeImportProgress={context.resumeImportProgress}
        workspace={context.workspace}
      />
    </JobFinderHydrationGate>
  );
}

const HOME_REQUIRED_COLLECTIONS = [
  "discovery_jobs",
  "review_queue",
  "applications",
  "source_history",
] as const;

/** Everything Home reads apart from the Find jobs lists. */
const HOME_FIRST_VIEW_COLLECTIONS = [
  "review_queue",
  "applications",
  "source_history",
  "documents",
  "intelligence",
] as const;

export function JobFinderCampaignsRoute() {
  const context = useJobFinderPageContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dismissedActionState, setDismissedActionState] = useState<
    typeof context.actionState | null
  >(null);
  const [pending, setPending] = useState(false);
  const [rulePending, setRulePending] = useState(false);
  const [funnelProjection, setFunnelProjection] =
    useState<CampaignRuleFunnelProjection | null>(null);
  const requestedCampaignId = searchParams.get("campaignId");
  const linkedPlanRequestRef = useRef<{ key: string } | null>(null);
  const linkedPlanRequestsRef = useRef(new Set<{ key: string }>());
  const [linkedPlanPendingCount, setLinkedPlanPendingCount] = useState(0);
  useEffect(
    () => () => {
      linkedPlanRequestRef.current = null;
      linkedPlanRequestsRef.current.clear();
    },
    [],
  );
  const requestedPlanEditorId =
    searchParams.get(CAMPAIGN_PLAN_EDITOR_SEARCH_PARAM) ===
    CAMPAIGN_PLAN_EDITOR_SEARCH_VALUE
      ? requestedCampaignId
      : null;
  // Latched, not read straight from the URL: the effect below clears the
  // request once the plan is current, and the screen is lazy-loaded, so the
  // params can be gone before the editor ever mounts.
  const [editCampaignId, setEditCampaignId] = useState<string | null>(
    requestedPlanEditorId,
  );
  useEffect(() => {
    if (requestedPlanEditorId !== null) {
      setEditCampaignId(requestedPlanEditorId);
    }
  }, [requestedPlanEditorId]);

  useEffect(() => {
    if (
      !requestedCampaignId ||
      !context.workspace.campaigns.some(
        (campaign) => campaign.id === requestedCampaignId,
      )
    ) {
      if (linkedPlanRequestRef.current) setPending(false);
      linkedPlanRequestRef.current = null;
      return;
    }

    const requestKey = searchParams.toString();
    const clearRequestedCampaign = () => {
      setSearchParams(
        (current) => {
          if (current.toString() !== requestKey) return current;
          const next = new URLSearchParams(current);
          next.delete("campaignId");
          next.delete(CAMPAIGN_PLAN_EDITOR_SEARCH_PARAM);
          return next;
        },
        { replace: true },
      );
    };
    if (requestedCampaignId === context.workspace.activeCampaignId) {
      // A prior selection can still publish an older plan. Keep the latest
      // link until all requests settle so that the effect can reconcile it.
      if (linkedPlanPendingCount > 0) return;
      linkedPlanRequestRef.current = null;
      setPending(false);
      clearRequestedCampaign();
      return;
    }
    const attemptKey = `${context.workspace.activeCampaignId}:${requestKey}`;
    if (linkedPlanRequestRef.current?.key === attemptKey) return;
    const request = { key: attemptKey };
    linkedPlanRequestRef.current = request;
    linkedPlanRequestsRef.current.add(request);
    setLinkedPlanPendingCount(linkedPlanRequestsRef.current.size);
    setPending(true);
    void context
      .onSelectCampaign(requestedCampaignId)
      .catch(() => undefined)
      .finally(() => {
        if (!linkedPlanRequestsRef.current.delete(request)) return;
        const remaining = linkedPlanRequestsRef.current.size;
        setLinkedPlanPendingCount(remaining);
        setPending(remaining > 0);
      });
  }, [
    context.onSelectCampaign,
    context.workspace.activeCampaignId,
    context.workspace.campaigns,
    linkedPlanPendingCount,
    requestedCampaignId,
    searchParams,
    setSearchParams,
  ]);

  const handleSaveCampaign = (
    campaign: SaveJobSearchCampaignInput,
  ): Promise<boolean> => {
    setPending(true);
    return context.onSaveCampaign(campaign).finally(() => {
      setPending(false);
    });
  };

  const handleSelectCampaign = (campaignId: string) => {
    setPending(true);
    void context.onSelectCampaign(campaignId).finally(() => {
      setPending(false);
    });
  };

  const refreshCampaignRuleFunnel = useCallback(
    (campaignId: string) => {
      setRulePending(true);
      void context
        .onProjectCampaignRuleFunnel(campaignId)
        .then((projection) => {
          setFunnelProjection(projection);
        })
        .catch(() => {
          setFunnelProjection(null);
        })
        .finally(() => {
          setRulePending(false);
        });
    },
    [context],
  );

  const handleSaveCampaignRule = (
    campaignId: string,
    rule: SaveCampaignRuleInput,
  ) => {
    void context.onSaveCampaignRule(campaignId, rule).then((saved) => {
      if (saved) {
        refreshCampaignRuleFunnel(campaignId);
      }
    });
  };

  const handleDeleteCampaignRule = (campaignId: string, ruleId: string) => {
    void context.onDeleteCampaignRule(campaignId, ruleId).then((saved) => {
      if (saved) {
        refreshCampaignRuleFunnel(campaignId);
      }
    });
  };

  const handleToggleCampaignRule = (
    campaignId: string,
    ruleId: string,
    enabled: boolean,
  ) => {
    void context
      .onToggleCampaignRule(campaignId, ruleId, enabled)
      .then((saved) => {
        if (saved) {
          refreshCampaignRuleFunnel(campaignId);
        }
      });
  };

  const handleRunCampaignNow = (campaignId: string) => {
    void context.onRunCampaignNow(campaignId);
  };

  return (
    <JobFinderHydrationGate
      collections={["discovery_jobs"]}
      workspace={context.workspace}
    >
      {context.actionState.message &&
      context.actionState !== dismissedActionState ? (
        <div
          aria-atomic="true"
          className="sticky top-0 z-10 mb-4 flex min-w-0 items-start justify-between gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background px-3 py-2 text-sm leading-5 text-foreground"
          role="status"
        >
          <p className="min-w-0 break-words">{context.actionState.message}</p>
          <Button
            onClick={() => setDismissedActionState(context.actionState)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <CampaignsScreen
        editCampaignId={editCampaignId}
        safeguardPauses={projectPlanSafeguardPauses(
          context.workspace.intelligence?.safeguards,
          context.workspace.campaigns,
        )}
        activeCampaignId={context.workspace.activeCampaignId}
        activeDiscoveryRun={context.workspace.activeDiscoveryRun ?? null}
        campaignRuleFunnel={funnelProjection}
        campaignRulePending={rulePending}
        campaigns={context.workspace.campaigns}
        profile={context.workspace.profile}
        discoveryRuns={context.workspace.recentDiscoveryRuns}
        onDirtyChange={context.onSearchPlanSurfaceDirtyChange}
        onDeleteCampaign={context.onDeleteCampaign}
        onDeleteCampaignRule={handleDeleteCampaignRule}
        onRefreshCampaignRuleFunnel={refreshCampaignRuleFunnel}
        onRunCampaignNow={handleRunCampaignNow}
        onSaveCampaign={handleSaveCampaign}
        onSaveCampaignRule={handleSaveCampaignRule}
        onSelectCampaign={handleSelectCampaign}
        onToggleCampaignRule={handleToggleCampaignRule}
        pending={pending}
        runCampaignPending={(campaignId) =>
          context.isPending(jobFinderPendingActions.campaignRun(campaignId))
        }
      />
    </JobFinderHydrationGate>
  );
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

export function selectJobFinderActionsScope(context: JobFinderPageContext) {
  return {
    groupedDecisions: context.workspace.intelligence.groupedDecisions,
    isGroupedApplyPending: (decisionId: string) =>
      context.isPending(
        jobFinderPendingActions.groupedManualAnswerApply(decisionId),
      ),
    isGroupedProjectPending: (groupKey: string) =>
      context.isPending(
        jobFinderPendingActions.groupedManualAnswerProject(groupKey),
      ),
    isGroupedSnoozePending: (decisionId: string) =>
      context.isPending(
        jobFinderPendingActions.groupedDecisionSnooze(decisionId),
      ),
    onApplyGroupedManualAnswer: context.onApplyGroupedManualAnswer,
    onProjectGroupedManualAnswer: context.onProjectGroupedManualAnswer,
    onSnoozeGroupedDecision: context.onSnoozeGroupedDecision,
  };
}

export function JobFinderActionsRoute() {
  const context = useJobFinderPageContext();
  // Lists every job: one full read if the lists fell behind.
  useEffect(readFullWorkspaceIfBehind, []);
  const [searchParams] = useSearchParams();
  const scope = useMemo(
    () => selectJobFinderActionsScope(context),
    // Only the fields selectJobFinderActionsScope reads: the outlet context
    // object identity changes on every parent render, so depending on it
    // would defeat the memo.
    [
      context.workspace.intelligence.groupedDecisions,
      context.isPending,
      context.onApplyGroupedManualAnswer,
      context.onProjectGroupedManualAnswer,
      context.onSnoozeGroupedDecision,
    ],
  );

  return (
    <JobFinderHydrationGate
      collections={["discovery_jobs", "applications", "intelligence"]}
      workspace={context.workspace}
    >
      <ActionsScreen
        applyMode={
          context.workspace.settings?.applicationAutomationMode ===
          "autonomous_submit"
            ? "apply_for_me"
            : "fill_only"
        }
        selectedApplicationRecordId={
          readJobFinderNavigationContext(searchParams).applicationRecordId
        }
        selectedRequestId={searchParams.get("requestId")}
        selectedDecisionId={searchParams.get("decisionId")}
        safeguardPauses={projectPlanSafeguardPauses(
          context.workspace.intelligence?.safeguards,
          context.workspace.campaigns,
        )}
        applicationAttempts={context.workspace.applicationAttempts}
        applicationRecords={context.workspace.applicationRecords}
        applyJobResults={context.workspace.applyJobResults}
        discoveryJobs={context.workspace.discoveryJobs}
        groupedDecisions={scope.groupedDecisions}
        isGroupedApplyPending={scope.isGroupedApplyPending}
        isGroupedProjectPending={scope.isGroupedProjectPending}
        isGroupedSnoozePending={scope.isGroupedSnoozePending}
        isPending={(requestId) =>
          context.isPending(jobFinderPendingActions.userAction(requestId))
        }
        onApplyGroupedManualAnswer={scope.onApplyGroupedManualAnswer}
        onGetApplyRunDetails={context.onGetApplyRunDetails}
        onCommand={async (command) => {
          await context.onPerformUserAction(command, {
            rethrowError: command.action === "submit_manual_answer",
          });
        }}
        onNavigate={context.onNavigateSafely}
        onProjectGroupedManualAnswer={scope.onProjectGroupedManualAnswer}
        onSnoozeGroupedDecision={scope.onSnoozeGroupedDecision}
        onStartOver={async (request, cancel) => {
          // A lost check: close it, then prepare the same application again.
          if (request.scope.type !== "application") return;
          const cancelled = await context.onPerformUserAction(cancel);
          if (!cancelled) return;
          context.onStartApplyCopilot({
            jobId: request.scope.jobId,
            ...(request.scope.applicationRecordId
              ? { applicationRecordId: request.scope.applicationRecordId }
              : {}),
          });
        }}
        profile={context.workspace.profile}
        requests={context.workspace.userActionRequests ?? []}
      />
    </JobFinderHydrationGate>
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
