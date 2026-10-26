import type { ReactNode } from "react";
import {
  createSharedRouteLoader,
  lazyScreen,
  preloadWhenIdle,
} from "@renderer/lib/lazy-screen";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { JobFinderRouteErrorBoundary } from "./job-finder-route-error-boundary";
import { Navigate } from "react-router-dom";
import { useLaunchReads } from "@renderer/features/job-finder/lib/launch-reads";
import {
  markGuidedSetupAutoOpenSpent,
  shouldAutoOpenGuidedSetup,
} from "@renderer/features/job-finder/components/profile/setup/guided-setup-auto-open";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { HomeScreen } from "@renderer/features/home/home-screen";

// Profile, setup and Settings are their own chunks, fetched once the window
// is idle or on the first visit, whichever comes first.
const loadProfileSetupScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/profile-store/stored-profile-setup-screen")
  ).StoredProfileSetupScreen,
}));
const loadProfileScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/profile-store/stored-profile-screen")
  ).StoredProfileScreen,
}));
const loadSettingsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/profile-store/stored-settings-screen")
  ).StoredSettingsScreen,
}));

preloadWhenIdle([
  loadProfileScreen,
  loadSettingsScreen,
  loadProfileSetupScreen,
]);

const StoredProfileScreen = lazyScreen(loadProfileScreen);
const ProfileSetupScreen = lazyScreen(loadProfileSetupScreen);
const SettingsScreen = lazyScreen(loadSettingsScreen);

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
  // Home opens before Profile, so setup state comes from the launch read.
  // A workspace the launch read could not read leaves setup unknown, and
  // Home stays.
  const launched = useLaunchReads().context;
  // A workspace that has not started setup opens guided setup directly; Home
  // is one screen of hallway before it. The redirect is spent immediately so
  // the sidebar's Home destination still works.
  if (
    launched &&
    launched.workspace !== "unreadable" &&
    shouldAutoOpenGuidedSetup(launched.profileSetupState)
  ) {
    markGuidedSetupAutoOpenSpent();
    return <Navigate replace to="/job-finder/profile/setup" />;
  }
  return <HomeScreen />;
}

export function JobFinderProfileRoute() {
  return <StoredProfileScreen />;
}

export function JobFinderProfileSetupRoute() {
  return <ProfileSetupScreen />;
}

export function JobFinderSettingsRoute() {
  return <SettingsScreen />;
}
